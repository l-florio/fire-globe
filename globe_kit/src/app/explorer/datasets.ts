import { RE_DATE, RE_MONTH, monthIndex, ql, toNum } from './util';
import { locale, t } from '../i18n';

const TEXT = {
  seriesLong: t('ex.datasets.seriesLong'),
  seriesDetail: t('ex.datasets.seriesDetail'),
  country: t('ex.datasets.country'),
  gfed: t('ex.datasets.gfed'),
  originAqua: t('ex.datasets.originAqua'),
  originConv: t('ex.datasets.originConv'),
  originNative: t('ex.datasets.originNative'),
  above: t('ex.datasets.above'),
  below: t('ex.datasets.below'),
  within: t('ex.datasets.within'),
  partial: t('ex.datasets.partial'),
  sensorModis: t('ex.datasets.sensorModis'),
  sensorSnpp: t('ex.datasets.sensorSnpp'),
  sensorN20: t('ex.datasets.sensorN20'),
  sensorN21: t('ex.datasets.sensorN21'),
  dsRegions: t('ex.datasets.dsRegions'),
  dsHarmGrid: t('ex.datasets.dsHarmGrid'),
  dsGrid: t('ex.datasets.dsGrid'),
  dsPoints: t('ex.datasets.dsPoints'),
  docRegions: t('ex.datasets.docRegions'),
  docHarmGrid: t('ex.datasets.docHarmGrid'),
  docGrid: t('ex.datasets.docGrid'),
  docPoints: t('ex.datasets.docPoints'),
  errNoRegions: t('ex.datasets.errNoRegions'),
  errNoFiles: t('ex.datasets.errNoFiles'),
  errPeriod: t('ex.datasets.errPeriod'),
  errOrder: t('ex.datasets.errOrder'),
  errSpanMonths: t('ex.datasets.errSpanMonths'),
  errSpanDays: t('ex.datasets.errSpanDays'),
  errBbox: t('ex.datasets.errBbox'),
  errYear: t('ex.datasets.errYear'),
  errMonthOnly: t('ex.datasets.errMonthOnly'),
  cdSeries: t('ex.datasets.cdSeries'),
  cdRegionType: t('ex.datasets.cdRegionType'),
  cdRegion: t('ex.datasets.cdRegion'),
  cdRegionId: t('ex.datasets.cdRegionId'),
  cdPeriod: t('ex.datasets.cdPeriod'),
  cdYear: t('ex.datasets.cdYear'),
  cdMonth: t('ex.datasets.cdMonth'),
  cdDetections: t('ex.datasets.cdDetections'),
  cdLo90: t('ex.datasets.cdLo90'),
  cdHi90: t('ex.datasets.cdHi90'),
  cdOrigin: t('ex.datasets.cdOrigin'),
  cdUsual: t('ex.datasets.cdUsual'),
  cdRatio: t('ex.datasets.cdRatio'),
  cdPercentile: t('ex.datasets.cdPercentile'),
  cdSignal: t('ex.datasets.cdSignal'),
  cdM: t('ex.datasets.cdM'),
  cdCellLat: t('ex.datasets.cdCellLat'),
  cdCellLon: t('ex.datasets.cdCellLon'),
  cdClsHarm: t('ex.datasets.cdClsHarm'),
  cdClsRaw: t('ex.datasets.cdClsRaw'),
  cdN: t('ex.datasets.cdN'),
  cdFrp: t('ex.datasets.cdFrp'),
  cdSeriesShort: t('ex.datasets.cdSeriesShort'),
  cdSensors: t('ex.datasets.cdSensors'),
  cdPtLon: t('ex.datasets.cdPtLon'),
  cdPtLat: t('ex.datasets.cdPtLat'),
  cdDate: t('ex.datasets.cdDate'),
  cdTime: t('ex.datasets.cdTime'),
  cdDayNight: t('ex.datasets.cdDayNight'),
  cdConfidence: t('ex.datasets.cdConfidence'),
  cdSatellite: t('ex.datasets.cdSatellite'),
  cdType: t('ex.datasets.cdType'),
  cdSource: t('ex.datasets.cdSource'),
  docPointsViews: t('ex.datasets.docPointsViews'),
  docRegionNames: t('ex.datasets.docRegionNames'),
  cdGfedCode: t('ex.datasets.cdGfedCode'),
  cdRegionName: t('ex.datasets.cdRegionName'),
} as const;

