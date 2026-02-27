"""
Extract HOLC redlining data for a specific city from the national dataset.

Usage: python fetch_redlining.py --city <slug>

Reads from cached holc_national.geojson and filters by city/state from cities.json.
"""

import json
import argparse
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.join(SCRIPT_DIR, '..')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
CITIES_FILE = os.path.join(DATA_DIR, 'cities.json')
CACHE_FILE = os.path.join(DATA_DIR, 'holc_national.geojson')


def load_city_config(slug):
    with open(CITIES_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)
    city = config['cities'].get(slug)
    if not city:
        raise ValueError(f"City '{slug}' not found in cities.json")
    return city


def fetch_redlining(slug):
    config = load_city_config(slug)
    holc_cities = config['holcCities']
    state = config['state']

    if not os.path.exists(CACHE_FILE):
        print(f"ERROR: National HOLC cache not found at {CACHE_FILE}")
        print("Run discover_cities.py first to download the national dataset.")
        return None

    print(f"Loading national HOLC data from cache...")
    with open(CACHE_FILE, 'r', encoding='utf-8') as f:
        national = json.load(f)

    # Filter features matching this city's HOLC cities and state
    matched = []
    for feature in national.get('features', []):
        props = feature.get('properties', {})
        feat_city = props.get('city', '')
        feat_state = props.get('state', '')
        if feat_city in holc_cities and feat_state == state:
            matched.append(feature)

    print(f"Found {len(matched)} HOLC zones for {config['label']}, {state}")

    if not matched:
        print("WARNING: No matching features found.")
        return None

    geojson = {
        'type': 'FeatureCollection',
        'features': matched,
    }

    # Save
    out_dir = os.path.join(DATA_DIR, 'cities', slug)
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, 'redlining.geojson')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(geojson, f)

    print(f"Saved to {out_file}")
    return geojson


def main():
    parser = argparse.ArgumentParser(description='Extract HOLC redlining data for a city')
    parser.add_argument('--city', required=True, help='City slug from cities.json')
    args = parser.parse_args()
    fetch_redlining(args.city)


if __name__ == '__main__':
    main()
