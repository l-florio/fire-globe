"""Monthly fire frames for the globe demo, built from the FIRMS grid aggregate.

Input: data_pipeline/data/agg/grid_0.25deg_month.parquet (sensor, month, cell_lat, cell_lon, type, n, frp_sum, ...).
Output: public/frames/<metric>/<sensor>/<YYYY-MM>.png + public/frames/manifest.json

Each PNG is an 8-bit grayscale equirectangular raster (row 0 = north, column 0 = 180 W).
Encoding: value = round(255 * log1p(x) / log1p(max)), with one max per metric shared by all
sensors, so frames of different sensors stay comparable. The browser decodes and colors them.

Raw values per sensor: NO MODIS/VIIRS harmonization is applied here.

Usage: python make_fire_frames.py [--grid PATH] [--out DIR] [--types 0,-1]
                                 [--from-year Y] [--to-year Y] [--scale-from other/manifest.json]
  --from-year/--to-year: only these years (historical part up to 2025, recent part from 2026).
  --scale-from: reuse the per-metric max of another manifest, so both parts share one colour scale.
  --harmonized: also write frames of the harmonized series (data_pipeline/data/harmonized/harm_map.parquet) as
                sensors HARM_LONG and HARM_DETAIL, 1 degree cells, detections only, one colour scale per series.
Requires: duckdb, numpy, pillow
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import duckdb
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
DEFAULT_GRID = HERE.parent.parent / "data_pipeline" / "data" / "agg" / "grid_0.25deg_month.parquet"
METRICS = {
    "n": {"expr": "sum(n)", "label": "Active fire detections", "unit": "detections / cell / month"},
    "frp": {"expr": "sum(frp_sum)", "label": "Fire radiative power", "unit": "MW / cell / month (sum)"},
}
HARM_SERIES = {
    "HARM_LONG": ("long", "Harmonized, long-term (Aqua-equivalent, 2003+)"),
    "HARM_DETAIL": ("detail", "Harmonized, detail (VIIRS 375 m, 2013+)"),
}
SENSOR_LABELS = {
    "MODIS": "MODIS (Terra + Aqua, 1 km)",
    "VIIRS_SNPP": "VIIRS S-NPP (375 m)",
    "VIIRS_NOAA20": "VIIRS NOAA-20 (375 m)",
    "VIIRS_NOAA21": "VIIRS NOAA-21 (375 m)",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", default=str(DEFAULT_GRID))
    ap.add_argument("--out", default=str(HERE.parent / "public" / "frames"))
    ap.add_argument("--types", default="0,-1", help="FIRMS type codes kept (0 vegetation, -1 unknown/NRT)")
    ap.add_argument("--from-year", type=int, default=1900)
    ap.add_argument("--to-year", type=int, default=9999)
    ap.add_argument("--scale-from", help="manifest.json whose per-metric max is reused")
    ap.add_argument("--harmonized", help="harm_map.parquet of the harmonized series")
    a = ap.parse_args()
    fixed = json.loads(Path(a.scale_from).read_text(encoding="utf-8"))["metrics"] if a.scale_from else {}

    con = duckdb.connect()
    types = ",".join(str(int(t)) for t in a.types.split(","))
    out = Path(a.out)
    res = 0.25
    w, h = int(360 / res), int(180 / res)
    con.execute(f"""
        CREATE TEMP TABLE g AS
        SELECT sensor, month,
               CAST(floor((90 - cell_lat) / {res}) AS INTEGER) AS r,
               CAST(floor((cell_lon + 180) / {res}) AS INTEGER) AS c,
               {METRICS['n']['expr']} AS n, {METRICS['frp']['expr']} AS frp
        FROM read_parquet('{Path(a.grid).as_posix()}')
        WHERE type IN ({types}) AND year(month) BETWEEN {a.from_year} AND {a.to_year}
        GROUP BY ALL
    """)
    cov = con.execute("SELECT sensor, max(month) FROM g GROUP BY 1").fetchall()
    manifest = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "NASA FIRMS active fires (MODIS C6.1, VIIRS 375 m), grid 0.25 deg x month",
        "encoding": "log1p-uint8",
        "width": w, "height": h, "rectangle": [-180, -90, 180, 90],
        "types": [int(t) for t in types.split(",")],
        "harmonized": False,
        "metrics": {}, "sensors": {},
    }
    for metric, meta in METRICS.items():
        vmax = fixed[metric]["max"] if metric in fixed else float(con.execute(f"SELECT max({metric}) FROM g").fetchone()[0])
        manifest["metrics"][metric] = {"label": meta["label"], "unit": meta["unit"], "max": vmax}
        scale = 255.0 / np.log1p(vmax)
        for sensor, last in cov:
            months = []
            rows = con.execute(f"""
                SELECT month, list(r), list(c), list({metric}) FROM g WHERE sensor = ? GROUP BY month ORDER BY month
            """, [sensor]).fetchall()
            d = out / metric / sensor
            d.mkdir(parents=True, exist_ok=True)
            for month, rr, cc, vv in rows:
                img = np.zeros((h, w), dtype=np.uint8)
                v = np.clip(np.rint(np.log1p(np.asarray(vv, dtype=np.float64)) * scale), 1, 255)
                img[np.asarray(rr), np.asarray(cc)] = v.astype(np.uint8)  # 0 = no detection
                key = month.strftime("%Y-%m")
                Image.fromarray(img, mode="L").save(d / f"{key}.png", optimize=True)
                months.append(key)
            s = manifest["sensors"].setdefault(sensor, {"label": SENSOR_LABELS.get(sensor, sensor)})
            s["months"] = months
            s["partial_last_month"] = last.strftime("%Y-%m") == dt.date.today().strftime("%Y-%m")
            print(f"{metric} {sensor}: {len(months)} frames")
    if a.harmonized:
        write_harmonized(con, a, out, manifest)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"manifest in {out / 'manifest.json'}")


def write_harmonized(con, a, out: Path, manifest: dict) -> None:
    """Frames of the harmonized series on 1 degree cells (360 x 180), same log encoding, own max per series."""
    w, h = 360, 180
    fixed = json.loads(Path(a.scale_from).read_text(encoding="utf-8")).get("sensors", {}) if a.scale_from else {}
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE hm AS
        SELECT series, month, CAST(floor(90 - cell_lat) AS INTEGER) AS r, CAST(floor(cell_lon + 180) AS INTEGER) AS c,
               value, partial
        FROM read_parquet('{Path(a.harmonized).as_posix()}')
        WHERE year(month) BETWEEN {a.from_year} AND {a.to_year} AND value > 0
    """)
    for sensor, (series, label) in HARM_SERIES.items():
        if not con.execute("SELECT count(*) FROM hm WHERE series = ?", [series]).fetchone()[0]:
            continue
        vmax = fixed.get(sensor, {}).get("max") or float(con.execute("SELECT max(value) FROM hm WHERE series = ?", [series]).fetchone()[0])
        scale = 255.0 / np.log1p(vmax)
        rows = con.execute("""
            SELECT month, list(r), list(c), list(value), bool_or(partial) FROM hm WHERE series = ? GROUP BY month ORDER BY month
        """, [series]).fetchall()
        d = out / "n" / sensor
        d.mkdir(parents=True, exist_ok=True)
        months, last_partial = [], False
        for month, rr, cc, vv, part in rows:
            img = np.zeros((h, w), dtype=np.uint8)
            v = np.clip(np.rint(np.log1p(np.asarray(vv, dtype=np.float64)) * scale), 1, 255)
            img[np.asarray(rr), np.asarray(cc)] = v.astype(np.uint8)
            key = month.strftime("%Y-%m")
            Image.fromarray(img, mode="L").save(d / f"{key}.png", optimize=True)
            months.append(key)
            last_partial = bool(part)
        manifest["sensors"][sensor] = {"label": label, "months": months, "partial_last_month": last_partial,
                                       "metrics": ["n"], "max": vmax, "harmonized": True}
        print(f"n {sensor}: {len(months)} frames (harmonized)")


if __name__ == "__main__":
    main()
