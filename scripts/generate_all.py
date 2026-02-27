"""
Batch generate data for all cities in cities.json.

Usage:
  python generate_all.py                     # All cities, skip floods
  python generate_all.py --featured-only     # Only featured cities
  python generate_all.py --floods-only       # Only flood data for featured cities
  python generate_all.py --include-floods    # All cities including floods
"""

import json
import argparse
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.join(SCRIPT_DIR, '..')
CITIES_FILE = os.path.join(ROOT_DIR, 'data', 'cities.json')

sys.path.insert(0, SCRIPT_DIR)

from generate_city import generate_city
from fetch_flood_zones import fetch_flood_zones


def main():
    parser = argparse.ArgumentParser(description='Generate data for all cities')
    parser.add_argument('--featured-only', action='store_true', help='Only process featured cities')
    parser.add_argument('--include-floods', action='store_true', help='Include flood zone fetching')
    parser.add_argument('--floods-only', action='store_true', help='Only fetch floods for featured cities')
    parser.add_argument('--api-key', default=None, help='Census API key')
    parser.add_argument('--start-from', default=None, help='Resume from this city slug')
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get('CENSUS_API_KEY')

    with open(CITIES_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)

    cities = config.get('cities', {})
    slugs = sorted(cities.keys(), key=lambda s: cities[s]['label'])

    # Filter
    if args.featured_only or args.floods_only:
        slugs = [s for s in slugs if cities[s].get('featured')]

    # Resume
    if args.start_from:
        try:
            idx = slugs.index(args.start_from)
            slugs = slugs[idx:]
            print(f"Resuming from: {args.start_from}")
        except ValueError:
            print(f"WARNING: '{args.start_from}' not found, processing all")

    total = len(slugs)
    print(f"Processing {total} cities...")
    print()

    start = time.time()
    successes = 0
    failures = []

    for i, slug in enumerate(slugs, 1):
        city = cities[slug]
        print(f"\n[{i}/{total}] {city['label']}, {city['state']} ({slug})")

        if args.floods_only:
            try:
                fetch_flood_zones(slug)
                successes += 1
            except Exception as e:
                print(f"  FAILED: {e}")
                failures.append(slug)
        else:
            try:
                generate_city(
                    slug,
                    skip_floods=not args.include_floods,
                    api_key=api_key,
                )
                successes += 1
            except Exception as e:
                print(f"  FAILED: {e}")
                failures.append(slug)

        # Rate limiting between cities
        if i < total:
            time.sleep(2)

    elapsed = time.time() - start
    print(f"\n{'='*60}")
    print(f"  Batch complete: {successes}/{total} succeeded in {elapsed:.0f}s")
    if failures:
        print(f"  Failed: {', '.join(failures)}")
    print(f"{'='*60}")


if __name__ == '__main__':
    main()
