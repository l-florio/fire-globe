"""Out-of-sample validation exhibit for the MODIS / VIIRS harmonization (see ../HARMONIZATION.md).

  python data_pipeline/validation/make_validation.py            # full run (needs data/parquet, about 5-10 minutes)
  python data_pipeline/validation/make_validation.py --reuse    # skip the heavy step, reuse the cached comparison table

What it does, without modifying harmonize.py (its helpers are imported):
  1. Rebuilds the S-NPP vs Aqua calibration table 2013-2020 (as `harmonize.py fit`) and the monthly VIIRS predictor
     2013-2025 (as `harmonize.py apply`, same level factors from coefficients.parquet).
  2. Converts VIIRS to Aqua units OUT OF SAMPLE: 2013-2020 leave-one-year-out (coefficients refitted without the year),
     2021-2025 with coefficients calibrated on 2013-2020 (the frozen ones).
  3. Compares with Aqua as observed, applies the 90% interval table, writes figures and numbers to docs/validation/.
Inputs: data/parquet (FIRMS archive normalized by firms_pipeline.py), data/harmonized/coefficients.parquet (mask, region maps,
level factors), interval_table.json, harm_region.parquet (only for the seam figure).
Requires: duckdb numpy pandas pyarrow matplotlib."""
from __future__ import annotations

import argparse, json, os, sys, textwrap, time
import duckdb
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__)).replace(os.sep, "/")
PIPE = os.path.dirname(HERE)
sys.path.insert(0, PIPE)
import harmonize as H  # noqa: E402  (imported only for its helpers; not modified)

ROOT = os.path.dirname(PIPE).replace(os.sep, "/")
DOCS = f"{ROOT}/docs/validation"
CACHE = f"{PIPE.replace(os.sep, '/')}/data/validation_cache"
COEF, HARM = H.COEF, H.OUT
Y0, Y1 = 2013, 2025
CONTINENT = {"BONA": "North America", "TENA": "North America", "CEAM": "North America", "NHSA": "South America",
             "SHSA": "South America", "NHAF": "Africa", "SHAF": "Africa", "EURO": "Europe", "BOAS": "Asia", "CEAS": "Asia",
             "SEAS": "Asia", "EQAS": "Asia", "MIDE": "Asia", "AUST": "Oceania"}
REGIONS = {"WORLD": "World", "BONA": "Boreal North America (GFED BONA)", "SHAF": "Southern Africa savanna (GFED SHAF)",
           "EQAS": "Equatorial Asia, peat (GFED EQAS)"}
SRC_NOTE = ("Data: NASA FIRMS active fire (MODIS C6.1 Aqua; VIIRS S-NPP, NOAA-20, NOAA-21 375 m), processed by data_pipeline/ "
            "(harmonize.py). Unit: Aqua-equivalent detections, not burned area.")


