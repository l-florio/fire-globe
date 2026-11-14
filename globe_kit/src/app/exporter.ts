import * as Cesium from 'cesium';
import { toCanvas, toBlob } from 'html-to-image';
import { fmtFixed, t, tn } from './i18n';
import './exporter.css';

const TEXT = {
  button: t('exp.button'),
  buttonTitle: t('exp.buttonTitle'),
  mapPng: t('exp.mapPng'),
  videoSection: t('exp.videoSection'),
  videoStart: t('exp.videoStart'),
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
  doneVideo: (name: string) => t('exp.saved', { name }),
  doneMap: (name: string) => t('exp.saved', { name }),
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
  credits: string;
}

const headerH = (s: number) => Math.round(56 * s);
const footerH = (s: number) => Math.round(26 * s);

/** Composite header + globe + legend + credits onto ctx (size W x H, scale s). */
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
  // Globe, contained in the area between header and footer.
  const aw = W;
  const ah = H - hh - fh;
  const k = Math.min(aw / globe.width, ah / globe.height);
  const dw = globe.width * k;
  const dh = globe.height * k;
  const dx = (aw - dw) / 2;
  const dy = hh + (ah - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(globe, dx, dy, dw, dh);
  if (splitFraction !== null) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(Math.round(dx + dw * splitFraction - s), dy, Math.max(2, Math.round(2 * s)), dh);
  }
  // Header.
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(0, 0, W, hh);
  const pad = 14 * s;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `700 ${Math.round(17 * s)}px ${FONT}`;
  ctx.fillText(fitText(ctx, m.title, W - 2 * pad), pad, Math.round(24 * s));
  ctx.fillStyle = ACCENT;
  ctx.font = `600 ${Math.round(15 * s)}px ${FONT}`;
  ctx.fillText(fitText(ctx, m.label, W - 2 * pad), pad, Math.round(46 * s));
  // Legend, bottom-left over the globe area.
  if (m.legend && m.legend.width > 0) {
    const lk = (0.5 * s) * 1; // legend rasterized at pixelRatio 2 -> x0.5 gives CSS size, times s
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

export function createExporter(o: ExporterOptions) {
  const { viewer } = o;
  const scene = viewer.scene;

  // ---------- capture helpers ----------

  async function settle(timeout = 12000) {
    const t0 = performance.now();
    scene.requestRender();
    await nextFrame();
    while (!scene.globe.tilesLoaded && performance.now() - t0 < timeout) {
      scene.requestRender();
      await sleep(60);
    }
    scene.requestRender();
    await nextFrame();
    await nextFrame();
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

  let legendCache: { html: string; canvas: HTMLCanvasElement | null } = { html: '', canvas: null };
  async function legendCanvas(): Promise<HTMLCanvasElement | null> {
    const el = o.legend();
    if (!el || !el.innerHTML.trim()) return null;
    if (legendCache.html === el.innerHTML && legendCache.canvas) return legendCache.canvas;
    try {
      const c = await toCanvas(el, { pixelRatio: 2, skipFonts: true, backgroundColor: undefined });
      legendCache = { html: el.innerHTML, canvas: c };
      return c;
    } catch {
      return null;
    }
  }

  // ---------- Map PNG ----------

  async function exportMapPng(): Promise<void> {
    await settle(4000);
    const legend = await legendCanvas();
    const label = o.formatKey(o.slider.key);
    const meta: Meta = { title: o.title(), label, legend, credits: creditsText() };
    const gw = scene.canvas.width;
    const s = Math.min(2, Math.max(0.8, gw / 1100));
    const W = gw;
    const H = scene.canvas.height + headerH(s) + footerH(s);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d')!;
    // Render and copy in the same task: the drawing buffer is not preserved.
    const globe = renderNow();
    compose(ctx, W, H, s, meta, globe, splitFraction());
    const name = `fire-globe-${slug(meta.title)}-${slug(label)}.png`;
    download(await canvasToBlob(out), name);
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
  const pickMime = () => VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t));

  let busy = false;
  let cancelFlag = false;

  async function recordVideo(opt: {
    start: number;
    end: number;
    fps: number;
    width: number | null; // null = current canvas size
    height: number | null;
    onProgress: (i: number, n: number, label: string) => void;
  }) {
    const mime = pickMime();
    if (!mime) throw new Error(TEXT.noVideo);
    const all = o.keys();
    const keys = all.slice(opt.start, opt.end + 1);
    if (!keys.length) throw new Error(TEXT.rangeInvalid);
    const origKey = o.slider.key;
    o.slider.stop?.();

    const gw = scene.canvas.width;
    const gh = scene.canvas.height;
    let W: number;
    let H: number;
    let s: number;
    if (opt.width && opt.height) {
      W = opt.width;
      H = opt.height;
      s = W / 1280;
    } else {
      s = Math.min(2, Math.max(0.8, gw / 1100));
      W = gw;
      H = gh + headerH(s) + footerH(s);
    }
    W -= W % 2;
    H -= H % 2;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d', { alpha: false })!;
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(0, 0, W, H);

    const stream = out.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const bps = Math.min(12e6, Math.max(2e6, W * H * 4));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    const title = o.title();
    const credits = creditsText();
    const frameMs = 1000 / opt.fps;

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
      await settle();
    };

    let ok = false;
    try {
      await prepare(keys[0]);
      rec.start();
      for (let i = 0; i < keys.length; i++) {
        if (cancelFlag) break;
        const label = o.formatKey(keys[i]);
        opt.onProgress(i + 1, keys.length, label);
        const legend = await legendCanvas();
        const globe = renderNow();
        compose(ctx, W, H, s, { title, label, legend, credits }, globe, splitFraction());
        track.requestFrame?.();
        // Hold this frame for 1/fps while the next one loads in parallel.
        const next = i + 1 < keys.length && !cancelFlag ? prepare(keys[i + 1]) : Promise.resolve();
        await Promise.all([sleep(frameMs), next]);
      }
      // Re-push the last frame so it keeps its duration, then flush.
      track.requestFrame?.();
      await sleep(150);
      ok = !cancelFlag;
    } finally {
      cleanup();
      await Promise.race([stopped, sleep(2000)]);
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
    const name = `fire-globe-${slug(title)}-${slug(o.formatKey(keys[0]))}_${slug(o.formatKey(keys[keys.length - 1]))}.${ext}`;
    download(blob, name);
    return name;
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
  pop.innerHTML = `
    <button type="button" class="gk-export-act" data-a="map">${TEXT.mapPng}</button>
    <div class="gk-export-sec">${TEXT.videoSection}</div>
    <div class="gk-export-row"><label for="${uid}-s">${TEXT.from}</label><select id="${uid}-s"></select></div>
    <div class="gk-export-row"><label for="${uid}-e">${TEXT.to}</label><select id="${uid}-e"></select></div>
    <div class="gk-export-row"><label for="${uid}-f">${TEXT.fps}</label>
      <select id="${uid}-f">${[2, 3, 4, 6, 8, 10, 12].map((n) => `<option value="${n}"${n === 6 ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="gk-export-row"><label for="${uid}-r">${TEXT.resolution}</label><select id="${uid}-r"></select></div>
    <div class="gk-export-info" data-r="info"></div>
    <button type="button" class="gk-export-act primary" data-a="video">${TEXT.videoStart}</button>
    <div class="gk-export-progress" data-r="prog"><progress max="100" value="0" aria-label="${TEXT.progressAria}"></progress></div>
    <button type="button" class="gk-export-act gk-export-cancel" data-a="cancel">${TEXT.cancel}</button>
    <div class="gk-export-status" data-r="status" role="status" aria-live="polite"></div>`;
  document.body.appendChild(pop);

  const q = <T extends HTMLElement>(sel: string) => pop.querySelector<T>(sel)!;
  const selStart = q<HTMLSelectElement>(`#${uid}-s`);
  const selEnd = q<HTMLSelectElement>(`#${uid}-e`);
  const selFps = q<HTMLSelectElement>(`#${uid}-f`);
  const selRes = q<HTMLSelectElement>(`#${uid}-r`);
  const info = q<HTMLDivElement>('[data-r="info"]');
  const status = q<HTMLDivElement>('[data-r="status"]');
  const progWrap = q<HTMLDivElement>('[data-r="prog"]');
  const prog = progWrap.querySelector('progress')!;
  const btnMap = q<HTMLButtonElement>('[data-a="map"]');
  const btnVideo = q<HTMLButtonElement>('[data-a="video"]');
  const btnCancel = q<HTMLButtonElement>('[data-a="cancel"]');

  function setStatus(msg: string, err = false) {
    status.textContent = msg;
    status.classList.toggle('error', err);
  }

  function fillKeys() {
    const ks = o.keys();
    const opts = ks.map((k, i) => `<option value="${i}">${o.formatKey(k)}</option>`).join('');
    selStart.innerHTML = opts;
    selEnd.innerHTML = opts;
    selStart.value = String(Math.max(0, ks.length - 24));
    selEnd.value = String(Math.max(0, ks.length - 1));
    selRes.innerHTML =
      `<option value="cur">${TEXT.resCurrent(scene.canvas.width - (scene.canvas.width % 2), scene.canvas.height)}</option>` +
      '<option value="1280x720">1280 x 720</option><option value="1920x1080">1920 x 1080</option>';
    updateInfo();
  }

  function updateInfo() {
    const a = Number(selStart.value);
    const b = Number(selEnd.value);
    if (b < a) {
      info.textContent = TEXT.rangeInvalid;
      btnVideo.disabled = true;
      return;
    }
    const n = b - a + 1;
    info.textContent = `${TEXT.frames(n, n / Number(selFps.value))} ${TEXT.keepVisible}`;
    btnVideo.disabled = busy || !videoSupported;
  }
  [selStart, selEnd, selFps].forEach((el) => el.addEventListener('change', updateInfo));

  if (!videoSupported || !pickMime()) {
    btnVideo.disabled = true;
    setStatus(TEXT.noVideo, true);
  }

  function setBusy(v: boolean) {
    busy = v;
    pop.querySelectorAll<HTMLElement>('select').forEach((s) => ((s as HTMLSelectElement).disabled = v));
    btnMap.disabled = v;
    btnVideo.disabled = v || !videoSupported;
    progWrap.classList.toggle('on', v);
    btnCancel.classList.toggle('on', v);
    if (!v) button.textContent = TEXT.button;
  }

  function place() {
    const r = button.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 16);
    pop.style.width = `${w}px`;
    let left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
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
    if (!busy) fillKeys();
    pop.hidden = false;
    place();
    button.setAttribute('aria-expanded', 'true');
    btnMap.focus();
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

  btnMap.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    setStatus(TEXT.working);
    try {
      await exportMapPng();
      setStatus(TEXT.doneMap('PNG'));
    } catch (e) {
      setStatus(TEXT.failed(e instanceof Error ? e.message : String(e)), true);
    } finally {
      setBusy(false);
    }
  });

  btnVideo.addEventListener('click', async () => {
    if (busy) return;
    cancelFlag = false;
    btnCancel.disabled = false;
    setBusy(true);
    setStatus(TEXT.keepVisible);
    prog.value = 0;
    const res = selRes.value;
    const [rw, rh] = res === 'cur' ? [null, null] : res.split('x').map(Number);
    try {
      const name = await recordVideo({
        start: Number(selStart.value),
        end: Number(selEnd.value),
        fps: Number(selFps.value),
        width: rw,
        height: rh,
        onProgress: (i, n, label) => {
          prog.value = (i / n) * 100;
          button.textContent = `${TEXT.button} ${Math.round((i / n) * 100)}%`;
          setStatus(TEXT.progress(i, n, label));
        },
      });
      setStatus(name ? TEXT.doneVideo(name) : TEXT.cancelled);
    } catch (e) {
      setStatus(TEXT.failed(e instanceof Error ? e.message : String(e)), true);
    } finally {
      setBusy(false);
      cancelFlag = false;
      updateInfo();
    }
  });

  return { button, exportMapPng, exportElementPng };
}
