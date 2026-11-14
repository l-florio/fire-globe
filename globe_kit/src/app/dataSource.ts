import { areaQuery, toCells, type Area } from '../globe';
import { t } from './i18n';

/**
 * The area as counted on a grid: every grid cell the area overlaps (so that a small circle or box still has data).
 * Harmonized series: 1 degree cells. rawGridRes: resolution of the raw per-sensor grid when the calendar is computed
 * from it (static version, 0.25); undefined when raw counts come from single detections (local service).
 */
export function areaFor(sensor: string, a: Area, rawGridRes?: number): Area {
  const res = sensor.startsWith('HARM_') ? 1 : rawGridRes;
  return res ? toCells(a, res) : a;
}

/** GET for boxes and circles; POST with a JSON body for places (cell lists are too long for a URL). */
function areaFetch(path: string, sensor: string, area: Area, extra: string) {
  const a = areaFor(sensor, area);
  if (a.kind !== 'cells') return fetch(`${path}?sensor=${sensor}&${areaQuery(a)}${extra}`);
  return fetch(`${path}?sensor=${sensor}${extra}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cells: { res: a.res, ids: a.ids, bbox: a.bbox } }),
  });
}

/** Detections as Float32 records of 7 values: lon, lat, frp_MW, day_of_month, hour_utc, flags, FIRMS type (-1 unknown). */
export interface Detections {
  buf: Float32Array;
  total: number;
  /** Set when the request falls outside the area covered by single detections (static version). */
  outside?: string;
}

/** [YYYY-MM, value, FRP, origin?]; origin only for harmonized series: 0 measured (Aqua), 1 converted, 2 VIIRS native. */
export type MonthRow = [string, number, number, number?];

/** Harmonized regional value: [region, YYYY-MM, value, lo90, hi90, origin]. */
export type RegionRow = [string, string, number, number, number, number];

export interface CalendarResult {
  source: 'detections' | 'grid' | 'harmonized';
  months: MonthRow[];
}

/**
 * Where the app gets data:
 * - "api": the local service (server/fire_api.py), full archive.
 * - "static": Parquet files next to the page, queried in the browser with DuckDB-WASM
 *   (worldwide calendar grid, single detections for one region).
 */
export interface DataSource {
  kind: 'api' | 'static';
  /** Shown to the user, e.g. which region has single detections. */
  note: string;
  detections(sensor: string, period: { month?: string; date?: string }, bbox: number[] | null, limit: number, signal?: AbortSignal, types?: string): Promise<Detections>;
  calendar(sensor: string, area: Area, types: string): Promise<CalendarResult>;
  exportCsv(sensor: string, area: Area, from: string, to: string, types: string): Promise<Blob>;
  /** Harmonized series by country or GFED region, for one calendar month (1-12) of every year. */
  regions(series: 'long' | 'detail', type: 'country' | 'gfed', monthOfYear: number): Promise<RegionRow[]>;
}

// ------------------------------------------------------------------ local service

export function apiSource(): DataSource {
  return {
    kind: 'api',
    note: t('data.note.api'),
    async detections(sensor, period, bbox, limit, signal, types = '0,-1') {
      const p = period.date ? `date=${period.date}` : `month=${period.month}`;
      const b = bbox ? `&bbox=${bbox.map((v) => v.toFixed(3)).join(',')}` : '';
      const r = await fetch(`/api/detections?sensor=${sensor}&${p}${b}&limit=${limit}&types=${types}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { buf: new Float32Array(await r.arrayBuffer()), total: Number(r.headers.get('X-Total') ?? 0) };
    },
    async calendar(sensor, area, types) {
      const r = await areaFetch('/api/calendar', sensor, area, `&types=${types}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    async regions(series, type, moy) {
      const r = await fetch(`/api/regions?series=${series}&type=${type}&month=${moy}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return ((await r.json()) as { rows: RegionRow[] }).rows;
    },
    async exportCsv(sensor, area, from, to, types) {
      const r = await areaFetch('/api/export', sensor, area, `&from=${from}&to=${to}&types=${types}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    },
  };
}

export async function detectSource(): Promise<DataSource | undefined> {
  const api = await fetch('/api/health')
    .then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('json'))
    .catch(() => false);
  if (api) return apiSource();
  const { staticSource } = await import('./staticSource');
  return staticSource(`${import.meta.env.BASE_URL}data/`);
}

/**
 * A data source usable at once: the real one (local service or DuckDB-WASM) is resolved in the
 * background, so the app does not wait for the database engine before showing the globe.
 */
export function lazySource(p: Promise<DataSource | undefined>): DataSource {
  let real: DataSource | undefined;
  const get = async () => {
    const d = real ?? (await p);
    if (!d) throw new Error(t('data.noSource'));
    return d;
  };
  void p.then((d) => (real = d));
  return {
    get kind() {
      return real?.kind ?? 'static';
    },
    get note() {
      return real?.note ?? t('data.loadingEngine');
    },
    detections: async (...a) => (await get()).detections(...a),
    calendar: async (...a) => (await get()).calendar(...a),
    exportCsv: async (...a) => (await get()).exportCsv(...a),
    regions: async (...a) => (await get()).regions(...a),
  };
}