# ------------------------------------------------------------------ heavy step: out-of-sample comparison table
def build_cmp() -> pd.DataFrame:
    t0 = time.time()
    con = duckdb.connect(); con.execute("SET enable_progress_bar=false")
    co = f"'{COEF}'"
    con.execute(f"CREATE TABLE mask AS SELECT lat la, lon lo FROM {co} WHERE kind='mask'")
    con.execute(f"CREATE TABLE f20 AS SELECT key::INT band, dn, value f FROM {co} WHERE kind='lvl_n20_raw'")
    con.execute(f"CREATE TABLE f21 AS SELECT kind, key::INT band, dn, mo ym, value f FROM {co} WHERE kind IN ('lvl_n21_w', 'lvl_n21_raw')")
    # ---- calibration table (S-NPP weighted clusters vs Aqua, 1 deg x year x month x day/night), as in harmonize.fit
    con.execute("CREATE TABLE cal (lat1 INT, lon1 INT, y INT, mo INT, dn VARCHAR, v DOUBLE, m DOUBLE)")
    for y in range(2013, 2021):
        con.execute(f"""CREATE OR REPLACE TEMP TABLE v_ AS SELECT lat1, lon1, mo, dn, sum(f*f/(f*f+100)) v FROM (
            SELECT floor(latitude)::INT lat1, floor(longitude)::INT lon1, month(acq_date) mo, acq_date d, daynight dn, acq_time//100 h,
                   floor(latitude/0.01)::INT gi, floor(longitude*cos(radians(floor(latitude)+0.5))/0.01)::INT gj, sum(coalesce(frp,0)) f
            FROM {H.src('VIIRS_SNPP', y)} x ANTI JOIN mask ON round(x.latitude,1)=mask.la AND round(x.longitude,1)=mask.lo GROUP BY ALL) GROUP BY ALL""")
        con.execute(f"""CREATE OR REPLACE TEMP TABLE m_ AS SELECT floor(latitude)::INT lat1, floor(longitude)::INT lon1, month(acq_date) mo, daynight dn, count(*)::DOUBLE m
            FROM {H.src('MODIS', y)} x ANTI JOIN mask ON round(x.latitude,1)=mask.la AND round(x.longitude,1)=mask.lo WHERE satellite='Aqua' GROUP BY ALL""")
        con.execute(f"""INSERT INTO cal SELECT lat1, lon1, {y}, mo, dn, coalesce(v,0), coalesce(m,0) FROM v_ FULL JOIN m_ USING (lat1, lon1, mo, dn)
            WHERE NOT ({y} = 2020 AND mo = 8)""")
        print("calibration", y, f"{time.time()-t0:.0f}s", flush=True)
    # ---- monthly VIIRS predictor 2013-2025 (same SQL as harmonize.apply, whole history)
    con.execute("CREATE TABLE vm (lat1 INT, lon1 INT, month DATE, dn VARCHAR, vw DOUBLE, vr DOUBLE)")
    for y in range(Y0, Y1 + 1):
        if not H.viirs_daily(con, y): continue
        H.flags(con)
        con.execute("""CREATE OR REPLACE TEMP TABLE fy AS SELECT g.ym, g.band, g.dn,
              coalesce((SELECT f FROM f21 l WHERE l.kind='lvl_n21_w' AND l.band=g.band AND l.dn=g.dn AND l.ym <= g.ym ORDER BY l.ym DESC LIMIT 1), 1) fw,
              coalesce((SELECT f FROM f21 l WHERE l.kind='lvl_n21_raw' AND l.band=g.band AND l.dn=g.dn AND l.ym <= g.ym ORDER BY l.ym DESC LIMIT 1), 1) fr
            FROM (SELECT DISTINCT year(d)*12 + month(d) - 1 ym, b.band, n.dn FROM vd, (VALUES (0),(1),(2),(3)) b(band), (VALUES ('D'),('N')) n(dn)) g""")
        con.execute(f"""INSERT INTO vm
          SELECT lat1, lon1, date_trunc('month', d)::DATE, dn,
                 sum((sw*a_s + nw*a_n + vw_*fw*uv) / nullif(a_s + a_n + uv, 0)),
                 sum((sr*a_s + nr*f20f*a_n + vr_*fr*f20f*uv) / nullif(a_s + a_n + uv, 0))
          FROM (SELECT w.*, fl.a_s, fl.a_n, CASE WHEN fl.a_v = 1 AND fl.a_s + fl.a_n < 2 THEN 1 ELSE 0 END uv, fy.fw, fy.fr, coalesce(f20.f, 1) f20f
                FROM (SELECT lat1, lon1, d, dn, {H.BAND} band,
                        coalesce(sum(h10) FILTER (s='snpp'),0) sw, coalesce(sum(h10) FILTER (s='n20'),0) nw, coalesce(sum(h10) FILTER (s='n21'),0) vw_,
                        coalesce(sum(raw) FILTER (s='snpp'),0) sr, coalesce(sum(raw) FILTER (s='n20'),0) nr, coalesce(sum(raw) FILTER (s='n21'),0) vr_
                      FROM vd GROUP BY ALL) w
                JOIN fl USING (d) JOIN fy ON fy.ym = year(w.d)*12 + month(w.d) - 1 AND fy.band = w.band AND fy.dn = w.dn
                LEFT JOIN f20 ON f20.band = w.band AND f20.dn = w.dn)
          GROUP BY ALL""")
        print("viirs", y, f"{time.time()-t0:.0f}s", flush=True)
    # ---- Aqua as observed, 2013-2025 (raw count; after 2021 the overpass drifts: shown for context only)
    con.execute("CREATE TABLE am (lat1 INT, lon1 INT, month DATE, m DOUBLE)")
    for y in range(Y0, Y1 + 1):
        q = H.src("MODIS", y)
        if q:
            con.execute(f"""INSERT INTO am SELECT floor(latitude)::INT, floor(longitude)::INT, date_trunc('month', acq_date)::DATE, count(*)
                FROM {q} x ANTI JOIN mask ON round(x.latitude,1)=mask.la AND round(x.longitude,1)=mask.lo WHERE satellite='Aqua' GROUP BY ALL""")
    print("aqua", f"{time.time()-t0:.0f}s", flush=True)
    # ---- coefficient folds and conversion (same shrinkage as harmonize.apply)
    con.execute("CREATE TABLE conv (lat1 INT, lon1 INT, month DATE, fine DOUBLE, coarse DOUBLE)")
    folds = [(f"f{y}", f"y <> {y}", f"year(v.month) = {y}") for y in range(2013, 2021)]
    folds.append(("fF", "TRUE", "year(v.month) BETWEEN 2021 AND 2025"))
    for name, cw, vw in folds:
        con.execute(f"CREATE OR REPLACE TEMP TABLE r_cell AS SELECT lat1 lat, lon1 lon, mo, dn, sum(m)/sum(v) r, sum(v) sv FROM cal WHERE {cw} GROUP BY ALL HAVING sum(v)>0")
        for kind, size in (("r_b25", 2.5), ("r_blk10", 10)):
            con.execute(f"""CREATE OR REPLACE TEMP TABLE {kind} AS SELECT floor(lat1/{size})*{size} lat, floor(lon1/{size})*{size} lon, mo, dn, sum(m)/sum(v) r, sum(v) sv
                            FROM cal WHERE {cw} GROUP BY ALL HAVING sum(v)>0""")
        con.execute(f"CREATE OR REPLACE TEMP TABLE r_band AS SELECT ({H.BAND}) band, mo, dn, sum(m)/sum(v) r FROM cal WHERE {cw} GROUP BY ALL HAVING sum(v)>0")
        rglob = con.execute(f"SELECT sum(m)/sum(v) FROM cal WHERE {cw}").fetchone()[0]
        if name == "fF":  # reproducibility check against the frozen coefficients
            stored = con.execute(f"SELECT value FROM {co} WHERE kind='r_glob'").fetchone()[0]
            print(f"check: r_glob recomputed {rglob:.9f} vs coefficients.parquet {stored:.9f}", flush=True)
            n_cell = con.execute("SELECT count(*) FROM r_cell").fetchone()[0]
            n_st = con.execute(f"SELECT count(*) FROM {co} WHERE kind='r_cell'").fetchone()[0]
            print(f"check: r_cell rows recomputed {n_cell} vs stored {n_st}", flush=True)
        K25, K1, MIN10 = H.K25, H.K1, H.MIN10
        con.execute(f"""INSERT INTO conv SELECT v.lat1, v.lon1, v.month,
             sum(v.vw * exp( (coalesce(c.sv,0)/(coalesce(c.sv,0)+{K1})) * ln(greatest(coalesce(c.r,1e-6),1e-6))
                       + ({K1}/(coalesce(c.sv,0)+{K1})) * ( (coalesce(b.sv,0)/(coalesce(b.sv,0)+{K25})) * ln(greatest(coalesce(b.r,1e-6),1e-6))
                                                          + ({K25}/(coalesce(b.sv,0)+{K25})) * ln(coalesce(rb.r, {rglob})) ) )),
             sum(v.vw * CASE WHEN t.sv >= {MIN10} THEN t.r ELSE coalesce(rb.r, {rglob}) END)
        FROM vm v
        LEFT JOIN r_cell c ON c.lat = v.lat1 AND c.lon = v.lon1 AND c.mo = month(v.month) AND c.dn = v.dn
        LEFT JOIN r_b25 b ON b.lat = floor(v.lat1/2.5)*2.5 AND b.lon = floor(v.lon1/2.5)*2.5 AND b.mo = month(v.month) AND b.dn = v.dn
        LEFT JOIN r_blk10 t ON t.lat = floor(v.lat1/10)*10 AND t.lon = floor(v.lon1/10)*10 AND t.mo = month(v.month) AND t.dn = v.dn
        LEFT JOIN r_band rb ON rb.band = (CASE WHEN v.lat1>=50 THEN 0 WHEN v.lat1>=23 THEN 1 WHEN v.lat1>-23 THEN 2 ELSE 3 END) AND rb.mo = month(v.month) AND rb.dn = v.dn
        WHERE {vw} GROUP BY v.lat1, v.lon1, v.month""")
        print("fold", name, f"{time.time()-t0:.0f}s", flush=True)
    # ---- comparison table (Aqua outage month 2020-08 removed from both sides)
    df = con.execute("""SELECT lat1, lon1, month, coalesce(c.fine,0) fine, coalesce(c.coarse,0) coarse, coalesce(a.m,0) aqua
        FROM conv c FULL JOIN (SELECT lat1, lon1, month, sum(m) m FROM am GROUP BY ALL) a USING (lat1, lon1, month)
        WHERE month <> DATE '2020-08-01'""").fetchdf()
    df["month"] = pd.to_datetime(df["month"])
    df = df[(df.fine > 0) | (df.coarse > 0) | (df.aqua > 0)].reset_index(drop=True)
    print(f"comparison table: {len(df)} cell-months, {time.time()-t0:.0f}s", flush=True)
    return df


