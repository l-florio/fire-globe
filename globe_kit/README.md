# globe-kit

Reusable CesiumJS globe, with a demo app: monthly NASA FIRMS active fires 2000-2026, comparing two sensors side by side.

SI disclosure: code generated with the assistance of Claude (Anthropic). Declare it in the submission and in the repo metadata.

## Library (`src/globe`)

No account and no token needed: NASA GIBS basemaps, no Cesium ion.

| Module | Purpose |
|---|---|
| `createGlobe.ts` | Viewer without ion: no Bing, no geocoder, no ion terrain. Render on demand, zoom limits, basemap and overlay switching |
| `basemaps.ts` | Basemaps:<br>- NASA GIBS: Blue Marble, Black Marble, daily VIIRS true color;<br>- Esri World Imagery;<br>- OSM.<br>Overlays: GIBS coastlines, borders, labels |
| `timeRaster.ts` | `TimeRasterLayer`: one equirectangular 8-bit PNG per time key, colored in the browser. Palette and range change without regenerating data. Also handles the split direction, an LRU cache and prefetch |
| `controls.ts` | Split divider (`scene.splitPosition`), time slider (play, speed, arrow keys), legend |
| `colormaps.ts` | Ramps `fire`, `viridis`, `diverging`, lookup tables, CSS gradients |

Minimal use:

```ts
import { createGlobe, TimeRasterLayer, createTimeSlider } from './globe';
const globe = createGlobe({ container: 'globe', basemap: 'gibs-bluemarble', overlays: ['gibs-coastlines'] });
const layer = new TimeRasterLayer(globe.viewer, { frameUrl: (k) => `frames/${k}.png`, keys });
createTimeSlider(el, { keys, onChange: (k) => layer.show(k) });
```

Frame format:
- grayscale PNG, row 0 = north, column 0 = 180 W;
- 0 = no data;
- 1..255 = encoded value.

The demo uses `round(255 * log1p(x) / log1p(max))`.

## FIRMS demo (`src/app`, `scripts`)

`scripts/make_fire_frames.py` reads `../data_pipeline/data/agg/grid_0.25deg_month.parquet` and writes `public/frames/<metric>/<sensor>/<YYYY-MM>.png` plus `manifest.json`:
- metrics: detections and FRP;
- FIRMS type kept: 0 and -1;
- one max per metric shared by all sensors, so frames are comparable;
- no harmonization.

It requires `duckdb numpy pillow`.

```bash
python scripts/make_fire_frames.py
```
```bash
npm install
```
```bash
npm run dev
```

### Zoomed-in detail: individual detections

Below 2,500 km of camera height, the app loads the single detections of the current month for the visible area.
- **Source:** the local service `server/fire_api.py`, which runs DuckDB on `data_pipeline/data/parquet` (about 0.1-0.3 s per query).
- **Display:** points are colored by FRP and the monthly raster fades into the background.
- **Day filter:** the "Day" menu filters one day without reloading.
- **Time step "Day":** the slider moves one day at a time. Detections are loaded for the visible area, or worldwide when zoomed out, and the monthly raster is hidden. It needs the service.
- **Overpass filters:** daytime or night pass; MODIS Terra (about 10:30 and 22:30 local) or Aqua (about 13:30 and 01:30). An hourly series is not meaningful: each satellite sees a place about twice a day.
- **Zoom:**
  - mouse wheel;
  - touchpad pinch, handled explicitly because Cesium ignores ctrl+wheel;
  - double click on a point;
  - +/- buttons, keys + - 0.
- **Large areas:** at most the 150,000 strongest detections per sensor are loaded, and the panel says so.
- **NRT data:** used only after the last standard-processing date, the same rule as the aggregates.

```bash
data_pipeline\.venv\Scripts\python globe_kit\server\fire_api.py
```

Vite forwards `/api` to `127.0.0.1:5198`. In `.claude/launch.json` there are two configurations, `globe-kit` and `fire-api`. On a static site with no service, the globe still works and the panel says that the detail view needs the service.

### Area fire calendar

