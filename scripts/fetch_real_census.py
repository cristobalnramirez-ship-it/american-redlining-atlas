"""
Fetch real ACS 5-Year data and update existing GeoJSON files for a city.

Usage: python fetch_real_census.py --city <slug> [--api-key KEY]

Replaces synthetic 2020 values in income.geojson and race.geojson
with real Census data while keeping synthetic historical decade values.
"""

import json
import urllib.request
import argparse
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.join(SCRIPT_DIR, '..')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
CITIES_FILE = os.path.join(DATA_DIR, 'cities.json')

ACS_URL = "https://api.census.gov/data/2022/acs/acs5"

VARIABLES = (
    "B19013_001E,B01003_001E,B17001_001E,B17001_002E,"
    "B03002_001E,B03002_003E,B03002_004E,B03002_006E,B03002_012E"
)


def load_city_config(slug):
    with open(CITIES_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)
    city = config['cities'].get(slug)
    if not city:
        raise ValueError(f"City '{slug}' not found in cities.json")
    return city


def safe_int(val):
    try:
        v = int(val)
        return v if v >= 0 else None
    except (ValueError, TypeError):
        return None


def fetch_acs_for_county(state_fips, county_fips, api_key=None):
    """Fetch ACS 5-Year data for all tracts in one county."""
    url = (
        f"{ACS_URL}"
        f"?get=NAME,{VARIABLES}"
        f"&for=tract:*"
        f"&in=state:{state_fips}%20county:{county_fips}"
    )
    if api_key:
        url += f"&key={api_key}"

    print(f"  Fetching ACS for county {county_fips}...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=120) as response:
        data = json.loads(response.read().decode('utf-8'))

    headers = data[0]
    rows = data[1:]
    result = {}

    for row in rows:
        record = dict(zip(headers, row))
        tract = record.get('tract', '')
        geoid = state_fips + county_fips + tract
        total_pop = safe_int(record.get('B01003_001E'))
        race_total = safe_int(record.get('B03002_001E'))
        denom = race_total or total_pop or 0

        poverty_universe = safe_int(record.get('B17001_001E'))
        poverty_pop = safe_int(record.get('B17001_002E'))
        poverty_rate = None
        if poverty_universe and poverty_universe > 0 and poverty_pop is not None:
            poverty_rate = round(100 * poverty_pop / poverty_universe, 1)

        white = safe_int(record.get('B03002_003E'))
        black = safe_int(record.get('B03002_004E'))
        asian = safe_int(record.get('B03002_006E'))
        hispanic = safe_int(record.get('B03002_012E'))

        result[geoid] = {
            'median_income': safe_int(record.get('B19013_001E')),
            'population': total_pop,
            'poverty_rate': poverty_rate,
            'pct_white': round(100 * (white or 0) / denom, 1) if denom > 0 else None,
            'pct_black': round(100 * (black or 0) / denom, 1) if denom > 0 else None,
            'pct_hispanic': round(100 * (hispanic or 0) / denom, 1) if denom > 0 else None,
            'pct_asian': round(100 * (asian or 0) / denom, 1) if denom > 0 else None,
        }

    return result


def fetch_real_census(slug, api_key=None):
    config = load_city_config(slug)
    state_fips = config['stateFips']
    counties = config['counties']
    city_dir = os.path.join(DATA_DIR, 'cities', slug)

    print(f"Fetching real ACS data for {config['label']}, {config['state']}")

    # Fetch ACS for all counties
    all_acs = {}
    for county_fips in counties:
        try:
            acs = fetch_acs_for_county(state_fips, county_fips, api_key)
            all_acs.update(acs)
            print(f"    Got {len(acs)} tracts for county {county_fips}")
        except Exception as e:
            print(f"  WARNING: Failed for county {county_fips}: {e}")

    if not all_acs:
        print("ERROR: No data returned")
        return

    print(f"  Total: {len(all_acs)} tracts")

    # Update income.geojson
    income_file = os.path.join(city_dir, 'income.geojson')
    if os.path.exists(income_file):
        with open(income_file, 'r', encoding='utf-8') as f:
            income_data = json.load(f)

        matched = 0
        for feat in income_data['features']:
            tid = feat['properties'].get('tract_id', '')
            if tid in all_acs:
                acs = all_acs[tid]
                if acs['median_income'] is not None:
                    feat['properties']['income_2020'] = acs['median_income']
                if acs['poverty_rate'] is not None:
                    feat['properties']['poverty_rate_2020'] = acs['poverty_rate']
                if acs['population'] is not None:
                    feat['properties']['population_2020'] = acs['population']
                feat['properties']['is_sample_data'] = False
                matched += 1

        with open(income_file, 'w', encoding='utf-8') as f:
            json.dump(income_data, f)
        print(f"  Updated {matched} income tracts in {income_file}")

    # Update race.geojson
    race_file = os.path.join(city_dir, 'race.geojson')
    if os.path.exists(race_file):
        with open(race_file, 'r', encoding='utf-8') as f:
            race_data = json.load(f)

        matched = 0
        for feat in race_data['features']:
            tid = feat['properties'].get('tract_id', '')
            if tid in all_acs:
                acs = all_acs[tid]
                for k in ['pct_white', 'pct_black', 'pct_hispanic', 'pct_asian']:
                    if acs[k] is not None:
                        feat['properties'][k + '_2020'] = acs[k]
                if acs['population'] is not None:
                    feat['properties']['population_2020'] = acs['population']
                feat['properties']['is_sample_data'] = False
                matched += 1

        with open(race_file, 'w', encoding='utf-8') as f:
            json.dump(race_data, f)
        print(f"  Updated {matched} race tracts in {race_file}")


def main():
    parser = argparse.ArgumentParser(description='Update census GeoJSON with real ACS data')
    parser.add_argument('--city', required=True, help='City slug from cities.json')
    parser.add_argument('--api-key', default=None, help='Census API key')
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get('CENSUS_API_KEY')
    fetch_real_census(args.city, api_key=api_key)


if __name__ == '__main__':
    main()
