"""
Discover all HOLC-mapped cities from the national redlining dataset.

Downloads the Mapping Inequality census crosswalk GeoJSON (~69MB),
extracts unique cities, computes centroids/bboxes/FIPS codes, and
generates data/cities.json with auto-computed configs.

Featured cities (Houston, NYC) keep their manually-curated configs.
"""

import json
import urllib.request
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.join(SCRIPT_DIR, '..')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
CITIES_FILE = os.path.join(DATA_DIR, 'cities.json')
CACHE_FILE = os.path.join(DATA_DIR, 'holc_national.geojson')

# National HOLC crosswalk from Mapping Inequality
HOLC_NATIONAL_URL = (
    "https://raw.githubusercontent.com/americanpanorama/mapping-inequality-census-crosswalk/"
    "main/MIv3Areas_2010TractCrosswalk.geojson"
)

# State FIPS -> abbreviation lookup
STATE_FIPS_MAP = {
    '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA',
    '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
    '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN',
    '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
    '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS',
    '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
    '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
    '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
    '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT',
    '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
    '56': 'WY',
}


def download_national_holc():
    """Download the national HOLC crosswalk GeoJSON (cached)."""
    if os.path.exists(CACHE_FILE):
        print(f"Using cached national HOLC data: {CACHE_FILE}")
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)

    print(f"Downloading national HOLC data (~69MB)...")
    print(f"  URL: {HOLC_NATIONAL_URL}")
    req = urllib.request.Request(HOLC_NATIONAL_URL, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=300) as response:
        raw = response.read().decode('utf-8')
        data = json.loads(raw)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        f.write(raw)

    print(f"  Cached to {CACHE_FILE}")
    return data


def compute_centroid(coords_list):
    """Compute centroid from a list of [lon, lat] points."""
    if not coords_list:
        return [0, 0]
    avg_lon = sum(p[0] for p in coords_list) / len(coords_list)
    avg_lat = sum(p[1] for p in coords_list) / len(coords_list)
    return [round(avg_lat, 4), round(avg_lon, 4)]


def extract_coords(geometry):
    """Flatten any geometry type into a list of [lon, lat] points."""
    pts = []
    gtype = geometry.get('type', '')
    coords = geometry.get('coordinates', [])

    if gtype == 'Polygon':
        for ring in coords:
            pts.extend(ring)
    elif gtype == 'MultiPolygon':
        for poly in coords:
            for ring in poly:
                pts.extend(ring)
    elif gtype == 'Point':
        pts.append(coords)
    return pts


def make_slug(city, state_abbr):
    """Generate a URL-safe slug from city + state."""
    raw = city.lower().replace(' ', '_').replace('.', '').replace("'", '')
    raw = re.sub(r'[^a-z0-9_]', '', raw)
    return f"{raw}_{state_abbr.lower()}"


def discover_cities(holc_data):
    """Parse national HOLC data and group by city."""
    city_groups = {}

    for feature in holc_data.get('features', []):
        props = feature.get('properties', {})
        city = props.get('city', '')
        state = props.get('state', '')
        geoid = str(props.get('GEOID', props.get('geoid', '')))

        if not city or not state:
            continue

        key = f"{city}|{state}"
        if key not in city_groups:
            city_groups[key] = {
                'city': city,
                'state': state,
                'geoids': set(),
                'coords': [],
            }

        if geoid:
            city_groups[key]['geoids'].add(geoid)

        pts = extract_coords(feature.get('geometry', {}))
        city_groups[key]['coords'].extend(pts)

    print(f"Found {len(city_groups)} unique cities in HOLC data")
    return city_groups


def build_city_configs(city_groups):
    """Convert grouped city data into city config entries."""
    cities = {}

    for key, group in city_groups.items():
        city_name = group['city']
        state = group['state']
        coords = group['coords']
        geoids = group['geoids']

        if not coords:
            continue

        # Compute centroid and bbox
        center = compute_centroid(coords)
        lons = [p[0] for p in coords]
        lats = [p[1] for p in coords]
        padding = 0.05
        bbox = [
            round(min(lons) - padding, 3),
            round(min(lats) - padding, 3),
            round(max(lons) + padding, 3),
            round(max(lats) + padding, 3),
        ]

        # Extract county FIPS (first 5 chars of GEOID = state + county)
        counties = {}
        state_fips = None
        for geoid in geoids:
            if len(geoid) >= 5:
                sf = geoid[:2]
                cf = geoid[2:5]
                state_fips = sf
                counties[cf] = ''  # name unknown from this data

        if not state_fips:
            state_fips = ''
            for fips, abbr in STATE_FIPS_MAP.items():
                if abbr == state:
                    state_fips = fips
                    break

        state_abbr = STATE_FIPS_MAP.get(state_fips, state)
        slug = make_slug(city_name, state_abbr)

        cities[slug] = {
            'slug': slug,
            'label': city_name,
            'state': state_abbr,
            'stateFips': state_fips,
            'center': center,
            'zoom': 12,
            'bbox': bbox,
            'counties': counties,
            'holcCities': [city_name],
            'holcYear': 1940,  # default, can be refined
            'decadeMin': 1940,
            'layers': ['redlining', 'income', 'race', 'pollution'],
            'featured': False,
        }

    return cities


def merge_featured(auto_cities, existing_cities_file):
    """Merge auto-discovered cities with manually-curated featured configs."""
    if not os.path.exists(existing_cities_file):
        return auto_cities

    with open(existing_cities_file, 'r', encoding='utf-8') as f:
        existing = json.load(f)

    featured = existing.get('cities', {})

    # Featured cities override auto-discovered ones
    for slug, config in featured.items():
        if config.get('featured'):
            auto_cities[slug] = config

    return auto_cities


def main():
    holc_data = download_national_holc()
    city_groups = discover_cities(holc_data)
    auto_cities = build_city_configs(city_groups)

    print(f"Generated configs for {len(auto_cities)} cities")

    # Merge with existing featured configs
    all_cities = merge_featured(auto_cities, CITIES_FILE)

    # Build final output
    output = {
        'defaultCity': 'nyc',
        'cities': dict(sorted(all_cities.items(), key=lambda x: x[1]['label'])),
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CITIES_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)

    print(f"Saved {len(all_cities)} cities to {CITIES_FILE}")

    # Summary
    featured_count = sum(1 for c in all_cities.values() if c.get('featured'))
    print(f"  Featured: {featured_count}")
    print(f"  Auto-discovered: {len(all_cities) - featured_count}")


if __name__ == '__main__':
    main()
