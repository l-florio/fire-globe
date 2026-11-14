"""Harmonized MODIS / VIIRS active-fire record (frozen method, 2026-11-14). See HARMONIZATION.md.

  python harmonize.py fit                    # local only, needs the full archive in data/parquet; writes coefficients.parquet
  python harmonize.py apply --from YYYY-MM   # applies the FROZEN coefficients to the data present in data/parquet and
                                             # rewrites harm_map.parquet and harm_region.parquet from that month on

Two series (1 deg x month):
  long    Aqua-equivalent detections from 2003-01: Aqua MODIS as observed until 2021-12 (origin aqua_obs); from 2022-01, and in
          2020-08 (Aqua outage), VIIRS converted to Aqua units (origin viirs_conv).
  detail  VIIRS 375 m detections from 2013-01, S-NPP level, harmonized only among S-NPP, NOAA-20 and NOAA-21 (origin viirs_native).
Conversion VIIRS -> Aqua units: predictor = FRP-weighted 1-km clusters (detections of one overpass in one ~1 km ground cell,
weight F^2/(F^2+100), F = summed FRP in MW), daily mean of the satellites that are not in outage; ratio Aqua/predictor
calibrated on S-NPP vs Aqua 2013-2020 (2020-08 excluded) per 2.5-deg block x calendar month x day/night, shrunk toward the
latitude band, plus a 1-deg cell term (fine method, harm_map) or per 10-deg block (coarse method, harm_region).
apply has no dependency on historical data: everything it needs is in coefficients.parquet and interval_table.json.
Requires: duckdb, numpy, pandas, pyarrow."""
from __future__ import annotations

import argparse, glob, json, os, sys, time
import duckdb
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)).replace(os.sep, "/")
PQ = f"{HERE}/data/parquet"
OUT = f"{HERE}/data/harmonized"
COEF = f"{OUT}/coefficients.parquet"
SENSORS = {"snpp": "VIIRS_SNPP", "n20": "VIIRS_NOAA20", "n21": "VIIRS_NOAA21"}
K25, K1, MIN10 = 20.0, 1000.0, 200.0          # shrinkage constants of the frozen method
AQUA_OUT = ["2020-08-01"]                     # Aqua outage months inside the observed era, replaced by converted VIIRS
LONG_START, DETAIL_START, CONV_START = "2003-01-01", "2013-01-01", "2022-01-01"
BAND = "CASE WHEN lat1>=50 THEN 0 WHEN lat1>=23 THEN 1 WHEN lat1>-23 THEN 2 ELSE 3 END"


def src(sensor: str, y: int) -> str | None:
    d = f"{PQ}/sensor={sensor}/year={y}"
    return f"read_parquet('{d}/*.parquet', hive_partitioning=false)" if glob.glob(f"{d}/*.parquet") else None


def viirs_daily(con, y: int, d0: str = "1900-01-01") -> bool:
    """TEMP TABLE vd(s, lat1, lon1, d, dn, h10, raw): weighted 1-km clusters and raw detections, per satellite and day."""
    con.execute("CREATE OR REPLACE TEMP TABLE vd (s VARCHAR, lat1 INT, lon1 INT, d DATE, dn VARCHAR, h10 DOUBLE, raw DOUBLE)")
    found = False
    for s, sensor in SENSORS.items():
        q = src(sensor, y)
        if not q: continue
        found = True
        con.execute(f"""INSERT INTO vd SELECT '{s}', lat1, lon1, d, dn, sum(f*f/(f*f+100)), sum(n) FROM (
            SELECT floor(latitude)::INT lat1, floor(longitude)::INT lon1, acq_date d, daynight dn, acq_time//100 h,
                   floor(latitude/0.01)::INT gi, floor(longitude*cos(radians(floor(latitude)+0.5))/0.01)::INT gj, count(*) n, sum(coalesce(frp,0)) f
            FROM {q} x ANTI JOIN mask ON round(x.latitude,1)=mask.la AND round(x.longitude,1)=mask.lo
            WHERE acq_date >= DATE '{d0}' GROUP BY ALL) GROUP BY ALL""")
    return found


