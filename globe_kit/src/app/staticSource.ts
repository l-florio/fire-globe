import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { cellIdSql, type Area } from '../globe';
import { areaFor, type CalendarResult, type DataSource, type Detections, type MonthRow, type RegionRow } from './dataSource';

interface StaticManifest {
  region: [number, number, number, number];
  grid: Record<string, { band: number; south: number; north: number; path: string }[]>;
  points: Record<string, { year: number; path: string; rows: number; region?: [number, number, number, number] }[]>;
  /** Harmonized regional values; a later file replaces the earlier ones from its first month (m) on. */
  regions?: { path: string; from: number }[];
}

/** SQL condition for a bbox or a circle (great-circle distance), same rule as the local service. */
function areaSql(a: Area, lat = 'lat', lon = 'lon'): string {
  if (a.kind === 'cells') {
    const [w, s, e, n] = a.bbox;
    const box = areaSql({ kind: 'bbox', west: w, south: s, east: e, north: n }, lat, lon);
    return `(${box} AND ${cellIdSql(lat, lon, a.res)} IN (${a.ids.join(',')}))`;
  }
  if (a.kind === 'circle') {
    const dlat = a.km / 111;
    const dlon = Math.min(180, a.km / (111 * Math.max(0.01, Math.cos(((Math.min(89, Math.abs(a.lat) + dlat)) * Math.PI) / 180))));
    const box = areaSql({ kind: 'bbox', west: Math.max(-180, a.lon - dlon), south: Math.max(-90, a.lat - dlat), east: Math.min(180, a.lon + dlon), north: Math.min(90, a.lat + dlat) }, lat, lon);
    return `(${box} AND 2 * 6371.0 * asin(sqrt(pow(sin(radians(${lat} - ${a.lat}) / 2), 2) + cos(radians(${a.lat})) * cos(radians(${lat})) * pow(sin(radians(${lon} - ${a.lon}) / 2), 2))) <= ${a.km})`;
  }
  const lonC = a.west <= a.east ? `(${lon} BETWEEN ${a.west} AND ${a.east})` : `(${lon} >= ${a.west} OR ${lon} <= ${a.east})`;
  return `(${lat} BETWEEN ${a.south} AND ${a.north} AND ${lonC})`;
}

function latRange(a: Area): [number, number] {
  if (a.kind === 'cells') return [a.bbox[1], a.bbox[3]];
  return a.kind === 'bbox' ? [a.south, a.north] : [a.lat - a.km / 111, a.lat + a.km / 111];
}

const CSV_HEAD = 'latitude,longitude,acq_date,acq_time_utc,satellite,confidence,frp_mw,daynight,type,source';

/**
 * Static data source: DuckDB-WASM reads the Parquet files in public/data with HTTP range requests,
 * so only the row groups needed by a query are downloaded.
 */
