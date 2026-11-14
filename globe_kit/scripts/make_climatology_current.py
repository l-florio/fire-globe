"""Current-year daily detection counts per region for the Climatology page (same region ids as site_data/data/climatology/band.parquet).

Sensor NOAA-20, raw counts (no correction to the S-NPP level of the band: about +-10% on weekly totals).
  SP_API / SP_ARCHIVE rows: vegetation only (type 0)
  NRT_API rows (no `type`): detections in the 0.1 degree static cells of the harmonization mask (kind 'mask' of
  data_pipeline/data/harmonized/coefficients.parquet) are excluded; the day is flagged prov = 1 (provisional: NRT fills in later).
Regions: GFED and continents from globe_kit/public/{regions_gfed,continents}.json (1 degree cell ids), countries from
globe_kit/scripts/climatology_country_cells.parquet (cell -> country, same assignment as the band). Only the regions of the band are written.

Inputs : data_pipeline/data/parquet/sensor=VIIRS_NOAA20/year=<Y>/*.parquet, coefficients.parquet (mask),
         site_data/data/climatology/band.parquet (list of regions), public/regions_gfed.json, public/continents.json
Output : <out>/climatology/current.parquet  (region_type, region_id, date, n, prov)
Run    : python globe_kit/scripts/make_climatology_current.py --out <dir>/climatology/current.parquet [--year 2026]
The trailing 7-day total (the band quantity) = rolling sum of n over 7 days (days without a row = 0): done by the page.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pandas as pd

HERE = Path(__file__).resolve().parent
KIT = HERE.parent
ROOT = KIT.parent


def region_cells(pub: Path) -> pd.DataFrame:
    rows = []
    for f, typ in (("regions_gfed.json", "gfed"), ("continents.json", "continent")):
        for g in json.loads((pub / f).read_text(encoding="utf-8"))["regions"]:
            rows += [(typ, g["code"], int(i)) for i in g["ids"]]
    return pd.DataFrame(rows, columns=["region_type", "region_id", "cell"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output file, e.g. build/recent/data/climatology/current.parquet")
    ap.add_argument("--year", type=int, default=datetime.now(timezone.utc).year)
    ap.add_argument("--parquet", default=str(ROOT / "data_pipeline" / "data" / "parquet"))
    ap.add_argument("--coefficients", default=str(ROOT / "data_pipeline" / "data" / "harmonized" / "coefficients.parquet"))
    ap.add_argument("--band", default=str(ROOT / "site_data" / "data" / "climatology" / "band.parquet"))
    ap.add_argument("--country-cells", default=str(HERE / "climatology_country_cells.parquet"))
    ap.add_argument("--public", default=str(KIT / "public"))
    a = ap.parse_args()

    src = Path(a.parquet) / "sensor=VIIRS_NOAA20" / f"year={a.year}"
    files = f"{src.as_posix()}/*.parquet"
    if not list(src.glob("*.parquet")):
        print(f"no NOAA-20 parquet in {src}: nothing written", file=sys.stderr)
        return 1
    for p in (a.coefficients, a.band, a.country_cells):
        if not Path(p).is_file():
            print(f"missing input: {p}", file=sys.stderr)
            return 1

    coef = pd.read_parquet(a.coefficients, columns=["kind", "lat", "lon"])
    mask = coef[coef.kind == "mask"][["lat", "lon"]].rename(columns={"lat": "la", "lon": "lo"}).round(1)
    band = pd.read_parquet(a.band, columns=["region_type", "region_id"]).drop_duplicates()
    ccells = pd.read_parquet(a.country_cells)

    con = duckdb.connect()
    con.register("regj", region_cells(Path(a.public)))
    con.register("mask", mask)
    con.register("keep", band)
    con.register("ccells", ccells)
    con.execute("""CREATE TABLE reg AS SELECT region_type, region_id, cell FROM regj
                   UNION ALL SELECT 'country', country, cell FROM ccells""")
    df = con.sql(f"""
        SELECT r.region_type, r.region_id, x.d AS date, count(*) AS n,
               max(CASE WHEN x.source = 'NRT_API' THEN 1 ELSE 0 END) AS prov
        FROM (SELECT (floor(latitude)::INT + 90) * 360 + floor(longitude)::INT + 180 AS cell, CAST(acq_date AS DATE) AS d,
                     source, type, round(latitude, 1) AS la, round(longitude, 1) AS lo
              FROM read_parquet('{files}')) x
        JOIN reg r USING (cell)
        JOIN keep k ON k.region_type = r.region_type AND k.region_id = r.region_id
        WHERE (x.source <> 'NRT_API' AND x.type = 0)
           OR (x.source = 'NRT_API' AND NOT EXISTS (SELECT 1 FROM mask m WHERE m.la = x.la AND m.lo = x.lo))
        GROUP BY ALL""").df()
    df["date"] = pd.to_datetime(df["date"])
    df["n"] = df["n"].astype("int32")
    df["prov"] = df["prov"].astype("int8")
    df = df.sort_values(["region_type", "region_id", "date"]).reset_index(drop=True)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, compression="zstd", index=False)
    print(f"{out}: {len(df)} rows, {df.date.min().date()} .. {df.date.max().date()}, {out.stat().st_size / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
