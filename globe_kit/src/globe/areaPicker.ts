import * as Cesium from 'cesium';
import { viewRectangle } from './pointLayer';

/** An area of interest: a lon/lat box or a circle (centre in degrees, radius in km). */
export type Area =
  | { kind: 'bbox'; west: number; south: number; east: number; north: number }
  | { kind: 'circle'; lat: number; lon: number; km: number };

export function areaQuery(a: Area): string {
  return a.kind === 'bbox'
    ? `bbox=${[a.west, a.south, a.east, a.north].map((v) => v.toFixed(4)).join(',')}`
    : `circle=${a.lat.toFixed(4)},${a.lon.toFixed(4)},${a.km}`;
}

export function areaLabel(a: Area): string {
  const f = (v: number) => v.toFixed(2);
  return a.kind === 'bbox'
    ? `Box ${f(a.south)}..${f(a.north)} N, ${f(a.west)}..${f(a.east)} E (about ${Math.round(areaKm2(a)).toLocaleString('en')} km2)`
    : `${a.km} km around ${f(a.lat)} N, ${f(a.lon)} E`;
}

export function areaKm2(a: Area): number {
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
  let shape: Cesium.Entity | undefined;
  let rubber: Cesium.Rectangle | undefined;
  let cancelDraw: (() => void) | undefined;

  const pick = (p: Cesium.Cartesian2) => {
    const c = viewer.camera.pickEllipsoid(p, viewer.scene.globe.ellipsoid);
    return c ? Cesium.Cartographic.fromCartesian(c) : undefined;
  };

  function clear() {
    if (shape) viewer.entities.remove(shape);
    shape = undefined;
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
    shape =
      a.kind === 'bbox'
        ? viewer.entities.add({
            rectangle: { coordinates: Cesium.Rectangle.fromDegrees(a.west, a.south, a.east, a.north), ...style },
          })
        : viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat),
            ellipse: { semiMajorAxis: a.km * 1000, semiMinorAxis: a.km * 1000, ...style },
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
  function zoomTo(a: Area) {
    const rect =
      a.kind === 'bbox'
        ? Cesium.Rectangle.fromDegrees(a.west, a.south, a.east, a.north)
        : Cesium.Rectangle.fromDegrees(
            a.lon - a.km / (111 * Math.cos(Cesium.Math.toRadians(a.lat))),
            a.lat - a.km / 111,
            a.lon + a.km / (111 * Math.cos(Cesium.Math.toRadians(a.lat))),
            a.lat + a.km / 111,
          );
    viewer.camera.flyTo({ destination: rect, duration: 1.2 });
  }

  return { drawBox, fromView, show, clear, zoomTo, cancel: () => cancelDraw?.(), destroy: () => handler.destroy() };
}