# ------------------------------------------------------------------ analysis
def load_maps() -> tuple[pd.DataFrame, pd.DataFrame]:
    con = duckdb.connect()
    g = con.execute(f"SELECT lat::INT lat1, lon::INT lon1, key g FROM '{COEF}' WHERE kind='gfed'").fetchdf()
    c = con.execute(f"SELECT lat::INT lat1, lon::INT lon1, key c FROM '{COEF}' WHERE kind='country'").fetchdf()
    g["cont"] = g["g"].map(CONTINENT)
    return g, c


def intervals(value: np.ndarray, years: np.ndarray, tab: dict) -> tuple[np.ndarray, np.ndarray]:
    """90% bounds with the rule of interval_table.json: base table for 2013-2020, by_year (drift term) from 2021."""
    lo, hi = value.copy(), value.copy()
    for y in np.unique(years):
        s = years == y
        t = dict(tab, **tab["by_year"][str(int(y))]) if (y >= 2021 and str(int(y)) in tab["by_year"]) else tab
        lo[s], hi[s] = H.bounds(value[s], t)
    return lo, hi


def period(y: np.ndarray) -> np.ndarray:
    return np.where(y <= 2020, "LOYO 2013-2020", "Calibrated 2013-2020, tested 2021-2025")


def aggregate(df, key_cols, extra=None):
    d = df if extra is None else df.merge(extra, on=["lat1", "lon1"], how="inner")
    return d.groupby(key_cols + ["month"], as_index=False)[["fine", "coarse", "aqua"]].sum()


