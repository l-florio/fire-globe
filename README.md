# Fire Globe: harmonized MODIS and VIIRS fire activity

NASA Space Apps Challenge 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots".

A web app to explore 25 years of satellite fire detections (NASA FIRMS), with three views:
- **Globe:** monthly fire activity, MODIS and VIIRS side by side.
- **Single detections:** shown when zooming in or stepping day by day.
- **Area fire calendar:** year x month calendar for any area, anomalies against the historical median, CSV export.

Status: the MODIS/VIIRS harmonization is in progress; the app currently shows raw values per sensor.

## Structure

| Folder | What it does |
|---|---|
| `data_pipeline/` | Downloads the NASA FIRMS archive (yearly files) and the current year (FIRMS API, MAP_KEY). Normalizes everything to Parquet and builds grid aggregates (0.25 deg x month) |
| `globe_kit/` | Web app (Vite, TypeScript, CesiumJS, DuckDB-WASM). `src/globe` is a reusable globe library; `src/app` is the fire app |
| `globe_kit/scripts/` | Builds the data published with the site: monthly frames, Parquet for the browser |
| `globe_kit/server/` | Optional local data service (DuckDB) with the full archive |
| `site_data/` | Historical part of the published data, built locally |
| `.github/workflows/pages.yml` | Nightly update of the current year and deploy to GitHub Pages |

## Run locally

```bash
cd globe_kit && npm install && npm run dev
```

With the full archive, also start the local data service: `python globe_kit/server/fire_api.py`. Without it, the app reads the static Parquet files in `globe_kit/public/data` with DuckDB-WASM.

## Data updates

- **Historical part:** built once from the FIRMS archive and committed in `site_data/`.
- **Current year:** a GitHub Action, every night:
  1. downloads it from the FIRMS API (repository secret `FIRMS_MAP_KEY`);
  2. rebuilds it;
  3. merges it with the historical part;
  4. publishes the site.

  Standard-processing data replace near-real-time data as soon as they are available.

**Single detections worldwide.** They take about 4 GB, more than GitHub Pages allows, so they are hosted as a public Hugging Face dataset. The browser reads them directly with range requests.

| Part | Where | How it is updated |
|---|---|---|
| Past years | Hugging Face dataset; `site_data/external_points/static.json` lists the files | once: build them with `make_static_data.py --skip-grid --region=-180,-90,180,90 --out site_data/external_points`, upload `site_data/external_points/points` to the dataset, then set the repository variable `POINTS_BASE` to `https://huggingface.co/datasets/<user>/<dataset>/resolve/main/` |
| Current year (active sensors) | on Pages | the nightly workflow |
| Without `POINTS_BASE` | Europe and the Mediterranean only | - |

## Data and credits

- NASA FIRMS active fire data: MODIS Collection 6.1 (Terra, Aqua), VIIRS 375 m (Suomi NPP, NOAA-20, NOAA-21). https://firms.modaps.eosdis.nasa.gov/
- Basemaps:
  - NASA GIBS (Blue Marble, Black Marble, VIIRS corrected reflectance);
  - Esri World Imagery and World Boundaries and Places;
  - OpenStreetMap contributors.
- Libraries:
  - CesiumJS (Apache 2.0);
  - DuckDB and DuckDB-WASM (MIT);
  - Vite (MIT).
- Viewer setup without Cesium ion inspired by gods-eye-view (MIT, Bilawal Sidhu).

## License

Code: Apache License 2.0 (see `LICENSE` and `NOTICE`). Data keep the terms of their sources (see `NOTICE`).

## Use of AI

Code in this repository was written with the assistance of Claude (Anthropic), as required by the Space Apps rules on AI disclosure. The method choices and the product design are the team's.
