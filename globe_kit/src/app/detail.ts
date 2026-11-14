import * as Cesium from 'cesium';
import { PointLayer, cameraHeight, viewRectangle, type TimeRasterLayer } from '../globe';
import type { DataSource } from './dataSource';

/** In monthly mode, below this camera height the app loads individual detections for the visible area. */
export const DETAIL_HEIGHT_M = 2_500_000;
/** FRP (MW) mapped to the top of the color ramp for single detections. */
export const DETECTION_FRP_TOP = 1000;
const STRIDE = 6; // lon, lat, frp, day, hour_utc, flags
const LIMIT = 150_000;

export type Step = 'month' | 'day';
export type Pass = 'all' | 'day' | 'night';
export type Sat = 'all' | 'terra' | 'aqua';

interface Side {
  sensor: string;
  split: Cesium.SplitDirection;
  raster: TimeRasterLayer;
}

export interface DetailEvents {
  /** Points on screen or not (legend and filters follow). */
  onMode(active: boolean): void;
  /** Human-readable status for the panel. */
  onStatus(text: string): void;
}

/**
 * Individual FIRMS detections from the local data service (server/fire_api.py), colored by FRP.
 * - month step: loaded when zoomed in, for the visible area; the raster stays as background.
 * - day step: always loaded for the visible area (whole globe when zoomed out); the raster is hidden.
 * Client-side filters (no reload): day of month, day/night pass, MODIS satellite (Terra 10:30, Aqua 13:30).
 */