export const ROW_CAP = 200_000;

/** Labels of the `signal` column; the table colours cells by comparing against these. */
/** Values stored in the data (signal, origin): fixed English, so that queries and exports do not depend on the UI language. */
const VAL = {
  above: 'Above usual',
  below: 'Below usual',
  within: 'Within usual',
  partial: 'Partial month',
  originAqua: 'Aqua MODIS (measured)',
  originConv: 'VIIRS converted to Aqua-equivalent',
  originNative: 'VIIRS 375 m (S-NPP level)',
} as const;
export const SIGNAL = { above: VAL.above, below: VAL.below, within: VAL.within, partial: VAL.partial } as const;

export type Kind = 'text' | 'int' | 'num' | 'date';
export interface ColDef {
  name: string;
  kind: Kind;
  doc: string;
}
export interface Manifest {
  grid: Record<string, { band: number; south: number; north: number; path: string }[]>;
  points: Record<string, { year: number; path: string; rows: number }[]>;
  regions?: { path: string; from: number }[];
}
export type Opt = [value: string, label: string];

/** Everything a dataset can be narrowed by before it is read; empty strings mean "not set". */
export interface Scope {
  series: string;
  rt: string;
  sensor: string;
  from: string;
  to: string;
  /** west, south, east, north */
  bbox: [string, string, string, string];
}

export interface ScopeSpec {
  series?: Opt[];
  rt?: Opt[];
  sensor?: Opt[];
  /** month: YYYY-MM, date: YYYY-MM-DD */
  period?: 'month' | 'date';
  periodRequired?: boolean;
  /** longest allowed period, in months (or days for dates) */
  maxSpan?: number;
  bbox?: boolean;
}

export interface DatasetDef {
  id: string;
  label: string;
  doc: string;
  cols: ColDef[];
  /** Columns shown by default in the table (all when omitted). */
  defaultCols?: string[];
  spec: ScopeSpec;
  /** SELECT with the friendly columns; the scope is already pushed into it. */
  relation(s: Scope): string;
  check(s: Scope): string | undefined;
  /** ORDER BY expression used by the table view. */
  order?: string;
  /** Rows can be opened on the globe (region_type and region_id columns). */
  regionRows?: boolean;
}

export interface ViewDoc {
  name: string;
  doc: string;
  cols: ColDef[];
}

export interface Catalog {
  man: Manifest;
  gfedNames: Record<string, string>;
  datasets: DatasetDef[];
  /** name (lower case) -> SQL, created on demand by the engine */
  views: Map<string, string>;
  docs: ViewDoc[];
}

const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k]));

const SENSOR_LABEL: Record<string, string> = {
  MODIS: TEXT.sensorModis,
  VIIRS_SNPP: TEXT.sensorSnpp,
  VIIRS_NOAA20: TEXT.sensorN20,
  VIIRS_NOAA21: TEXT.sensorN21,
};
const RAW_SENSORS = ['MODIS', 'VIIRS_SNPP', 'VIIRS_NOAA20', 'VIIRS_NOAA21'];
const HARM_KEY: Record<string, string> = { long: 'HARM_LONG', detail: 'HARM_DETAIL' };
const SERIES_OPTS: Opt[] = [
  ['long', TEXT.seriesLong],
  ['detail', TEXT.seriesDetail],
];
const RT_OPTS: Opt[] = [
  ['country', TEXT.country],
  ['gfed', TEXT.gfed],
];

const originSql = (col: string) =>
  `CASE ${col} WHEN 0 THEN ${ql(VAL.originAqua)} WHEN 1 THEN ${ql(VAL.originConv)} WHEN 2 THEN ${ql(VAL.originNative)} END`;

/** Quoted file list; `{data}/` is expanded to the data folder by the engine. */
const list = (paths: string[]) => `[${paths.map((p) => ql(/^https?:\/\//.test(p) ? p : `{data}/${p}`)).join(', ')}]`;

const col = (name: string, kind: Kind, doc: string): ColDef => ({ name, kind, doc });

// ---------- regions ----------

