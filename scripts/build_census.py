"""
Build synthetic historical census data (1970-2010) for a city.

Usage: python build_census.py --city <slug>

Auto-detects demographic centers from real ACS data:
- Sorts tracts by income -> top/bottom 10% centroids
- Sorts tracts by pct_white/black/hispanic/asian -> top 10% centroids
Generates synthetic 1970-2010 history using spatial interpolation.

Requires income.geojson and race.geojson to already exist (from fetch_census.py).
"""

import json
import math
import random
import argparse
import os

random.seed(42)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.join(SCRIPT_DIR, '..')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
CITIES_FILE = os.path.join(DATA_DIR, 'cities.json')


def load_city_config(slug):
    with open(CITIES_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)
    city = config['cities'].get(slug)
    if not city:
        raise ValueError(f"City '{slug}' not found in cities.json")
    return city


def centroid(geometry):
    """Compute centroid from a GeoJSON geometry."""
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
    if not pts:
        return (0, 0)
    avg_lon = sum(p[0] for p in pts) / len(pts)
    avg_lat = sum(p[1] for p in pts) / len(pts)
    return (avg_lon, avg_lat)


def dist(p1, p2):
    return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)


def detect_centers(features, value_key, top_n_pct=10):
    """Auto-detect geographic centers for high values of a given property."""
    scored = []
    for feat in features:
        val = feat['properties'].get(value_key)
        if val is not None and val > 0:
            c = centroid(feat['geometry'])
            scored.append((val, c))

    scored.sort(key=lambda x: x[0], reverse=True)
    top_n = max(3, len(scored) * top_n_pct // 100)
    return [s[1] for s in scored[:top_n]]


def detect_low_centers(features, value_key, top_n_pct=10):
    """Auto-detect geographic centers for low values of a given property."""
    scored = []
    for feat in features:
        val = feat['properties'].get(value_key)
        if val is not None and val > 0:
            c = centroid(feat['geometry'])
            scored.append((val, c))

    scored.sort(key=lambda x: x[0])
    top_n = max(3, len(scored) * top_n_pct // 100)
    return [s[1] for s in scored[:top_n]]


def income_for_location(lon, lat, high_centers, low_centers, base_2020):
    """Generate income based on distance to high/low income centers."""
    if not high_centers or not low_centers:
        return base_2020

    min_high = min(dist((lon, lat), c) for c in high_centers)
    min_low = min(dist((lon, lat), c) for c in low_centers)
    score = min_low / (min_high + min_low + 0.001)
    score = max(0, min(1, score))
    base = 30000 + score * 200000
    noise = random.gauss(0, 15000)
    return max(20000, int(base + noise))


def build_census(slug):
    config = load_city_config(slug)
    city_dir = os.path.join(DATA_DIR, 'cities', slug)

    income_file = os.path.join(city_dir, 'income.geojson')
    race_file = os.path.join(city_dir, 'race.geojson')

    if not os.path.exists(income_file) or not os.path.exists(race_file):
        print(f"ERROR: Run fetch_census.py --city {slug} first")
        return

    with open(income_file, 'r', encoding='utf-8') as f:
        income_data = json.load(f)
    with open(race_file, 'r', encoding='utf-8') as f:
        race_data = json.load(f)

    print(f"Building synthetic history for {config['label']}, {config['state']}")
    print(f"  Income tracts: {len(income_data['features'])}")
    print(f"  Race tracts: {len(race_data['features'])}")

    # Auto-detect demographic centers from real 2020 data
    high_income_centers = detect_centers(income_data['features'], 'income_2020')
    low_income_centers = detect_low_centers(income_data['features'], 'income_2020')
    white_centers = detect_centers(race_data['features'], 'pct_white_2020')
    black_centers = detect_centers(race_data['features'], 'pct_black_2020')
    hispanic_centers = detect_centers(race_data['features'], 'pct_hispanic_2020')
    asian_centers = detect_centers(race_data['features'], 'pct_asian_2020')

    print(f"  Detected {len(high_income_centers)} high-income centers")
    print(f"  Detected {len(low_income_centers)} low-income centers")

    # Build historical income data
    for feat in income_data['features']:
        p = feat['properties']
        inc_2020 = p.get('income_2020')
        if inc_2020 is None:
            c = centroid(feat['geometry'])
            inc_2020 = income_for_location(c[0], c[1], high_income_centers, low_income_centers, 50000)
            p['income_2020'] = inc_2020

        # Generate synthetic historical values (backward from 2020)
        p['income_2010'] = int(inc_2020 * random.uniform(0.82, 0.95))
        p['income_2000'] = int(p['income_2010'] * random.uniform(0.78, 0.92))
        p['income_1990'] = int(p['income_2000'] * random.uniform(0.72, 0.88))
        p['income_1980'] = int(p['income_1990'] * random.uniform(0.60, 0.80))
        p['income_1970'] = int(p['income_1980'] * random.uniform(0.55, 0.75))

        if p.get('poverty_rate_2020') is None:
            p['poverty_rate_2020'] = max(1, min(50, round(40 - (inc_2020 / 8000) + random.gauss(0, 5), 1)))
        if p.get('population_2020') is None:
            p['population_2020'] = random.randint(1500, 12000)

    # Build historical race data
    for feat in race_data['features']:
        p = feat['properties']
        w = p.get('pct_white_2020') or 25
        b = p.get('pct_black_2020') or 25
        h = p.get('pct_hispanic_2020') or 25
        a = p.get('pct_asian_2020') or 5

        # 1970: more white, less hispanic/asian
        p['pct_white_1970'] = round(min(98, w + random.uniform(10, 25)), 1)
        p['pct_black_1970'] = round(max(1, b + random.uniform(-5, 5)), 1)
        p['pct_hispanic_1970'] = round(max(1, h * 0.5 + random.gauss(0, 3)), 1)
        p['pct_asian_1970'] = round(max(0, a * 0.2 + random.gauss(0, 1)), 1)

        # 1990: transitional
        p['pct_white_1990'] = round(min(95, w + random.uniform(5, 15)), 1)
        p['pct_black_1990'] = round(max(1, b + random.uniform(-3, 5)), 1)
        p['pct_hispanic_1990'] = round(max(1, h * 0.7 + random.gauss(0, 3)), 1)
        p['pct_asian_1990'] = round(max(0, a * 0.5 + random.gauss(0, 2)), 1)

        if p.get('population_2020') is None:
            p['population_2020'] = random.randint(1500, 12000)

    # Save updated files
    with open(income_file, 'w', encoding='utf-8') as f:
        json.dump(income_data, f)
    print(f"  Updated {income_file}")

    with open(race_file, 'w', encoding='utf-8') as f:
        json.dump(race_data, f)
    print(f"  Updated {race_file}")


def main():
    parser = argparse.ArgumentParser(description='Build synthetic historical census data')
    parser.add_argument('--city', required=True, help='City slug from cities.json')
    args = parser.parse_args()
    build_census(args.city)


if __name__ == '__main__':
    main()