def analyse(df: pd.DataFrame) -> dict:
    gmap, cmap = load_maps()
    it = json.load(open(f"{HARM}/interval_table.json", encoding="utf-8"))
    tab_fine, tab_coarse = it["long"]["viirs_conv"], it["long_region"]["viirs_conv"]
    df = df.copy(); df["year"] = df.month.dt.year
    df["b25"] = (np.floor(df.lat1 / 2.5) * 2.5).astype(str) + "_" + (np.floor(df.lon1 / 2.5) * 2.5).astype(str)
    df["b10"] = (np.floor(df.lat1 / 10) * 10).astype(str) + "_" + (np.floor(df.lon1 / 10) * 10).astype(str)
    levels = {
        "cell (1 deg)": (df.assign(u=df.lat1.astype(str) + "_" + df.lon1.astype(str)), "u", "fine", tab_fine),
        "cell (2.5 deg)": (df.assign(u=df.b25), "u", "fine", tab_fine),
        "block (10 deg)": (df.assign(u=df.b10), "u", "coarse", tab_coarse),
        "GFED region": (df.merge(gmap[["lat1", "lon1", "g"]], on=["lat1", "lon1"]).rename(columns={"g": "u"}), "u", "coarse", tab_coarse),
        "country": (df.merge(cmap, on=["lat1", "lon1"]).rename(columns={"c": "u"}), "u", "coarse", tab_coarse),
        "continent (GFED groups)": (df.merge(gmap[["lat1", "lon1", "cont"]], on=["lat1", "lon1"]).rename(columns={"cont": "u"}), "u", "coarse", tab_coarse),
        "world": (df.assign(u="world"), "u", "coarse", tab_coarse),
    }
    out = {"coverage": [], "agg": {}}
    R_PROD, R_CELL = "harm_region product (coarse values, table long_region)", "cell-sum rule (fine values, table long)"
    for lev, (d, ucol, vcol, tab) in levels.items():
        a = d.groupby([ucol, "month"], as_index=False)[["fine", "coarse", "aqua"]].sum()
        a = a[(a[vcol] > 0) | (a.aqua > 0)].copy()
        a["year"] = a.month.dt.year
        rules = [(R_CELL if vcol == "fine" else R_PROD, vcol, tab)]
        if vcol == "coarse": rules.append((R_CELL, "fine", tab_fine))
        for rule, col, t in rules:
            b = a[(a[col] > 0) | (a.aqua > 0)].copy()
            lo, hi = intervals(b[col].to_numpy(float), b.year.to_numpy(), t)
            ins = (b.aqua >= lo) & (b.aqua <= hi)
            for per, s in (("2013-2020", b.year <= 2020), ("2021", b.year == 2021), ("2021-2025", b.year >= 2021)):
                out["coverage"].append({"level": lev, "rule": rule, "period": per, "n": int(s.sum()), "coverage_pct": round(100 * float(ins[s].mean()), 1)})
            if col == vcol:
                b["pred"], b["lo"], b["hi"] = b[col], lo, hi
                out["agg"][lev] = b.rename(columns={ucol: "u"})
    return out


