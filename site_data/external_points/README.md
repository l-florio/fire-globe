---
license: other
license_name: nasa-firms-public-data
pretty_name: Fire Globe - NASA FIRMS active fire detections (Parquet)
tags:
- wildfire
- remote-sensing
- modis
- viirs
- nasa
- geospatial
size_categories:
- 100M<n<1B
---

# Fire Globe: NASA FIRMS active fire detections, 2000-2026 (Parquet)

Single active-fire detections from NASA FIRMS, normalized and partitioned for direct reading in the browser with DuckDB-WASM (HTTP range requests). Used by the Fire Globe web app (NASA Space Apps Challenge 2026, "Harmonization of MODIS and VIIRS Hot Spots").

These are **raw per-sensor detections**. The harmonized MODIS/VIIRS series is computed by the app's pipeline (see the project repository).

## Layout

```
points/sensor=<SENSOR>/year=<YYYY>.parquet
```

Sensors: MODIS (Terra + Aqua, from 2000-11), VIIRS_SNPP (2012-01 to 2026-11-02), VIIRS_NOAA20 (from 2018-04), VIIRS_NOAA21 (from 2023-03).
Rows are sorted by date, then latitude (row groups of 32,768 rows), so queries by period and area read only a small part of each file.

| Column | Type | Meaning |
|---|---|---|
| lon, lat | float | detection centre, degrees |
| d | date | acquisition date (UTC) |
| hhmm | int16 | acquisition time, UTC, HHMM |
| frp | float | fire radiative power, MW |
| flags | int8 | bit 0: night; bits 1-2: confidence (0 low, 1 nominal, 2 high); bits 3-4: satellite (1 Terra, 2 Aqua, 0 VIIRS) |
| type | int8 | FIRMS type: 0 vegetation, 1 volcano, 2 other static source, 3 offshore, -1 unknown (near real time) |
| src | int8 | 0 standard processing (archive), 1 standard processing (API), 2 near real time |

Near-real-time rows are kept only after the last standard-processing date of each sensor.

## Source and terms

NASA FIRMS (Fire Information for Resource Management System), MODIS Collection 6.1 (MCD14) and VIIRS 375 m (VNP14IMG, VJ114IMG, VJ214IMG) active fire products: https://firms.modaps.eosdis.nasa.gov/

NASA data are not copyrighted in the United States; please acknowledge the source:
"We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/firms), part of NASA's Earth Science Data and Information System (ESDIS)."

The processing code (Apache License 2.0) is in the Fire Globe project repository.
