"""
FIRMS global pipeline: download + normalizzazione + aggregazione degli hotspot MODIS / VIIRS.

SI disclosure: script generato con assistenza di Claude (Anthropic), rivisto da Lorenzo Florio.
Da dichiarare nella submission (campo "Use of Super Intelligence" + metadati del repo).

Fonti (NASA FIRMS, https://firms.modaps.eosdis.nasa.gov):
  - Archivio annuale per paese, Standard Processing, senza chiave:
      /data/country/zips/{modis|viirs-snpp|viirs-jpss1}_<anno>_all_countries.zip
      (un CSV per paese dentro ogni zip; MODIS 2000-2025, VIIRS S-NPP 2012-2025)
  - API area (MAP_KEY gratuita) per l'anno corrente: SP finche' disponibile, poi NRT.
      /api/area/csv/<MAP_KEY>/<SOURCE>/world/<1..5>/<YYYY-MM-DD>
      Costo per chiamata (dal JS del sito): 18 celle x (VIIRS 2 | MODIS 0.5) x giorni.

Sottocomandi:
  download-archive  scarica gli zip annuali (resume via HTTP Range)
  sample-country    estrae via Range solo il CSV di un paese (test veloce, pochi MB)
  download-recent   scarica l'anno corrente via API (richiede MAP_KEY)
  build             normalizza zip + CSV API in Parquet (data/parquet/sensor=.../year=...)
  aggregate         aggrega su griglia x mese e paese x mese (data/agg/)
  all               download-archive + download-recent (se c'e' la chiave) + build + aggregate

Rete aziendale: se installato, `truststore` fa usare lo store certificati di Windows; in alternativa
REQUESTS_CA_BUNDLE / --ca-bundle con la CA aziendale. Non e' prevista la disattivazione della verifica TLS.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import requests

BASE = "https://firms.modaps.eosdis.nasa.gov"
UA = {"User-Agent": "firms-pipeline/1.0 (hackathon research script)"}

# sensore logico -> (prefisso zip archivio, anni disponibili, sorgente API SP, sorgente API NRT, peso API)
SENSORS = {
    "MODIS": ("modis", range(2000, 2026), "MODIS_SP", "MODIS_NRT", 0.5),
    "VIIRS_SNPP": ("viirs-snpp", range(2012, 2026), "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT", 2.0),
    "VIIRS_NOAA20": ("viirs-jpss1", range(2018, 2026), "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT", 2.0),
    # NOAA-21: nessuno zip annuale sul server (verificato 14/11/2026); SP via API dal 2023-03-01,
    # quindi: download-recent --sensors VIIRS_NOAA21 --start 2023-03-01
    "VIIRS_NOAA21": ("viirs-jpss2", range(0), "VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT", 2.0),
}
DEFAULT_SENSORS = ["MODIS", "VIIRS_SNPP"]


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


try:  # usa lo store certificati di sistema (utile dietro proxy TLS aziendale), se installato
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass


def session(ca_bundle: str | None) -> requests.Session:
    s = requests.Session()
    s.headers.update(UA)
    if ca_bundle:
        s.verify = ca_bundle
    return s


# ---------------------------------------------------------------- download archivio

def archive_url(prefix: str, year: int) -> str:
    return f"{BASE}/data/country/zips/{prefix}_{year}_all_countries.zip"


def download_resumable(s: requests.Session, url: str, dest: Path, retries: int = 5) -> bool:
    """Scarica url in dest con resume. Ritorna False se il file remoto non esiste (404)."""
    head = s.head(url, timeout=60, allow_redirects=True)
    if head.status_code == 404:
        return False
    head.raise_for_status()
    total = int(head.headers.get("Content-Length", 0))
    if dest.exists() and total and dest.stat().st_size == total:
        log(f"ok (gia' presente) {dest.name}")
        return True
    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        hdr = {"Range": f"bytes={have}-"} if have else {}
        try:
            with s.get(url, headers=hdr, stream=True, timeout=120) as r:
                if have and r.status_code != 206:
                    have = 0  # il server ha ignorato il Range: riparto
                    part.unlink(missing_ok=True)
                r.raise_for_status()
                mode = "ab" if have else "wb"
                with open(part, mode) as f:
                    done, last = have, time.time()
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        if time.time() - last > 15:
                            log(f"  {dest.name}: {done / 1e6:.0f}/{total / 1e6:.0f} MB")
                            last = time.time()
            if total and part.stat().st_size != total:
                raise IOError(f"dimensione {part.stat().st_size} != {total}")
            part.replace(dest)
            log(f"ok {dest.name} ({total / 1e6:.0f} MB)")
            return True
        except (requests.RequestException, IOError) as e:
            log(f"  tentativo {attempt}/{retries} fallito per {dest.name}: {e}")
            time.sleep(min(60, 5 * attempt))
    raise RuntimeError(f"download fallito: {url}")


def cmd_download_archive(a) -> None:
    s = session(a.ca_bundle)
    out = Path(a.data) / "raw" / "archive"
    out.mkdir(parents=True, exist_ok=True)
    for name in a.sensors:
        prefix, years, *_ = SENSORS[name]
        for y in years:
            if a.years and y not in a.years:
                continue
            dest = out / f"{prefix}_{y}_all_countries.zip"
            if not download_resumable(s, archive_url(prefix, y), dest):
                log(f"assente sul server: {dest.name}")


# ---------------------------------------------------------------- estrazione di un solo paese via Range

class HTTPRangeFile(io.RawIOBase):
    """File remoto in sola lettura e seekable, letto a blocchi via HTTP Range (per zipfile)."""

    def __init__(self, s: requests.Session, url: str, block: int = 1 << 20):
        self.s, self.url, self.block, self.pos = s, url, block, 0
        r = s.head(url, timeout=60)
        r.raise_for_status()
        self.size = int(r.headers["Content-Length"])
        self.cache: dict[int, bytes] = {}
        self.fetched = 0

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=io.SEEK_SET):
        self.pos = {io.SEEK_SET: off, io.SEEK_CUR: self.pos + off, io.SEEK_END: self.size + off}[whence]
        return self.pos

    def _blk(self, i: int) -> bytes:
        if i not in self.cache:
            a, b = i * self.block, min(self.size, (i + 1) * self.block) - 1
            r = self.s.get(self.url, headers={"Range": f"bytes={a}-{b}"}, timeout=120)
            if r.status_code != 206:
                raise IOError(f"Range non supportato (HTTP {r.status_code})")
            self.cache[i] = r.content
            self.fetched += len(r.content)
            if len(self.cache) > 64:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[i]

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray()
        while n > 0:
            i, o = divmod(self.pos, self.block)
            chunk = self._blk(i)[o:o + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def cmd_sample_country(a) -> None:
    s = session(a.ca_bundle)
    out = Path(a.data) / "raw" / "country" / a.country
    out.mkdir(parents=True, exist_ok=True)
    for name in a.sensors:
        prefix, years, *_ = SENSORS[name]
        for y in years:
            if a.years and y not in a.years:
                continue
            url = archive_url(prefix, y)
            dest = out / f"{prefix}_{y}_{a.country}.csv"
            if dest.exists():
                continue
            try:
                f = HTTPRangeFile(s, url)
            except requests.HTTPError as e:
                log(f"skip {url}: {e}")
                continue
            with zipfile.ZipFile(f) as z:
                member = next((m for m in z.namelist() if m.endswith(f"_{a.country}.csv")), None)
                if not member:
                    log(f"{a.country} non presente in {prefix} {y}")
                    continue
                dest.write_bytes(z.read(member))
            log(f"ok {dest.name} (scaricati {f.fetched / 1e6:.1f} MB)")


# ---------------------------------------------------------------- API anno corrente

def api_text(s: requests.Session, url: str) -> str:
    for attempt in range(1, 6):
        try:
            r = s.get(url, timeout=300)
            txt = r.text
            if r.status_code == 200 and not re.search(r"(?i)invalid|exceed|error", txt[:200]):
                return txt
            if re.search(r"(?i)exceed", txt[:300]) or r.status_code == 429:
                log("limite transazioni MAP_KEY raggiunto: attendo 10 minuti")
                time.sleep(600)
                continue
            raise RuntimeError(f"HTTP {r.status_code}: {txt[:200]}")
        except requests.RequestException as e:
            # requests mette l'URL (con la MAP_KEY) nel messaggio: va oscurato prima di scriverlo nei log
            msg = re.sub(r"/csv/[^/\s]+/", "/csv/***/", str(e))
            msg = re.sub(r"MAP_KEY=[^&\s]+", "MAP_KEY=***", msg)
            log(f"  tentativo {attempt} fallito: {msg}")
            time.sleep(10 * attempt)
    raise RuntimeError(f"API non raggiungibile: {url.split('/csv/')[0]}")


def wait_quota(s: requests.Session, key: str, needed: float) -> None:
    """Attende finche' la quota della MAP_KEY consente la chiamata (best effort)."""
    try:
        st = s.get(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={key}", timeout=60).json()
        limit, used = float(st.get("transaction_limit", 0)), float(st.get("current_transactions", 0))
        if limit and used + needed > limit:
            log(f"quota {used:.0f}/{limit:.0f}: attendo il reset (10 minuti)")
            time.sleep(600)
    except (requests.RequestException, ValueError):
        time.sleep(2)


def availability(s: requests.Session, key: str) -> dict[str, tuple[dt.date, dt.date]]:
    txt = api_text(s, f"{BASE}/api/data_availability/csv/{key}/ALL")
    res = {}
    rows = list(csv.reader(io.StringIO(txt)))
    for row in rows[1:]:  # atteso: data_id,min_date,max_date
        if len(row) >= 3:
            res[row[0].strip()] = (dt.date.fromisoformat(row[1].strip()), dt.date.fromisoformat(row[2].strip()))
    return res


KEY_FILE = Path(__file__).with_name(".firms_key")


def get_map_key(a) -> str | None:
    """Ordine: --map-key, variabile FIRMS_MAP_KEY, file .firms_key accanto allo script."""
    key = a.map_key or os.environ.get("FIRMS_MAP_KEY")
    if not key and KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip() or None
    return key


def cmd_download_recent(a) -> None:
    key = get_map_key(a)
    if not key:
        sys.exit("MAP_KEY mancante: --map-key, variabile FIRMS_MAP_KEY o file .firms_key")
    s = session(a.ca_bundle)
    avail = availability(s, key)
    log("disponibilita': " + ", ".join(f"{k} {v[0]}..{v[1]}" for k, v in sorted(avail.items())))
    start = dt.date.fromisoformat(a.start)
    refresh_from = dt.date.today() - dt.timedelta(days=a.refresh_days)
    for name in a.sensors:
        _, _, sp, nrt, w = SENSORS[name]
        sp_end = avail.get(sp, (None, start - dt.timedelta(days=1)))[1]
        nrt_end = avail.get(nrt, (None, dt.date.today()))[1]
        plan = [(sp, start, sp_end), (nrt, max(start, sp_end + dt.timedelta(days=1)), nrt_end)]
        for source, d0, d1 in plan:
            out = Path(a.data) / "raw" / "api" / source
            out.mkdir(parents=True, exist_ok=True)
            d = d0
            while d <= d1:
                days = min(5, (d1 - d).days + 1)
                dest = out / f"{d.isoformat()}_{days}d.csv"
                stale = source.endswith("NRT") and d + dt.timedelta(days=days) >= refresh_from
                if dest.exists() and not stale:
                    d += dt.timedelta(days=days)
                    continue
                wait_quota(s, key, 18 * w * days)
                txt = api_text(s, f"{BASE}/api/area/csv/{key}/{source}/world/{days}/{d.isoformat()}")
                tmp = dest.with_suffix(".tmp")
                tmp.write_text(txt, encoding="utf-8")
                tmp.replace(dest)
                log(f"ok {source} {d}..{d + dt.timedelta(days=days - 1)} ({txt.count(chr(10)) - 1} righe)")
                d += dt.timedelta(days=days)


# ---------------------------------------------------------------- build Parquet normalizzato

def _duck():
    import duckdb  # import ritardato: serve solo a build/aggregate
    con = duckdb.connect()
    con.execute(f"SET threads TO {os.cpu_count() or 4}")
    return con


def normalized_select(con, rel_sql: str, sensor: str, source: str, country_expr: str) -> str:
    cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {rel_sql}").fetchall()}

    def c(name, cast="VARCHAR"):
        return f"TRY_CAST({name} AS {cast})" if name in cols else f"CAST(NULL AS {cast})"

    bright = "brightness" if "brightness" in cols else "bright_ti4"
    bright2 = "bright_t31" if "bright_t31" in cols else "bright_ti5"
    # classe di confidenza comune: MODIS 0-100 (soglie FIRMS <30 low, <80 nominal), VIIRS l/n/h
    conf_class = (
        "CASE WHEN TRY_CAST(confidence AS INTEGER) IS NOT NULL THEN "
        "CASE WHEN TRY_CAST(confidence AS INTEGER) < 30 THEN 'low' "
        "WHEN TRY_CAST(confidence AS INTEGER) < 80 THEN 'nominal' ELSE 'high' END "
        "WHEN lower(CAST(confidence AS VARCHAR)) IN ('l','low') THEN 'low' "
        "WHEN lower(CAST(confidence AS VARCHAR)) IN ('n','nominal') THEN 'nominal' "
        "WHEN lower(CAST(confidence AS VARCHAR)) IN ('h','high') THEN 'high' END"
    )
    return f"""
        SELECT
          '{sensor}' AS sensor, '{source}' AS source, {country_expr} AS country,
          {c('latitude', 'DOUBLE')} AS latitude, {c('longitude', 'DOUBLE')} AS longitude,
          {c('acq_date', 'DATE')} AS acq_date,
          {c('acq_time', 'INTEGER')} AS acq_time,
          {c('satellite')} AS satellite,
          CAST(confidence AS VARCHAR) AS confidence_raw, {conf_class} AS confidence_class,
          {c(bright, 'DOUBLE')} AS bright_main, {c(bright2, 'DOUBLE')} AS bright_aux,
          {c('frp', 'DOUBLE')} AS frp, {c('scan', 'DOUBLE')} AS scan, {c('track', 'DOUBLE')} AS track,
          {c('daynight')} AS daynight, {c('type', 'INTEGER')} AS type, {c('version')} AS version
        FROM {rel_sql}
    """


def write_partition(con, select_sql: str, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp.parquet")
    con.execute(f"COPY ({select_sql}) TO '{tmp.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    tmp.replace(dest)
    return con.execute(f"SELECT count(*) FROM '{dest.as_posix()}'").fetchone()[0]


def cmd_build(a) -> None:
    con = _duck()
    raw, pq = Path(a.data) / "raw", Path(a.data) / "parquet"
    # 1) archivio annuale
    for name in a.sensors:
        prefix, years, *_ = SENSORS[name]
        for y in years:
            if a.years and y not in a.years:
                continue
            z = raw / "archive" / f"{prefix}_{y}_all_countries.zip"
            dest = pq / f"sensor={name}" / f"year={y}" / "archive.parquet"
            if not z.exists() or (dest.exists() and not a.force):
                continue
            with tempfile.TemporaryDirectory(dir=a.tmp) as td:
                with zipfile.ZipFile(z) as zf:
                    zf.extractall(td, [m for m in zf.namelist() if m.endswith(".csv")])
                glob = (Path(td) / "**" / "*.csv").as_posix()
                rel = (f"read_csv('{glob}', union_by_name=true, all_varchar=true, "
                       f"filename=true, header=true)")
                country = (r"replace(regexp_extract(filename, '_\d{4}_(.+)\.csv$', 1), '_', ' ')")
                n = write_partition(con, normalized_select(con, rel, name, "SP_ARCHIVE", country), dest)
            log(f"build {name} {y}: {n:,} righe")
    # 2) anno corrente da API (SP + NRT), ricostruito sempre per intero
    for name in a.sensors:
        _, _, sp, nrt, _ = SENSORS[name]
        for source in (sp, nrt):
            folder = raw / "api" / source
            files = sorted(folder.glob("*.csv")) if folder.exists() else []
            files = [f for f in files if f.stat().st_size > 200]
            if not files:
                continue
            glob = (folder / "*.csv").as_posix()
            rel = f"read_csv('{glob}', union_by_name=true, all_varchar=true, header=true)"
            sel = normalized_select(con, rel, name, "SP_API" if source == sp else "NRT_API", "CAST(NULL AS VARCHAR)")
            sel = f"SELECT DISTINCT * FROM ({sel})"  # finestre NRT riscaricate possono sovrapporsi
            for (yr,) in con.execute(f"SELECT DISTINCT year(acq_date) FROM ({sel})").fetchall():
                dest = pq / f"sensor={name}" / f"year={yr}" / f"{source.lower()}.parquet"
                n = write_partition(con, f"SELECT * FROM ({sel}) WHERE year(acq_date) = {yr}", dest)
                log(f"build {name} {yr} {source}: {n:,} righe")


# ---------------------------------------------------------------- aggregazione

def cmd_aggregate(a) -> None:
    con = _duck()
    pq = (Path(a.data) / "parquet" / "**" / "*.parquet").as_posix()
    out = Path(a.data) / "agg"
    out.mkdir(parents=True, exist_ok=True)
    src = f"read_parquet('{pq}', hive_partitioning=false)"
    # SP ha precedenza su NRT negli stessi giorni (NRT viene sostituito quando arriva lo SP)
    con.execute(f"""
        CREATE TEMP VIEW hs AS
        WITH raw AS (SELECT * FROM {src}),
             cut AS (SELECT sensor, max(acq_date) AS sp_end FROM raw WHERE source <> 'NRT_API' GROUP BY sensor)
        SELECT raw.* FROM raw LEFT JOIN cut USING (sensor)
        WHERE raw.source <> 'NRT_API' OR cut.sp_end IS NULL OR raw.acq_date > cut.sp_end
    """)
    r = a.res
    grid = f"""
        SELECT sensor,
               CAST(date_trunc('month', acq_date) AS DATE) AS month,
               round(floor(latitude / {r}) * {r} + {r} / 2, 4)  AS cell_lat,
               round(floor(longitude / {r}) * {r} + {r} / 2, 4) AS cell_lon,
               coalesce(type, -1) AS type, daynight, confidence_class,
               count(*) AS n, sum(frp) AS frp_sum, max(frp) AS frp_max
        FROM hs GROUP BY ALL
    """
    con.execute(f"COPY ({grid}) TO '{(out / f'grid_{r}deg_month.parquet').as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    country = """
        SELECT sensor, country, CAST(date_trunc('month', acq_date) AS DATE) AS month,
               coalesce(type, -1) AS type, confidence_class, count(*) AS n, sum(frp) AS frp_sum
        FROM hs WHERE country IS NOT NULL GROUP BY ALL ORDER BY country, month, sensor
    """
    con.execute(f"COPY ({country}) TO '{(out / 'country_month.parquet').as_posix()}' (FORMAT PARQUET)")
    con.execute(f"COPY ({country}) TO '{(out / 'country_month.csv').as_posix()}' (HEADER)")
    summary = con.execute("""
        SELECT sensor, source, min(acq_date), max(acq_date), count(*) FROM hs GROUP BY ALL ORDER BY 1, 2
    """).fetchall()
    meta = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "grid_res_deg": r,
        "coverage": [dict(zip(["sensor", "source", "min_date", "max_date", "rows"], map(str, s))) for s in summary],
        "notes": "type: 0 vegetazione, 1 vulcano, 2 altra sorgente statica, 3 offshore, -1 assente (NRT API). "
                 "Nessuna armonizzazione MODIS/VIIRS applicata: aggregati grezzi per sensore.",
    }
    (out / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    for s in summary:
        log(f"{s[0]:13} {s[1]:10} {s[2]} .. {s[3]}  {s[4]:,} righe")
    log(f"aggregati in {out}")


# ---------------------------------------------------------------- CLI

def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default=str(Path(__file__).resolve().parent / "data"), help="cartella dati")
    def sensors_t(v):
        out = [x.strip().upper() for x in v.split(",") if x.strip()]
        bad = [x for x in out if x not in SENSORS]
        if bad:
            raise argparse.ArgumentTypeError(f"sensori non validi {bad}; ammessi {list(SENSORS)}")
        return out

    def years_t(v):  # "2012,2017" oppure "2012-2015"
        ys = set()
        for part in v.split(","):
            lo, _, hi = part.partition("-")
            ys.update(range(int(lo), int(hi or lo) + 1))
        return sorted(ys)

    p.add_argument("--sensors", type=sensors_t, default=DEFAULT_SENSORS,
                   help="lista separata da virgole: MODIS,VIIRS_SNPP,VIIRS_NOAA20,VIIRS_NOAA21")
    p.add_argument("--years", type=years_t, help="es. 2012,2017 oppure 2012-2015 (archivio/build)")
    p.add_argument("--ca-bundle", default=os.environ.get("REQUESTS_CA_BUNDLE"), help="CA aziendale (PEM)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("download-archive")
    sc = sub.add_parser("sample-country")
    sc.add_argument("--country", default="Italy", help="nome come nei file FIRMS, es. Italy, United_States")
    dr = sub.add_parser("download-recent")
    dr.add_argument("--map-key")
    dr.add_argument("--start", default=f"{dt.date.today().year}-01-01")
    dr.add_argument("--refresh-days", type=int, default=7, help="riscarica le finestre NRT degli ultimi N giorni")
    b = sub.add_parser("build")
    b.add_argument("--force", action="store_true")
    b.add_argument("--tmp", default=None, help="cartella temporanea per l'estrazione (servono ~2 GB)")
    ag = sub.add_parser("aggregate")
    ag.add_argument("--res", type=float, default=0.25, help="risoluzione griglia in gradi")
    al = sub.add_parser("all")
    al.add_argument("--map-key")
    al.add_argument("--start", default=f"{dt.date.today().year}-01-01")
    al.add_argument("--refresh-days", type=int, default=7)
    al.add_argument("--force", action="store_true")
    al.add_argument("--tmp", default=None)
    al.add_argument("--res", type=float, default=0.25)
    a = p.parse_args(argv)

    cmds = {"download-archive": [cmd_download_archive], "sample-country": [cmd_sample_country],
            "download-recent": [cmd_download_recent], "build": [cmd_build], "aggregate": [cmd_aggregate]}
    if a.cmd == "all":
        steps = [cmd_download_archive]
        if get_map_key(a):
            steps.append(cmd_download_recent)
        else:
            log("nessuna MAP_KEY: salto l'anno corrente")
        steps += [cmd_build, cmd_aggregate]
    else:
        steps = cmds[a.cmd]
    for step in steps:
        step(a)


if __name__ == "__main__":
    main()