def error_tables(out: dict, min_cell: int = 20) -> list[dict]:
    """Annual-total errors. Cell levels: only cell-years with at least `min_cell` Aqua detections (small cells are noise);
    region and world: all."""
    rows = []
    for lev in ("cell (1 deg)", "cell (2.5 deg)", "GFED region", "world"):
        a = out["agg"][lev]
        an = a.groupby(["u", "year"], as_index=False)[["pred", "aqua"]].sum()
        if lev.startswith("cell"): an = an[an.aqua >= min_cell]
        an = an[an.aqua > 0]
        an["pcterr"] = np.abs(an.pred / an.aqua - 1) * 100
        mo = a.copy(); mo["lnerr"] = np.abs(np.log((mo.aqua + 1) / (mo.pred + 1)))
        for per, lo_y, hi_y in (("2013-2020", 2013, 2020), ("2021", 2021, 2021), ("2021-2025", 2021, 2025)):
            s = an[(an.year >= lo_y) & (an.year <= hi_y)]; m = mo[(mo.year >= lo_y) & (mo.year <= hi_y)]
            rows.append({"level": lev, "period": per, "annual_filter": f"Aqua >= {min_cell} per year" if lev.startswith("cell") else "none",
                         "n_annual": int(len(s)), "annual_median_abs_pct_err": round(float(s.pcterr.median()), 1),
                         "annual_mean_abs_pct_err": round(float(s.pcterr.mean()), 1), "annual_max_abs_pct_err": round(float(s.pcterr.max()), 1),
                         "monthly_median_abs_log_err": round(float(m.lnerr.median()), 3),
                         "monthly_share_within_factor2_pct": round(100 * float((m.lnerr < np.log(2)).mean()), 1)})
    return rows


# ------------------------------------------------------------------ figures
def style():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 15, "axes.titlesize": 16, "axes.labelsize": 15, "legend.fontsize": 13, "xtick.labelsize": 13,
                         "ytick.labelsize": 13, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True,
                         "grid.alpha": 0.25, "figure.dpi": 100, "savefig.dpi": 100})
    return plt


# Okabe-Ito colour-vision-safe palette
BLK, BLUE, ORG, VERM, GREEN, GREY, SKY = "#000000", "#0072B2", "#E69F00", "#D55E00", "#009E73", "#8c8c8c", "#56B4E9"


def monthly_series(out: dict) -> pd.DataFrame:
    rows = []
    for key in REGIONS:
        a = out["agg"]["world" if key == "WORLD" else "GFED region"]
        a = a if key == "WORLD" else a[a.u == key]
        a = a.groupby("month", as_index=False)[["pred", "aqua", "lo", "hi"]].sum() if key == "WORLD" else a
        a = a.set_index("month")[["pred", "aqua", "lo", "hi"]].reindex(pd.date_range("2013-01-01", "2025-12-01", freq="MS"))
        a.insert(0, "region", key); a.index.name = "month"; rows.append(a.reset_index())
    r = pd.concat(rows)
    r["fold"] = np.where(r.month.dt.year <= 2020, "leave-one-year-out", "calibrated 2013-2020")
    return r.rename(columns={"pred": "viirs_converted", "aqua": "aqua_observed", "lo": "lo90", "hi": "hi90"})


def caption(fig, text, y=0.008):
    fig.text(0.5, y, textwrap.fill(text, 175), ha="center", va="bottom", fontsize=11)


def fig_timeseries(plt, ms: pd.DataFrame, path: str):
    fig, axs = plt.subplots(2, 2, figsize=(16, 10), sharex=True)
    for ax, (key, name) in zip(axs.ravel(), REGIONS.items()):
        d = ms[ms.region == key].set_index("month")
        s = 1e3
        ax.fill_between(d.index, d.lo90 / s, d.hi90 / s, color=SKY, alpha=0.45, lw=0, label="VIIRS converted, 90% interval")
        ax.plot(d.index, d.viirs_converted / s, color=BLUE, lw=1.6, label="VIIRS converted to Aqua units (out of sample)")
        obs = d.aqua_observed.where(d.index < "2022-01-01")
        ax.plot(d.index, obs / s, color=VERM, lw=1.4, ls="--", label="Aqua as observed")
        ax.plot(d.index, d.aqua_observed.where(d.index >= "2022-01-01") / s, color=GREY, lw=1.0, ls=":", label="Aqua as observed after 2021 (orbit drift)")
        ax.axvline(pd.Timestamp("2021-01-01"), color=BLK, lw=1, ls="-.")
        ax.set_title(name); ax.set_ylabel("Detections / month (thousands)")
        ax.set_ylim(bottom=0)
    h, l = axs[0, 0].get_legend_handles_labels()
    fig.legend(h, l, loc="lower center", bbox_to_anchor=(0.5, 0.055), ncol=2, frameon=False)
    axs[1, 0].set_xlabel("Month"); axs[1, 1].set_xlabel("Month")
    fig.suptitle("Monthly Aqua vs VIIRS converted to Aqua units, 2013-2025. Left of the dash-dot line: leave-one-year-out; right: calibrated on 2013-2020",
                 fontsize=16, y=0.985)
    caption(fig, SRC_NOTE + " 2020-08 (Aqua outage) omitted. Bands: interval_table.json, drift term from 2021.")
    fig.tight_layout(rect=(0, 0.14, 1, 0.965)); fig.savefig(path); plt.close(fig)


