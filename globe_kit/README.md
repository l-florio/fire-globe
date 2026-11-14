# globe-kit

Web app of the Fire Globe project (NASA Space Apps Challenge 2026, "Harmonization of MODIS and VIIRS Hot Spots") and the reusable CesiumJS globe library it is built on. Project overview: `../README.md`. Method: `../data_pipeline/HARMONIZATION.md`.

## What the app does

- **Globe modes:** MODIS, VIIRS, both (split compare), Harmonized (Aqua-equivalent long series from 2003, VIIRS 375 m detail series from 2013). Monthly and daily steps.
- **Single detections:** below 2,500 km of camera height, colored by FRP, with a list of the detections in view. Overpass filters (day/night, Terra/Aqua). Not available for the harmonized series.
- **Area fire calendar:** area by place search (OpenStreetMap Nominatim), continent (Natural Earth), GFED region, drawn box, current view, or point plus radius. Month x year calendar; color by value (log) or anomaly (ratio to the median of the same month in the other years); 90% interval for harmonized series; the current month is partial and excluded from medians. CSV and PNG export.
- **Data explorer (Table tab):** datasets (harmonized regions, harmonized 1 degree grid, raw 0.25 degree grid, single detections), Excel-like filters, no-code builder, SQL on DuckDB-WASM, charts.
- **Export:** map PNG and time-animation video. English and Italian UI.

Harmonized values are on 1 degree cells (small areas count whole cells) and are detections, not burned area.

## Run

```bash
npm install
npm run dev        # http://localhost:5199
npm run static     # build + preview on 5197, no data service: simulates the published site
npm run build      # tsc + vite build, writes dist/
```

Optional local data service (DuckDB over `data_pipeline/data/parquet`; Vite proxies `/api` to 127.0.0.1:5198):

```bash
python server/fire_api.py
```

Without the service the app uses static data: DuckDB-WASM queries the Parquet files in `public/data/` with HTTP range requests. Day steps and single detections then need static points for the region in view.

## Build the site data

`public/data/` and `public/frames/` are generated and excluded from git. Python: `pip install -r scripts/requirements.txt`.

| Script | Purpose |
|---|---|
| `scripts/make_fire_frames.py` | Monthly PNG frames per sensor and metric from the 0.25 degree grid; `--harmonized <harm_map.parquet>` adds the harmonized series (own color scale) |
| `scripts/make_static_data.py` | Parquet for the browser: grids, regions, interval table, single detections (`--region`, `--points-sensors`, `--harmonized`) |
| `scripts/assemble_site.py` | Merges the historical part (`site_data/`) and the recent part into `public/` |
| `scripts/check_site.py` | Consistency checks of the assembled data |
| `scripts/make_continents.py` | Continent cells (Natural Earth) for the calendar |

Historical part: built once locally with `--to-year 2025 --tag hist` and committed in `site_data/`. Recent part: built nightly by `.github/workflows/pages.yml` with `--from-year 2026 --tag recent` after `harmonize.py apply`. Worldwide single detections of past years are hosted on a Hugging Face dataset (repository variable `POINTS_BASE`); without it, only Europe and the Mediterranean are available.

## Library (`src/globe`)

No account and no token needed: NASA GIBS basemaps, no Cesium ion.

| Module | Purpose |
|---|---|
| `createGlobe.ts` | Viewer without ion: no Bing, geocoder or ion terrain. Render on demand, zoom limits, basemap and overlay switching |
| `basemaps.ts` | NASA GIBS (Blue Marble, Black Marble, VIIRS true color), Esri World Imagery, OSM; overlays: GIBS coastlines, borders, labels, Esri labels |
| `timeRaster.ts` | `TimeRasterLayer`: one equirectangular 8-bit PNG per time key, colored in the browser; split direction, LRU cache, prefetch |
| `pointLayer.ts` | Many points with a color ramp, fast show/hide filter, split direction; `viewRectangle`, `cameraHeight` helpers |
| `controls.ts` | Split divider, time slider, legend |
| `colormaps.ts` | Ramps `fire`, `viridis`, `diverging` |
| `areaPicker.ts`, `calendar.ts`, `cells.ts` | Area selection and month x year calendar heatmap (any monthly series) |

```ts
import { createGlobe, TimeRasterLayer, createTimeSlider } from './globe';
const globe = createGlobe({ container: 'globe', basemap: 'gibs-bluemarble', overlays: ['gibs-coastlines'] });
const layer = new TimeRasterLayer(globe.viewer, { frameUrl: (k) => `frames/${k}.png`, keys });
createTimeSlider(el, { keys, onChange: (k) => layer.show(k) });
```

Frame format: grayscale PNG, row 0 = north, column 0 = 180 W; 0 = no data; 1..255 = `round(255 * log1p(x) / log1p(max))`.

## Notes

- Versions are pinned: `cesium` 1.147.0 (with 1.146.0 the caret dependencies install an incompatible `@cesium/engine` 26.5), `vite` 8.3.8.
- GIBS is used through the Web Mercator endpoints (`epsg3857`); the EPSG:4326 endpoints use a 288 degree level-0 tile that does not match Cesium's tiling.
- `Reference_Features_15m` is drawn only at higher zoom; at global scale use `Coastlines_15m`.

## Credits

CesiumJS (Apache-2.0); NASA GIBS; Esri; OpenStreetMap contributors; Natural Earth; NASA FIRMS (MODIS C6.1, VIIRS 375 m); DuckDB-WASM, Tabulator, Chart.js, html-to-image. Viewer setup without ion inspired by [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (MIT, Bilawal Sidhu); no code copied verbatim. Full list: `../README.md`.

## Use of AI

AI assistants (Claude, Codex) were used to write code, run analyses and draft documentation. The method and design choices were selected by the team from the tests; AI was not used to ideate the solution.