export function createDetail(viewer: Cesium.Viewer, labels: Record<string, string>, ds: DataSource | undefined, ev: DetailEvents) {
  const layers = [new PointLayer(viewer, { pixelSize: 5 }), new PointLayer(viewer, { pixelSize: 5 })];
  const data: (Float32Array | undefined)[] = [undefined, undefined];
  let sides: Side[] = [];
  let step: Step = 'month';
  let period = ''; // YYYY-MM or YYYY-MM-DD
  let day = 0; // month step only, 0 = all days
  let pass: Pass = 'all';
  let sat: Sat = 'all';
  let active = false;
  let ctrl: AbortController | undefined;
  let timer: number | undefined;
  let baseStatus = '';

  const t = (frp: number) => Math.log1p(Math.max(0, frp)) / Math.log1p(DETECTION_FRP_TOP);
  const rasterOpacity = () => (step === 'day' ? 0 : active ? 0.3 : 0.9);

  function setActive(on: boolean) {
    if (on !== active) {
      active = on;
      if (!on) {
        ctrl?.abort();
        for (const l of layers) l.clear();
        data.fill(undefined);
        baseStatus = '';
        ev.onStatus('');
      }
      ev.onMode(on);
    }
    for (const s of sides) s.raster.setOpacity(rasterOpacity());
  }

  function keep(d: Float32Array, i: number) {
    const o = i * STRIDE;
    if (step === 'month' && day && d[o + 3] !== day) return false;
    const flags = d[o + 5];
    const night = (flags & 1) === 1;
    if (pass === 'day' && night) return false;
    if (pass === 'night' && !night) return false;
    const s = (flags >> 3) & 3; // 1 Terra, 2 Aqua, 0 other (VIIRS)
    if (sat === 'terra' && s === 2) return false;
    if (sat === 'aqua' && s === 1) return false;
    return true;
  }

  function applyFilters() {
    const counts: string[] = [];
    data.forEach((d, k) => {
      if (!d) return;
      let c = 0;
      layers[k].filter((i) => {
        const ok = keep(d, i);
        if (ok) c++;
        return ok;
      });
      counts.push(`${(labels[sides[k]?.sensor] ?? sides[k]?.sensor ?? '').split(' ')[0]} ${c.toLocaleString('en')}`);
    });
    const filtered = (step === 'month' && day) || pass !== 'all' || sat !== 'all';
    if (baseStatus) ev.onStatus(filtered ? `${baseStatus} Shown after filters: ${counts.join(', ')}.` : baseStatus);
  }

  async function load() {
    const zoomedIn = cameraHeight(viewer) <= DETAIL_HEIGHT_M;
    // No sensor with single detections on screen (e.g. the harmonized series): nothing to load.
    if (!period || !sides.length || (step === 'month' && !zoomedIn)) return setActive(false);
    const rect = viewRectangle(viewer);
    setActive(true);
    ctrl?.abort();
    const my = (ctrl = new AbortController());
    let bbox: number[] | null = null;
    if (rect && zoomedIn) {
      // Pad the view a little so small pans do not reload.
      const [w, s, e, n] = rect;
      const pw = (e >= w ? e - w : e + 360 - w) * 0.1;
      const ph = (n - s) * 0.1;
      bbox = [((w - pw + 540) % 360) - 180, Math.max(-90, s - ph), ((e + pw + 540) % 360) - 180, Math.min(90, n + ph)];
    }
    if (!ds) {
      ev.onStatus('Detections need the local data service or the static data files.');
      return;
    }
    const per = step === 'day' ? { date: period } : { month: period };
    ev.onStatus('Loading detections...');
    let outside = '';
    try {
      const results = await Promise.all(
        sides.map(async (sd) => {
          const r = await ds.detections(sd.sensor, per, bbox, LIMIT, my.signal);
          if (r.outside) outside = r.outside;
          return { sd, buf: r.buf, total: r.total };
        }),
      );
      if (my.signal.aborted) return;
      const parts: string[] = [];
      layers.forEach((l, k) => {
        const res = results[k];
        if (!res) {
          l.clear();
          data[k] = undefined;
          return;
        }
        const { sd, buf, total } = res;
        const count = buf.length / STRIDE;
        l.setSplit(sd.split);
        l.setPoints(count, (i) => ({ lon: buf[i * STRIDE], lat: buf[i * STRIDE + 1], t: t(buf[i * STRIDE + 2]) }));
        data[k] = buf;
        const name = labels[sd.sensor] ?? sd.sensor;
        parts.push(
          count < total
            ? `${name}: strongest ${count.toLocaleString('en')} of ${total.toLocaleString('en')}`
            : `${name}: ${total.toLocaleString('en')}`,
        );
      });
      const where = bbox === null ? (ds.kind === 'static' ? 'in the covered region' : 'worldwide') : 'in view';
      baseStatus = outside
        ? `${outside} Zoom or move there to see single detections.`
        : `Detections ${where} (${step === 'day' ? period : `month ${period}`}) - ${parts.join('; ')}.`;
      applyFilters();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      ev.onStatus(`Could not load detections: ${(err as Error).message}`);
    }
  }

  function schedule(ms = 250) {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(), ms);
  }

  viewer.camera.moveEnd.addEventListener(() => schedule());

  return {
    get active() {
      return active;
    },
    /** Time step and the current key (YYYY-MM for month, YYYY-MM-DD for day). */
    setPeriod(nextStep: Step, key: string) {
      if (nextStep === step && key === period) return;
      const stepChanged = nextStep !== step;
      step = nextStep;
      period = key;
      if (stepChanged) {
        for (const l of layers) l.clear();
        data.fill(undefined);
        for (const s of sides) s.raster.setOpacity(rasterOpacity());
      }
      schedule(stepChanged ? 0 : 150);
    },
    setSides(next: Side[]) {
      for (const s of sides) s.raster.setOpacity(0.9);
      sides = next;
      for (const s of sides) s.raster.setOpacity(rasterOpacity());
      for (let k = next.length; k < layers.length; k++) {
        layers[k].clear();
        data[k] = undefined;
      }
      schedule(50);
    },
    setFilters(f: { day?: number; pass?: Pass; sat?: Sat }) {
      if (f.day !== undefined) day = f.day;
      if (f.pass) pass = f.pass;
      if (f.sat) sat = f.sat;
      applyFilters();
    },
  };
}
