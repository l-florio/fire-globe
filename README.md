# Fire Globe: harmonized MODIS and VIIRS fire activity

NASA Space Apps Challenge 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots".

Live app (published on 15 November 2026): https://l-florio.github.io/fire-globe/

Fire Globe turns the MODIS (2000-) and VIIRS (2012-) active-fire records of NASA FIRMS into harmonized series that can be compared across sensors and years, and lets anyone explore them on a 3D globe, for any area, with uncertainty intervals and exports.

## Results

Numbers come from `data_pipeline/HARMONIZATION.md` (out of sample, against Aqua, 2013-2025):

- **Two harmonized series, one unit (detections, not burned area).** `long`: Aqua-equivalent MODIS 1 km detections from 2003-01 (Aqua as observed to 2021-12, VIIRS converted to Aqua units after that and in 2020-08), with 90% intervals. `detail`: VIIRS 375 m detections from 2013-01 at S-NPP level, harmonizing S-NPP, NOAA-20 and NOAA-21 (its band is the spread between satellites, not a confidence interval).
- **Two products:** 1 degree cell maps (`harm_map`) and regional monthly series by country and GFED region (`harm_region`).
- **Accuracy:** annual totals differ from Aqua by 2% / 5% per GFED region and 1% / 3% for the world (leave-one-year-out 2013-2020 / calibrated 2013-2020 and tested 2021-2025). Step at the 2022-01 seam, world: below 1%. Correlation of annual totals with GFED5 burned area 2003-2020: 0.93.
- **Intervals:** out-of-sample coverage of the 90% intervals is 88-93% across GFED regions, countries, continents and the world (table in `HARMONIZATION.md`).
- **Trends:** per-country trends keep the sign of the single-sensor record in 89-90% of 136 countries (stress variant, VIIRS converted from 2013).

## How the harmonization works

1. Static sources (volcano, static, offshore) are masked with one rule for all sensors; the FIRMS `type` field is ignored.
2. VIIRS detections of one overpass in a ~1 km cell are clustered; each cluster weighs `F^2 / (F^2 + 10^2)` (F = summed FRP in MW), which mimics what a 1 km MODIS pixel detects. The daily VIIRS value is the mean of the satellites not in outage; NOAA-21 is scaled to NOAA-20.
3. VIIRS is converted to Aqua units with a ratio per 2.5 degree block x calendar month x day/night, shrunk toward the latitude band, plus a 1 degree cell term.
4. Calibration uses S-NPP against Aqua in 2013-2020, before Aqua's orbit drifted; nothing is recalibrated after 2020.
5. 90% intervals come from out-of-sample residuals, with a drift term after 2020.

Full method, validation and limits: [data_pipeline/HARMONIZATION.md](data_pipeline/HARMONIZATION.md). Code: `data_pipeline/harmonize.py` (fit once locally, apply nightly).

## Using the app

- **Globe:** MODIS, VIIRS, both (split compare) or Harmonized (long or detail series). Monthly and daily steps. Zoomed in, single detections are drawn and a list shows the detections in view.
- **Area fire calendar:** pick an area by place search (OpenStreetMap Nominatim), continent (Natural Earth), GFED region, drawn box, current view, or point plus radius. It shows a month x year calendar, the anomaly against the median of the same month in the other years, and the 90% interval for harmonized series. Export as CSV or PNG.
- **Data explorer (Table tab):** datasets, Excel-like column filters, a no-code builder, SQL on DuckDB-WASM, and charts.
- **Climatology (third tab):** for a continent, GFED region or country, the typical range (5-95%) of the 7-day total of fire detections for each day of the year (VIIRS S-NPP 2012-2025, validated at about 90% leave-one-year-out coverage) with the current year (NOAA-20, near-real-time days provisional) on top, plus PNG and CSV export. Descriptive, not a forecast. Linked from the Area fire calendar.
- **Export:** map as PNG, time animation as video. The interface is in English and Italian.

## Limits

