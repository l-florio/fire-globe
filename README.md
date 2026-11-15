# Fire Globe: harmonized MODIS and VIIRS fire activity

NASA Space Apps Challenge 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots".

Live app (published on 15 November 2026): https://l-florio.github.io/fire-globe/

Fire Globe turns the MODIS (2000-) and VIIRS (2012-) active-fire records of NASA FIRMS into harmonized series that can be compared across sensors and years, and lets anyone explore them on a 3D globe, for any area, with uncertainty intervals and exports.

## Results

Numbers are out of sample, against Aqua, 2013-2025, and can be re-run from the public data (`docs/validation/`):

- **Two harmonized series, one unit (detections, not burned area).** `long`: Aqua-equivalent MODIS 1 km detections from 2003-01, with 90% intervals. It is the Aqua record as observed up to 2021-12 (Aqua drifts in overpass time afterwards), continued with VIIRS converted to Aqua units from 2022-01 (and in 2020-08, an Aqua gap): the harmonization is what makes 2022-2026 comparable with 2003-2021. `detail`: VIIRS 375 m detections from 2013-01 at S-NPP level, harmonizing S-NPP, NOAA-20 and NOAA-21 (its band is the spread between satellites, not a confidence interval).
- **Two products:** 1 degree cell maps (`harm_map`) and regional monthly series by country and GFED region (`harm_region`).
- **Accuracy** (`docs/validation/error_summary.csv`): median annual difference from Aqua of 1.7% per GFED region and 0.3% for the world (leave-one-year-out, 2013-2020); calibrated on 2013-2020 and tested on 2021-2025 against Aqua as observed: 4.3% per GFED region (worst region-year 24%) and 2.0% for the world (worst year 3.1%). On single 1 degree cells: 11% (2013-2020) and 13% (2021-2025). World step at the 2022-01 seam (VIIRS converted against Aqua in 2021): +0.1%.
- **Intervals:** out-of-sample coverage of the 90% intervals is 88-93% across GFED regions, countries, continents and the world (table in `HARMONIZATION.md`).
- **Validation figures:** monthly series, annual scatter, 2022-01 seam and interval coverage, re-runnable with `python data_pipeline/validation/make_validation.py`: [docs/validation/](docs/validation/fig1_monthly_timeseries.png) (see "Validation figures" in `data_pipeline/HARMONIZATION.md`).
- **Trends:** in a development check not included in the public pipeline, per-country trends kept the sign of the single-sensor record in 89-90% of 136 countries (stress variant, VIIRS converted from 2013).

## How the harmonization works

1. Static sources (volcano, static, offshore) are masked with one rule for all sensors; the FIRMS `type` field is ignored.
2. VIIRS detections of one overpass in a ~1 km cell are clustered; each cluster weighs `F^2 / (F^2 + 10^2)` (F = summed FRP in MW), which mimics what a 1 km MODIS pixel detects. The daily VIIRS value is the mean of the satellites not in outage; NOAA-21 is scaled to NOAA-20.
3. VIIRS is converted to Aqua units with a ratio per 2.5 degree block x calendar month x day/night, shrunk toward the latitude band, plus a 1 degree cell term.
4. Calibration uses S-NPP against Aqua in 2013-2020, before Aqua's orbit drifted; nothing is recalibrated after 2020.
5. 90% intervals come from out-of-sample residuals, with a drift term after 2020.

Full method, validation and limits: [data_pipeline/HARMONIZATION.md](data_pipeline/HARMONIZATION.md). Code: `data_pipeline/harmonize.py` (fit once locally, apply nightly).

## Quick start

1. Open https://l-florio.github.io/fire-globe/ (no login).
2. In the left panel choose **Show: Harmonized** and the **long** series: one comparable unit from 2003 to today.
3. Click **Area fire calendar** and pick a large area (a country, continent or GFED region work best; the harmonized values live on 1 degree cells).
4. Read the month x year calendar: colour = value or anomaly against the median of the same month in the other years; a dot marks months whose 90% interval excludes the median.
5. Change the period, then **Export** the CSV (with the interval bounds) or a PNG.
6. Optional: switch the globe to **MODIS** and **VIIRS** side by side to see why the raw records are not comparable, or zoom in on a day to see single detections.

## Using the app

