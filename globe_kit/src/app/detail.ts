import * as Cesium from 'cesium';
import { PointLayer, cameraHeight, viewRectangle, type Stop, type TimeRasterLayer } from '../globe';
import type { DataSource } from './dataSource';
import { fmtInt, t as tr } from './i18n';

/** In monthly mode, below this camera height the app loads individual detections for the visible area. */
export const DETAIL_HEIGHT_M = 2_500_000;
/** FRP (MW) mapped to the top of the color ramp for single detections. */
export const DETECTION_FRP_TOP = 1000;
const STRIDE = 7; // lon, lat, frp, day, hour_utc, flags, FIRMS type (-1 unknown)
const LIMIT = 150_000;

export type Step = 'month' | 'day';
export type Pass = 'all' | 'day' | 'night';
export type Sat = 'all' | 'terra' | 'aqua';

interface Side {
  sensor: string;
  split: Cesium.SplitDirection;
  raster: TimeRasterLayer;
}

/** One detection as listed in the detections popup. */
export interface DetectionRecord {
  sensor: string;
  lon: number;
  lat: number;
  frp: number;
  date: string; // YYYY-MM-DD
  hourUtc: number; // decimal hours
  night: boolean;
  confidence: 'low' | 'nominal' | 'high';
  satellite: string; // Terra, Aqua or the VIIRS satellite
  kind: 'vegetation' | 'volcano' | 'industrial' | 'offshore';
}

export interface DetailEvents {
  /** Points on screen or not (legend and filters follow). */
  onMode(active: boolean): void;
  /** Human-readable status for the panel; busy: loading or failed (no detections to list yet). */
  onStatus(text: string, busy?: boolean): void;
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
  let types = '0,-1'; // FIRMS type list sent to the data source
  let active = false;
  let ctrl: AbortController | undefined;
  let timer: number | undefined;
  let baseStatus = '';

  // Highlighted detection (hover or click in the list).
  const mark = viewer.entities.add({
    show: false,
    position: Cesium.Cartesian3.fromDegrees(0, 0),
    point: {
      pixelSize: 16,
      color: Cesium.Color.TRANSPARENT,
      outlineColor: Cesium.Color.CYAN,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  const t = (frp: number) => Math.log1p(Math.max(0, frp)) / Math.log1p(DETECTION_FRP_TOP);
  // The raster holds vegetation fires only: dimmed when the filter shows no vegetation (volcanoes, static, offshore).
  const noVeg = () => !types.split(',').some((x) => x === '0' || x === '-1');
  const rasterOpacity = () => (step === 'day' ? 0 : noVeg() ? 0.1 : active ? 0.3 : 0.9);

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
      counts.push(`${(labels[sides[k]?.sensor] ?? sides[k]?.sensor ?? '').split(' ')[0]} ${fmtInt(c)}`);
    });
    const filtered = (step === 'month' && day) || pass !== 'all' || sat !== 'all';
    if (baseStatus) ev.onStatus(filtered ? `${baseStatus} ${tr('det.filtered', { counts: counts.join(', ') })}` : baseStatus);
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
      ev.onStatus(tr('det.needService'), true);
      return;
    }
    const per = step === 'day' ? { date: period } : { month: period };
    ev.onStatus(tr('det.loading'), true);
    let outside = '';
    try {
      const results = await Promise.all(
        sides.map(async (sd) => {
          const r = await ds.detections(sd.sensor, per, bbox, LIMIT, my.signal, types);
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
            ? tr('det.strongest', { name, n: fmtInt(count), total: fmtInt(total) })
            : tr('det.total', { name, total: fmtInt(total) }),
        );
      });
      const where = tr(bbox === null ? (ds.kind === 'static' ? 'det.where.region' : 'det.where.world') : 'det.where.view');
      baseStatus = outside
        ? tr('det.outside', { outside })
        : tr('det.status', { where, period: step === 'day' ? period : tr('det.month', { period }), parts: parts.join('; ') });
      applyFilters();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      ev.onStatus(tr('det.error', { msg: (err as Error).message }), true);
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
    /** Loaded detections after the filters, strongest first (both sides of a split view). */
    list(limit = 500): { rows: DetectionRecord[]; total: number } {
      const all: DetectionRecord[] = [];
      let total = 0;
      data.forEach((d, k) => {
        const sensor = sides[k]?.sensor;
        if (!d || !sensor) return;
        const name = (labels[sensor] ?? sensor).split(' (')[0];
        for (let i = 0; i < d.length / STRIDE; i++) {
          if (!keep(d, i)) continue;
          total++;
          const o = i * STRIDE;
          const flags = d[o + 5];
          const sat = (flags >> 3) & 3;
          all.push({
            sensor,
            lon: d[o],
            lat: d[o + 1],
            frp: d[o + 2],
            date: step === 'day' ? period : `${period}-${String(d[o + 3]).padStart(2, '0')}`,
            hourUtc: d[o + 4],
            night: (flags & 1) === 1,
            confidence: (['low', 'nominal', 'high'] as const)[(flags >> 1) & 3] ?? 'low',
            satellite: sat === 1 ? 'Terra' : sat === 2 ? 'Aqua' : name,
            kind: (['vegetation', 'volcano', 'industrial', 'offshore'] as const)[d[o + 6]] ?? 'vegetation',
          });
        }
      });
      all.sort((a, b) => b.frp - a.frp);
      return { rows: all.slice(0, limit), total };
    },
    /** Ring around one detection on the globe; undefined hides it. */
    highlight(r: DetectionRecord | undefined) {
      mark.show = !!r;
      if (r) mark.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(r.lon, r.lat));
      viewer.scene.requestRender();
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
    /** FIRMS `type` list of the sources to show (reloads the detections when it changes). */
    setTypes(next: string) {
      if (next === types) return;
      types = next;
      for (const s of sides) s.raster.setOpacity(rasterOpacity());
      if (active) schedule(0);
    },
    /** Accessibility look of the detection points: colour ramp and dark outline (no reload). */
    setLook(look: { ramp?: Stop[]; halo?: boolean }) {
      for (const l of layers) {
        if (look.ramp) l.setRamp(look.ramp);
        if (look.halo !== undefined) l.setHalo(look.halo);
      }
    },
    setFilters(f: { day?: number; pass?: Pass; sat?: Sat }) {
      if (f.day !== undefined) day = f.day;
      if (f.pass) pass = f.pass;
      if (f.sat) sat = f.sat;
      applyFilters();
    },
  };
}
