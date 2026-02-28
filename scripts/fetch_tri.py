"""
Fetch EPA Toxic Release Inventory (TRI) facilities for a city.

Usage: python fetch_tri.py --city <slug>

Reads state abbreviation and county names from cities.json.
Queries EPA Envirofacts API (no API key required).
"""

import json
import urllib.request
import urllib.parse
import argparse
import os
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.join(SCRIPT_DIR, '..')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
CITIES_FILE = os.path.join(DATA_DIR, 'cities.json')

BASE_URL = "https://data.epa.gov/efservice/tri_facility"


def load_city_config(slug):
    with open(CITIES_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)
    city = config['cities'].get(slug)
    if not city:
        raise ValueError(f"City '{slug}' not found in cities.json")
    return city


def fetch_page(url, offset=0, count=1000):
    page_url = f"{url}/rows/{offset}:{offset + count}/json"
    req = urllib.request.Request(page_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode('utf-8'))


def fetch_tri(slug):
    config = load_city_config(slug)
    state = config['state']
    counties = config['counties']

    print(f"Fetching TRI data for {config['label']}, {state}")

    all_facilities = []
    for county_fips, county_name in counties.items():
        # Try by county name if available, otherwise by state only
        name = county_name.strip() if county_name else ''
        if name:
            url = f"{BASE_URL}/state_abbr/{state}/county_name/{urllib.parse.quote(name)}"
        else:
            url = f"{BASE_URL}/state_abbr/{state}"

        print(f"  Fetching county: {name or county_fips}...")
        offset = 0
        while offset < 5000:
            try:
                rows = fetch_page(url, offset, 1000)
            except Exception as e:
                print(f"    Error at offset {offset}: {e}")
                break

            if not rows:
                break
            all_facilities.extend(rows)
            if len(rows) < 1000:
                break
            offset += 1000
            time.sleep(0.5)

        print(f"    Got {len(all_facilities)} total facilities so far")

    # De-duplicate by tri_facility_id
    seen = set()
    unique = []
    for fac in all_facilities:
        fid = fac.get('tri_facility_id', fac.get('TRI_FACILITY_ID', ''))
        if fid and fid not in seen:
            seen.add(fid)
            unique.append(fac)
        elif not fid:
            unique.append(fac)

    print(f"  Unique facilities: {len(unique)}")

    # Convert to GeoJSON
    features = []
    for fac in unique:
        lat, lon = None, None

        # Prefer pref_latitude/pref_longitude (decimal degrees)
        plat = fac.get('pref_latitude')
        plon = fac.get('pref_longitude')
        if plat and plon:
            try:
                lat = float(plat)
                lon = -abs(float(plon))  # US longitudes are negative
            except (ValueError, TypeError):
                pass

        # Fall back to street address geocoding via fac_latitude/fac_longitude
        if lat is None or lon is None:
            flat = fac.get('fac_latitude')
            flon = fac.get('fac_longitude')
            if flat and flon:
                try:
                    flat = float(flat)
                    flon = float(flon)
                    if flat > 1000:  # DMS format like 341240 = 34.2111
                        s = str(int(flat)).zfill(6)
                        lat = int(s[:2]) + int(s[2:4]) / 60 + int(s[4:6]) / 3600
                        s = str(int(flon)).zfill(7)
                        lon = -(int(s[:3]) + int(s[3:5]) / 60 + int(s[5:7]) / 3600)
                    elif flat != 0 and flon != 0:
                        lat = flat
                        lon = -abs(flon)
                except (ValueError, TypeError):
                    pass

        if lat is None or lon is None or lat == 0 or lon == 0:
            continue

        # Infer some fields for compatibility with the frontend
        year_reported = None
        for key in ['REPORTING_YEAR', 'SUBMISSION_REPORTING_YEAR']:
            if fac.get(key):
                try:
                    year_reported = int(fac[key])
                except (ValueError, TypeError):
                    pass
                break

        features.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': {
                'facility_name': fac.get('facility_name', fac.get('FACILITY_NAME', '')),
                'industry': fac.get('industry_sector', fac.get('INDUSTRY_SECTOR', fac.get('sic_code', fac.get('SIC_CODE', '')))),
                'tri_facility_id': fac.get('tri_facility_id', fac.get('TRI_FACILITY_ID', '')),
                'year_first_reported': year_reported or 1987,
                'carcinogen': False,  # Would need TRI release data to determine
                'total_releases_lbs': 1000,  # Placeholder
                'top_chemical': 'Unknown',
                'risk_score': 5,
                'nearby_neighborhoods': [],
            },
        })

    geojson = {
        'type': 'FeatureCollection',
        'features': features,
    }

    # Save
    out_dir = os.path.join(DATA_DIR, 'cities', slug)
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, 'tri_sites.geojson')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, indent=2)

    print(f"Saved {len(features)} TRI sites to {out_file}")


def main():
    parser = argparse.ArgumentParser(description='Fetch EPA TRI data for a city')
    parser.add_argument('--city', required=True, help='City slug from cities.json')
    args = parser.parse_args()
    fetch_tri(args.city)


if __name__ == '__main__':
    main()
