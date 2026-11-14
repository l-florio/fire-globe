import * as Cesium from 'cesium';
import { lut, RAMPS, type Stop } from './colormaps';

export interface PointLayerOptions {
  ramp?: Stop[];
  /** Base size in pixels; scaled down when the camera is far. */
  pixelSize?: number;
  split?: Cesium.SplitDirection;
}

export interface PointInput {
  lon: number;
  lat: number;
  /** Ramp position 0..1. */
  t: number;
}

/**
 * Many small points on the globe (Cesium PointPrimitiveCollection), colored by a ramp.
 * Points can be shown and hidden without rebuilding, for fast client-side filters.
 */
export class PointLayer {
  private coll: Cesium.PointPrimitiveCollection;
  private points: Cesium.PointPrimitive[] = [];
  private colors: Cesium.Color[];
  private split: Cesium.SplitDirection;

  constructor(private viewer: Cesium.Viewer, private o: PointLayerOptions = {}) {
    this.coll = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.colors = this.buildColors();
    this.split = o.split ?? Cesium.SplitDirection.NONE;
  }

  /** Replace all points. Large inputs (100k+) take a few hundred milliseconds. */
  setPoints(n: number, get: (i: number) => PointInput) {
    this.coll.removeAll();
    this.points = new Array(n);
    const size = this.o.pixelSize ?? 4;
    const scale = new Cesium.NearFarScalar(2e4, 1.6, 4e6, 0.6);
    const outline = Cesium.Color.BLACK.withAlpha(0.35);
    for (let i = 0; i < n; i++) {
      const p = get(i);
      this.points[i] = this.coll.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
        color: this.colors[Math.round(Math.min(1, Math.max(0, p.t)) * 255)],
        pixelSize: size,
        outlineColor: outline,
        outlineWidth: 0.5,
        scaleByDistance: scale,
        splitDirection: this.split,
      });
    }
    this.viewer.scene.requestRender();
  }

  /** Show only the points for which keep(i) is true. */
  filter(keep: (i: number) => boolean) {
    for (let i = 0; i < this.points.length; i++) this.points[i].show = keep(i);
    this.viewer.scene.requestRender();
  }

  setSplit(d: Cesium.SplitDirection) {
    this.split = d;
    for (const p of this.points) p.splitDirection = d;
    this.viewer.scene.requestRender();
  }

  setVisible(v: boolean) {
    this.coll.show = v;
    this.viewer.scene.requestRender();
  }

  get size() {
    return this.points.length;
  }

  clear() {
    this.coll.removeAll();
    this.points = [];
    this.viewer.scene.requestRender();
  }

  destroy() {
    this.viewer.scene.primitives.remove(this.coll);
    this.points = [];
  }

  private buildColors() {
    const t = lut(this.o.ramp ?? RAMPS.fire);
    const out: Cesium.Color[] = [];
    for (let i = 0; i < 256; i++)
      out.push(Cesium.Color.fromBytes(t[i * 4], t[i * 4 + 1], t[i * 4 + 2], Math.max(200, t[i * 4 + 3])));
    return out;
  }
}

/** Visible map rectangle in degrees [west, south, east, north], or undefined when the sky is in view. */
export function viewRectangle(viewer: Cesium.Viewer): [number, number, number, number] | undefined {
  const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!r) return undefined;
  const d = Cesium.Math.toDegrees;
  return [d(r.west), d(r.south), d(r.east), d(r.north)];
}

/** Camera height above the ellipsoid, metres. */
export function cameraHeight(viewer: Cesium.Viewer): number {
  return viewer.scene.globe.ellipsoid.cartesianToCartographic(viewer.camera.positionWC)?.height ?? Infinity;
}