def fig_scatter(plt, out: dict, path: str) -> dict:
    a = out["agg"]["GFED region"]
    an = a.groupby(["u", "year"], as_index=False)[["pred", "aqua"]].sum()
    an["err"] = (an.pred / an.aqua - 1) * 100
    w = out["agg"]["world"].groupby("year", as_index=False)[["pred", "aqua"]].sum(); w["err"] = (w.pred / w.aqua - 1) * 100
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(16, 10), gridspec_kw={"width_ratios": [1, 1.15]})
    groups = [("2013-2020, leave-one-year-out", an.year <= 2020, BLUE, "o", True), ("2021, calibrated 2013-2020", an.year == 2021, VERM, "s", True),
              ("2022-2025 vs raw Aqua (drifting, indicative)", an.year >= 2022, VERM, "s", False)]
    for lab, s, c, m, filled in groups:
        d = an[s]
        ax.scatter(d.aqua / 1e3, d.pred / 1e3, s=60, marker=m, facecolor=c if filled else "none", edgecolor=c, lw=1.6, alpha=0.85, label=lab)
    lim = [an[["pred", "aqua"]].replace(0, np.nan).min().min() / 1e3 * 0.7, an[["pred", "aqua"]].max().max() / 1e3 * 1.4]
    ax.plot(lim, lim, color=BLK, lw=1.2, label="1:1"); ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlim(lim); ax.set_ylim(lim)
    ax.set_xlabel("Aqua as observed, annual total (thousands of detections)"); ax.set_ylabel("VIIRS converted to Aqua units (thousands)")
    ax.set_title("Annual totals per GFED region (14 regions x 13 years)"); ax.legend(loc="upper left", fontsize=12)
    summ = {}
    txt = []
    for lab, s in (("2013-2020", an.year <= 2020), ("2021", an.year == 2021), ("2021-2025", an.year >= 2021)):
        e = an[s].err.abs(); ew = w[(w.year >= int(lab[:4])) & (w.year <= int(lab[-4:]))].err.abs()
        summ[lab] = {"region_median_abs_pct": round(float(e.median()), 1), "region_mean_abs_pct": round(float(e.mean()), 1),
                     "region_max_abs_pct": round(float(e.max()), 1), "world_mean_abs_pct": round(float(ew.mean()), 1),
                     "world_max_abs_pct": round(float(ew.max()), 1)}
    for lab in ("2013-2020", "2021"):
        s = summ[lab]; txt.append(f"{lab}: regions median {s['region_median_abs_pct']}%, max {s['region_max_abs_pct']}%; world mean {s['world_mean_abs_pct']}%")
    ax.text(0.97, 0.04, "Absolute % error\n" + "\n".join(txt), transform=ax.transAxes, ha="right", va="bottom", fontsize=12,
            bbox=dict(fc="white", ec=GREY, alpha=0.9))
    regs = sorted(an.u.unique())
    for lab, s, c, m, filled in groups:
        d = an[s]; x = [regs.index(r) for r in d.u]
        bx.scatter(x, d.err, s=45, marker=m, facecolor=c if filled else "none", edgecolor=c, lw=1.4, alpha=0.8)
    bx.axhline(0, color=BLK, lw=1.2); bx.set_xticks(range(len(regs))); bx.set_xticklabels(regs, rotation=60)
    bx.set_ylabel("Converted minus Aqua, % of Aqua"); bx.set_xlabel("GFED region (one marker per year)")
    bx.set_title("Signed error of the annual total")
    fig.suptitle("Annual totals, VIIRS converted to Aqua units vs Aqua as observed, by GFED region", fontsize=17, y=0.985)
    caption(fig, SRC_NOTE + " Hollow markers: Aqua after 2021 is not corrected for its overpass drift.")
    fig.tight_layout(rect=(0, 0.06, 1, 0.96)); fig.savefig(path); plt.close(fig)
    summ["world_by_year_pct"] = {int(r.year): round(float(r.err), 1) for r in w.itertuples()}
    return summ