const REGION_COLS: ColDef[] = [
  col('series', 'text', TEXT.cdSeries),
  col('region_type', 'text', TEXT.cdRegionType),
  col('region', 'text', TEXT.cdRegion),
  col('region_id', 'text', TEXT.cdRegionId),
  col('period', 'text', TEXT.cdPeriod),
  col('year', 'int', TEXT.cdYear),
  col('month', 'int', TEXT.cdMonth),
  col('detections', 'num', TEXT.cdDetections),
  col('lo90', 'num', TEXT.cdLo90),
  col('hi90', 'num', TEXT.cdHi90),
  col('origin', 'text', TEXT.cdOrigin),
  col('usual', 'num', TEXT.cdUsual),
  col('ratio_to_usual', 'num', TEXT.cdRatio),
  col('percentile', 'num', TEXT.cdPercentile),
  col('signal', 'text', fill(TEXT.cdSignal, { above: VAL.above, below: VAL.below, within: VAL.within, partial: VAL.partial })),
];

/** Harmonized regional values, filled with 0 where a region has no row, with usual, ratio, percentile and signal. */
function regionsSql(man: Manifest, s: { series?: string; rt?: string }, where: string[]): string {
  const files = man.regions ?? [];
  const cond = (s.series ? ` AND series = ${ql(s.series)}` : '') + (s.rt ? ` AND rt = ${ql(s.rt)}` : '');
  // A later file replaces the earlier ones from its first month on.
  const parts = files.map((f, i) => {
    const later = files.slice(i + 1).map((g) => g.from);
    return `    SELECT series, rt, id, m, v, lo, hi, o FROM read_parquet(${list([f.path])}) WHERE m >= ${f.from}${later.length ? ` AND m < ${Math.min(...later)}` : ''}${cond}`;
  });
  // The current month is still being filled: it is neither compared nor part of the baseline.
  const now = new Date();
  const pm = (now.getUTCFullYear() - 2000) * 12 + now.getUTCMonth();
  const sql = `WITH src AS (
${parts.join('\n    UNION ALL\n')}
  ),
  months AS (SELECT DISTINCT series, rt, m FROM src),
  ids AS (SELECT DISTINCT series, rt, id FROM src),
  full_grid AS (
    SELECT i.series, i.rt, i.id, t.m, coalesce(s.v, 0) AS v, coalesce(s.lo, 0) AS lo, coalesce(s.hi, 0) AS hi, s.o
    FROM ids i JOIN months t ON t.series = i.series AND t.rt = i.rt
    LEFT JOIN src s ON s.series = i.series AND s.rt = i.rt AND s.id = i.id AND s.m = t.m
  ),
  stat AS (
    SELECT a.series, a.rt, a.id, a.m, median(b.v) AS usual, count(b.v) AS k,
           count(b.v) FILTER (WHERE b.v < a.v) AS below, count(b.v) FILTER (WHERE b.v = a.v) AS ties
    FROM full_grid a LEFT JOIN full_grid b
      ON b.series = a.series AND b.rt = a.rt AND b.id = a.id AND b.m % 12 = a.m % 12 AND b.m <> a.m AND b.m < ${pm}
    GROUP BY a.series, a.rt, a.id, a.m
  )
  SELECT a.series, a.rt AS region_type,
         CASE WHEN n.name IS NOT NULL THEN n.name || ' (' || a.id || ')' ELSE a.id END AS region,
         a.id AS region_id,
         printf('%04d-%02d', 2000 + a.m // 12, a.m % 12 + 1) AS period,
         2000 + a.m // 12 AS year, a.m % 12 + 1 AS month,
         CAST(a.v AS DOUBLE) AS detections, CAST(a.lo AS DOUBLE) AS lo90, CAST(a.hi AS DOUBLE) AS hi90,
         ${originSql('a.o')} AS origin,
         CAST(t.usual AS DOUBLE) AS usual,
         CASE WHEN t.usual > 0 AND a.m < ${pm} THEN a.v / t.usual END AS ratio_to_usual,
         CASE WHEN t.k > 0 AND a.m < ${pm} THEN 100.0 * (t.below + 0.5 * t.ties) / t.k END AS percentile,
         CASE WHEN a.m >= ${pm} THEN ${ql(VAL.partial)} WHEN t.usual IS NULL THEN NULL WHEN a.lo > t.usual THEN ${ql(VAL.above)}
              WHEN a.hi < t.usual THEN ${ql(VAL.below)} ELSE ${ql(VAL.within)} END AS signal
  FROM full_grid a
  JOIN stat t ON t.series = a.series AND t.rt = a.rt AND t.id = a.id AND t.m = a.m
  LEFT JOIN region_names n ON a.rt = 'gfed' AND n.code = a.id`;
  return where.length ? `SELECT * FROM (${sql}) WHERE ${where.join(' AND ')}` : sql;
}

