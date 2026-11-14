"""Local data service: individual FIRMS detections for a sensor, a month and a map rectangle.

Reads the normalized Parquet written by data_pipeline/firms_pipeline.py
(parquet/sensor=<S>/year=<Y>/*.parquet) with DuckDB. About 0.1 s per query, no index needed.

GET /api/detections?sensor=VIIRS_SNPP&month=2024-08 | &date=2024-08-20 [&bbox=w,s,e,n][&limit=150000][&types=0,-1]
  200 application/octet-stream: Float32 records of 7 values
      [lon, lat, frp_MW, day_of_month, hour_utc, flags, type]  (type: FIRMS type, -1 unknown)
      flags: bit0 night, bits1-2 confidence (0 low, 1 nominal, 2 high), bits3-4 satellite (1 Terra, 2 Aqua, 0 other)
  bbox defaults to the whole world
  headers: X-Total (matches in the rectangle), X-Returned (records sent; the strongest FRP first when capped)
GET /api/calendar?sensor=MODIS&bbox=w,s,e,n | &circle=lat,lon,km [&types=0,-1][&pass=all|day|night]
     (types: FIRMS type list; 0,-1 vegetation fires, 0,1,2,3,-1 all, 1,2,3 volcanoes and static sources only)
  200 JSON {sensor, source: "detections" | "grid", months: [[YYYY-MM, count, frp_sum], ...]}
  Small areas (under 25 square degrees) are counted from single detections; larger ones from the
  0.25 degree grid aggregate (cells whose centre falls in the area).
GET /api/export?sensor=MODIS&bbox=... | &circle=... &from=YYYY-MM-DD&to=YYYY-MM-DD [&types=0,-1]
GET /api/regions?series=long|detail&type=country|gfed&month=1..12   harmonized regional values, that month of every year
POST /api/calendar and /api/export: same query parameters, area as JSON body {"cells": {"res", "ids", "bbox"}}
  (grid cells of a place; cell id = floor((lat+90)/res) * (360/res) + floor((lon+180)/res))
  200 text/csv: the single detections in the area and period (at most 2,000,000 rows)
GET /api/health -> {"sensors": {...: last standard-processing date}}

NRT rows are used only after the last standard-processing (SP) date of the same sensor,
the same rule as the aggregates. Raw values, no MODIS/VIIRS harmonization.

Usage: python fire_api.py [--data ../../data_pipeline/data] [--port 5198]
"""
from __future__ import annotations

import argparse
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import duckdb

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE.parent.parent / "data_pipeline" / "data"
MONTH_RE = re.compile(r"^(\d{4})-(\d{2})$")
DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
SENSOR_RE = re.compile(r"^[A-Z0-9_]+$")
CONF = {"low": 0, "nominal": 1, "high": 2}


def area_sql(area: dict, lat: str = "latitude", lon: str = "longitude") -> str:
    """SQL condition for a bbox, a circle (great-circle distance in km) or a set of grid cells (a place)."""
    if "cells" in area:
        res, ids, bbox = area["cells"]
        ncol = round(360 / res)
        cid = f"(CAST(floor(({lat} + 90) / {res}) AS BIGINT) * {ncol} + CAST(floor(({lon} + 180) / {res}) AS BIGINT))"
        return f"({area_sql({'bbox': bbox}, lat, lon)} AND {cid} IN ({','.join(map(str, ids))}))"
    if "circle" in area:
        import math

        la, lo, km = area["circle"]
        # Bounding box first: lets DuckDB skip row groups and avoids the trigonometry on most rows.
        dlat = km / 111.0
        dlon = min(180.0, km / (111.0 * max(0.01, math.cos(math.radians(min(89.0, abs(la) + dlat))))))
        box = area_sql({"bbox": (max(-180.0, lo - dlon), max(-90.0, la - dlat), min(180.0, lo + dlon), min(90.0, la + dlat))}, lat, lon)
        return (f"({box} AND 2 * 6371.0 * asin(sqrt(pow(sin(radians({lat} - {la}) / 2), 2) + cos(radians({la})) * "
                f"cos(radians({lat})) * pow(sin(radians({lon} - {lo}) / 2), 2))) <= {km})")
    w, s, e, n = area["bbox"]
    lon_c = f"({lon} BETWEEN {w} AND {e})" if w <= e else f"({lon} >= {w} OR {lon} <= {e})"
    return f"({lat} BETWEEN {s} AND {n} AND {lon_c})"