- **Globe:** MODIS, VIIRS, both (split compare) or Harmonized (long or detail series). Monthly and daily steps. Zoomed in, single detections are drawn and a list shows the detections in view.
- **Area fire calendar:** pick an area by place search (OpenStreetMap Nominatim), continent (Natural Earth), GFED region, drawn box, current view, or point plus radius. It shows a month x year calendar, the anomaly against the median of the same month in the other years, and the 90% interval for harmonized series. Export as CSV or PNG.
- **Data explorer (Table tab):** datasets, Excel-like column filters, a no-code builder, SQL on DuckDB-WASM, and charts.
- **Climatology (third tab):** for a continent, GFED region or country, the typical range (5-95%) of the 7-day total of fire detections for each day of the year (VIIRS S-NPP 2012-2025, validated at about 90% leave-one-year-out coverage) with the current year (NOAA-20, near-real-time days provisional) on top, plus PNG and CSV export. Descriptive, not a forecast. Linked from the Area fire calendar.
- **Export:** map as PNG, time animation as video (formats 16:9, 4:3, 1:1, 9:16, up to 4K).
- **Accessibility and languages:** keyboard use, colour-blind safe palette, high contrast, reduced motion, larger text; interface in 28 languages (English and Italian written by the team, the others machine-translated).

## Limits

- Harmonized values live on 1 degree cells: a small area counts every cell it overlaps, whole. Cell values are noisy (lower to upper bound factor of about 4); use regional totals for statements.
- Small fires get less weight in the Aqua-equivalent series (clusters under 10 MW are two thirds of VIIRS clusters but about a third of the weight). Regional trends can differ in sign (Middle East, Europe); the `detail` series keeps them.
- No harmonized series before 2003. FRP is not harmonized: counts only.
- After 2021, the checks quoted in `HARMONIZATION.md` use an Aqua corrected for its overpass shift, which is partly circular (VIIRS is the stable witness) and is not in the public pipeline; the public figures above compare with Aqua as observed, which includes its drift. The drift term in the intervals is an assumption.
- Reproducibility: `harmonize.py apply` (nightly) runs from the committed coefficients; `harmonize.py fit` also reads the 1 degree GFED region grid `diagnostica/gfed_regions_1deg.parquet`, built by `diagnostica/gfed_regions.py` from the GFED4.1s basis regions (Giglio et al. 2013).
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

Worldwide single detections (about 6.6 GB) exceed the Pages limit, so past years are a public Hugging Face dataset (https://huggingface.co/datasets/xlordx/fire-globe-detections) read directly by the browser with HTTP range requests; the current year of the active sensors is on Pages.

## References

- NASA FIRMS active fire data: MODIS Collection 6.1 (Terra, Aqua); VIIRS 375 m VNP14IMG (S-NPP), VJ114IMG (NOAA-20), VJ214IMG (NOAA-21). https://firms.modaps.eosdis.nasa.gov/
- NASA GIBS imagery (Blue Marble, Black Marble, VIIRS corrected reflectance, coastlines and labels). https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api
- Esri World Imagery and World Boundaries and Places (reference labels).
- OpenStreetMap contributors: basemap and Nominatim place search.
- Natural Earth: continent boundaries.
- GFED basis regions: Giglio, L., Randerson, J. T., van der Werf, G. R. (2013), Analysis of daily, monthly, and annual burned area using the fourth-generation Global Fire Emissions Database (GFED4), J. Geophys. Res. Biogeosci., 118.
- GFED5 burned area (Global Fire Emissions Database, version 5): compared during development only; not a validation of the published series (see data_pipeline/HARMONIZATION.md, Limits).
- Libraries: CesiumJS (Apache-2.0), DuckDB and DuckDB-WASM (MIT), Vite (MIT), Tabulator, Chart.js, html-to-image, TypeScript; Python: numpy, pandas, pyarrow, duckdb, requests, pillow.
- Viewer setup without Cesium ion inspired by gods-eye-view (MIT, Bilawal Sidhu); no code copied verbatim.

## License

Code: Apache License 2.0 (see `LICENSE` and `NOTICE`). Data keep the terms of their sources (see `NOTICE`).

## Use of AI

AI assistants (Claude by Anthropic, Codex by OpenAI) were used to write code, run analyses and draft documentation. Interface translations other than English and Italian are machine-made: a local open model (Qwen, via Ollama) for most languages, Claude Haiku for Swahili, Urdu, Bengali and Albanian. The harmonization method and the design choices were selected by the team from the tests; AI was not used to ideate the solution (Space Apps rule).
