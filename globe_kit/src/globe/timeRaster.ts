import * as Cesium from 'cesium';
import { lut, RAMPS, type Stop } from './colormaps';

/**
 * A raster layer that changes with time: one equirectangular 8-bit grayscale PNG per time key
 * (0 = no data, 1..255 = encoded value). Frames are colored in the browser, so palette and
 * display range change without regenerating data.
 */
export interface TimeRasterOptions {
  /** URL of the frame for a time key. */
  frameUrl: (key: string) => string;
  /** Time keys with data, sorted. Keys outside this list hide the layer. */
  keys: string[];
  rectangle?: [number, number, number, number]; // west, south, east, north (degrees)
  ramp?: Stop[];
  /** Maps an encoded byte (1..255) to a 0..1 ramp position. Default: identity (b/255). */
  transfer?: (byte: number) => number;
  opacity?: number;
  /** Nearest keeps data cells crisp (honest); linear looks smoother. */
  smooth?: boolean;
  split?: Cesium.SplitDirection;
  /** Colored frames kept in memory (blob URLs). */
  cacheSize?: number;
}

export class TimeRasterLayer {
  private layer?: Cesium.ImageryLayer;
  private key?: string;
  private keys: Set<string>;
  private cache = new Map<string, string>();
  private table: Uint8ClampedArray;
  private seq = 0;
  readonly rect: Cesium.Rectangle;

  constructor(private viewer: Cesium.Viewer, private o: TimeRasterOptions) {
    this.keys = new Set(o.keys);
    const r = o.rectangle ?? [-180, -90, 180, 90];
    this.rect = Cesium.Rectangle.fromDegrees(...r);
    this.table = this.buildTable();
  }

  has(key: string) {
    return this.keys.has(key);
  }

  get currentKey() {
    return this.key;
  }

  /** Show the frame for a time key; resolves when it is on the globe. */
  async show(key: string): Promise<void> {
    this.key = key;
    const my = ++this.seq;
    if (!this.keys.has(key)) {
      this.swap(undefined);
      return;
    }
    const url = await this.colored(key);
    if (my !== this.seq) return; // a newer request superseded this one
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle: this.rect });
    if (my !== this.seq) return;
    const layer = new Cesium.ImageryLayer(provider, {
      alpha: this.o.opacity ?? 0.9,
      magnificationFilter: this.o.smooth ? Cesium.TextureMagnificationFilter.LINEAR : Cesium.TextureMagnificationFilter.NEAREST,
      minificationFilter: this.o.smooth ? Cesium.TextureMinificationFilter.LINEAR : Cesium.TextureMinificationFilter.NEAREST,
    });
    layer.splitDirection = this.o.split ?? Cesium.SplitDirection.NONE;
    this.swap(layer);
    this.prefetchAround(key);
  }

  setOpacity(a: number) {
    this.o.opacity = a;
    if (this.layer) this.layer.alpha = a;
    this.viewer.scene.requestRender();
  }

  setSplit(d: Cesium.SplitDirection) {
    this.o.split = d;
    if (this.layer) this.layer.splitDirection = d;
    this.viewer.scene.requestRender();
  }

  /** Change palette or transfer function: clears the colored cache and redraws. */
  restyle(p: { ramp?: Stop[]; transfer?: (byte: number) => number }) {
    Object.assign(this.o, p);
    this.table = this.buildTable();
    for (const u of this.cache.values()) URL.revokeObjectURL(u);
    this.cache.clear();
    if (this.key) void this.show(this.key);
  }

  /** New data source (other metric or sensor) with the same styling. */
  setSource(frameUrl: (key: string) => string, keys: string[]) {
    this.o.frameUrl = frameUrl;
    this.o.keys = keys;
    this.keys = new Set(keys);
    for (const u of this.cache.values()) URL.revokeObjectURL(u);
    this.cache.clear();
    if (this.key) void this.show(this.key);
  }

  get imageryLayer() {
    return this.layer;
  }

  destroy() {
    this.seq++;
    this.swap(undefined);
    for (const u of this.cache.values()) URL.revokeObjectURL(u);
    this.cache.clear();
  }

  // ------------------------------------------------------------------ internals

  private buildTable() {
    const ramp = lut(this.o.ramp ?? RAMPS.fire);
    const tf = this.o.transfer ?? ((b: number) => b / 255);
    const t = new Uint8ClampedArray(256 * 4); // byte 0 stays transparent
    for (let b = 1; b < 256; b++) {
      const i = Math.round(Math.min(1, Math.max(0, tf(b))) * 255) * 4;
      t.set(ramp.subarray(i, i + 4), b * 4);
    }
    return t;
  }

  private swap(next: Cesium.ImageryLayer | undefined) {
    const prev = this.layer;
    this.layer = next;
    const layers = this.viewer.imageryLayers;
    if (next) {
      // Insert just above the previous frame, so overlays stay on top.
      const at = prev ? layers.indexOf(prev) + 1 : layers.length;
      layers.add(next, at);
    }
    this.viewer.scene.requestRender();
    if (prev) {
      // Keep the old frame until the new texture is on screen, to avoid a blink.
      const remove = () => {
        if (layers.contains(prev)) layers.remove(prev, true);
        this.viewer.scene.requestRender();
      };
      if (next) setTimeout(remove, 250);
      else remove();
    }
  }

  private async colored(key: string): Promise<string> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // LRU: move to the end
      this.cache.set(key, hit);
      return hit;
    }
    const img = await loadImage(this.o.frameUrl(key));
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    const t = this.table;
    for (let i = 0; i < px.length; i += 4) {
      const j = px[i] * 4; // grayscale: R = G = B = encoded byte
      px[i] = t[j];
      px[i + 1] = t[j + 1];
      px[i + 2] = t[j + 2];
      px[i + 3] = t[j + 3];
    }
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob>((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error('toBlob failed'))), 'image/png'));
    const url = URL.createObjectURL(blob);
    this.cache.set(key, url);
    const max = this.o.cacheSize ?? 48;
    while (this.cache.size > max) {
      const [k, u] = this.cache.entries().next().value as [string, string];
      if (k === this.key) break;
      URL.revokeObjectURL(u);
      this.cache.delete(k);
    }
    return url;
  }

  private prefetchAround(key: string) {
    const all = this.o.keys;
    const i = all.indexOf(key);
    for (const k of [all[i + 1], all[i + 2]]) if (k && !this.cache.has(k)) void this.colored(k).catch(() => {});
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error(`cannot load ${url}`));
    img.src = url;
  });
}