def area_deg2(area: dict) -> float:
    if "cells" in area:
        res, ids, _ = area["cells"]
        return len(ids) * res * res
    if "circle" in area:
        la, _, km = area["circle"]
        import math
        return math.pi * (km / 111.0) ** 2 / max(0.1, math.cos(math.radians(la)))
    w, s, e, n = area["bbox"]
    return ((e - w) % 360 or 360) * (n - s)


def parse_area(q: dict) -> dict:
    if isinstance(q.get("cells"), dict):  # POST body: {"cells": {"res": 0.25, "ids": [...], "bbox": [w, s, e, n]}}
        c = q["cells"]
        res = float(c["res"])
        ids = [int(i) for i in c["ids"]]
        bbox = tuple(float(x) for x in c["bbox"])
        assert res in (0.25, 0.5, 1.0) and 0 < len(ids) <= 200_000 and len(bbox) == 4
        return {"cells": (res, ids, bbox)}
    if q.get("circle"):
        la, lo, km = (float(x) for x in q["circle"].split(","))
        assert -90 <= la <= 90 and -180 <= lo <= 180 and 0 < km <= 5000
        return {"circle": (la, lo, km)}
    b = tuple(float(x) for x in q.get("bbox", "-180,-90,180,90").split(","))
    assert len(b) == 4 and -90 <= b[1] <= b[3] <= 90
    return {"bbox": b}


class Store:
    def __init__(self, data: Path):
        self.grid = data / "agg" / "grid_0.25deg_month.parquet"
        self.harm = data / "harmonized" / "harm_map.parquet"
        self.harm_region = data / "harmonized" / "harm_region.parquet"
        self.pq = data / "parquet"
        self.db = duckdb.connect()
        self.local = threading.local()
        self.sp_end: dict[str, str] = {}
        for d in sorted(self.pq.glob("sensor=*")):
            s = d.name.split("=", 1)[1]
            files = [f.as_posix() for f in d.glob("year=*/*.parquet") if not f.stem.endswith("_nrt")]
            if files:
                q = f"SELECT max(acq_date) FROM read_parquet({files!r}, union_by_name=true)"
                self.sp_end[s] = str(self.db.execute(q).fetchone()[0])

    def con(self):
        c = getattr(self.local, "c", None)
        if c is None:
            c = self.local.c = self.db.cursor()
        return c

    def detections(self, sensor: str, period: str, bbox: tuple[float, float, float, float], limit: int, types: list[int]):
        """period: YYYY-MM (one month) or YYYY-MM-DD (one day)."""
        import datetime as dt

        if DATE_RE.match(period):
            day0 = dt.date.fromisoformat(period)
            d0, d1, y = day0.isoformat(), (day0 + dt.timedelta(days=1)).isoformat(), day0.year
        else:
            y, m = map(int, MONTH_RE.match(period).groups())
            d0 = f"{y:04d}-{m:02d}-01"
            d1 = f"{y + (m == 12):04d}-{m % 12 + 1:02d}-01"
        folder = self.pq / f"sensor={sensor}" / f"year={y}"
        files = sorted(f.as_posix() for f in folder.glob("*.parquet"))
        if not files:
            return 0, b""
        w, s, e, n = bbox
        lon = f"(longitude BETWEEN {w} AND {e})" if w <= e else f"(longitude >= {w} OR longitude <= {e})"
        sp_end = self.sp_end.get(sensor, "1900-01-01")
        where = f"""
            acq_date >= DATE '{d0}' AND acq_date < DATE '{d1}'
            AND latitude BETWEEN {s} AND {n} AND {lon}
            AND coalesce(type, -1) IN ({','.join(map(str, types))})
            AND (source <> 'NRT_API' OR acq_date > DATE '{sp_end}')
        """
        src = f"read_parquet({files!r}, union_by_name=true)"
        c = self.con()
        total = c.execute(f"SELECT count(*) FROM {src} WHERE {where}").fetchone()[0]
        rows = c.execute(f"""
            SELECT longitude, latitude, coalesce(frp, 0), day(acq_date),
                   coalesce(acq_time, 0) // 100 + (coalesce(acq_time, 0) % 100) / 60.0,
                   (CASE WHEN daynight = 'N' THEN 1 ELSE 0 END)
                   + 2 * (CASE confidence_class WHEN 'high' THEN 2 WHEN 'nominal' THEN 1 ELSE 0 END)
                   + 8 * (CASE satellite WHEN 'Terra' THEN 1 WHEN 'Aqua' THEN 2 ELSE 0 END),
                   coalesce(type, -1)
            FROM {src} WHERE {where}
            ORDER BY frp DESC NULLS LAST LIMIT {limit}
        """).fetchnumpy()
        import numpy as np

        arr = np.column_stack([np.asarray(v, dtype=np.float32) for v in rows.values()]) if total else np.zeros((0, 7), np.float32)
        return total, arr.astype("<f4").tobytes()