// ---------- grids ----------

const GRID_COLS = (first: ColDef, harm: boolean): ColDef[] => [
  first,
  col('m', 'int', TEXT.cdM),
  col('year', 'int', TEXT.cdYear),
  col('month', 'int', TEXT.cdMonth),
  col('period', 'text', TEXT.cdPeriod),
  col('lat', 'num', TEXT.cdCellLat),
  col('lon', 'num', TEXT.cdCellLon),
  col('cls', 'int', harm ? TEXT.cdClsHarm : TEXT.cdClsRaw),
  col('n', 'num', TEXT.cdN),
  col('frp', 'num', TEXT.cdFrp),
  ...(harm ? [col('origin', 'text', TEXT.cdOrigin)] : []),
];

function gridSelect(label: { col: string; value: string }, files: string[], harm: boolean, where: string[]): string {
  return `SELECT ${ql(label.value)} AS ${label.col}, m, 2000 + m // 12 AS year, m % 12 + 1 AS month,
       printf('%04d-%02d', 2000 + m // 12, m % 12 + 1) AS period, lat, lon, cls, n, frp${harm ? `, ${originSql('o')} AS origin` : ''}
FROM read_parquet(${list(files)})${where.length ? `\nWHERE ${where.join(' AND ')}` : ''}`;
}

// ---------- points ----------

const POINT_COLS: ColDef[] = [
  col('sensor', 'text', TEXT.cdSensors),
  col('lon', 'num', TEXT.cdPtLon),
  col('lat', 'num', TEXT.cdPtLat),
  col('date', 'date', TEXT.cdDate),
  col('time_utc', 'text', TEXT.cdTime),
  col('frp', 'num', TEXT.cdFrp),
  col('daynight', 'text', TEXT.cdDayNight),
  col('confidence', 'text', TEXT.cdConfidence),
  col('satellite', 'text', TEXT.cdSatellite),
  col('type', 'int', TEXT.cdType),
  col('source', 'text', TEXT.cdSource),
];

function pointsSelect(sensor: string, files: string[], where: string[]): string {
  return `SELECT ${ql(sensor)} AS sensor, lon, lat, d AS date, lpad(CAST(hhmm AS VARCHAR), 4, '0') AS time_utc, frp,
       CASE WHEN flags & 1 = 1 THEN 'night' ELSE 'day' END AS daynight,
       CASE (flags >> 1) & 3 WHEN 2 THEN 'high' WHEN 1 THEN 'nominal' ELSE 'low' END AS confidence,
       CASE (flags >> 3) & 3 WHEN 1 THEN 'Terra' WHEN 2 THEN 'Aqua' ELSE 'VIIRS' END AS satellite,
       type, CASE src WHEN 0 THEN 'SP_ARCHIVE' WHEN 1 THEN 'SP_API' ELSE 'NRT_API' END AS source
FROM read_parquet(${list(files)})${where.length ? `\nWHERE ${where.join(' AND ')}` : ''}`;
}

// ---------- scope helpers ----------

function parseBbox(s: Scope): { box?: [number, number, number, number]; err?: string } {
  const raw = s.bbox.map((t) => t.trim());
  if (raw.every((t) => t === '')) return {};
  const v = raw.map(toNum);
  const [w, so, e, n] = v;
  const ok = v.every((x) => x !== undefined) && w! >= -180 && e! <= 180 && w! <= 180 && e! >= -180 && so! >= -90 && n! <= 90 && so! <= n!;
  return ok ? { box: [w!, so!, e!, n!] } : { err: TEXT.errBbox };
}

function bboxCond(box: number[] | undefined): string[] {
  if (!box) return [];
  const [w, s, e, n] = box;
  return [`lat BETWEEN ${s} AND ${n}`, w <= e ? `lon BETWEEN ${w} AND ${e}` : `(lon >= ${w} OR lon <= ${e})`];
}

function monthPeriod(s: Scope, required: boolean, maxSpan?: number): string | undefined {
  if (!s.from && !s.to && !required) return undefined;
  const a = monthIndex(s.from);
  const b = monthIndex(s.to);
  if ((s.from && a === undefined) || (s.to && b === undefined) || (required && (a === undefined || b === undefined))) return TEXT.errPeriod;
  if (a !== undefined && b !== undefined) {
    if (a > b) return TEXT.errOrder;
    if (maxSpan && b - a + 1 > maxSpan) return fill(TEXT.errSpanMonths, { n: maxSpan });
  }
  return undefined;
}

