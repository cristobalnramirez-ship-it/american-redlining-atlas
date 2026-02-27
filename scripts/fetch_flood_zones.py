"""
Fetch FEMA flood zone data for a city.

Usage: python fetch_flood_zones.py --city <slug>

Reads bbox from cities.json. Queries FEMA NFHL ArcGIS REST API.
No API key required. This can be slow (~20 min per city).
"""

import json
import urllib.request
import urllib.parse
import argparse
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.join(SCRIPT_DIR, '..')
DATA_DIR = os.path.join(ROOT_DIR, 'data')
CITIES_FILE = os.path.join(DATA_DIR, 'cities.json')

# FEMA NFHL MapServer — Layer 28 = S_FLD_HAZ_AR (Flood Hazard Areas)
FEMA_URL = (
    "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query"
)


def load_city_config(slug):
    with open(CITIES_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)
    city = config['cities'].get(slug)
    if not city:
        raise ValueError(f"City '{slug}' not found in cities.json")
    return city


def classify_zone(properties):
    """Add human-readable flood risk classification."""
    zone = properties.get('FLD_ZONE', '')

    if zone in ('A', 'AE', 'AH', 'AO', 'A99'):
        properties['flood_risk'] = 'high'
        properties['zone'] = zone
        properties['zone_description'] = '1% annual chance flood (100-year floodplain)'
    elif zone in ('V', 'VE'):
        properties['flood_risk'] = 'coastal'
        properties['zone'] = zone
        properties['zone_description'] = 'Coastal high hazard area with wave action'
    elif zone == 'X':
        subtype = (properties.get('ZONE_SUBTY') or '').upper()
        if 'SHADED' in subtype or '500' in subtype:
            properties['flood_risk'] = 'moderate'
            properties['zone'] = 'X500'
            properties['zone_description'] = '0.2% annual chance flood (500-year floodplain)'
        else:
            properties['flood_risk'] = 'minimal'
            properties['zone'] = 'X'
            properties['zone_description'] = 'Minimal flood hazard area'
    else:
        properties['flood_risk'] = 'minimal'
        properties['zone'] = zone or 'Unknown'
        properties['zone_description'] = 'Minimal flood hazard area'

    return properties


def fetch_tile(bbox_str, offset=0, page_size=1000):
    """Fetch a page of flood zone features for a bbox tile."""
    params = {
        'where': '1=1',
        'geometry': bbox_str,
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'outFields': 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH',
        'returnGeometry': 'true',
        'outSR': '4326',
        'f': 'geojson',
        'resultOffset': str(offset),
        'resultRecordCount': str(page_size),
    }

    url = FEMA_URL + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read().decode('utf-8'))


def fetch_flood_zones(slug):
    config = load_city_config(slug)
    bbox = config['bbox']  # [minLon, minLat, maxLon, maxLat]

    print(f"Fetching FEMA flood zones for {config['label']}, {config['state']}")
    print(f"  Bounding box: {bbox}")

    # Tile the bbox into smaller tiles to avoid FEMA API limits
    tile_size = 0.15  # degrees
    all_features = []
    tile_num = 0

    lon = bbox[0]
    while lon < bbox[2]:
        lat = bbox[1]
        while lat < bbox[3]:
            tile_bbox = f"{lon},{lat},{min(lon + tile_size, bbox[2])},{min(lat + tile_size, bbox[3])}"
            tile_num += 1

            offset = 0
            while offset < 10000:
                try:
                    data = fetch_tile(tile_bbox, offset, 1000)
                    features = data.get('features', [])
                except Exception as e:
                    print(f"    Tile {tile_num} error: {e}")
                    break

                if not features:
                    break

                for f in features:
                    f['properties'] = classify_zone(f['properties'])

                all_features.extend(features)

                if len(features) < 1000:
                    break
                offset += 1000

            lat += tile_size
        lon += tile_size

    print(f"  Total features: {len(all_features)} from {tile_num} tiles")

    # Filter out minimal risk zones to reduce size
    significant = [f for f in all_features if f['properties'].get('flood_risk') != 'minimal']
    print(f"  Significant risk features: {len(significant)}")

    geojson = {
        'type': 'FeatureCollection',
        'features': significant,
    }

    # Save
    out_dir = os.path.join(DATA_DIR, 'cities', slug)
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, 'flood_zones.geojson')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(geojson, f)

    print(f"Saved to {out_file}")


def main():
    parser = argparse.ArgumentParser(description='Fetch FEMA flood zone data for a city')
    parser.add_argument('--city', required=True, help='City slug from cities.json')
    args = parser.parse_args()
    fetch_flood_zones(args.city)


if __name__ == '__main__':
    main()
