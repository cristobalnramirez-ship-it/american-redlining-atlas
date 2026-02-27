"""
Fetch census tract geometry and ACS data for a specific city.

Usage: python fetch_census.py --city <slug> [CENSUS_API_KEY]

Reads stateFips and counties from cities.json. Fetches TIGERweb tract geometry
and ACS income/demographic data, then saves income.geojson and race.geojson.
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

TIGER_URL = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
    "Tracts_Blocks/MapServer/8/query"
)
ACS_URL = "https://api.census.gov/data/{year}/acs/acs5"


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


def fetch_tract_geometry(state_fips, county_fips):
    """Fetch census tract polygons from TIGERweb for one county."""
    all_features = []
    offset = 0
    page_size = 500

    while True:
        params = (
            f"?where=STATE%3D%27{state_fips}%27+AND+COUNTY%3D%27{county_fips}%27"
            f"&outFields=GEOID,NAME,AREALAND"
            f"&returnGeometry=true"
            f"&f=geojson"
            f"&resultOffset={offset}"
            f"&resultRecordCount={page_size}"
        )
        url = TIGER_URL + params
        print(f"  Fetching tracts for county {county_fips}, offset {offset}...")

        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.loads(response.read().decode('utf-8'))

        features = data.get('features', [])
        if not features:
            break
        all_features.extend(features)

        if len(features) < page_size:
            break
        offset += page_size

    return all_features


def fetch_acs_data(state_fips, county_fips, year=2022, api_key=None):
    """Fetch ACS income and demographic data for tracts in one county."""
    variables = "B19013_001E,B01003_001E,B17001_002E,B03002_003E,B03002_004E,B03002_006E,B03002_012E"

    url = (
        f"{ACS_URL.format(year=year)}"
        f"?get=NAME,{variables}"
        f"&for=tract:*"
        f"&in=state:{state_fips}%20county:{county_fips}"
    )
    if api_key:
        url += f"&key={api_key}"

    print(f"  Fetching ACS {year} for county {county_fips}...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = json.loads(response.read().decode('utf-8'))

    headers = data[0]
    rows = data[1:]

    result = {}
    for row in rows:
        record = dict(zip(headers, row))
        geoid = state_fips + county_fips + record.get('tract', '')
        total_pop = safe_int(record.get('B01003_001E'))
        median_income = safe_int(record.get('B19013_001E'))
        poverty_pop = safe_int(record.get('B17001_002E'))
        white = safe_int(record.get('B03002_003E'))
        black = safe_int(record.get('B03002_004E'))
        asian = safe_int(record.get('B03002_006E'))
        hispanic = safe_int(record.get('B03002_012E'))

        denom = total_pop or 0
        result[geoid] = {
            'median_income': median_income,
            'population': total_pop,
            'poverty_pop': poverty_pop,
            'pct_white': round(100 * (white or 0) / denom, 1) if denom > 0 else None,
            'pct_black': round(100 * (black or 0) / denom, 1) if denom > 0 else None,
            'pct_hispanic': round(100 * (hispanic or 0) / denom, 1) if denom > 0 else None,
            'pct_asian': round(100 * (asian or 0) / denom, 1) if denom > 0 else None,
            'poverty_rate': round(100 * (poverty_pop or 0) / denom, 1) if denom > 0 else None,
        }

    return result


def fetch_census(slug, api_key=None):
    config = load_city_config(slug)
    state_fips = config['stateFips']
    counties = config['counties']

    print(f"Fetching census data for {config['label']}, {config['state']}")

    # Fetch geometry for all counties
    all_features = []
    for county_fips in counties:
        features = fetch_tract_geometry(state_fips, county_fips)
        all_features.extend(features)
        print(f"    Got {len(features)} tracts for county {county_fips}")

    print(f"  Total tracts: {len(all_features)}")

    # Fetch ACS data
    all_acs = {}
    for county_fips in counties:
        try:
            acs = fetch_acs_data(state_fips, county_fips, api_key=api_key)
            all_acs.update(acs)
        except Exception as e:
            print(f"  WARNING: ACS fetch failed for county {county_fips}: {e}")

    # Join and build output
    income_features = []
    race_features = []

    for feature in all_features:
        geoid = feature['properties'].get('GEOID', '')
        name = feature['properties'].get('NAME', geoid)
        acs = all_acs.get(geoid, {})

        income_features.append({
            'type': 'Feature',
            'properties': {
                'tract_id': geoid,
                'name': 'Tract ' + name,
                'income_2020': acs.get('median_income'),
                'poverty_rate_2020': acs.get('poverty_rate'),
                'population_2020': acs.get('population'),
                'is_sample_data': not bool(acs),
            },
            'geometry': feature['geometry'],
        })

        race_features.append({
            'type': 'Feature',
            'properties': {
                'tract_id': geoid,
                'name': 'Tract ' + name,
                'pct_white_2020': acs.get('pct_white'),
                'pct_black_2020': acs.get('pct_black'),
                'pct_hispanic_2020': acs.get('pct_hispanic'),
                'pct_asian_2020': acs.get('pct_asian'),
                'population_2020': acs.get('population'),
                'is_sample_data': not bool(acs),
            },
            'geometry': feature['geometry'],
        })

    # Save
    out_dir = os.path.join(DATA_DIR, 'cities', slug)
    os.makedirs(out_dir, exist_ok=True)

    income_file = os.path.join(out_dir, 'income.geojson')
    with open(income_file, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': income_features}, f)
    print(f"Saved income data ({len(income_features)} tracts) to {income_file}")

    race_file = os.path.join(out_dir, 'race.geojson')
    with open(race_file, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': race_features}, f)
    print(f"Saved race data ({len(race_features)} tracts) to {race_file}")


def main():
    parser = argparse.ArgumentParser(description='Fetch census data for a city')
    parser.add_argument('--city', required=True, help='City slug from cities.json')
    parser.add_argument('--api-key', default=None, help='Census API key')
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get('CENSUS_API_KEY')
    fetch_census(args.city, api_key=api_key)


if __name__ == '__main__':
    main()
