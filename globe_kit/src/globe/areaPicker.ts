import * as Cesium from 'cesium';
import { viewRectangle } from './pointLayer';
import { cellCorners, cellsFrame, cellsKm2, outerRings, polygonKm2, type CellArea } from './cells';

/** An area of interest: a lon/lat box, a circle (centre in degrees, radius in km) or a set of grid cells (a place). */
export type Area =
  | { kind: 'bbox'; west: number; south: number; east: number; north: number }
  | { kind: 'circle'; lat: number; lon: number; km: number }
  | CellArea;

/** Query string for GET endpoints (cells areas are sent in a POST body instead, see areaBody). */
export function areaQuery(a: Area): string {
  if (a.kind === 'cells') return `cells=${a.res}:${a.ids.length}`;
  return a.kind === 'bbox'
    ? `bbox=${[a.west, a.south, a.east, a.north].map((v) => v.toFixed(4)).join(',')}`
    : `circle=${a.lat.toFixed(4)},${a.lon.toFixed(4)},${a.km}`;
}

/** Texts of areaLabel (English defaults); the app passes translated ones. */
export interface AreaLabels {
  locale: string;
  /** Grid cells: count, resolution (deg), area in km2 (already formatted). */
  cells(n: number, res: number, km2: string): string;
  /** A named place on grid cells, with the area of the place itself when its outline is known (else placeKm2 is undefined). */
  place(label: string, cells: string, placeKm2?: string): string;
  box(south: string, north: string, west: string, east: string, km2: string): string;
  circle(km: number, lat: string, lon: string): string;
}
const AREA_LABELS: AreaLabels = {
  locale: 'en',
  cells: (n, res, km2) => `${n} cells of ${res} deg, about ${km2} km2`,
  place: (label, cells, placeKm2) => (placeKm2 === undefined ? `${label} (${cells})` : `${label} (place about ${placeKm2} km2; counted on ${cells})`),
  box: (s, n, w, e, km2) => `Box ${s}..${n} N, ${w}..${e} E (about ${km2} km2)`,
  circle: (km, lat, lon) => `${km} km around ${lat} N, ${lon} E`,
};