function dayPeriod(s: Scope): string | undefined {
  if (!RE_DATE.test(s.from) || !RE_DATE.test(s.to) || Number.isNaN(Date.parse(s.from)) || Number.isNaN(Date.parse(s.to))) return TEXT.errPeriod;
  const days = (Date.parse(s.to) - Date.parse(s.from)) / 864e5;
  if (days < 0) return TEXT.errOrder;
  return days > 365 ? TEXT.errSpanDays : undefined;
}

function monthWhere(s: Scope): string[] {
  const a = monthIndex(s.from);
  const b = monthIndex(s.to);
  return [...(a !== undefined ? [`m >= ${a}`] : []), ...(b !== undefined ? [`m <= ${b}`] : [])];
}

/** Files of the 10 degree latitude bands that overlap the box; at least one so an empty box still has a schema. */
function bandFiles(man: Manifest, key: string, box: number[] | undefined): string[] {
  const all = man.grid[key] ?? [];
  const hit = box ? all.filter((f) => f.north >= box[1] && f.south <= box[3]) : all;
  return (hit.length ? hit : all.slice(0, 1)).map((f) => f.path);
}

function pointFiles(man: Manifest, sensor: string, s: Scope): string[] {
  const y0 = Number(s.from.slice(0, 4));
  const y1 = Number(s.to.slice(0, 4));
  return (man.points[sensor] ?? []).filter((f) => f.year >= y0 && f.year <= y1).map((f) => f.path);
}

// ---------- catalog ----------

export function buildCatalog(man: Manifest, gfedNames: Record<string, string>): Catalog {
  const sensorOpts = (keys: string[]): Opt[] => keys.filter((k) => man.grid[k]?.length).map((k) => [k, SENSOR_LABEL[k] ?? k]);
  const pointSensors: Opt[] = Object.keys(man.points).map((k) => [k, SENSOR_LABEL[k] ?? k]);
  const hasRegions = !!man.regions?.length;

  const regionCheck = (s: Scope) => {
    if (!hasRegions) return TEXT.errNoRegions;
    return monthPeriod(s, false);
  };
  const regionRelation = (s: Scope) => {
    const w: string[] = [];
    if (RE_MONTH.test(s.from)) w.push(`period >= ${ql(s.from)}`);
    if (RE_MONTH.test(s.to)) w.push(`period <= ${ql(s.to)}`);
    return regionsSql(man, { series: s.series, rt: s.rt }, w);
  };

  const harmKey = (s: Scope) => HARM_KEY[s.series] ?? '';
  const datasets: DatasetDef[] = [
    {
      id: 'regions',
      label: TEXT.dsRegions,
      doc: TEXT.docRegions,
      cols: REGION_COLS,
      defaultCols: ['region', 'year', 'month', 'detections', 'lo90', 'hi90', 'usual', 'ratio_to_usual', 'percentile', 'signal', 'origin'],
      spec: { series: SERIES_OPTS, rt: RT_OPTS, period: 'month', periodRequired: false },
      order: 'region, year, month',
      regionRows: true,
      relation: regionRelation,
      check: regionCheck,
    },
    {
      id: 'harm_grid',
      label: TEXT.dsHarmGrid,
      doc: TEXT.docHarmGrid,
      cols: GRID_COLS(col('series', 'text', TEXT.cdSeriesShort), true),
      defaultCols: ['series', 'period', 'lat', 'lon', 'cls', 'n', 'frp', 'origin'],
      spec: { series: SERIES_OPTS, period: 'month', periodRequired: true, maxSpan: 24, bbox: true },
      relation(s) {
        const { box } = parseBbox(s);
        return gridSelect({ col: 'series', value: s.series }, bandFiles(man, harmKey(s), box), true, [...monthWhere(s), ...bboxCond(box)]);
      },
      check: (s) => (man.grid[harmKey(s)]?.length ? monthPeriod(s, true, 24) ?? parseBbox(s).err : TEXT.errNoFiles),
    },
    {
      id: 'grid',
      label: TEXT.dsGrid,
      doc: TEXT.docGrid,
      cols: GRID_COLS(col('sensor', 'text', TEXT.cdSensors), false),
      defaultCols: ['sensor', 'period', 'lat', 'lon', 'cls', 'n', 'frp'],
      spec: { sensor: sensorOpts(RAW_SENSORS), period: 'month', periodRequired: true, maxSpan: 12, bbox: true },
      relation(s) {
        const { box } = parseBbox(s);
        return gridSelect({ col: 'sensor', value: s.sensor }, bandFiles(man, s.sensor, box), false, [...monthWhere(s), ...bboxCond(box)]);
      },
      check: (s) => (man.grid[s.sensor]?.length ? monthPeriod(s, true, 12) ?? parseBbox(s).err : TEXT.errNoFiles),
    },
    {
      id: 'points',
      label: TEXT.dsPoints,
      doc: fill(TEXT.docPoints, { cap: ROW_CAP.toLocaleString(locale) }),
      cols: POINT_COLS,
      spec: { sensor: pointSensors, period: 'date', periodRequired: true, maxSpan: 366, bbox: true },
      order: 'date, time_utc',
      relation(s) {
        const { box } = parseBbox(s);
        const where = [`d BETWEEN DATE ${ql(s.from)} AND DATE ${ql(s.to)}`, ...bboxCond(box)];
        return pointsSelect(s.sensor, pointFiles(man, s.sensor, s), where);
      },
      check(s) {
        const err = dayPeriod(s) ?? parseBbox(s).err;
        if (err) return err;
        return pointFiles(man, s.sensor, s).length
          ? undefined
          : fill(TEXT.errYear, { sensor: s.sensor, years: s.from.slice(0, 4) === s.to.slice(0, 4) ? s.from.slice(0, 4) : `${s.from.slice(0, 4)}-${s.to.slice(0, 4)}` });
      },
    },
  ];

  return { man, gfedNames, datasets: datasets.filter((d) => hasRegions || !d.regionRows), views: viewSql(man, hasRegions), docs: viewDocs(man, hasRegions) };
}

