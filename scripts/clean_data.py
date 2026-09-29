"""
Rebuild every city's published layers from real sources only.

Usage: python clean_data.py            (all cities)
       python clean_data.py --city nyc (one city)

What it does, per city:
  1. Redlining: rebuilds redlining.geojson from the Mapping Inequality
     census-tract crosswalk (data/holc_national.geojson), dissolving the
     tract-split fragments back into one polygon per HOLC area (area_id) and
     normalising grades ("A " -> "A"; non A-D values -> null).
  2. Census: keeps only the real ACS 2018-2022 values. Removes the synthetic
     1970-2010 fields that build_census.py used to generate, and blanks values
     that can't be trusted (tracts with <50 residents, and special land-use
     tracts 98xx/99xx, where ACS suppresses medians and the old pipeline
     filled in random numbers).
  3. TRI: keeps facility name/location/industry/id only. Removes the
     placeholder release totals, carcinogen flag, chemical and risk score,
     and drops facilities outside the city's bounding box.
  4. Updates each city's "layers" list in cities.json to what actually has data.

Requires: shapely (pip install shapely)
"""

import argparse
import json
import os
from collections import defaultdict

from shapely.geometry import shape, mapping
from shapely.ops import unary_union

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(SCRIPT_DIR, '..')
DATA = os.path.join(ROOT, 'data')
CITIES_FILE = os.path.join(DATA, 'cities.json')
HOLC_FILE = os.path.join(DATA, 'holc_national.geojson')
HOLC_URL = ("https://raw.githubusercontent.com/americanpanorama/"
            "mapping-inequality-census-crosswalk/main/MIv3Areas_2010TractCrosswalk.geojson")

KEEP_HOLC = ['area_id', 'city', 'state', 'city_survey', 'cat', 'grade', 'label', 'res', 'com', 'ind']
HISTORICAL_KEYS = [
    'income_1970', 'income_1980', 'income_1990', 'income_2000', 'income_2010',
    'pct_white_1970', 'pct_black_1970', 'pct_hispanic_1970', 'pct_asian_1970',
    'pct_white_1990', 'pct_black_1990', 'pct_hispanic_1990', 'pct_asian_1990',
]
RACE_KEYS = ['pct_white_2020', 'pct_black_2020', 'pct_hispanic_2020', 'pct_asian_2020',
             'dominant_group_2020', 'diversity_index_2020']

# Tracts whose income_2020 was confirmed synthetic by cross-checking the two
# independently generated Houston files (values disagreed; ACS had suppressed them).
KNOWN_SYNTHETIC_INCOME = {
    '48201980400', '48201312901', '48201340201', '48201980000', '48201432302',
    '48201324102', '48201241503', '48201252602', '48201980300', '48201343601',
    '48201980100',
}


def round_coords(obj, nd=5):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], nd), round(obj[1], nd)]
        return [round_coords(o, nd) for o in obj]
    return obj


def norm_grade(g):
    if g is None:
        return None
    g = str(g).strip().upper()
    return g if g in ('A', 'B', 'C', 'D') else None


def load_holc_index():
    if not os.path.exists(HOLC_FILE):
        raise SystemExit(f"Missing {HOLC_FILE}. Download it from:\n  {HOLC_URL}")
    with open(HOLC_FILE, encoding='utf-8') as f:
        nat = json.load(f)
    idx = defaultdict(list)
    for feat in nat['features']:
        p = feat['properties']
        idx[(p.get('city'), p.get('state'))].append(feat)
    return idx


def dissolve(features):
    by_area = defaultdict(list)
    for f in features:
        by_area[f['properties']['area_id']].append(f)
    out = []
    for area_id, parts in by_area.items():
        geoms = [shape(p['geometry']).buffer(0) for p in parts if p.get('geometry')]
        merged = unary_union(geoms).buffer(0)
        if merged.is_empty:
            continue
        props = {k: parts[0]['properties'].get(k) for k in KEEP_HOLC}
        props['grade'] = norm_grade(props['grade'])
        props['label'] = (props.get('label') or '').strip() or None
        props['cat'] = (props.get('cat') or '').strip() or None
        props['holc_grade'] = props['grade']
        out.append({'type': 'Feature', 'properties': props,
                    'geometry': round_coords(mapping(merged))})
    out.sort(key=lambda f: (f['properties']['grade'] or 'Z', f['properties']['label'] or ''))
    return out