def _calendar(self, sensor: str, area: dict, types: list[int], pass_: str):
    if sensor in ("HARM_LONG", "HARM_DETAIL"):
        series = "long" if sensor == "HARM_LONG" else "detail"
        rows = self.con().execute(f"""
            SELECT strftime(month, '%Y-%m'), sum(value), 0,
                   max(CASE origin WHEN 'aqua_obs' THEN 0 WHEN 'viirs_conv' THEN 1 ELSE 2 END)
            FROM read_parquet('{self.harm.as_posix()}')
            WHERE series = ? AND {area_sql(area, 'cell_lat', 'cell_lon')}
            GROUP BY 1 ORDER BY 1
        """, [series]).fetchall()
        return "harmonized", rows
    tcond = f"coalesce(type, -1) IN ({','.join(map(str, types))})"
    dn = {"day": "AND daynight = 'D'", "night": "AND daynight = 'N'"}.get(pass_, "")
    c = self.con()
    if area_deg2(area) < 25:
        files = sorted(f.as_posix() for f in (self.pq / f"sensor={sensor}").glob("year=*/*.parquet"))
        if not files:
            return "detections", []
        sp_end = self.sp_end.get(sensor, "1900-01-01")
        rows = c.execute(f"""
            SELECT strftime(acq_date, '%Y-%m') AS m, count(*), coalesce(sum(frp), 0)
            FROM read_parquet({files!r}, union_by_name=true)
            WHERE {area_sql(area)} AND {tcond} {dn}
              AND (source <> 'NRT_API' OR acq_date > DATE '{sp_end}')
            GROUP BY 1 ORDER BY 1
        """).fetchall()
        return "detections", rows
    rows = c.execute(f"""
        SELECT strftime(month, '%Y-%m') AS m, sum(n), coalesce(sum(frp_sum), 0)
        FROM read_parquet('{self.grid.as_posix()}')
        WHERE sensor = ? AND {area_sql(area, 'cell_lat', 'cell_lon')} AND {tcond} {dn}
        GROUP BY 1 ORDER BY 1
    """, [sensor]).fetchall()
    return "grid", rows


def _export(self, sensor: str, area: dict, d0: str, d1: str, types: list[int]) -> bytes:
    import datetime as dt
    import os
    import tempfile

    a, b = dt.date.fromisoformat(d0), dt.date.fromisoformat(d1)
    files = sorted(f.as_posix() for y in range(a.year, b.year + 1)
                   for f in (self.pq / f"sensor={sensor}" / f"year={y}").glob("*.parquet"))
    if not files:
        return b"latitude,longitude,acq_date,acq_time_utc,satellite,sensor,confidence,frp_mw,daynight,type,source\n"
    sp_end = self.sp_end.get(sensor, "1900-01-01")
    fd, tmp = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    try:
        self.con().execute(f"""
            COPY (
              SELECT latitude, longitude, acq_date, lpad(CAST(acq_time AS VARCHAR), 4, '0') AS acq_time_utc,
                     satellite, sensor, confidence_class AS confidence, frp AS frp_mw, daynight,
                     type, source
              FROM read_parquet({files!r}, union_by_name=true)
              WHERE acq_date BETWEEN DATE '{a}' AND DATE '{b}' AND {area_sql(area)}
                AND coalesce(type, -1) IN ({','.join(map(str, types))})
                AND (source <> 'NRT_API' OR acq_date > DATE '{sp_end}')
              ORDER BY acq_date, acq_time LIMIT 2000000
            ) TO '{Path(tmp).as_posix()}' (HEADER, DELIMITER ',')
        """)
        return Path(tmp).read_bytes()
    finally:
        os.remove(tmp)


def _regions(self, series: str, rtype: str, moy: int):
    """Harmonized regional values for one calendar month (1-12) in every year: [id, YYYY-MM, value, lo90, hi90, origin]."""
    if not self.harm_region.exists():
        return []
    return self.con().execute(f"""
        SELECT region_id, strftime(month, '%Y-%m'), value, lo90, hi90,
               CASE origin WHEN 'aqua_obs' THEN 0 WHEN 'viirs_conv' THEN 1 ELSE 2 END
        FROM read_parquet('{self.harm_region.as_posix()}')
        WHERE series = ? AND region_type = ? AND month(month) = ?
        ORDER BY 1, 2
    """, [series, rtype, moy]).fetchall()