export function areaLabel(a: Area, labels: Partial<AreaLabels> = {}): string {
  const L = { ...AREA_LABELS, ...labels };
  const f = (v: number) => v.toFixed(2);
  const int = (v: number) => Math.round(v).toLocaleString(L.locale);
  if (a.kind === 'cells') {
    const cellsTxt = L.cells(a.ids.length, a.res, int(cellsKm2(a)));
    if (!a.geojson) return L.place(a.label, cellsTxt);
    const km2 = polygonKm2(a.geojson);
    return L.place(a.label, cellsTxt, km2 < 100 ? km2.toLocaleString(L.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : int(km2));
  }
  return a.kind === 'bbox'
    ? L.box(f(a.south), f(a.north), f(a.west), f(a.east), int(areaKm2(a)))
    : L.circle(a.km, f(a.lat), f(a.lon));
}

export function areaKm2(a: Area): number {
  if (a.kind === 'cells') return cellsKm2(a);
  if (a.kind === 'circle') return Math.PI * a.km * a.km;
  const r = 6371;
  const w = (((a.east - a.west) % 360) + 360) % 360 || 360;
  return (r * r * Cesium.Math.toRadians(w) * Math.abs(Math.sin(Cesium.Math.toRadians(a.north)) - Math.sin(Cesium.Math.toRadians(a.south))));
}

/**
 * Draws and edits an area of interest on the globe.
 * drawBox(): the next two clicks set opposite corners (Esc cancels); the box follows the mouse in between.
 */
export function createAreaPicker(viewer: Cesium.Viewer, color = Cesium.Color.fromCssColorString('#ffb020')) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  const pin = new Cesium.PinBuilder().fromColor(color, 40).toDataURL();
  let shape: Cesium.Entity | undefined;
  /** Cells and outline of a place area. */
  const extra = viewer.scene.primitives.add(new Cesium.PrimitiveCollection({ destroyPrimitives: true })) as Cesium.PrimitiveCollection;
  let rubber: Cesium.Rectangle | undefined;
  let cancelDraw: (() => void) | undefined;

  const pick = (p: Cesium.Cartesian2) => {
    const c = viewer.camera.pickEllipsoid(p, viewer.scene.globe.ellipsoid);
    return c ? Cesium.Cartographic.fromCartesian(c) : undefined;
  };

  function clear() {
    if (shape) viewer.entities.remove(shape);
    shape = undefined;
    extra.removeAll();
    viewer.scene.requestRender();
  }

  function show(a: Area) {
    clear();
    const style = {
      material: color.withAlpha(0.12),
      outline: true,
      outlineColor: color,
      outlineWidth: 2,
      height: 0,
    };
    if (a.kind === 'cells') {
      // The cells that are actually counted, filled, plus the outline of the place when known.
      const fill = color.withAlpha(0.22);
      const cells = new Cesium.Primitive({
        geometryInstances: cellCorners(a).map(
          ([x, y]) =>
            new Cesium.GeometryInstance({
              geometry: new Cesium.RectangleGeometry({ rectangle: Cesium.Rectangle.fromDegrees(x, y, x + a.res, y + a.res), height: 0 }),
              attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(fill) },
            }),
        ),
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: true,
      });
      extra.add(cells);
      if (a.geojson) {
        const lines = new Cesium.PolylineCollection();
        for (const ring of outerRings(a.geojson))
          if (ring.length > 1)
            lines.add({ positions: Cesium.Cartesian3.fromDegreesArray(ring.flatMap(([x, y]) => [x, y])), width: 2, material: Cesium.Material.fromType('Color', { color }) });
        extra.add(lines);
      }
      viewer.scene.requestRender();
      return;
    }
    shape =
      a.kind === 'bbox'
        ? viewer.entities.add({
            rectangle: { coordinates: Cesium.Rectangle.fromDegrees(a.west, a.south, a.east, a.north), ...style },
          })
        : viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat),
            ellipse: { semiMajorAxis: a.km * 1000, semiMinorAxis: a.km * 1000, ...style },
            // Pin on the reference point (address or typed coordinates).
            billboard: {
              image: pin,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
    viewer.scene.requestRender();
  }

  function drawBox(): Promise<Area | undefined> {
    cancelDraw?.();
    return new Promise((resolve) => {
      let first: Cesium.Cartographic | undefined;
      const canvas = viewer.scene.canvas;
      canvas.style.cursor = 'crosshair';
      const done = (a: Area | undefined) => {
        handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
        handler.removeInputAction(Cesium.ScreenSpaceEventType.MOUSE_MOVE);
        window.removeEventListener('keydown', onKey);
        canvas.style.cursor = '';
        cancelDraw = undefined;
        if (!a) clear();
        resolve(a);
      };
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && done(undefined);
      window.addEventListener('keydown', onKey);
      cancelDraw = () => done(undefined);
      handler.setInputAction((m: { position: Cesium.Cartesian2 }) => {
        const c = pick(m.position);
        if (!c) return;
        if (!first) {
          first = c;
          rubber = new Cesium.Rectangle(c.longitude, c.latitude, c.longitude, c.latitude);
          clear();
          shape = viewer.entities.add({
            rectangle: {
              coordinates: new Cesium.CallbackProperty(() => rubber, false),
              material: color.withAlpha(0.12),
              outline: true,
              outlineColor: color,
              height: 0,
            },
          });
          return;
        }
        const d = Cesium.Math.toDegrees;
        const a: Area = {
          kind: 'bbox',
          west: d(Math.min(first.longitude, c.longitude)),
          east: d(Math.max(first.longitude, c.longitude)),
          south: d(Math.min(first.latitude, c.latitude)),
          north: d(Math.max(first.latitude, c.latitude)),
        };
        show(a);
        done(a);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      handler.setInputAction((m: { endPosition: Cesium.Cartesian2 }) => {
        if (!first || !rubber) return;
        const c = pick(m.endPosition);
        if (!c) return;
        rubber.west = Math.min(first.longitude, c.longitude);
        rubber.east = Math.max(first.longitude, c.longitude);
        rubber.south = Math.min(first.latitude, c.latitude);
        rubber.north = Math.max(first.latitude, c.latitude);
        viewer.scene.requestRender();
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    });
  }

  function fromView(): Area | undefined {
    const r = viewRectangle(viewer);
    if (!r) return undefined;
    const a: Area = { kind: 'bbox', west: r[0], south: r[1], east: r[2], north: r[3] };
    show(a);
    return a;
  }

  /** Fly so that the area fills the view. */
  /**
   * Fly so that the area fills the part of the view not covered by panels.
   * pad: screen pixels covered on each side (panels, bottom bar); ignored on a side when too little would remain.
   */
  function zoomTo(a: Area, pad: { left?: number; right?: number; top?: number; bottom?: number } = {}) {
    let [w, s, e, n] =
      a.kind === 'cells'
        ? a.geojson
          ? a.bbox
          : cellsFrame(a)
        : a.kind === 'bbox'
          ? [a.west, a.south, a.east, a.north]
          : [
              a.lon - a.km / (111 * Math.cos(Cesium.Math.toRadians(a.lat))),
              a.lat - a.km / 111,
              a.lon + a.km / (111 * Math.cos(Cesium.Math.toRadians(a.lat))),
              a.lat + a.km / 111,
            ];
    if (e < w) e += 360;
    // 8% margin around the area, then extend the rectangle so that the area lands in the free part of the screen.
    const mx = (e - w) * 0.08 || 0.01;
    const my = (n - s) * 0.08 || 0.01;
    [w, e, s, n] = [w - mx, e + mx, s - my, n + my];
    const W = viewer.scene.canvas.clientWidth;
    const H = viewer.scene.canvas.clientHeight;
    let [l, r, t, b] = [pad.left ?? 0, pad.right ?? 0, pad.top ?? 0, pad.bottom ?? 0];
    if (W - l - r < W * 0.35) [l, r] = [0, 0];
    if (H - t - b < H * 0.3) [t, b] = [0, 0];
    const fw = (e - w) / (W - l - r);
    const fh = (n - s) / (H - t - b);
    [w, e, s, n] = [w - fw * l, e + fw * r, Math.max(-89, s - fh * b), Math.min(89, n + fh * t)];
    const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
    const rect = e - w >= 359 ? Cesium.Rectangle.fromDegrees(-180, s, 180, n) : Cesium.Rectangle.fromDegrees(wrap(w), s, wrap(e), n);
    viewer.camera.flyTo({ destination: rect, duration: 1.2 });
  }

  return { drawBox, fromView, show, clear, zoomTo, cancel: () => cancelDraw?.(), destroy: () => handler.destroy() };
}
