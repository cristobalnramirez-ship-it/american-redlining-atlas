# American Redlining Atlas

HOLC ("redlining") maps for 315 U.S. places, layered with current Census income and race data and EPA Toxics Release Inventory facility locations. New York City and Houston are featured with curated highway histories, timelines and political districts (plus FEMA floodplains for Houston).

Link to a city with its slug, e.g. `index.html#houston` or `index.html#chicago_il`.

## Run it

```bash
python -m http.server 8000   # fetch() doesn't work from file://
# open http://localhost:8000
```

## Data

| Layer | Source | Notes |
|---|---|---|
| HOLC redlining | [Mapping Inequality](https://dsl.richmond.edu/panorama/redlining/) (Nelson, Winling et al., University of Richmond; CC BY-NC-SA 4.0), via its [census-tract crosswalk](https://github.com/americanpanorama/mapping-inequality-census-crosswalk) | Tract-split pieces are dissolved back into one polygon per HOLC area. Maps were drawn 1935–1940; exact years are shown only where verified (NYC 1938, Houston 1937). 98 places come from maps outside HOLC's standard City Survey and use their own categories. |
| Income, poverty, race & ethnicity | U.S. Census Bureau ACS 2018–2022 5-year, by tract | Suppressed values, tracts with under 50 residents, and special land-use tracts (98xx/99xx) show "No data". Not available for Connecticut cities (2022 planning-region change) or a few misconfigured places; those toggles are hidden. |
| TRI facilities | EPA TRI facility registry | Locations, names and industry only; clipped to each city's map area. |
| Featured-city history | Sources linked on every highway and timeline card | NYC: nycroads.com, NYC agencies, Furman Center. Houston: Baker Institute, Houston Freeways, NHC, HCFCD. |
| Political districts (featured) | Census TIGERweb and city/county boundaries; officeholders in `data/officeholders.json` | As of 2026-09-27. Unknown officeholders are never assigned a party. |

**Removed in the Sept 2026 audit:** modeled 1970–2010 census values, placeholder TRI release totals/carcinogen flags/risk scores, hand-drawn NYC flood rectangles, and Houston's sample-data Capital Flow layer. None of these were real data.

## Rebuilding data

```bash
pip install shapely
curl -L -o data/holc_national.geojson \
  https://raw.githubusercontent.com/americanpanorama/mapping-inequality-census-crosswalk/main/MIv3Areas_2010TractCrosswalk.geojson
cd scripts
python generate_city.py --city chicago_il --api-key YOUR_CENSUS_KEY   # one city
python clean_data.py                                                   # re-clean all cities
```

The pipeline never generates sample or placeholder values; if a source fails, that layer is left out.

## Credits

Redlining data © Mapping Inequality, CC BY-NC-SA 4.0 (credited on the map). Basemap © OpenStreetMap contributors © CARTO. Census and EPA data are U.S. government works. Built with Leaflet, chroma.js and noUiSlider.