// ---------- named views for SQL mode ----------

function viewSql(man: Manifest, hasRegions: boolean): Map<string, string> {
  const v = new Map<string, string>();
  if (hasRegions) v.set('regions', regionsSql(man, {}, []));
  const union = (parts: string[]) => parts.join('\nUNION ALL\n');
  const harm = Object.entries(HARM_KEY).filter(([, k]) => man.grid[k]?.length);
  if (harm.length)
    v.set('harm_grid', union(harm.map(([series, k]) => gridSelect({ col: 'series', value: series }, man.grid[k].map((f) => f.path), true, []))));
  const raw = RAW_SENSORS.filter((k) => man.grid[k]?.length);
  if (raw.length) v.set('grid', union(raw.map((k) => gridSelect({ col: 'sensor', value: k }, man.grid[k].map((f) => f.path), false, []))));
  for (const [sensor, files] of Object.entries(man.points)) {
    const byYear = new Map<number, string[]>();
    for (const f of files) byYear.set(f.year, [...(byYear.get(f.year) ?? []), f.path]);
    for (const [year, paths] of byYear) v.set(`points_${sensor.toLowerCase()}_${year}`, pointsSelect(sensor, paths, []));
  }
  return v;
}

function viewDocs(man: Manifest, hasRegions: boolean): ViewDoc[] {
  const out: ViewDoc[] = [];
  if (hasRegions) out.push({ name: 'regions', doc: TEXT.docRegions, cols: REGION_COLS });
  if (man.grid.HARM_LONG || man.grid.HARM_DETAIL) out.push({ name: 'harm_grid', doc: TEXT.docHarmGrid, cols: GRID_COLS(col('series', 'text', TEXT.cdSeriesShort), true) });
  out.push({ name: 'grid', doc: TEXT.docGrid, cols: GRID_COLS(col('sensor', 'text', TEXT.cdSensors), false) });
  const years = Object.entries(man.points).map(([s, f]) => `${s.toLowerCase()}: ${Math.min(...f.map((x) => x.year))}-${Math.max(...f.map((x) => x.year))}`);
  out.push({
    name: 'points_<sensor>_<year>',
    doc: fill(TEXT.docPointsViews, { years: years.join('; ') }),
    cols: POINT_COLS,
  });
  out.push({ name: 'region_names', doc: TEXT.docRegionNames, cols: [col('code', 'text', TEXT.cdGfedCode), col('name', 'text', TEXT.cdRegionName)] });
  return out;
}
