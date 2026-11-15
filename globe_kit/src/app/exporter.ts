import * as Cesium from 'cesium';
import { toCanvas, toBlob } from 'html-to-image';
import { fmtFixed, t, tn } from './i18n';
import './exporter.css';

const TEXT = {
  button: t('exp.button'),
  buttonTitle: t('exp.buttonTitle'),
  modeLabel: t('exp.modeLabel'),
  modeImage: t('exp.modeImage'),
  modeVideo: t('exp.modeVideo'),
  format: t('exp.format'),
  fmt: {
    cur: t('exp.fmt.cur'),
    '16:9': t('exp.fmt.169'),
    '4:3': t('exp.fmt.43'),
    '1:1': t('exp.fmt.11'),
    '9:16': t('exp.fmt.916'),
  } as Record<string, string>,
  resPreset: (p: number, w: number, h: number) => t(p >= 2160 ? 'exp.resPreset4k' : 'exp.resPreset', { p, w, h }),
  hint4k: t('exp.hint4k'),
  capNote: (w: number, h: number) => t('exp.capNote', { w, h }),
  errVideoSize: (w: number, h: number) => t('exp.err.videoSize', { w, h }),
  dlImage: t('exp.dlImage'),
  dlVideo: t('exp.dlVideo'),
  share: t('exp.share'),
  shareReady: t('exp.shareReady'),
  shared: t('exp.shared'),
  cancel: t('exp.cancel'),
  from: t('exp.from'),
  to: t('exp.to'),
  fps: t('exp.fps'),
  resolution: t('exp.resolution'),
  resCurrent: (w: number, h: number) => t('exp.resCurrent', { w, h }),
  frames: (n: number, sec: number) => tn('exp.frames', n, { sec: fmtFixed(sec, 1) }),
  rangeInvalid: t('exp.rangeInvalid'),
  noVideo: t('exp.noVideo'),
  keepVisible: t('exp.keepVisible'),
  progress: (i: number, n: number, label: string) => t('exp.progress', { i, n, label }),
  progressAria: t('exp.progressAria'),
  finishing: t('exp.finishing'),
  saved: (name: string) => t('exp.saved', { name }),
  cancelled: t('exp.cancelled'),
  failed: (m: string) => t('exp.failed', { msg: m }),
  working: t('exp.working'),
  dataCredit: t('exp.dataCredit'),
  imageryFallback: t('exp.imageryFallback'),
  popLabel: t('exp.popLabel'),
  errCanvas: t('exp.err.canvas'),
  errBlob: t('exp.err.blob'),
};

type Slider = { readonly key: string; go(key: string): Promise<void> | void; stop?: () => void };

export interface ExporterOptions {
  viewer: Cesium.Viewer;
  slider: Slider;
  keys: () => string[];
  formatKey: (key: string) => string;
  title: () => string;
  legend: () => HTMLElement | null;
}