Store.regions = _regions
Store.calendar = _calendar
Store.export = _export


def make_handler(store: Store):
    class H(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quiet
            pass

        def send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "X-Total, X-Returned")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def error(self, code: int, msg: str):
            self.send(code, json.dumps({"error": msg}).encode(), "application/json")

        def do_POST(self):
            # Same endpoints as GET; a place area (list of grid cells) is too long for a URL and comes as JSON.
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                n = int(self.headers.get("Content-Length", "0"))
                assert 0 < n <= 4_000_000
                q.update(json.loads(self.rfile.read(n)))
            except (ValueError, AssertionError):
                return self.error(400, "JSON body required")
            if u.path not in ("/api/calendar", "/api/export"):
                return self.error(404, "not found")
            return self.route(u, q)

        def do_GET(self):
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            return self.route(u, q)

        def route(self, u, q: dict):
            if u.path == "/api/health":
                return self.send(200, json.dumps({"sensors": store.sp_end}).encode(), "application/json")
            if u.path == "/api/regions":
                series, rtype, moy = q.get("series", ""), q.get("type", ""), q.get("month", "")
                if series not in ("long", "detail") or rtype not in ("country", "gfed") or not moy.isdigit() or not 1 <= int(moy) <= 12:
                    return self.error(400, "series=long|detail&type=country|gfed&month=1..12 required")
                rows = [[r[0], r[1], round(r[2], 2), round(r[3], 2), round(r[4], 2), r[5]] for r in store.regions(series, rtype, int(moy))]
                return self.send(200, json.dumps({"rows": rows}).encode(), "application/json")
            if u.path in ("/api/calendar", "/api/export"):
                sensor = q.get("sensor", "")
                try:
                    assert SENSOR_RE.match(sensor)
                    area = parse_area(q)
                    types = [int(t) for t in q.get("types", "0,-1").split(",")]
                except (ValueError, AssertionError, KeyError, TypeError):
                    return self.error(400, "sensor, and bbox=w,s,e,n or circle=lat,lon,km (or cells in a POST body) required")
                if u.path == "/api/calendar":
                    source, rows = store.calendar(sensor, area, types, q.get("pass", "all"))
                    body = {"sensor": sensor, "source": source,
                            "months": [[r[0], round(float(r[1]), 3), round(float(r[2]), 1)] + ([int(r[3])] if len(r) > 3 else [])
                                       for r in rows]}
                    return self.send(200, json.dumps(body).encode(), "application/json")
                d0, d1 = q.get("from", ""), q.get("to", "")
                if not (DATE_RE.match(d0) and DATE_RE.match(d1)) or d0 > d1:
                    return self.error(400, "from=YYYY-MM-DD&to=YYYY-MM-DD required")
                body = store.export(sensor, area, d0, d1, types)
                name = f"firms_{sensor.lower()}_{d0}_{d1}.csv"
                return self.send(200, body, "text/csv; charset=utf-8", {"Content-Disposition": f'attachment; filename="{name}"'})
            if u.path != "/api/detections":
                return self.error(404, "not found")
            sensor, period = q.get("sensor", ""), q.get("date") or q.get("month", "")
            if not SENSOR_RE.match(sensor) or not (MONTH_RE.match(period) or DATE_RE.match(period)):
                return self.error(400, "sensor and month=YYYY-MM or date=YYYY-MM-DD required")
            try:
                bbox = tuple(float(x) for x in q.get("bbox", "-180,-90,180,90").split(","))
                assert len(bbox) == 4 and -90 <= bbox[1] <= bbox[3] <= 90
                limit = max(1, min(int(q.get("limit", 150_000)), 500_000))
                types = [int(t) for t in q.get("types", "0,-1").split(",")]
            except (ValueError, AssertionError):
                return self.error(400, "bbox=w,s,e,n in degrees; limit and types must be integers")
            try:
                total, body = store.detections(sensor, period, bbox, limit, types)
            except ValueError:
                return self.error(400, "invalid date")
            self.send(200, body, "application/octet-stream", {"X-Total": str(total), "X-Returned": str(len(body) // 28)})

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5198)
    a = ap.parse_args()
    store = Store(Path(a.data))
    print(f"fire_api on http://{a.host}:{a.port}  SP end: {store.sp_end}", flush=True)
    ThreadingHTTPServer((a.host, a.port), make_handler(store)).serve_forever()


if __name__ == "__main__":
    main()