def clean_census(city_dir, slug):
    changed = {}
    inc_path = os.path.join(city_dir, 'income.geojson')
    race_path = os.path.join(city_dir, 'race.geojson')
    for path, kind in ((inc_path, 'income'), (race_path, 'race')):
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        for feat in data['features']:
            if feat.get('geometry'):
                feat['geometry']['coordinates'] = round_coords(feat['geometry']['coordinates'])
            p = feat['properties']
            for k in HISTORICAL_KEYS:
                p.pop(k, None)
            p.pop('is_sample_data', None)
            name = p.get('name') or ''
            if name.startswith('Tract Census Tract'):
                p['name'] = name.replace('Tract Census Tract', 'Census Tract', 1)
            elif name.startswith('Tract '):
                p['name'] = 'Census Tract ' + name[len('Tract '):]
            tract = str(p.get('tract_id', ''))
            pop = p.get('population_2020')
            special = tract[5:7] in ('98', '99')
            untrusted = pop is None or pop < 50
            if kind == 'income':
                if untrusted or special or tract in KNOWN_SYNTHETIC_INCOME:
                    p['income_2020'] = None
                if untrusted:
                    p['poverty_rate_2020'] = None
            else:
                if untrusted:
                    for k in RACE_KEYS:
                        p[k] = None
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        changed[kind] = len(data['features'])
    return changed


def clean_tri(city_dir, bbox):
    path = os.path.join(city_dir, 'tri_sites.geojson')
    if not os.path.exists(path):
        return 0
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    x0, y0, x1, y1 = bbox
    out = []
    for feat in data['features']:
        lon, lat = feat['geometry']['coordinates'][:2]
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        p = feat['properties']
        feat['properties'] = {
            'facility_name': (p.get('facility_name') or '').strip() or None,
            'industry': (p.get('industry') or '').strip() or None,
            'tri_facility_id': p.get('tri_facility_id') or None,
        }
        out.append(feat)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection', 'features': out}, f)
    return len(out)


def has_features(path):
    if not os.path.exists(path):
        return False
    with open(path, encoding='utf-8') as f:
        return len(json.load(f).get('features', [])) > 0


LAYER_FILES = {
    'redlining': 'redlining.geojson', 'highways': 'highways.geojson',
    'income': 'income.geojson', 'race': 'race.geojson',
    'floods': 'flood_zones.geojson', 'pollution': 'tri_sites.geojson',
    'political': 'political.geojson',
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--city')
    args = ap.parse_args()

    with open(CITIES_FILE, encoding='utf-8') as f:
        config = json.load(f)
    cities = config['cities']
    holc = load_holc_index()

    slugs = [args.city] if args.city else sorted(cities)
    for slug in slugs:
        c = cities[slug]
        city_dir = os.path.join(DATA, 'cities', slug)
        os.makedirs(city_dir, exist_ok=True)

        feats = []
        for name in c['holcCities']:
            feats.extend(holc.get((name, c['state']), []))
        if feats:
            red = dissolve(feats)
            with open(os.path.join(city_dir, 'redlining.geojson'), 'w', encoding='utf-8') as f:
                json.dump({'type': 'FeatureCollection', 'features': red}, f)
            c['citySurvey'] = any(f['properties'].get('city_survey') for f in red)
        else:
            print(f"  WARNING {slug}: no HOLC areas for {c['holcCities']} / {c['state']}")

        clean_census(city_dir, slug)
        n_tri = clean_tri(city_dir, c['bbox'])

        layers = [l for l, fn in LAYER_FILES.items() if has_features(os.path.join(city_dir, fn))]
        c['layers'] = layers
        print(f"{slug:40s} layers={','.join(layers)} tri={n_tri}")

    with open(CITIES_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)


if __name__ == '__main__':
    main()