def flags(con, tbl: str = "vd", val: str = "raw") -> None:
    """TEMP TABLE fl(d, a_s, a_n, a_v): 1 when the satellite is usable that day (its world total is at least half of the
    best other satellite; a satellite with no data is out)."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE g_ AS SELECT s, d, sum({val}) g FROM {tbl} GROUP BY ALL")
    con.execute("""CREATE OR REPLACE TEMP TABLE fl AS
      WITH gg AS (SELECT t.s, dd.d, coalesce(g_.g, 0) g FROM (SELECT DISTINCT d FROM g_) dd CROSS JOIN (VALUES ('snpp'), ('n20'), ('n21')) t(s)
                  LEFT JOIN g_ ON g_.s = t.s AND g_.d = dd.d),
           o AS (SELECT a.s, a.d, a.g, max(b.g) mx FROM gg a JOIN gg b ON a.d = b.d AND a.s <> b.s GROUP BY a.s, a.d, a.g)
      SELECT d, max(CASE WHEN s='snpp' THEN ok END) a_s, max(CASE WHEN s='n20' THEN ok END) a_n, max(CASE WHEN s='n21' THEN ok END) a_v
      FROM (SELECT s, d, (g > 0 AND g >= 0.5*mx)::INT ok FROM o) GROUP BY d""")


def static_mask(con) -> None:
    con.execute(f"""CREATE TABLE mask AS SELECT round(latitude,1) la, round(longitude,1) lo
      FROM read_parquet('{PQ}/sensor=VIIRS_SNPP/year=*/*.parquet', hive_partitioning=false)
      WHERE year(acq_date) BETWEEN 2013 AND 2025 GROUP BY ALL HAVING avg((coalesce(type,0) IN (1,2,3))::INT) > 0.5""")


# ------------------------------------------------------------------ fit
def fit() -> None:
    t0 = time.time(); os.makedirs(OUT, exist_ok=True)
    con = duckdb.connect(); con.execute("SET enable_progress_bar=false")
    static_mask(con)
    con.execute("CREATE TABLE co (kind VARCHAR, lat DOUBLE, lon DOUBLE, mo INT, dn VARCHAR, key VARCHAR, value DOUBLE, weight DOUBLE)")
    con.execute("INSERT INTO co SELECT 'mask', la, lo, NULL, NULL, NULL, NULL, NULL FROM mask")
    # calibration: S-NPP weighted clusters vs Aqua detections, 2013-2020, 1 deg x month x day/night
    con.execute("CREATE TABLE cal (lat1 INT, lon1 INT, y INT, mo INT, dn VARCHAR, v DOUBLE, m DOUBLE)")
    for y in range(2013, 2021):
        con.execute(f"""CREATE OR REPLACE TEMP TABLE v_ AS SELECT lat1, lon1, mo, dn, sum(f*f/(f*f+100)) v FROM (
            SELECT floor(latitude)::INT lat1, floor(longitude)::INT lon1, month(acq_date) mo, acq_date d, daynight dn, acq_time//100 h,
                   floor(latitude/0.01)::INT gi, floor(longitude*cos(radians(floor(latitude)+0.5))/0.01)::INT gj, sum(coalesce(frp,0)) f
            FROM {src('VIIRS_SNPP', y)} x ANTI JOIN mask ON round(x.latitude,1)=mask.la AND round(x.longitude,1)=mask.lo GROUP BY ALL) GROUP BY ALL""")
        con.execute(f"""CREATE OR REPLACE TEMP TABLE m_ AS SELECT floor(latitude)::INT lat1, floor(longitude)::INT lon1, month(acq_date) mo, daynight dn, count(*)::DOUBLE m
            FROM {src('MODIS', y)} x ANTI JOIN mask ON round(x.latitude,1)=mask.la AND round(x.longitude,1)=mask.lo WHERE satellite='Aqua' GROUP BY ALL""")
        con.execute(f"""INSERT INTO cal SELECT lat1, lon1, {y}, mo, dn, coalesce(v,0), coalesce(m,0) FROM v_ FULL JOIN m_ USING (lat1, lon1, mo, dn)
            WHERE NOT ({y} = 2020 AND mo = 8)""")
        print("calibration", y, flush=True)
    con.execute(f"""INSERT INTO co SELECT 'r_glob', NULL, NULL, NULL, NULL, NULL, sum(m)/sum(v), sum(v) FROM cal""")
    con.execute(f"""INSERT INTO co SELECT 'r_band', NULL, NULL, mo, dn, ({BAND})::VARCHAR, sum(m)/sum(v), sum(v) FROM cal GROUP BY ALL HAVING sum(v) > 0""")
    for kind, size in (("r_blk10", 10), ("r_b25", 2.5), ("r_cell", 1)):
        con.execute(f"""INSERT INTO co SELECT '{kind}', floor(lat1/{size})*{size}, floor(lon1/{size})*{size}, mo, dn, NULL, sum(m)/sum(v), sum(v)
                        FROM cal GROUP BY ALL HAVING sum(v) > 0""")
    # level factors between VIIRS satellites (daily sums by latitude band, days when both satellites are usable)
    con.execute("CREATE TABLE db (s VARCHAR, d DATE, dn VARCHAR, band INT, h10 DOUBLE, raw DOUBLE)")
    for y in range(2018, 2100):
        if not viirs_daily(con, y): break
        con.execute(f"INSERT INTO db SELECT s, d, dn, {BAND}, sum(h10), sum(raw) FROM vd GROUP BY ALL")
        print("level factors", y, flush=True)
    flags(con, "db")
    con.execute("""CREATE TABLE w AS SELECT d, dn, band, a_s, a_n, a_v,
        coalesce(sum(raw) FILTER (s='snpp'),0) sr, coalesce(sum(raw) FILTER (s='n20'),0) nr, coalesce(sum(raw) FILTER (s='n21'),0) vr,
        coalesce(sum(h10) FILTER (s='n20'),0) nw, coalesce(sum(h10) FILTER (s='n21'),0) vw
        FROM db JOIN fl USING (d) GROUP BY ALL""")
    con.execute("""INSERT INTO co SELECT 'lvl_n20_raw', NULL, NULL, NULL, dn, band::VARCHAR, sum(sr)/sum(nr), sum(nr) FROM w
                   WHERE a_s = 1 AND a_n = 1 AND d BETWEEN DATE '2018-04-01' AND DATE '2025-12-31' GROUP BY ALL""")
    last = con.execute("SELECT max(d) FROM db").fetchone()[0]
    for kind, a, b in (("lvl_n21_w", "nw", "vw"), ("lvl_n21_raw", "nr", "vr")):  # NOAA-20 / NOAA-21 over the 12 months before each month
        con.execute(f"""INSERT INTO co SELECT '{kind}', NULL, NULL, year(mth)*12 + month(mth) - 1, dn, band::VARCHAR, CASE WHEN k >= 3 AND sb > 0 THEN sa/sb ELSE 1 END, sb FROM (
            SELECT band, dn, mth, sum(a) OVER x sa, sum(b) OVER x sb, count(*) OVER x k FROM (
               SELECT band, dn, date_trunc('month', d)::DATE mth, sum({a}) a, sum({b}) b FROM w
               WHERE a_n = 1 AND a_v = 1 AND d >= DATE '2023-03-01' AND d < date_trunc('month', DATE '{last}' + INTERVAL 1 DAY) GROUP BY ALL)
            WINDOW x AS (PARTITION BY band, dn ORDER BY mth ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING))""")
    # region maps for harm_region
    gf = f"{HERE}/../diagnostica/gfed_regions_1deg.parquet"
    con.execute(f"INSERT INTO co SELECT 'gfed', lat1, lon1, NULL, NULL, name, NULL, NULL FROM '{gf}' WHERE name <> 'Ocean'")
    con.execute(f"""INSERT INTO co SELECT 'country', lat1, lon1, NULL, NULL, arg_max(country, n), NULL, NULL FROM (
        SELECT floor(latitude)::INT lat1, floor(longitude)::INT lon1, country, count(*) n
        FROM read_parquet('{PQ}/sensor=MODIS/year=*/*.parquet', hive_partitioning=false)
        WHERE country IS NOT NULL AND year(acq_date) <= 2025 GROUP BY ALL) GROUP BY ALL""")
    con.execute(f"COPY (SELECT * FROM co ORDER BY kind, lat, lon, mo, dn, key) TO '{COEF}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    print(con.execute("SELECT kind, count(*) FROM co GROUP BY 1 ORDER BY 1").fetchall())
    print(f"fit done in {time.time()-t0:.0f}s -> {COEF}")


# ------------------------------------------------------------------ apply
def bounds(value: np.ndarray, tab: dict) -> tuple[np.ndarray, np.ndarray]:
    edges = np.array([e for e in tab["level_upper_edges"] if e is not None]); i = np.searchsorted(edges, value, side="right")
    q05, q95 = np.array(tab["q05"]), np.array(tab["q95"])
    return np.maximum(0.0, (value + 1) * q05[i] - 1), (value + 1) * q95[i] - 1


def write_merged(con, path: str, new_sql: str, d0: str, order: str) -> None:
    keep = f"SELECT * FROM '{path}' WHERE month < DATE '{d0}' UNION ALL BY NAME " if os.path.exists(path) else ""
    tmp = path + ".tmp"
    con.execute(f"COPY (SELECT * FROM ({keep}{new_sql}) ORDER BY {order}) TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    os.replace(tmp, path)


FLIES = {"snpp": ("2012-01-19", "2026-11-02"), "n20": ("2018-04-01", "2100-01-01"), "n21": ("2023-03-01", "2100-01-01")}


def check_coverage(con, d0: str, allow_partial: bool) -> None:
    """Stop if a satellite that flies in the first month has no data from the first days of that month: the month would
    be understated without any error (monthly totals, level factors and outage detection all need whole days)."""
    y0, problems = int(d0[:4]), []
    for s, sensor in SENSORS.items():
        q = src(sensor, y0)
        start, end = FLIES[s]
        need = max(d0, start)
        if not q or need > end: continue
        first = con.execute(f"SELECT min(acq_date) FROM {q}").fetchone()[0]
        if first is None or first > con.execute(f"SELECT DATE '{need}' + 3").fetchone()[0]:
            problems.append(f"{sensor} starts on {first}, needed from {need}")
    q = src("MODIS", y0)
    if d0 < CONV_START and q:
        first = con.execute(f"SELECT min(acq_date) FROM {q}").fetchone()[0]
        if first is None or first > con.execute(f"SELECT DATE '{d0}' + 3").fetchone()[0]:
            problems.append(f"MODIS starts on {first}, needed from {d0}")
    if problems and not allow_partial:
        sys.exit("apply --from %s refused: data in data/parquet do not cover the whole first month (%s). "
                 "Download from the first day of that month or use a later --from; --allow-partial overrides." % (d0[:7], "; ".join(problems)))
    if problems: print("WARNING (--allow-partial):", "; ".join(problems), flush=True)


def apply(d0: str, allow_partial: bool = False) -> None:
    t0 = time.time()
    con = duckdb.connect(); con.execute("SET enable_progress_bar=false")
    check_coverage(con, d0, allow_partial)
    co = f"'{COEF}'"
    con.execute(f"CREATE TABLE mask AS SELECT lat la, lon lo FROM {co} WHERE kind='mask'")
    for kind in ("r_blk10", "r_b25", "r_cell"):
        con.execute(f"CREATE TABLE {kind} AS SELECT lat, lon, mo, dn, value r, weight sv FROM {co} WHERE kind='{kind}'")
    con.execute(f"CREATE TABLE r_band AS SELECT key::INT band, mo, dn, value r FROM {co} WHERE kind='r_band'")
    rglob = con.execute(f"SELECT value FROM {co} WHERE kind='r_glob'").fetchone()[0]
    con.execute(f"CREATE TABLE f20 AS SELECT key::INT band, dn, value f FROM {co} WHERE kind='lvl_n20_raw'")
    con.execute(f"CREATE TABLE f21 AS SELECT kind, key::INT band, dn, mo ym, value f FROM {co} WHERE kind IN ('lvl_n21_w', 'lvl_n21_raw')")
    con.execute(f"CREATE TABLE reg AS SELECT kind, lat::INT lat1, lon::INT lon1, key id FROM {co} WHERE kind IN ('gfed', 'country')")
    y0 = int(d0[:4])
    # ---- VIIRS: monthly weighted predictor (vw) and harmonized raw detections (vr), year by year
    con.execute("CREATE TABLE vm (lat1 INT, lon1 INT, month DATE, dn VARCHAR, vw DOUBLE, vr DOUBLE)")
    last_day = None
    for y in range(max(y0, 2013), 2100):
        if not viirs_daily(con, y, d0):
            if y > time.gmtime().tm_year: break
            continue
        flags(con)
        con.execute("""CREATE OR REPLACE TEMP TABLE fy AS SELECT g.ym, g.band, g.dn,
              coalesce((SELECT f FROM f21 l WHERE l.kind='lvl_n21_w' AND l.band=g.band AND l.dn=g.dn AND l.ym <= g.ym ORDER BY l.ym DESC LIMIT 1), 1) fw,
              coalesce((SELECT f FROM f21 l WHERE l.kind='lvl_n21_raw' AND l.band=g.band AND l.dn=g.dn AND l.ym <= g.ym ORDER BY l.ym DESC LIMIT 1), 1) fr
            FROM (SELECT DISTINCT year(d)*12 + month(d) - 1 ym, b.band, n.dn FROM vd, (VALUES (0),(1),(2),(3)) b(band), (VALUES ('D'),('N')) n(dn)) g""")
        # daily value = mean of the first two usable satellites in the order S-NPP, NOAA-20, NOAA-21 (one alone if only one is usable)
        con.execute(f"""INSERT INTO vm
          SELECT lat1, lon1, date_trunc('month', d)::DATE, dn,
                 sum((sw*a_s + nw*a_n + vw_*fw*uv) / nullif(a_s + a_n + uv, 0)),
                 sum((sr*a_s + nr*f20f*a_n + vr_*fr*f20f*uv) / nullif(a_s + a_n + uv, 0))
          FROM (SELECT w.*, fl.a_s, fl.a_n, CASE WHEN fl.a_v = 1 AND fl.a_s + fl.a_n < 2 THEN 1 ELSE 0 END uv, fy.fw, fy.fr, coalesce(f20.f, 1) f20f
                FROM (SELECT lat1, lon1, d, dn, {BAND} band,
                        coalesce(sum(h10) FILTER (s='snpp'),0) sw, coalesce(sum(h10) FILTER (s='n20'),0) nw, coalesce(sum(h10) FILTER (s='n21'),0) vw_,
                        coalesce(sum(raw) FILTER (s='snpp'),0) sr, coalesce(sum(raw) FILTER (s='n20'),0) nr, coalesce(sum(raw) FILTER (s='n21'),0) vr_
                      FROM vd GROUP BY ALL) w
                JOIN fl USING (d) JOIN fy ON fy.ym = year(w.d)*12 + month(w.d) - 1 AND fy.band = w.band AND fy.dn = w.dn
                LEFT JOIN f20 ON f20.band = w.band AND f20.dn = w.dn)
          GROUP BY ALL""")
        last_day = con.execute("SELECT max(d) FROM vd").fetchone()[0]
        print("viirs", y, f"{time.time()-t0:.0f}s", flush=True)
    # ---- Aqua observed (only for months before the conversion era)
    con.execute("CREATE TABLE am (lat1 INT, lon1 INT, month DATE, dn VARCHAR, m DOUBLE)")
    for y in range(max(y0, 2003), 2022):
        q = src("MODIS", y)
        if not q: continue
        con.execute(f"""INSERT INTO am SELECT floor(latitude)::INT, floor(longitude)::INT, date_trunc('month', acq_date)::DATE, daynight, count(*)
            FROM {q} x ANTI JOIN mask ON round(x.latitude,1)=mask.la AND round(x.longitude,1)=mask.lo
            WHERE satellite='Aqua' AND acq_date >= DATE '{d0}' GROUP BY ALL""")
    aq_out = ", ".join(f"DATE '{d}'" for d in AQUA_OUT)
    # ---- long series (fine and coarse values) and detail series, 1 deg x month x day/night
    con.execute(f"""CREATE TABLE cellv AS
      SELECT 'long' series, lat1, lon1, month, dn, m fine, m coarse, 'aqua_obs' origin FROM am
        WHERE month >= DATE '{LONG_START}' AND month < DATE '{CONV_START}' AND month NOT IN ({aq_out})
      UNION ALL
      SELECT 'long', v.lat1, v.lon1, v.month, v.dn,
             v.vw * exp( (coalesce(c.sv,0)/(coalesce(c.sv,0)+{K1})) * ln(greatest(coalesce(c.r,1e-6),1e-6))
                       + ({K1}/(coalesce(c.sv,0)+{K1})) * ( (coalesce(b.sv,0)/(coalesce(b.sv,0)+{K25})) * ln(greatest(coalesce(b.r,1e-6),1e-6))
                                                          + ({K25}/(coalesce(b.sv,0)+{K25})) * ln(coalesce(rb.r, {rglob})) ) ),
             v.vw * CASE WHEN t.sv >= {MIN10} THEN t.r ELSE coalesce(rb.r, {rglob}) END, 'viirs_conv'
        FROM vm v
        LEFT JOIN r_cell c ON c.lat = v.lat1 AND c.lon = v.lon1 AND c.mo = month(v.month) AND c.dn = v.dn
        LEFT JOIN r_b25 b ON b.lat = floor(v.lat1/2.5)*2.5 AND b.lon = floor(v.lon1/2.5)*2.5 AND b.mo = month(v.month) AND b.dn = v.dn
        LEFT JOIN r_blk10 t ON t.lat = floor(v.lat1/10)*10 AND t.lon = floor(v.lon1/10)*10 AND t.mo = month(v.month) AND t.dn = v.dn
        LEFT JOIN r_band rb ON rb.band = (CASE WHEN v.lat1>=50 THEN 0 WHEN v.lat1>=23 THEN 1 WHEN v.lat1>-23 THEN 2 ELSE 3 END) AND rb.mo = month(v.month) AND rb.dn = v.dn
        WHERE v.month >= DATE '{CONV_START}' OR v.month IN ({aq_out})
      UNION ALL
      SELECT 'detail', lat1, lon1, month, dn, vr, vr, 'viirs_native' FROM vm WHERE month >= DATE '{DETAIL_START}'""")
    con.execute("DELETE FROM cellv WHERE NOT (fine > 0 OR coarse > 0)")
    if last_day is None: last_day = con.execute("SELECT max(month) FROM cellv").fetchone()[0]
    part = f"(month = date_trunc('month', DATE '{last_day}') AND DATE '{last_day}' < (date_trunc('month', DATE '{last_day}') + INTERVAL 1 MONTH - INTERVAL 1 DAY))"
    os.makedirs(OUT, exist_ok=True)
    write_merged(con, f"{OUT}/harm_map.parquet", f"""SELECT series, month, (lat1 + 0.5)::DOUBLE cell_lat, (lon1 + 0.5)::DOUBLE cell_lon, round(sum(fine), 3) value,
        round(coalesce(sum(fine) FILTER (dn='D'), 0), 3) value_day, round(coalesce(sum(fine) FILTER (dn='N'), 0), 3) value_night,
        any_value(origin) origin, {part} partial FROM cellv GROUP BY series, month, lat1, lon1 HAVING round(sum(fine), 3) > 0""", d0, "series, month, cell_lat, cell_lon")
    # ---- regional product (coarse method) with 90% bounds from interval_table.json
    df = con.execute("""SELECT series, region_type, region_id, month, sum(coarse) value, any_value(origin) origin FROM (
          SELECT c.series, r.kind region_type, r.id region_id, c.month, c.coarse, c.origin FROM cellv c JOIN reg r USING (lat1, lon1)
          UNION ALL
          SELECT series, 'block10', printf('%+03d_%+04d', (floor(lat1/10)*10)::INT, (floor(lon1/10)*10)::INT), month, coarse, origin FROM cellv)
        GROUP BY ALL HAVING sum(coarse) > 0""").fetchdf()
    it = json.load(open(f"{OUT}/interval_table.json", encoding="utf-8"))
    v = df["value"].to_numpy(float); lo = v.copy(); hi = v.copy(); yr = df["month"].dt.year.to_numpy(); org = df["origin"].to_numpy()
    s = org == "viirs_native"
    if s.any(): lo[s], hi[s] = bounds(v[s], it["detail"]["viirs_native"])
    tabc = it["long_region"]["viirs_conv"]
    for y in np.unique(yr[org == "viirs_conv"]):
        s = (org == "viirs_conv") & (yr == y)
        t = dict(tabc, **tabc["by_year"][str(int(y))]) if str(int(y)) in tabc["by_year"] else tabc
        lo[s], hi[s] = bounds(v[s], t)
    df["value"] = np.round(v, 3); df["lo90"] = np.round(lo, 3); df["hi90"] = np.round(hi, 3)
    df = df[df["value"] > 0]
    con.register("rg", df)
    write_merged(con, f"{OUT}/harm_region.parquet", "SELECT series, region_type, region_id, month::DATE AS month, value, lo90, hi90, origin FROM rg", d0,
                 "series, region_type, region_id, month")
    for f in ("harm_map", "harm_region"):
        print(f, con.execute(f"SELECT series, count(*), min(month), max(month), round(sum(value)) FROM '{OUT}/{f}.parquet' GROUP BY 1 ORDER BY 1").fetchall())
    print(f"apply done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fit")
    a = sub.add_parser("apply"); a.add_argument("--from", dest="start", required=True, help="first month to (re)write, YYYY-MM")
    a.add_argument("--allow-partial", action="store_true", help="run even if data do not cover the whole first month")
    args = ap.parse_args()
    if args.cmd == "fit": fit()
    else:
        if not os.path.exists(COEF): sys.exit(f"missing {COEF}: run 'fit' locally and commit the file")
        apply(args.start + "-01", args.allow_partial)