const PANEL_BG = '#0c121e';
const TEXT_COLOR = '#e8edf5';
const MUTED = '#9aa7ba';
const ACCENT = '#ff8a3d';
const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** rAF with a timeout fallback (rAF never fires in background tabs). */
const nextFrame = () =>
  new Promise<void>((r) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        r();
      }
    };
    requestAnimationFrame(fin);
    setTimeout(fin, 120);
  });

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'fire-globe'
  );
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function canvasToBlob(c: HTMLCanvasElement, type = 'image/png') {
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error(TEXT.errBlob))), type));
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}...`).width > maxW) t = t.slice(0, -1);
  return `${t}...`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface Meta {
  title: string;
  label: string;
  legend: HTMLCanvasElement | null;
  /** Pixel ratio the legend canvas was rasterized at. */
  legendPr: number;
  credits: string;
  logo: HTMLImageElement | null;
}

const headerH = (s: number) => Math.round(56 * s);
const footerH = (s: number) => Math.round(26 * s);
/** Banner scale for an output of W x H pixels. */
const scaleFor = (W: number, H: number) =>
  Math.min(4, Math.max(0.7, W / (W >= H ? 1100 : 600)));

const LOGO_RATIO = 1073 / 581;
let logoPromise: Promise<HTMLImageElement | null> | null = null;
/** Load the logo once (same-origin, so it never taints the canvas); null if it fails. */
function loadLogo(): Promise<HTMLImageElement | null> {
  logoPromise ??= new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = `${import.meta.env.BASE_URL}logo.svg`;
  });
  return logoPromise;
}

/** Composite header + globe + legend + credits onto ctx (size W x H, scale s). The globe is cover-cropped to its area. */
function compose(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  s: number,
  m: Meta,
  globe: HTMLCanvasElement,
  splitFraction: number | null,
) {
  const hh = headerH(s);
  const fh = footerH(s);
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(0, 0, W, H);
  // Globe: centre-cropped ("cover") to the area between header and footer, so it is never stretched.
  const aw = W;
  const ah = H - hh - fh;
  const k = Math.max(aw / globe.width, ah / globe.height);
  const sw = aw / k;
  const sh = ah / k;
  const sx = (globe.width - sw) / 2;
  const sy = (globe.height - sh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(globe, sx, sy, sw, sh, 0, hh, aw, ah);
  if (splitFraction !== null) {
    const fx = (splitFraction * globe.width - sx) / sw;
    if (fx >= 0 && fx <= 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(Math.round(aw * fx - s), hh, Math.max(2, Math.round(2 * s)), ah);
    }
  }
  // Header.
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(0, 0, W, hh);
  const pad = 14 * s;
  // Logo, top-right, sized to the bar; dropped when it would crowd the text.
  let textW = W - 2 * pad;
  if (m.logo) {
    const lh = hh - 16 * s;
    const lw = lh * LOGO_RATIO;
    if (W - 3 * pad - lw >= 150 * s) {
      ctx.drawImage(m.logo, W - pad - lw, (hh - lh) / 2, lw, lh);
      textW = W - 3 * pad - lw;
    }
  }
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `700 ${Math.round(17 * s)}px ${FONT}`;
  ctx.fillText(fitText(ctx, m.title, textW), pad, Math.round(24 * s));
  ctx.fillStyle = ACCENT;
  ctx.font = `600 ${Math.round(15 * s)}px ${FONT}`;
  ctx.fillText(fitText(ctx, m.label, textW), pad, Math.round(46 * s));
  // Legend, bottom-left over the globe area.
  if (m.legend && m.legend.width > 0) {
    const lk = s / m.legendPr; // legend rasterized at pixelRatio legendPr -> /legendPr gives CSS size, times s
    let lw = m.legend.width * lk;
    let lh = m.legend.height * lk;
    const maxW = aw - 2 * pad - 16 * s;
    if (lw > maxW) {
      lh *= maxW / lw;
      lw = maxW;
    }
    const p = 8 * s;
    const bx = pad;
    const by = H - fh - lh - 2 * p - 10 * s;
    ctx.fillStyle = 'rgba(12,18,30,0.82)';
    roundRect(ctx, bx, by, lw + 2 * p, lh + 2 * p, 8 * s);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.drawImage(m.legend, bx + p, by + p, lw, lh);
  }
  // Footer credits.
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(0, H - fh, W, fh);
  ctx.fillStyle = MUTED;
  let fs = Math.round(11 * s);
  ctx.font = `${fs}px ${FONT}`;
  while (fs > 8 * s && ctx.measureText(m.credits).width > W - 2 * pad) {
    fs -= 1;
    ctx.font = `${fs}px ${FONT}`;
  }
  ctx.fillText(fitText(ctx, m.credits, W - 2 * pad), pad, H - Math.round(9 * s));
}

type Mode = 'image' | 'video';
const FORMATS: { id: string; ratio: number | null }[] = [
  { id: 'cur', ratio: null },
  { id: '16:9', ratio: 16 / 9 },
  { id: '4:3', ratio: 4 / 3 },
  { id: '1:1', ratio: 1 },
  { id: '9:16', ratio: 9 / 16 },
];
const PRESETS = [720, 1080, 1440, 2160];
/** Legend raster density: enough to stay sharp at banner scale s. */
const legendPrFor = (s: number) => Math.min(4, Math.max(2, Math.ceil(s)));
const MAX_GLOBE_PIXELS = 50e6; // memory guard for the temporary high-density drawing buffer
const videoBps = (W: number, H: number) => Math.min(40e6, Math.max(2e6, W * H * 4));
const even = (n: number) => Math.max(2, Math.round(n) - (Math.round(n) % 2));

/** Output size for a format ratio (total frame W/H, null = current view) and resolution ('cur' or short side in px). */
function outputSize(gw: number, gh: number, ratio: number | null, res: 'cur' | number) {
  if (res === 'cur') {
    if (ratio === null) {
      const s = scaleFor(gw, gh + 80);
      return { W: even(gw), H: even(gh + headerH(s) + footerH(s)) };
    }
    // Largest frame of this ratio whose globe area fits natively inside the canvas.
    let W = gw;
    for (let i = 0; i < 6; i++) {
      const H0 = W / ratio;
      const s = scaleFor(W, H0);
      const area = H0 - headerH(s) - footerH(s);
      if (area <= gh + 0.5 && W <= gw) break;
      W = Math.min(gw, W * Math.min(1, gh / area));
    }
    const H0 = W / ratio;
    return { W: even(W), H: even(H0) };
  }
  const r = ratio ?? gw / (gh + 80);
  return r >= 1 ? { W: even(res * r), H: even(res) } : { W: even(res), H: even(res / r) };
}

export function createExporter(o: ExporterOptions) {
  const { viewer } = o;
  const scene = viewer.scene;

  // ---------- capture helpers ----------

  /** Wait for globe tiles: `warm` rendered frames first (so the tile queue reflects the current size), then tilesLoaded stable for 2 polls; always bounded by `timeout`. */
  async function settle(timeout = 12000, warm = 1) {
    const t0 = performance.now();
    for (let i = 0; i < warm; i++) {
      scene.requestRender();
      await nextFrame();
    }
    let stable = 0;
    while (stable < 2 && performance.now() - t0 < timeout) {
      scene.requestRender();
      await sleep(60);
      stable = scene.globe.tilesLoaded ? stable + 1 : 0;
    }
    scene.requestRender();
    await nextFrame();
    await nextFrame();
  }

  /** Largest drawing-buffer side the GPU accepts (min of renderbuffer, texture and viewport limits). */
  function bufferLimits() {
    const gl = ((scene as unknown as { context?: { _gl?: WebGLRenderingContext } }).context?._gl ??
      scene.canvas.getContext('webgl2') ??
      scene.canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { maxDim: 4096, rb: 0, tex: 0, vp: [0, 0] };
    const rb = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 4096;
    const tex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    const vpv = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    const vp = vpv ? [vpv[0], vpv[1]] : [rb, rb];
    return { maxDim: Math.min(rb, tex, vp[0], vp[1]), rb, tex, vp };
  }

  /**
   * Run fn with the globe drawn at a density that covers an aw x ah pixel area natively (no upscaling),
   * by temporarily raising viewer.resolutionScale (capped to GPU limits). The previous scale is always restored.
   * The CSS layout is untouched: only the drawing buffer grows.
   */
  async function withGlobeDensity<T>(aw: number, ah: number, fn: (note: string) => Promise<T>): Promise<T> {
    const prev = viewer.resolutionScale;
    const cw = scene.canvas.width;
    const ch = scene.canvas.height;
    const need = Math.max(aw / cw, ah / ch);
    let note = '';
    let scale = prev;
    if (need > 1.02) {
      const target = prev * need;
      const { maxDim } = bufferLimits();
      const cap = Math.min(maxDim / cw, maxDim / ch, Math.sqrt(MAX_GLOBE_PIXELS / (cw * ch))) * prev;
      scale = Math.max(prev, Math.min(target, cap));
      if (scale < target * 0.98) note = TEXT.capNote(Math.round(cw * (scale / prev)), Math.round(ch * (scale / prev)));
    }
    const changed = Math.abs(scale - prev) > 1e-3;
    try {
      if (changed) {
        viewer.resolutionScale = scale;
        viewer.resize();
      }
      return await fn(note);
    } finally {
      if (changed) {
        viewer.resolutionScale = prev;
        viewer.resize();
      }
      scene.requestRender();
    }
  }

  /** Render now and return the live canvas; it must be consumed synchronously (no preserveDrawingBuffer). */
  function renderNow(): HTMLCanvasElement {
    scene.render(viewer.clock.currentTime);
    const c = scene.canvas;
    if (!c.width || !c.height) throw new Error(TEXT.errCanvas);
    return c;
  }

  function splitFraction(): number | null {
    const L = viewer.imageryLayers;
    for (let i = 0; i < L.length; i++) {
      const l = L.get(i);
      if (l.show && l.splitDirection !== Cesium.SplitDirection.NONE) return scene.splitPosition;
    }
    return null;
  }

  function creditsText(): string {
    const items: string[] = [];
    const root = viewer.cesiumWidget.creditContainer as HTMLElement | undefined;
    // The visible credit line (imagery and labels providers), as shown at the bottom of the globe.
    for (const t of (root?.innerText ?? '').split(/\n|•/).map((x) => x.replace(/\s+/g, ' ').trim()))
      if (t && !items.includes(t) && !/^data attribution$/i.test(t)) items.push(t);
    const imagery = items.length ? items.join(' | ') : TEXT.imageryFallback;
    return `${TEXT.dataCredit}. ${imagery}`;
  }

  let legendCache: { html: string; pr: number; canvas: HTMLCanvasElement | null } = { html: '', pr: 0, canvas: null };
  async function legendCanvas(pr: number): Promise<HTMLCanvasElement | null> {
    const el = o.legend();
    if (!el || !el.innerHTML.trim()) return null;
    if (legendCache.html === el.innerHTML && legendCache.pr === pr && legendCache.canvas) return legendCache.canvas;
    try {
      const c = await toCanvas(el, { pixelRatio: pr, skipFonts: true, backgroundColor: undefined });
      legendCache = { html: el.innerHTML, pr, canvas: c };
      return c;
    } catch {
      return null;
    }
  }

  // ---------- Map PNG ----------

  interface Result {
    blob: Blob;
    name: string;
    note?: string;
  }

  async function exportMapPng(opt?: { ratio: number | null; res: 'cur' | number }): Promise<Result> {
    const logo = await loadLogo();
    const label = o.formatKey(o.slider.key);
    // Size first: for 'cur' it depends on the on-screen canvas, which the high-density pass changes.
    const { W, H } = outputSize(scene.canvas.width, scene.canvas.height, opt?.ratio ?? null, opt?.res ?? 'cur');
    const s = scaleFor(W, H);
    const pr = legendPrFor(s);
    const legend = await legendCanvas(pr);
    const meta: Meta = { title: o.title(), label, legend, legendPr: pr, credits: creditsText(), logo };
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    try {
      const ctx = out.getContext('2d')!;
      const note = await withGlobeDensity(W, H - headerH(s) - footerH(s), async (n) => {
        await settle(15000, 3);
        // Render and copy in the same task: the drawing buffer is not preserved.
        const globe = renderNow();
        compose(ctx, W, H, s, meta, globe, splitFraction());
        return n;
      });
      const name = `fire-globe-${slug(meta.title)}-${slug(label)}.png`;
      return { blob: await canvasToBlob(out), name, note };
    } finally {
      out.width = out.height = 0; // release the pixel memory
    }
  }

  // ---------- Element PNG ----------

  async function exportElementPng(el: HTMLElement, filename: string): Promise<void> {
    const blob = await toBlob(el, {
      backgroundColor: PANEL_BG,
      pixelRatio: 2,
      width: Math.max(el.scrollWidth, el.clientWidth),
      height: Math.max(el.scrollHeight, el.clientHeight),
    });
    if (!blob) throw new Error(TEXT.errBlob);
    download(blob, /\.png$/i.test(filename) ? filename : `${filename}.png`);
  }

  // ---------- Video ----------

  const VIDEO_TYPES = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const videoSupported =
    typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  const pickMime = () => (videoSupported ? VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) : undefined);

  let busy = false;
  let cancelFlag = false;

  /** Probe which recorder MIME type can encode frames of this canvas size; null if none can. */
  async function probeMime(canvas: HTMLCanvasElement, bps: number): Promise<string | null> {
    for (const mt of VIDEO_TYPES) {
      if (!MediaRecorder.isTypeSupported(mt)) continue;
      let stream: MediaStream | null = null;
      try {
        stream = canvas.captureStream(0);
        const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
        const rec = new MediaRecorder(stream, { mimeType: mt, videoBitsPerSecond: bps });
        let err = false;
        let size = 0;
        rec.onerror = () => (err = true);
        rec.ondataavailable = (e) => (size += e.data.size);
        const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
        rec.start();
        track.requestFrame?.();
        await sleep(300);
        track.requestFrame?.();
        await sleep(200);
        if (rec.state !== 'inactive') rec.stop();
        await Promise.race([stopped, sleep(2000)]);
        if (!err && size > 0) return mt;
      } catch {
        /* try the next type */
      } finally {
        stream?.getTracks().forEach((x) => x.stop());
      }
    }
    return null;
  }

  async function recordVideo(opt: {
    start: number;
    end: number;
    fps: number;
    ratio: number | null;
    res: 'cur' | number;
    onProgress: (i: number, n: number, label: string) => void;
  }): Promise<Result | null> {
    let mime = pickMime();
    if (!mime) throw new Error(TEXT.noVideo);
    const all = o.keys();
    const keys = all.slice(opt.start, opt.end + 1);
    if (!keys.length) throw new Error(TEXT.rangeInvalid);
    const origKey = o.slider.key;
    o.slider.stop?.();
    const logo = await loadLogo();

    const { W, H } = outputSize(scene.canvas.width, scene.canvas.height, opt.ratio, opt.res);
    const s = scaleFor(W, H);
    const pr = legendPrFor(s);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d', { alpha: false })!;
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(0, 0, W, H);
    const bps = videoBps(W, H);
    const releaseCanvas = () => {
      out.width = out.height = 0;
    };

    // Large frames: make sure some encoder accepts this size before spending time on tiles.
    if (Math.min(W, H) >= 1440) {
      const m = await probeMime(out, bps);
      if (!m) {
        releaseCanvas();
        throw new Error(TEXT.errVideoSize(W, H));
      }
      mime = m;
    }

    const stream = out.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps });
    } catch {
      stream.getTracks().forEach((x) => x.stop());
      releaseCanvas();
      throw new Error(TEXT.errVideoSize(W, H));
    }
    const chunks: Blob[] = [];
    let recErr = false;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = () => (recErr = true);
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    const title = o.title();
    const credits = creditsText();
    const frameMs = 1000 / opt.fps;
    let note = '';

    const cleanup = () => {
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop());
    };

    const prepare = async (key: string) => {
      await o.slider.go(key);
      await settle(12000, 2);
    };

    let ok = false;
    try {
      await withGlobeDensity(W, H - headerH(s) - footerH(s), async (n) => {
        note = n;
        await prepare(keys[0]);
        rec.start();
        for (let i = 0; i < keys.length; i++) {
          if (cancelFlag) break;
          if (recErr || rec.state === 'inactive') throw new Error(TEXT.errVideoSize(W, H));
          const label = o.formatKey(keys[i]);
          opt.onProgress(i + 1, keys.length, label);
          const legend = await legendCanvas(pr);
          const globe = renderNow();
          compose(ctx, W, H, s, { title, label, legend, legendPr: pr, credits, logo }, globe, splitFraction());
          track.requestFrame?.();
          // Hold this frame for 1/fps while the next one loads in parallel.
          const next = i + 1 < keys.length && !cancelFlag ? prepare(keys[i + 1]) : Promise.resolve();
          await Promise.all([sleep(frameMs), next]);
        }
        // Re-push the last frame so it keeps its duration, then flush.
        track.requestFrame?.();
        await sleep(150);
        ok = !cancelFlag;
      });
    } finally {
      cleanup();
      await Promise.race([stopped, sleep(2000)]);
      releaseCanvas();
      try {
        await o.slider.go(origKey);
      } catch {
        /* ignore */
      }
      scene.requestRender();
    }
    if (!ok) return null;
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (recErr || !blob.size) throw new Error(TEXT.errVideoSize(W, H));
    const name = `fire-globe-${slug(title)}-${slug(o.formatKey(keys[0]))}_${slug(o.formatKey(keys[keys.length - 1]))}.${ext}`;
    return { blob, name, note };
  }

  // ---------- Sharing (Web Share API level 2) ----------

  /** True when the browser can share a file of this MIME type (probed with a tiny dummy file). */
  function canShareType(mime: string): boolean {
    try {
      if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
      const ext = mime.split('/')[1] || 'bin';
      return navigator.canShare({ files: [new File([new Uint8Array(1)], `x.${ext}`, { type: mime })] });
    } catch {
      return false;
    }
  }

  // ---------- UI ----------

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gk-export-btn';
  button.textContent = TEXT.button;
  button.title = TEXT.buttonTitle;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');

  const pop = document.createElement('div');
  pop.className = 'gk-export-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', TEXT.popLabel);
  const uid = `gkx${Math.random().toString(36).slice(2, 7)}`;
  const field = (id: string, label: string) =>
    `<div class="gk-export-field"><label for="${uid}-${id}">${label}</label><select id="${uid}-${id}"></select></div>`;
  pop.innerHTML = `
    <div class="gk-export-seg" role="radiogroup" aria-label="${TEXT.modeLabel}">
      <button type="button" role="radio" aria-checked="true" tabindex="0" data-mode="image">${TEXT.modeImage}</button>
      <button type="button" role="radio" aria-checked="false" tabindex="-1" data-mode="video">${TEXT.modeVideo}</button>
    </div>
    <div class="gk-export-grid">
      ${field('fmt', TEXT.format)}
      ${field('r', TEXT.resolution)}
      <div class="gk-export-vid" hidden>
        ${field('s', TEXT.from)}
        ${field('e', TEXT.to)}
        ${field('f', TEXT.fps)}
      </div>
    </div>
    <div class="gk-export-info" data-r="info" hidden></div>
    <div class="gk-export-actions">
      <button type="button" class="gk-export-act primary" data-a="dl"></button>
      <button type="button" class="gk-export-act" data-a="share" hidden>${TEXT.share}</button>
    </div>
    <div class="gk-export-progress" data-r="prog"><progress max="100" value="0" aria-label="${TEXT.progressAria}"></progress></div>
    <button type="button" class="gk-export-act gk-export-cancel" data-a="cancel">${TEXT.cancel}</button>
    <div class="gk-export-status" data-r="status" role="status" aria-live="polite"></div>`;
  document.body.appendChild(pop);

  const q = <T extends HTMLElement>(sel: string) => pop.querySelector<T>(sel)!;
  const selFmt = q<HTMLSelectElement>(`#${uid}-fmt`);
  const selStart = q<HTMLSelectElement>(`#${uid}-s`);
  const selEnd = q<HTMLSelectElement>(`#${uid}-e`);
  const selFps = q<HTMLSelectElement>(`#${uid}-f`);
  const selRes = q<HTMLSelectElement>(`#${uid}-r`);
  const vidBox = q<HTMLDivElement>('.gk-export-vid');
  const info = q<HTMLDivElement>('[data-r="info"]');
  const status = q<HTMLDivElement>('[data-r="status"]');
  const progWrap = q<HTMLDivElement>('[data-r="prog"]');
  const prog = progWrap.querySelector('progress')!;
  const btnDl = q<HTMLButtonElement>('[data-a="dl"]');
  const btnShare = q<HTMLButtonElement>('[data-a="share"]');
  const btnCancel = q<HTMLButtonElement>('[data-a="cancel"]');
  const segBtns = Array.from(pop.querySelectorAll<HTMLButtonElement>('.gk-export-seg [role="radio"]'));

  selFps.innerHTML = [2, 3, 4, 6, 8, 10, 12]
    .map((n) => `<option value="${n}"${n === 6 ? ' selected' : ''}>${n}</option>`)
    .join('');
  selFmt.innerHTML = FORMATS.map((f) => `<option value="${f.id}">${TEXT.fmt[f.id]}</option>`).join('');

  let mode: Mode = 'image';
  /** Result already rendered but not yet shared (share was refused for lack of a user gesture). */
  let cached: (Result & { mode: Mode }) | null = null;

  const ratioOf = () => FORMATS.find((f) => f.id === selFmt.value)?.ratio ?? null;
  const resOf = (): 'cur' | number => (selRes.value === 'cur' ? 'cur' : Number(selRes.value));
  const shareMime = () => (mode === 'image' ? 'image/png' : (pickMime()?.split(';')[0] ?? ''));
  const canShareNow = () => !!shareMime() && canShareType(shareMime());

  function setStatus(msg: string, err = false) {
    status.textContent = msg;
    status.classList.toggle('error', err);
  }

  function resetCache() {
    cached = null;
    btnShare.textContent = TEXT.share;
    btnShare.classList.remove('ready');
  }

  function fillRes() {
    const prev = selRes.value;
    const gw = scene.canvas.width;
    const gh = scene.canvas.height;
    const r = ratioOf();
    const cur = outputSize(gw, gh, r, 'cur');
    selRes.innerHTML =
      `<option value="cur">${TEXT.resCurrent(cur.W, cur.H)}</option>` +
      PRESETS.map((p) => {
        const z = outputSize(gw, gh, r, p);
        return `<option value="${p}">${TEXT.resPreset(p, z.W, z.H)}</option>`;
      }).join('');
    if (prev) selRes.value = prev;
    if (!selRes.value) selRes.value = 'cur';
  }

  function fillKeys() {
    const ks = o.keys();
    const opts = ks.map((k, i) => `<option value="${i}">${o.formatKey(k)}</option>`).join('');
    selStart.innerHTML = opts;
    selEnd.innerHTML = opts;
    selStart.value = String(Math.max(0, ks.length - 24));
    selEnd.value = String(Math.max(0, ks.length - 1));
    fillRes();
    updateInfo();
  }

  function updateInfo() {
    if (mode === 'image') {
      info.hidden = true;
      btnDl.disabled = busy;
      return;
    }
    info.hidden = false;
    const a = Number(selStart.value);
    const b = Number(selEnd.value);
    if (b < a) {
      info.textContent = TEXT.rangeInvalid;
      btnDl.disabled = true;
      return;
    }
    const n = b - a + 1;
    const big = typeof resOf() === 'number' && (resOf() as number) >= 1440;
    info.textContent = `${TEXT.frames(n, n / Number(selFps.value))} ${TEXT.keepVisible}${big ? ` ${TEXT.hint4k}` : ''}`;
    btnDl.disabled = busy || !pickMime();
  }

  function applyMode() {
    segBtns.forEach((b) => {
      const on = b.dataset.mode === mode;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    vidBox.hidden = mode !== 'video';
    btnDl.textContent = mode === 'image' ? TEXT.dlImage : TEXT.dlVideo;
    btnShare.hidden = !canShareNow();
    resetCache();
    if (mode === 'video' && !pickMime()) setStatus(TEXT.noVideo, true);
    else setStatus('');
    updateInfo();
    if (!pop.hidden) place();
  }

  function setMode(m: Mode, focus = false) {
    if (busy || m === mode) return;
    mode = m;
    applyMode();
    if (focus) segBtns.find((b) => b.dataset.mode === m)?.focus();
  }
  segBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));
  q<HTMLDivElement>('.gk-export-seg').addEventListener('keydown', (e) => {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k)) return;
    e.preventDefault();
    setMode(k === 'ArrowLeft' || k === 'ArrowUp' || k === 'Home' ? 'image' : 'video', true);
  });

  selFmt.addEventListener('change', () => {
    fillRes();
    resetCache();
  });
  [selStart, selEnd, selFps, selRes].forEach((el) =>
    el.addEventListener('change', () => {
      resetCache();
      updateInfo();
    }),
  );

  function setBusy(v: boolean) {
    busy = v;
    pop.querySelectorAll<HTMLSelectElement>('select').forEach((s) => (s.disabled = v));
    segBtns.forEach((b) => (b.disabled = v));
    btnDl.disabled = v;
    btnShare.disabled = v;
    progWrap.classList.toggle('on', v);
    btnCancel.classList.toggle('on', v);
    if (!v) {
      button.textContent = TEXT.button;
      updateInfo();
    }
  }

  function place() {
    const r = button.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    pop.style.width = `${w}px`;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    pop.style.left = `${left}px`;
    const below = window.innerHeight - r.bottom;
    if (below >= r.top) {
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.bottom = '';
      pop.style.maxHeight = `${Math.max(120, below - 14)}px`;
    } else {
      pop.style.bottom = `${window.innerHeight - r.top + 6}px`;
      pop.style.top = '';
      pop.style.maxHeight = `${Math.max(120, r.top - 14)}px`;
    }
  }

  function open() {
    if (!busy) {
      fillKeys();
      applyMode();
    }
    pop.hidden = false;
    place();
    button.setAttribute('aria-expanded', 'true');
    btnDl.focus();
  }
  function close() {
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden || busy) return;
    const t = e.target as Node;
    if (!pop.contains(t) && !button.contains(t)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      e.stopPropagation();
      if (busy) cancelFlag = true;
      else {
        close();
        button.focus();
      }
    }
  });
  window.addEventListener('resize', () => !pop.hidden && place());

  btnCancel.addEventListener('click', () => {
    cancelFlag = true;
    btnCancel.disabled = true;
  });

  /** Render the current selection; null if cancelled. */
  async function produce(): Promise<Result | null> {
    if (mode === 'image') return exportMapPng({ ratio: ratioOf(), res: resOf() });
    return recordVideo({
      start: Number(selStart.value),
      end: Number(selEnd.value),
      fps: Number(selFps.value),
      ratio: ratioOf(),
      res: resOf(),
      onProgress: (i, n, label) => {
        prog.value = (i / n) * 100;
        button.textContent = `${TEXT.button} ${Math.round((i / n) * 100)}%`;
        setStatus(TEXT.progress(i, n, label));
      },
    });
  }

  /** Try to share; true when finished (or the user closed the sheet), false when a fresh user gesture is needed. */
  async function tryShare(r: Result): Promise<boolean> {
    const file = new File([r.blob], r.name, { type: r.blob.type });
    try {
      await navigator.share({ files: [file], title: o.title() });
      setStatus(TEXT.shared);
      return true;
    } catch (e) {
      const n = (e as { name?: string } | null)?.name;
      if (n === 'AbortError') {
        setStatus('');
        return true;
      }
      if (n === 'NotAllowedError') return false;
      throw e;
    }
  }

  async function run(action: 'download' | 'share') {
    if (busy) return;
    cancelFlag = false;
    btnCancel.disabled = false;
    setBusy(true);
    setStatus(mode === 'video' ? TEXT.keepVisible : TEXT.working);
    prog.value = 0;
    try {
      const r = await produce();
      if (!r) {
        setStatus(TEXT.cancelled);
      } else if (action === 'download') {
        download(r.blob, r.name);
        setStatus(TEXT.saved(r.name) + (r.note ? ` ${r.note}` : ''));
      } else if (await tryShare(r)) {
        resetCache();
      } else {
        cached = { ...r, mode };
        btnShare.textContent = TEXT.shareReady;
        btnShare.classList.add('ready');
        setStatus('');
      }
    } catch (e) {
      setStatus(TEXT.failed(e instanceof Error ? e.message : String(e)), true);
    } finally {
      setBusy(false);
      cancelFlag = false;
    }
  }

  btnDl.addEventListener('click', () => void run('download'));
  btnShare.addEventListener('click', async () => {
    if (busy) return;
    if (cached && cached.mode === mode) {
      // Fresh gesture: share the blob rendered earlier.
      try {
        if (await tryShare(cached)) resetCache();
        else setStatus(TEXT.failed('NotAllowedError'), true);
      } catch (e) {
        setStatus(TEXT.failed(e instanceof Error ? e.message : String(e)), true);
      }
      return;
    }
    void run('share');
  });

  return { button, exportMapPng: () => exportMapPng().then((r) => download(r.blob, r.name)), exportElementPng };
}
