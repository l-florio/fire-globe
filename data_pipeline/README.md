# data_pipeline: FIRMS download, normalization and MODIS/VIIRS harmonization

Part of the Fire Globe project (NASA Space Apps Challenge 2026, "Harmonization of MODIS and VIIRS Hot Spots"). Two stages:

1. `firms_pipeline.py`: download, normalize and aggregate NASA FIRMS hotspots (raw, per sensor).
2. `harmonize.py`: the frozen harmonization (2026-11-14). Method, validation, uncertainty and limits: [HARMONIZATION.md](HARMONIZATION.md).

## Harmonization (summary)

`harmonize.py fit` is run once locally on the full archive and writes the frozen coefficients; `harmonize.py apply --from YYYY-MM` applies them to new months (nightly in the GitHub Action). Outputs in `data/harmonized/`:

| File | Content |
|---|---|
| `harm_map.parquet` | 1 degree cell x month, series `long` and `detail` |
| `harm_region.parquet` | Monthly series by GFED region, country and 10 degree block, with 90% intervals |
| `interval_table.json` | Rule and table for a 90% interval on the monthly total of any area |
| `coefficients.parquet` | Frozen coefficients used by `apply` |

Series: `long` = Aqua-equivalent detections from 2003-01 (VIIRS converted from 2022-01); `detail` = VIIRS 375 m at S-NPP level from 2013-01. Unit: detections, not burned area. FRP is not harmonized. HARMONIZATION.md has the declared limits and the behavior of `apply` on incomplete months (exit code 1 unless `--allow-partial`).

```bash
pip install -r requirements-harmonize.txt   # duckdb numpy pandas pyarrow
python harmonize.py fit
python harmonize.py apply --from 2026-11
```

## Data

| Dataset | Source | Period | Access | Volume |
|---|---|---|---|---|
| MODIS C6.1 (Terra+Aqua), Standard Processing | FIRMS yearly zips per country | 2000-2025 | free | about 2 GB zip, 9 GB CSV |
| VIIRS 375 m S-NPP, SP | FIRMS yearly zips per country | 2012-2025 (mission ended 2026-11-02) | free | about 5 GB zip, 21 GB CSV |
| VIIRS NOAA-20 (`--sensors ...,VIIRS_NOAA20`) | FIRMS | 2018-04 on | free | about 330 MB zip per year |
| VIIRS NOAA-21 (`--sensors ...,VIIRS_NOAA21`) | FIRMS | 2023-03 on | free | not measured |
| Current year (SP, then NRT) | FIRMS area API, `world`, 5-day windows | 1 January to today | free MAP_KEY | about 65 calls per sensor |

Notes:
- The zips hold one CSV per country, so detections outside national borders may be missing (not checked).
- The API returns data without country; NRT data have no `type` field, which is -1 in the aggregates (the harmonization ignores `type` anyway).
- MAP_KEY quota: a worldwide VIIRS call over 5 days costs 180 transactions, a MODIS one 45. The script checks `mapkey_status` and waits for the reset when the quota is spent.

## Install

```bash
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

## Use

Quick test, Italy only, a few MB:
```bash
.venv\Scripts\python firms_pipeline.py --years 2012-2025 sample-country --country Italy
```

Full pipeline (archive, current year if a key is present, build, aggregate):
```bash
set FIRMS_MAP_KEY=your_key
.venv\Scripts\python firms_pipeline.py all
```

Instead of the environment variable, put the key alone in a `.firms_key` file next to the script (excluded from git).

Single steps: `download-archive`, `download-recent`, `build`, `aggregate`. Global options, before the subcommand: `--sensors MODIS,VIIRS_SNPP`, `--years 2012-2025`, `--data <folder>`, `--ca-bundle <pem>`.

Periodic update (as in the GitHub Action): `download-recent --refresh-days 7`, then `build`, then `aggregate`, then `harmonize.py apply`. NRT windows of the last N days are downloaded again because NRT data fill in over time.

## Output (`data/`)

- `raw/archive/*.zip`, `raw/api/<SOURCE>/*.csv`: raw data; downloads resume where they stopped.
- `parquet/sensor=<S>/year=<Y>/*.parquet`: normalized schema:
  - identification: `sensor`, `source` (SP_ARCHIVE|SP_API|NRT_API), `country`;
  - position and time: `latitude`, `longitude`, `acq_date`, `acq_time`, `satellite`;
  - confidence: `confidence_raw`, `confidence_class` (low/nominal/high);
  - measures: `bright_main`, `bright_aux`, `frp`, `scan`, `track`;
  - other: `daynight`, `type`, `version`.
- `agg/grid_<res>deg_month.parquet`: cells (default 0.25 degree) x month x sensor x type x day/night x confidence, with `n`, `frp_sum`, `frp_max`.
- `agg/country_month.parquet|csv`: country x month x sensor x type x confidence.
- `agg/metadata.json`: coverage per sensor and source, generation date.
- `harmonized/`: harmonization outputs (see above).

SP against NRT: in the aggregates, NRT data are used only after the last Standard Processing date of the same sensor. The aggregates in `agg/` are raw and per sensor; the harmonized series is produced by `harmonize.py` from `data/parquet`.

## Time and space (estimates)

- Download: about 7 GB; measured about 3 MB/s on the development network, so about 40 minutes.
- Build: about 7 seconds per MODIS year (1.8 million rows, measured); VIIRS estimated at 1-2 minutes per year. About 2 GB temporary space per zip extraction.
- Total: zips about 7 GB plus Parquet about 3-5 GB.

## Tests run

Download and aggregation steps, 13 November 2026:
- `sample-country` Italy 2025, MODIS + VIIRS: ok (3.1 MB downloaded instead of about 390 MB).
- `download-archive` MODIS 2000-2001: ok; a rerun skips existing files.
- `build` + `aggregate` on MODIS 2000-2001 (2.03 million rows) and on synthetic API-format CSV (SP and NRT): ok; the discard of NRT data already covered by SP is verified.
- Not covered by these tests: `download-recent` with a real MAP_KEY and a full VIIRS build. The nightly workflow exercises `download-recent`; check its logs for the current status.

Harmonization validation is documented in HARMONIZATION.md.

## Use of AI

AI assistants (Claude, Codex) were used to write the scripts, run analyses and draft documentation. The harmonization method and design choices were selected by the team from the tests; AI was not used to ideate the solution.
