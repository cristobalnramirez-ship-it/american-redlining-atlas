"""
Master pipeline: generate all data for one city.

Usage: python generate_city.py --city <slug> [--skip-floods] [--api-key KEY]

Runs in order:
  1. fetch_redlining.py
  2. fetch_census.py
  3. build_census.py (synthetic history)
  4. fetch_real_census.py (real ACS 2020 overlay)
  5. fetch_tri.py
  6. fetch_flood_zones.py (optional, slow)
"""

import argparse
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from fetch_redlining import fetch_redlining
from fetch_census import fetch_census
from build_census import build_census
from fetch_real_census import fetch_real_census
from fetch_tri import fetch_tri
from fetch_flood_zones import fetch_flood_zones


def generate_city(slug, skip_floods=False, api_key=None):
    print(f"{'='*60}")
    print(f"  Generating data for: {slug}")
    print(f"{'='*60}")
    start = time.time()

    # 1. Redlining
    print(f"\n--- Step 1/6: Redlining ---")
    try:
        fetch_redlining(slug)
    except Exception as e:
        print(f"  ERROR: {e}")

    # 2. Census geometry + basic ACS
    print(f"\n--- Step 2/6: Census tracts ---")
    try:
        fetch_census(slug, api_key=api_key)
    except Exception as e:
        print(f"  ERROR: {e}")

    # 3. Synthetic historical data
    print(f"\n--- Step 3/6: Synthetic history ---")
    try:
        build_census(slug)
    except Exception as e:
        print(f"  ERROR: {e}")

    # 4. Real ACS overlay
    print(f"\n--- Step 4/6: Real ACS data ---")
    try:
        fetch_real_census(slug, api_key=api_key)
    except Exception as e:
        print(f"  ERROR: {e}")

    # 5. TRI pollution
    print(f"\n--- Step 5/6: TRI pollution ---")
    try:
        fetch_tri(slug)
    except Exception as e:
        print(f"  ERROR: {e}")

    # 6. Flood zones (optional)
    if skip_floods:
        print(f"\n--- Step 6/6: Flood zones (SKIPPED) ---")
    else:
        print(f"\n--- Step 6/6: Flood zones ---")
        try:
            fetch_flood_zones(slug)
        except Exception as e:
            print(f"  ERROR: {e}")

    elapsed = time.time() - start
    print(f"\n{'='*60}")
    print(f"  Done: {slug} ({elapsed:.1f}s)")
    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(description='Generate all data for one city')
    parser.add_argument('--city', required=True, help='City slug from cities.json')
    parser.add_argument('--skip-floods', action='store_true', help='Skip slow FEMA flood fetch')
    parser.add_argument('--api-key', default=None, help='Census API key')
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get('CENSUS_API_KEY')
    generate_city(args.city, skip_floods=args.skip_floods, api_key=api_key)


if __name__ == '__main__':
    main()
