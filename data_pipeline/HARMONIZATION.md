# MODIS / VIIRS harmonization

Frozen method, 2026-11-14. Code: `harmonize.py`. Outputs: `data/harmonized/`.

## What it produces

| File | Content |
|---|---|
| `harm_map.parquet` | Cell product (1 deg x month), fine method. Columns: `series`, `month`, `cell_lat`, `cell_lon` (cell centre), `value` (day + night), `value_day`, `value_night`, `origin`, `partial`. Only cells with value > 0. |
| `harm_region.parquet` | Regional product (month), coarse method. Columns: `series`, `region_type` (`gfed`, `country`, `block10`), `region_id`, `month`, `value`, `lo90`, `hi90`, `origin`. |
| `interval_table.json` | How to put a 90% interval on the monthly total of any area (sum of `harm_map` cells). The rule is written inside the file. |
| `coefficients.parquet` | The frozen coefficients used by `apply`. |

Two series, one unit each:

- **`long`**: Aqua-equivalent active-fire detections (MODIS 1 km pixel, day + night), from **2003-01**. `origin = aqua_obs` until 2021-12 (Aqua as observed); `origin = viirs_conv` from 2022-01 (VIIRS converted to Aqua units), and in 2020-08 (Aqua outage).
- **`detail`**: VIIRS 375 m detections, from **2013-01**, at S-NPP level, harmonized only among S-NPP, NOAA-20 and NOAA-21 (`origin = viirs_native`). Nothing is invented before 2012.

The unit is a count of fire detections per cell and month, not burned area.

## Method in ten lines

1. The FIRMS `type` field is ignored (MODIS reclassified many agricultural fires as static sources from the 2018 archive version). Static sources are masked with one rule for every sensor: 0.1 deg cells where more than 50% of S-NPP detections in 2013-2025 are volcano, static or offshore (8,015 cells).
2. VIIRS detections of the same overpass falling in one ~1 km ground cell form one cluster; each cluster counts `F^2 / (F^2 + 10^2)`, with `F` the summed FRP in MW. This mimics what a 1 km MODIS pixel detects.
3. The daily VIIRS value is the mean of the satellites that are not in outage that day (a satellite is out when its world daily total is below half of the best other one). Satellites: S-NPP (ended 2026-11-02), NOAA-20, NOAA-21.
4. NOAA-21 reads about 9% higher than NOAA-20 with this weighting; its level factor is NOAA-20 / NOAA-21 over the 12 months before, by latitude band and day/night. In nightly runs the last fitted factor is carried forward.
5. VIIRS to Aqua units: ratio Aqua / predictor per 2.5 deg block x calendar month x day/night, shrunk in log space toward the latitude band (weight V / (V + 20)), then a 1 deg cell term (weight V / (V + 1000)). This is the fine method (`harm_map`). The coarse method (`harm_region`) uses 10 deg blocks.
6. Calibration: S-NPP against Aqua, 2013-2020 (2020-08 excluded), before Aqua's orbit started to drift. Nothing is recalibrated after 2020.
7. `long` = Aqua observed to 2021-12, converted VIIRS afterwards. `detail` = VIIRS native.
8. Intervals: 5% and 95% quantiles of observed / predicted by level of the monthly total, from out-of-sample residuals (each year of 2013-2020 predicted from the other seven). For converted months a drift term grows with the years after 2020 (taken from the Terra-Aqua pair, 2003-2020).
9. Aqua observed months carry no interval (`lo90 = hi90 = value`). For `detail` the table gives only the spread between satellite pairs, not an error against a reference.
10. `apply` uses only `coefficients.parquet`, `interval_table.json` and the parquet files present in `data/parquet`; it needs no historical archive.

## How well it works (out of sample, 2013-2025 chain)

Leave-one-year-out 2013-2020 / calibrated on 2013-2020 and tested on 2021-2025, against Aqua:

- median monthly error per 1 deg cell (median |ln((obs+1)/(pred+1))|): 0.241 / 0.241; 86% / 85% within a factor of 2;
- annual totals per cell: 11% / 14% (1 deg), 9% / 12% (2.5 deg); per GFED region: 2% / 5%; world: 1% / 3%;
- step at the 2022-01 seam, world: below 1% against Aqua; correlation of annual totals with GFED5 burned area 2003-2020: 0.93;
- trends per country against the single-sensor record (stress variant, VIIRS converted from 2013): same sign in 89-90% of 136 countries, rank correlation 0.94;
- 90% intervals, out-of-sample coverage with the drift term, 2013-2020 / 2021-2025: 1 deg cell 90.3% / 90.6%; 2.5 deg cell 89.1% / 88.5%; 10 deg block 88.4% / 87.5%; GFED region 89.6% / 89.9%; country 88.4% / 88.6%; continent 89.8% / 91.3%; world 90.5% / 93.2%.

## Limits to declare

- **Aqua-equivalent compresses small fires.** Clusters under 10 MW are two thirds of the clusters VIIRS sees but about a third of the weight in the `long` series (up to 78% against 41% in South-East Asia, Middle East, Europe, Central Asia). Monthly anomalies and country trends barely change (correlation 0.96-0.99 in most regions), but regional trends can differ in sign (Middle East, Europe). The `detail` series keeps them.
- **Before 2003** there is no harmonized series. Terra alone flew from 2000-11 to 2002-06 and its conversion is not verifiable.
- **Aqua drifts after 2021** (overpass 13:36 to about 15:30 by 2026). The product does not use Aqua after 2021. Checks after 2021 use an Aqua corrected for the overpass shift, which is partly circular (VIIRS is the stable witness).
- **The drift term in the intervals is an assumption** (Terra-Aqua behaviour), not a measurement of VIIRS drift.
- **2026 data** are partly near-real-time and can be revised. The month in progress is flagged `partial`. From 2026-11 only NOAA-20 and NOAA-21 fly (S-NPP ended 2026-11-02). The expected step at that seam is +0.09% worldwide (from the 12 common months), but the measured step rests on 11 days of data and should be recomputed once two or three months are available.
- **Cell level is noisy.** Cells with few detections per month have wide intervals (a factor of about 4 between lower and upper bound). Use regional totals for statements.
- **FRP** is not harmonized. Counts only.

## How to regenerate

Requirements: `duckdb`, `numpy`, `pandas`, `pyarrow` (`requirements-harmonize.txt`).

```bash
# once, locally, needs the full archive in data/parquet (about 1 minute)
python harmonize.py fit

# nightly (about 10 seconds on 2026 data only; about 1 minute on the full history)
python harmonize.py apply --from 2026-11
```

`apply --from YYYY-MM` rewrites `harm_map.parquet` and `harm_region.parquet` from that month on and keeps earlier months untouched, but only if those files already exist: on a fresh checkout it writes only the months from `--from` on, so history must be merged by the caller. Run it with `--from 2003-01` (needs the full archive) to rebuild everything.

`apply` stops with exit code 1 when the data in `data/parquet` do not cover the first days of the first month, because that month would silently be understated (monthly totals, level factors and outage detection need whole days). `--allow-partial` overrides the check with a warning.