- Harmonized values live on 1 degree cells: a small area counts every cell it overlaps, whole. Cell values are noisy (lower to upper bound factor of about 4); use regional totals for statements.
- Small fires get less weight in the Aqua-equivalent series (clusters under 10 MW are two thirds of VIIRS clusters but about a third of the weight). Regional trends can differ in sign (Middle East, Europe); the `detail` series keeps them.
- No harmonized series before 2003. FRP is not harmonized: counts only.
- After 2021, checks use an Aqua corrected for its overpass shift, which is partly circular (VIIRS is the stable witness). The drift term in the intervals is an assumption.
- 2026 data are partly near-real-time and can be revised; the newest month is partial. S-NPP ended on 2026-11-02; the measured step at that seam rests on 11 days of data and must be recomputed.

## Structure

| Folder | What it does |
|---|---|
| `data_pipeline/` | FIRMS download and normalization to Parquet (`firms_pipeline.py`); harmonization (`harmonize.py`, `HARMONIZATION.md`) |
| `globe_kit/` | Web app (Vite, TypeScript, CesiumJS, DuckDB-WASM). `src/globe` is a reusable globe library; `src/app` is the fire app |
| `globe_kit/scripts/` | Builds the data published with the site: monthly frames, Parquet for the browser |
| `globe_kit/server/` | Optional local data service (DuckDB) for development |
| `site_data/` | Historical part of the published data, built locally |
| `.github/workflows/pages.yml` | Nightly update of the current year, harmonization and deploy to GitHub Pages |

## Run locally

```bash
cd globe_kit && npm install && npm run dev
```

The app reads the static Parquet files in `globe_kit/public/data` with DuckDB-WASM (see `globe_kit/README.md` to build them). Optionally start the local data service: `python globe_kit/server/fire_api.py`. To regenerate the harmonized series, see `data_pipeline/README.md`.

## Data updates

The site is static (GitHub Pages, no server). Historical data are built once and committed in `site_data/`. A GitHub Action runs every night: it downloads the current year from the FIRMS API (repository secret `FIRMS_MAP_KEY`), applies the frozen harmonization (`harmonize.py apply`), rebuilds the recent part, merges it with the historical part and publishes. Standard-processing data replace near-real-time data when available.

Worldwide single detections (about 4 GB) exceed the Pages limit, so past years are a public Hugging Face dataset (https://huggingface.co/datasets/xlordx/fire-globe-detections) read directly by the browser with HTTP range requests; the current year of the active sensors is on Pages.

## References

- NASA FIRMS active fire data: MODIS Collection 6.1 (Terra, Aqua); VIIRS 375 m VNP14IMG (S-NPP), VJ114IMG (NOAA-20), VJ214IMG (NOAA-21). https://firms.modaps.eosdis.nasa.gov/
- NASA GIBS imagery (Blue Marble, Black Marble, VIIRS corrected reflectance, coastlines and labels). https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api
- Esri World Imagery and World Boundaries and Places (reference labels).
- OpenStreetMap contributors: basemap and Nominatim place search.
- Natural Earth: continent boundaries.
- GFED basis regions: Giglio, L., Randerson, J. T., van der Werf, G. R. (2013), Analysis of daily, monthly, and annual burned area using the fourth-generation Global Fire Emissions Database (GFED4), J. Geophys. Res. Biogeosci., 118.
- GFED5 burned area (Global Fire Emissions Database, version 5): used only to check annual totals, 2003-2020.
- Libraries: CesiumJS (Apache-2.0), DuckDB and DuckDB-WASM (MIT), Vite (MIT), Tabulator, Chart.js, html-to-image, TypeScript; Python: numpy, pandas, pyarrow, duckdb, requests, pillow.
- Viewer setup without Cesium ion inspired by gods-eye-view (MIT, Bilawal Sidhu); no code copied verbatim.

## License

Code: Apache License 2.0 (see `LICENSE` and `NOTICE`). Data keep the terms of their sources (see `NOTICE`).

## Use of AI

AI assistants (Claude by Anthropic, Codex by OpenAI) were used to write code, run analyses and draft documentation. The harmonization method and the design choices were selected by the team from the tests; AI was not used to ideate the solution (Space Apps rule).
