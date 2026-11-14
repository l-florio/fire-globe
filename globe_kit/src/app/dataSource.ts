import { areaQuery, type Area } from '../globe';

/** Detections as Float32 records of 6 values: lon, lat, frp_MW, day_of_month, hour_utc, flags. */
export interface Detections {
  buf: Float32Array;
  total: number;
  /** Set when the request falls outside the area covered by single detections (static version). */
  outside?: string;
}

export interface CalendarResult {
  source: 'detections' | 'grid';
  months: [string, number, number][];
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
  detections(sensor: string, period: { month?: string; date?: string }, bbox: number[] | null, limit: number, signal?: AbortSignal): Promise<Detections>;
  calendar(sensor: string, area: Area, types: string): Promise<CalendarResult>;
  exportCsv(sensor: string, area: Area, from: string, to: string, types: string): Promise<Blob>;
}

// ------------------------------------------------------------------ local service

export function apiSource(): DataSource {
  return {
    kind: 'api',
    note: 'Local data service: full FIRMS archive.',
    async detections(sensor, period, bbox, limit, signal) {
      const p = period.date ? `date=${period.date}` : `month=${period.month}`;
      const b = bbox ? `&bbox=${bbox.map((v) => v.toFixed(3)).join(',')}` : '';
      const r = await fetch(`/api/detections?sensor=${sensor}&${p}${b}&limit=${limit}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { buf: new Float32Array(await r.arrayBuffer()), total: Number(r.headers.get('X-Total') ?? 0) };
    },
    async calendar(sensor, area, types) {
      const r = await fetch(`/api/calendar?sensor=${sensor}&${areaQuery(area)}&types=${types}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    async exportCsv(sensor, area, from, to, types) {
      const r = await fetch(`/api/export?sensor=${sensor}&${areaQuery(area)}&from=${from}&to=${to}&types=${types}`);
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