def seam_series() -> dict:
    con = duckdb.connect()
    it = json.load(open(f"{HARM}/interval_table.json", encoding="utf-8"))
    tab = it["long_region"]["viirs_conv"]
    r = con.execute(f"""SELECT region_id, month, value, origin FROM '{HARM}/harm_region.parquet'
                        WHERE series='long' AND region_type='gfed' AND month BETWEEN DATE '2013-01-01' AND DATE '2025-12-01'""").fetchdf()
    r["month"] = pd.to_datetime(r["month"])
    w = r.groupby("month", as_index=False).agg(value=("value", "sum"), origin=("origin", "first")); w["region_id"] = "WORLD"
    r = pd.concat([r, w])
    r["lo"] = r.value; r["hi"] = r.value
    s = (r.origin == "viirs_conv").to_numpy()
    lo, hi = intervals(r.value.to_numpy(float), r.month.dt.year.to_numpy(), tab)
    r.loc[s, "lo"], r.loc[s, "hi"] = lo[s], hi[s]
    return {k: g.set_index("month") for k, g in r.groupby("region_id")}


def fig_seam(plt, ms: pd.DataFrame, path: str) -> dict:
    prod = seam_series()
    fig, axs = plt.subplots(2, 2, figsize=(16, 10), sharex=True)
    lo_d, hi_d = pd.Timestamp("2019-01-01"), pd.Timestamp("2024-12-01")
    stats = {}
    for ax, (key, name) in zip(axs.ravel(), REGIONS.items()):
        p = prod[key].reindex(pd.date_range(lo_d, hi_d, freq="MS")).loc[lo_d:hi_d]; a = ms[ms.region == key].set_index("month").loc[lo_d:hi_d]
        late = p.index >= "2022-01-01"; outage = p.index == "2020-08-01"
        ax.fill_between(p.index, p.lo.where(late | outage) / 1e3, p.hi.where(late | outage) / 1e3, color=SKY, alpha=0.45, lw=0, label="90% interval (converted months)")
        ax.plot(p.index, p.value.where(p.origin == "aqua_obs") / 1e3, color=VERM, lw=1.8, label="Harmonized series, Aqua as observed (to 2021-12)")
        ax.plot(p.index, p.value.where(late) / 1e3, color=BLUE, lw=1.8, label="Harmonized series, VIIRS converted (from 2022-01)")
        ax.plot(p.index[outage], p.value[outage] / 1e3, "o", color=BLUE, ms=7, label="2020-08 (Aqua outage): VIIRS converted")
        ax.plot(a.index, a.aqua_observed.where(a.index >= "2022-01-01") / 1e3, color=GREY, lw=1.0, ls=":", label="Aqua as observed after 2021 (not used)")
        ax.axvline(pd.Timestamp("2022-01-01"), color=BLK, lw=1, ls="-.")
        ax.set_title(name); ax.set_ylabel("Detections / month (thousands)"); ax.set_ylim(bottom=0)
        # seam statistic: converted vs Aqua over the last full overlap year (2021)
        y21 = a.loc["2021-01-01":"2021-12-01"]; c21 = y21.viirs_converted.sum() / y21.aqua_observed.sum() - 1
        stats[key] = {"conv_vs_aqua_2021_pct": round(100 * float(c21), 1)}
        ax.text(0.02, 0.96, f"2021 overlap, converted vs Aqua: {100*c21:+.1f}%", transform=ax.transAxes, va="top", fontsize=12,
                bbox=dict(fc="white", ec=GREY, alpha=0.9))
    h, l = axs[0, 0].get_legend_handles_labels()
    fig.legend(h, l, loc="lower center", bbox_to_anchor=(0.5, 0.055), ncol=2, frameon=False)
    axs[1, 0].set_xlabel("Month"); axs[1, 1].set_xlabel("Month")
    fig.suptitle("The 2022-01 seam of the harmonized long series (Aqua observed to 2021-12, VIIRS converted from 2022-01), 2019-2024", fontsize=16, y=0.985)
    caption(fig, SRC_NOTE + " Series read from data/harmonized/harm_region.parquet; world = sum of the 14 GFED regions.")
    fig.tight_layout(rect=(0, 0.14, 1, 0.965)); fig.savefig(path); plt.close(fig)
    return stats