export async function staticSource(baseUrl: string): Promise<DataSource | undefined> {
  const res = await fetch(`${baseUrl}static.json`).catch(() => undefined);
  if (!res?.ok) return undefined;
  const man = (await res.json()) as StaticManifest;
  const url = (p: string) => (/^https?:\/\//.test(p) ? p : new URL(`${baseUrl}${p}`, document.baseURI).href);

  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  const list = (paths: string[]) => `[${paths.map((p) => `'${url(p)}'`).join(', ')}]`;
  const WORLD: [number, number, number, number] = [-180, -90, 180, 90];
  const regionOf = (f: { region?: [number, number, number, number] }) => f.region ?? man.region ?? WORLD;
  const isWorld = (r: number[]) => r[0] <= -180 && r[2] >= 180 && r[1] <= -89 && r[3] >= 89;
  const describe = (r: number[]) =>
    isWorld(r) ? 'worldwide' : `${r[1]}-${r[3]} N, ${Math.abs(r[0])} ${r[0] < 0 ? 'W' : 'E'} - ${r[2]} E`;
  const allRegions = Object.values(man.points).flat().map(regionOf);
  const regionText = allRegions.length && allRegions.every(isWorld) ? 'worldwide' : describe(allRegions.find((r) => !isWorld(r)) ?? WORLD);

  /** Clip a bbox to a file's region; undefined when they do not overlap. */
  function clip(b: number[] | null, r: number[]): number[] | undefined {
    const [w, s, e, n] = b ?? WORLD;
    if (isWorld(r)) return [w, s, e, n];
    if (w > e) return [r[0], Math.max(s, r[1]), r[2], Math.min(n, r[3])]; // antimeridian: regions do not cross it
    const c = [Math.max(w, r[0]), Math.max(s, r[1]), Math.min(e, r[2]), Math.min(n, r[3])];
    return c[0] < c[2] && c[1] < c[3] ? c : undefined;
  }

  function pointFiles(sensor: string, y0: number, y1: number) {
    return (man.points[sensor] ?? []).filter((f) => f.year >= y0 && f.year <= y1);
  }

  return {
    kind: 'static',
    note: `Online version: calendar worldwide on the 0.25 degree grid; single detections ${regionText === 'worldwide' ? 'worldwide' : `for ${regionText}`}.`,

    async detections(sensor, period, bbox, limit): Promise<Detections> {
      const key = period.date ?? period.month ?? '';
      const fileMeta = pointFiles(sensor, Number(key.slice(0, 4)), Number(key.slice(0, 4)));
      const region = fileMeta.length ? regionOf(fileMeta[0]) : WORLD;
      const box = fileMeta.length ? clip(bbox, region) : undefined;
      const files = fileMeta.map((f) => f.path);
      if (!box || !files.length)
        return { buf: new Float32Array(0), total: 0, outside: `Single detections online for ${key.slice(0, 4)} cover ${describe(region)}.` };
      // A bbox crossing the antimeridian (w > e) on a worldwide file
      const lonCond = box[0] <= box[2] ? `lon BETWEEN ${box[0]} AND ${box[2]}` : `(lon >= ${box[0]} OR lon <= ${box[2]})`;
      let d0: string, d1: string;
      if (period.date) {
        d0 = period.date;
        d1 = period.date;
      } else {
        const [y, m] = key.split('-').map(Number);
        d0 = `${key}-01`;
        d1 = `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
      }
      const where = `d BETWEEN DATE '${d0}' AND DATE '${d1}' AND lat BETWEEN ${box[1]} AND ${box[3]} AND ${lonCond} AND type IN (0, -1)`;
      const src = `read_parquet(${list(files)})`;
      const total = Number((await conn.query(`SELECT count(*) AS c FROM ${src} WHERE ${where}`)).getChild('c')!.get(0));
      const t = await conn.query(`
        SELECT lon, lat, frp, CAST(day(d) AS FLOAT) AS dd, CAST(hhmm // 100 + (hhmm % 100) / 60.0 AS FLOAT) AS hh, CAST(flags AS FLOAT) AS fl
        FROM ${src} WHERE ${where} ORDER BY frp DESC LIMIT ${limit}`);
      const cols = ['lon', 'lat', 'frp', 'dd', 'hh', 'fl'].map((c) => t.getChild(c)!.toArray() as Float32Array);
      const buf = new Float32Array(t.numRows * 6);
      for (let i = 0; i < t.numRows; i++) for (let k = 0; k < 6; k++) buf[i * 6 + k] = cols[k][i];
      return { buf, total };
    },

    async calendar(sensor, place, types): Promise<CalendarResult> {
      const area = areaFor(sensor, place);
      const [s, n] = latRange(area);
      const files = (man.grid[sensor] ?? []).filter((f) => f.north >= s && f.south <= n).map((f) => f.path);
      if (!files.length) return { source: 'grid', months: [] };
      const harm = sensor.startsWith('HARM_');
      const cls = types === '0,-1' && !harm ? 'AND cls = 0' : '';
      const t = await conn.query(`
        SELECT printf('%04d-%02d', 2000 + m // 12, m % 12 + 1) AS ym, CAST(sum(n) AS DOUBLE) AS n, CAST(sum(frp) AS DOUBLE) AS f${harm ? ', CAST(max(o) AS DOUBLE) AS o' : ''}
        FROM read_parquet(${list(files)}) WHERE ${areaSql(area)} ${cls}
        GROUP BY m ORDER BY m`);
      const ym = t.getChild('ym')!.toArray() as string[];
      const nn = t.getChild('n')!.toArray() as Float64Array;
      const ff = t.getChild('f')!.toArray() as Float64Array;
      const oo = harm ? (t.getChild('o')!.toArray() as Float64Array) : undefined;
      return {
        source: harm ? 'harmonized' : 'grid',
        months: ym.map((m, i) => [m, nn[i], Math.round(ff[i] * 10) / 10, ...(oo ? [oo[i]] : [])] as MonthRow),
      };
    },

    async regions(series, type, moy): Promise<RegionRow[]> {
      const files = man.regions ?? [];
      if (!files.length) return [];
      // Each month comes from the last file whose range starts at or before it.
      const parts = files.map(
        (f, i) =>
          `SELECT id, m, v, lo, hi, o FROM read_parquet('${url(f.path)}') WHERE series = '${series}' AND rt = '${type}' AND m % 12 = ${moy - 1} AND m >= ${f.from}` +
          (files.slice(i + 1).length ? ` AND m < ${Math.min(...files.slice(i + 1).map((g) => g.from))}` : ''),
      );
      const t = await conn.query(`
        SELECT id, printf('%04d-%02d', 2000 + m // 12, m % 12 + 1) AS ym, CAST(v AS DOUBLE) AS v, CAST(lo AS DOUBLE) AS lo,
               CAST(hi AS DOUBLE) AS hi, CAST(o AS INTEGER) AS o
        FROM (${parts.join(' UNION ALL ')}) ORDER BY id, m`);
      const c = ['id', 'ym', 'v', 'lo', 'hi', 'o'].map((k) => t.getChild(k)!.toArray() as ArrayLike<unknown>);
      const out: RegionRow[] = [];
      for (let i = 0; i < t.numRows; i++)
        out.push([c[0][i] as string, c[1][i] as string, c[2][i] as number, c[3][i] as number, c[4][i] as number, c[5][i] as number]);
      return out;
    },

    async exportCsv(sensor, area, from, to, types): Promise<Blob> {
      const files = pointFiles(sensor, Number(from.slice(0, 4)), Number(to.slice(0, 4))).map((f) => f.path);
      if (!files.length) return new Blob([`# outside the region with single detections (${regionText})\n${CSV_HEAD}\n`], { type: 'text/csv' });
      const typeCond = types === '0,-1' ? 'AND type IN (0, -1)' : '';
      await conn.query(`
        COPY (
          SELECT lat AS latitude, lon AS longitude, d AS acq_date, lpad(CAST(hhmm AS VARCHAR), 4, '0') AS acq_time_utc,
                 CASE (flags >> 3) & 3 WHEN 1 THEN 'Terra' WHEN 2 THEN 'Aqua' ELSE 'VIIRS' END AS satellite,
                 CASE (flags >> 1) & 3 WHEN 2 THEN 'high' WHEN 1 THEN 'nominal' ELSE 'low' END AS confidence,
                 frp AS frp_mw, CASE WHEN flags & 1 = 1 THEN 'N' ELSE 'D' END AS daynight, type,
                 CASE src WHEN 0 THEN 'SP_ARCHIVE' WHEN 1 THEN 'SP_API' ELSE 'NRT_API' END AS source
          FROM read_parquet(${list(files)})
          WHERE d BETWEEN DATE '${from}' AND DATE '${to}' AND ${areaSql(area)} ${typeCond}
          ORDER BY d, hhmm LIMIT 2000000
        ) TO 'export.csv' (HEADER, DELIMITER ',')`);
      const bytes = await db.copyFileToBuffer('export.csv');
      await db.dropFile('export.csv');
      return new Blob([new Uint8Array(bytes)], { type: 'text/csv' });
    },
  };
}
