"""Static data for the online version (no server): Parquet files read in the browser by DuckDB-WASM
with HTTP range requests.

Output in public/data/:
  grid/sensor=<S>/band=<B>.parquet   calendar grid, worldwide: 0.25 deg cell x month, 10-degree latitude bands
      columns: m (months since 2000-01), lat, lon (cell centre), cls (0 vegetation/unknown, 1 volcano/static/offshore),
               n (detections), frp (MW, sum)
  points/sensor=<S>/year=<Y>.parquet single detections inside --region, sorted by date then latitude
      columns: lon, lat, d (date), hhmm (UTC), frp, flags (bit0 night, bits1-2 confidence, bits3-4 satellite 1 Terra 2 Aqua),
               type (-1 unknown/NRT), src (0 SP archive, 1 SP API, 2 NRT)
  static.json                         file lists, region, row counts

NRT rows are kept only after the last standard-processing date of each sensor (same rule as the aggregates).
Raw values: no MODIS/VIIRS harmonization.

Usage: python make_static_data.py [--region -25,27,45,72] [--data ../../data_pipeline/data] [--out ../public/data]
                                 [--from-year Y] [--to-year Y] [--tag hist]
  The year window and the tag let a historical part (built once, locally) and a recent part
  (rebuilt by the nightly GitHub Action) live side by side; scripts/assemble_site.py merges them.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent.parent / "data_pipeline" / "data"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--out", default=str(HERE.parent / "public" / "data"))
    ap.add_argument("--region", default="-25,27,45,72", help="w,s,e,n for single detections (Europe and Mediterranean)")
    ap.add_argument("--from-year", type=int, default=1900)
    ap.add_argument("--to-year", type=int, default=9999)
    ap.add_argument("--tag", default="all", help="suffix of the grid file names, e.g. hist or recent")
    ap.add_argument("--skip-grid", action="store_true")
    ap.add_argument("--harmonized", help="harm_map.parquet: adds grid files for HARM_LONG / HARM_DETAIL and interval_table.json")
    ap.add_argument("--skip-points", action="store_true")
    ap.add_argument("--points-sensors", help="comma list; default all sensors")
    a = ap.parse_args()
    point_sensors = set(a.points_sensors.split(",")) if a.points_sensors else None
    data, out = Path(a.data), Path(a.out)
    w, s, e, n = (float(x) for x in a.region.split(","))
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    con = duckdb.connect()
    manifest: dict = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "region": [w, s, e, n],
        "grid_res_deg": 0.25,
        "grid": {},
        "points": {},
        "harmonized": False,
    }

    # ---- calendar grid, worldwide, split by sensor and 10-degree latitude band
    grid = (data / "agg" / "grid_0.25deg_month.parquet").as_posix()
    sensors = [] if a.skip_grid else [r[0] for r in con.execute(f"SELECT DISTINCT sensor FROM '{grid}' ORDER BY 1").fetchall()]
    for sensor in sensors:
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE g AS
            SELECT CAST((year(month) - 2000) * 12 + month(month) - 1 AS SMALLINT) AS m,
                   CAST(cell_lat AS FLOAT) AS lat, CAST(cell_lon AS FLOAT) AS lon,
                   CAST(CASE WHEN coalesce(type, -1) IN (1, 2, 3) THEN 1 ELSE 0 END AS TINYINT) AS cls,
                   CAST(sum(n) AS INTEGER) AS n, CAST(sum(frp_sum) AS FLOAT) AS frp,
                   CAST(floor((cell_lat + 90) / 10) AS INTEGER) AS band
            FROM '{grid}' WHERE sensor = '{sensor}' AND year(month) BETWEEN {a.from_year} AND {a.to_year} GROUP BY ALL
        """)
        files = []
        for (band,) in con.execute("SELECT DISTINCT band FROM g ORDER BY 1").fetchall():
            d = out / "grid" / f"sensor={sensor}"
            d.mkdir(parents=True, exist_ok=True)
            f = d / f"band={band}.{a.tag}.parquet"
            con.execute(f"""COPY (SELECT m, lat, lon, cls, n, frp FROM g WHERE band = {band} ORDER BY lat, lon, m)
                            TO '{f.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 65536)""")
            files.append({"band": band, "south": band * 10 - 90, "north": band * 10 - 80,
                          "path": f.relative_to(out).as_posix(), "bytes": f.stat().st_size})
        manifest["grid"][sensor] = files
        print(f"grid {sensor}: {len(files)} files, {sum(x['bytes'] for x in files) / 1e6:.1f} MB")

    # ---- harmonized series: same grid layout, 1 degree cells, plus origin o (0 aqua_obs, 1 viirs_conv, 2 viirs_native)
    if a.harmonized and not a.skip_grid:
        harm = Path(a.harmonized)
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE hg AS
            SELECT series,
                   CAST((year(month) - 2000) * 12 + month(month) - 1 AS SMALLINT) AS m,
                   CAST(cell_lat AS FLOAT) AS lat, CAST(cell_lon AS FLOAT) AS lon, CAST(0 AS TINYINT) AS cls,
                   CAST(value AS FLOAT) AS n, CAST(0 AS FLOAT) AS frp,
                   CAST(CASE origin WHEN 'aqua_obs' THEN 0 WHEN 'viirs_conv' THEN 1 ELSE 2 END AS TINYINT) AS o,
                   CAST(floor((cell_lat + 90) / 10) AS INTEGER) AS band
            FROM read_parquet('{harm.as_posix()}')
            WHERE year(month) BETWEEN {a.from_year} AND {a.to_year} AND value > 0
        """)
        for sensor, series in (("HARM_LONG", "long"), ("HARM_DETAIL", "detail")):
            files = []
            for (band,) in con.execute("SELECT DISTINCT band FROM hg WHERE series = ? ORDER BY 1", [series]).fetchall():
                d = out / "grid" / f"sensor={sensor}"
                d.mkdir(parents=True, exist_ok=True)
                f = d / f"band={band}.{a.tag}.parquet"
                con.execute(f"""COPY (SELECT m, lat, lon, cls, n, frp, o FROM hg WHERE series = '{series}' AND band = {band} ORDER BY lat, lon, m)
                                TO '{f.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 65536)""")
                files.append({"band": band, "south": band * 10 - 90, "north": band * 10 - 80,
                              "path": f.relative_to(out).as_posix(), "bytes": f.stat().st_size})
            if files:
                manifest["grid"][sensor] = files
                print(f"grid {sensor}: {len(files)} files, {sum(x['bytes'] for x in files) / 1e6:.1f} MB (harmonized)")
        # Regional totals (countries and GFED regions) with 90% intervals, for the Table view.
        hr = harm.with_name("harm_region.parquet")
        if hr.exists():
            d = out / "regions"
            d.mkdir(parents=True, exist_ok=True)
            f = d / f"harm_region.{a.tag}.parquet"
            m0 = con.execute(f"""
                COPY (SELECT series, region_type AS rt, region_id AS id,
                             CAST((year(month) - 2000) * 12 + month(month) - 1 AS SMALLINT) AS m,
                             CAST(value AS FLOAT) AS v, CAST(lo90 AS FLOAT) AS lo, CAST(hi90 AS FLOAT) AS hi,
                             CAST(CASE origin WHEN 'aqua_obs' THEN 0 WHEN 'viirs_conv' THEN 1 ELSE 2 END AS TINYINT) AS o
                      FROM read_parquet('{hr.as_posix()}')
                      WHERE region_type IN ('country', 'gfed') AND year(month) BETWEEN {a.from_year} AND {a.to_year}
                      ORDER BY series, rt, m, id)
                TO '{f.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
            first = con.execute(f"SELECT min(m) FROM read_parquet('{f.as_posix()}')").fetchone()[0]
            manifest["regions"] = [{"path": f.relative_to(out).as_posix(), "from": int(first or 0), "bytes": f.stat().st_size}]
            print(f"regions: {f.stat().st_size / 1e6:.2f} MB from month {first}")
        it = harm.with_name("interval_table.json")
        if it.exists():
            shutil.copy(it, out / "interval_table.json")
            manifest["intervals"] = "interval_table.json"

    # ---- single detections in the region, by sensor and year
    pq = data / "parquet"
    for sd in sorted(pq.glob("sensor=*")) if not a.skip_points else []:
        sensor = sd.name.split("=", 1)[1]
        if point_sensors and sensor not in point_sensors:
            continue
        sp_files = [f.as_posix() for f in sd.glob("year=*/*.parquet") if not f.stem.endswith("_nrt")]
        if not sp_files:
            continue
        sp_end = con.execute(f"SELECT max(acq_date) FROM read_parquet({sp_files!r}, union_by_name=true)").fetchone()[0]
        files = []
        for yd in sorted(sd.glob("year=*")):
            year = int(yd.name.split("=", 1)[1])
            if not a.from_year <= year <= a.to_year:
                continue
            src = [f.as_posix() for f in yd.glob("*.parquet")]
            d = out / "points" / f"sensor={sensor}"
            d.mkdir(parents=True, exist_ok=True)
            f = d / f"year={year}.parquet"
            lon = f"(longitude BETWEEN {w} AND {e})" if w <= e else f"(longitude >= {w} OR longitude <= {e})"
            con.execute(f"""
                COPY (
                  SELECT CAST(longitude AS FLOAT) AS lon, CAST(latitude AS FLOAT) AS lat, acq_date AS d,
                         CAST(coalesce(acq_time, 0) AS SMALLINT) AS hhmm, CAST(coalesce(frp, 0) AS FLOAT) AS frp,
                         CAST((CASE WHEN daynight = 'N' THEN 1 ELSE 0 END)
                              + 2 * (CASE confidence_class WHEN 'high' THEN 2 WHEN 'nominal' THEN 1 ELSE 0 END)
                              + 8 * (CASE satellite WHEN 'Terra' THEN 1 WHEN 'Aqua' THEN 2 ELSE 0 END) AS TINYINT) AS flags,
                         CAST(coalesce(type, -1) AS TINYINT) AS type,
                         CAST(CASE source WHEN 'SP_ARCHIVE' THEN 0 WHEN 'SP_API' THEN 1 ELSE 2 END AS TINYINT) AS src
                  FROM read_parquet({src!r}, union_by_name=true)
                  WHERE latitude BETWEEN {s} AND {n} AND {lon}
                    AND (source <> 'NRT_API' OR acq_date > DATE '{sp_end}')
                  ORDER BY d, lat
                ) TO '{f.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 32768)
            """)
            rows = con.execute(f"SELECT count(*) FROM '{f.as_posix()}'").fetchone()[0]
            files.append({"year": year, "path": f.relative_to(out).as_posix(), "rows": rows,
                          "bytes": f.stat().st_size, "region": [w, s, e, n]})
        manifest["points"][sensor] = files
        print(f"points {sensor}: {len(files)} files, {sum(x['rows'] for x in files):,} rows, "
              f"{sum(x['bytes'] for x in files) / 1e6:.1f} MB")

    (out / "static.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    total = sum(p.stat().st_size for p in out.rglob("*.parquet"))
    print(f"total {total / 1e6:.1f} MB in {out}")


if __name__ == "__main__":
    main()