def fig_coverage(plt, cov: list[dict], path: str):
    d = pd.DataFrame(cov); rules = list(dict.fromkeys(d.rule)); rules.sort(key=lambda r: not r.startswith("cell-sum"))
    fig, axs = plt.subplots(1, 2, figsize=(16, 10), sharey=True, gridspec_kw={"width_ratios": [7, 5]})
    wd = 0.38
    for ax, rule in zip(axs, rules):
        r = d[d.rule == rule]; levels = list(dict.fromkeys(r.level))
        for i, (per, col) in enumerate((("2013-2020", BLUE), ("2021-2025", VERM))):
            s = r[r.period == per].set_index("level").loc[levels]
            xs = np.arange(len(levels)) + (i - 0.5) * wd
            ax.bar(xs, s.coverage_pct, wd, color=col, label=("2013-2020: leave-one-year-out" if i == 0 else "2021-2025: calibrated on 2013-2020, drift term"))
            for x, v, n in zip(xs, s.coverage_pct, s.n):
                ax.text(x, v + 0.25, f"{v:.1f}", ha="center", fontsize=11, rotation=90 if len(levels) > 5 else 0)
                ax.text(x, 80.6, f"n={n:,}", ha="center", rotation=90, fontsize=10, color="white")
        ax.axhline(90, color=BLK, lw=1.8, ls="--", label="Nominal 90%")
        ax.set_xticks(range(len(levels))); ax.set_xticklabels([l.replace(" (", chr(10) + "(") for l in levels], fontsize=12)
        ax.set_ylim(80, 100); ax.set_xlabel("Aggregation level"); ax.set_title(rule, fontsize=13)
    axs[0].set_ylabel("Area-months with Aqua value inside the 90% interval (%)"); axs[0].legend(loc="upper left", fontsize=12)
    fig.suptitle("Observed coverage of the 90% intervals by aggregation level", fontsize=17, y=0.985)
    caption(fig, SRC_NOTE + " Units are not independent (neighbouring cells, adjacent months); n = area-months. Continent = GFED groups.")
    fig.tight_layout(rect=(0, 0.07, 1, 0.96)); fig.savefig(path); plt.close(fig)


# ------------------------------------------------------------------ main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reuse", action="store_true", help="reuse the cached comparison table (data/validation_cache) if present")
    args = ap.parse_args(); t0 = time.time()
    os.makedirs(DOCS, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
    cpath = f"{CACHE}/cmp.parquet"
    if args.reuse and os.path.exists(cpath): df = pd.read_parquet(cpath)
    else:
        df = build_cmp(); df.to_parquet(cpath)
    out = analyse(df)
    err = error_tables(out)
    ms = monthly_series(out)
    ms.round({"viirs_converted": 1, "aqua_observed": 1, "lo90": 1, "hi90": 1}).to_csv(f"{DOCS}/monthly_series.csv", index=False)
    pd.DataFrame(out["coverage"]).to_csv(f"{DOCS}/interval_coverage.csv", index=False)
    pd.DataFrame(err).to_csv(f"{DOCS}/error_summary.csv", index=False)
    plt = style()
    fig_timeseries(plt, ms, f"{DOCS}/fig1_monthly_timeseries.png")
    sc = fig_scatter(plt, out, f"{DOCS}/fig2_annual_scatter.png")
    seam = fig_seam(plt, ms, f"{DOCS}/fig3_seam_2022.png")
    fig_coverage(plt, out["coverage"], f"{DOCS}/fig4_interval_coverage.png")
    # consistency of the recomputed 2022-2025 converted values with the published harm_region.parquet
    g = out["agg"]["GFED region"]; g = g[g.year >= 2022][["u", "month", "pred"]]
    pr = duckdb.connect().execute(f"SELECT region_id u, month, value pub FROM '{HARM}/harm_region.parquet' WHERE series='long' AND region_type='gfed' AND origin='viirs_conv' AND month BETWEEN DATE '2022-01-01' AND DATE '2025-12-01'").fetchdf()
    pr["month"] = pd.to_datetime(pr["month"]); m = g.merge(pr, on=["u", "month"])
    rel = (m.pred - m.pub).abs() / m.pub.clip(lower=1)
    res = {"generated_utc": pd.Timestamp.now("UTC").strftime("%Y-%m-%dT%H:%M:%SZ"), "error_summary": err, "interval_coverage": out["coverage"],
           "annual_scatter_summary": sc, "seam": seam,
           "check_vs_published_harm_region_2022_2025": {"n": int(len(m)), "median_rel_diff": float(rel.median()), "max_rel_diff": float(rel.max())},
           "runtime_s": round(time.time() - t0)}
    json.dump(res, open(f"{DOCS}/validation_numbers.json", "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != "interval_coverage"}, indent=1)); print(pd.DataFrame(out["coverage"]).drop(columns="rule").assign(r=[x["rule"][:4] for x in out["coverage"]]).to_string())
    print(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