The **Area fire calendar** button opens a panel with the year x month calendar of one sensor over an area.
- **Choosing the area:** draw a box (two clicks), use the current view, or enter a point and a radius.
- **Colour:**
  - value: viridis, log scale;
  - anomaly: ratio to the median of the same month in the other years, diverging ramp from 1/4x to 4x.
- **Partial month:** the current month has a dashed outline and is left out of the medians.
- **Summary:** the selected month's value, its ratio to the median and its percentile; the peak month; the most active years.
- **Navigation:** clicking a cell moves the globe to that month.
- **CSV export:**
  - the calendar, built in the browser;
  - the single detections of the area and period, from `/api/export`.
- **Source and speed:**
  - areas under 25 square degrees are counted from single detections, larger ones from the 0.25 degree grid;
  - each query takes about 0.2-0.7 s.
- **Not harmonized yet:** values are raw counts of one sensor.

Service endpoints:

| Endpoint | Area | Other parameters | Returns |
|---|---|---|---|
| `/api/calendar` | `bbox=w,s,e,n` or `circle=lat,lon,km` | `types`, `pass` | JSON with the monthly counts |
| `/api/export` | same as above | `from`, `to`, `types` | CSV with at most 2 million rows |

### Online version without a server (static)

When the local service is not running (for example on GitHub Pages or static hosting), the app switches to static data on its own:
- **Engine:** DuckDB-WASM in the browser queries the Parquet files in `public/data/` with HTTP range requests, so only the parts needed by each query are downloaded.
- **Calendar:** worldwide, from the 0.25 degree grid (75 MB).
- **Single detections** (zoom, day view, hotspot CSV): only for one region, Europe and the Mediterranean by default (`--region`). They take 139 MB for 13.8 million detections.
- **Outside the region:** the panel says so.
- **File size:** every file is under 40 MB, the per-file limit of Porkbun static hosting.

```bash
python scripts/make_static_data.py --region -25,27,45,72
```
```bash
npm run static
```

`npm run static` = build + preview on port 5197, with no proxy to the service: it simulates the published site. The launch configuration is `globe-static`.

Measured locally on 14/11/2026:
- **Sicily calendar** (120 km): about 2 s on first use, including the DuckDB-WASM start.
- **Detections of one month in view:** about 1.5 s.
- **CSV of one month:** 0.2 s.
- **Results:** the same as the service; the calendar differs by less than 1% because it counts grid cells.

`public/data/` and `public/frames/` are generated and excluded from git.

They are built from two parts, merged by `scripts/assemble_site.py`:

| Part | Years | Built by | Where | How |
|---|---|---|---|---|
| historical | up to 2025 | you, once, locally | `site_data/` in the repo | `--to-year 2025 --tag hist` |
| recent | from 2026 | the nightly GitHub Action, with the `FIRMS_MAP_KEY` secret | built on each run | `--from-year 2026 --tag recent`, with `--scale-from` on the frames so the colour scale stays the same |

The workflow is `.github/workflows/pages.yml` in the repo root.

Library: `createAreaPicker` (`src/globe/areaPicker.ts`) and `createCalendarHeatmap` (`src/globe/calendar.ts`) are generic: any monthly series.

Library: `PointLayer` in `src/globe/pointLayer.ts` handles many points with a color ramp, a fast show/hide filter and the split direction. `viewRectangle` and `cameraHeight` are helpers.

`npm run build` writes `dist/` (about 67 MB, frames included). It is a static site and works on GitHub Pages.

## Notes

- Versions are pinned:
  - `cesium` 1.147.0. With 1.146.0 the caret dependencies install `@cesium/engine` 26.5, whose exports are incompatible.
  - `vite` 8.3.8.
- GIBS is used through the Web Mercator endpoints (`epsg3857`). The EPSG:4326 endpoints use a level-0 tile of 288 degrees, which does not match Cesium's geographic tiling.
- `Reference_Features_15m` (borders, roads) is drawn only at higher zoom levels; at global scale use `Coastlines_15m`.

## Credits

- [CesiumJS](https://cesium.com/platform/cesiumjs/), Apache 2.0.
- Imagery: [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api), Esri, OpenStreetMap contributors.
- Data: [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (MODIS C6.1, VIIRS 375 m).
- Viewer setup without ion, inspired by [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (MIT, Bilawal Sidhu). No code copied verbatim.
