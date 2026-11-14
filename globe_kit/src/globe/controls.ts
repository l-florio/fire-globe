import * as Cesium from 'cesium';
import { cssGradient, type Stop } from './colormaps';

/** Draggable vertical divider driving scene.splitPosition (layers set splitDirection LEFT/RIGHT). */
export function createSplitter(viewer: Cesium.Viewer, parent: HTMLElement, onMove?: (fraction: number) => void) {
  const el = document.createElement('div');
  el.className = 'gk-splitter';
  el.innerHTML = '<div class="gk-splitter-handle" title="Drag to compare"></div>';
  parent.appendChild(el);
  const scene = viewer.scene;
  const place = (f: number) => {
    const p = Math.min(0.98, Math.max(0.02, f));
    scene.splitPosition = p;
    el.style.left = `${p * 100}%`;
    scene.requestRender();
    onMove?.(p);
  };
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = parent.getBoundingClientRect();
    place((e.clientX - r.left) / r.width);
  });
  el.addEventListener('pointerup', () => (dragging = false));
  place(0.5);
  return {
    setVisible(v: boolean) {
      el.style.display = v ? '' : 'none';
    },
    place,
    destroy: () => el.remove(),
  };
}

export interface TimeSliderOptions {
  keys: string[];
  initial?: string;
  format?: (key: string) => string;
  onChange: (key: string) => void | Promise<void>;
  /** Frames per second while playing. */
  fps?: number;
}

/** Play/pause + range slider over discrete time keys. Arrow keys step, space plays. */
export function createTimeSlider(parent: HTMLElement, o: TimeSliderOptions) {
  const el = document.createElement('div');
  el.className = 'gk-time';
  el.innerHTML = `
    <button class="gk-play" type="button" aria-label="Play">&#9654;</button>
    <input class="gk-range" type="range" min="0" step="1" aria-label="Time" />
    <span class="gk-picker" aria-label="Date"></span>
    <select class="gk-speed" aria-label="Speed">
      <option value="2">0.5x</option><option value="4" selected>1x</option><option value="8">2x</option><option value="16">4x</option>
    </select>`;
  parent.appendChild(el);
  const btn = el.querySelector<HTMLButtonElement>('.gk-play')!;
  const range = el.querySelector<HTMLInputElement>('.gk-range')!;
  const picker = el.querySelector<HTMLSpanElement>('.gk-picker')!;
  const speed = el.querySelector<HTMLSelectElement>('.gk-speed')!;
  if (o.fps) speed.value = String(o.fps);
  const fmt = o.format ?? ((k: string) => k);
  let keys = o.keys;
  let idx = Math.max(0, keys.indexOf(o.initial ?? keys[keys.length - 1]));
  let timer: number | undefined;
  let busy = false;

  async function go(i: number) {
    idx = Math.min(keys.length - 1, Math.max(0, i));
    range.value = String(idx);
    renderPicker();
    busy = true;
    try {
      await o.onChange(keys[idx]);
    } finally {
      busy = false;
    }
  }

  function tick() {
    if (busy) return; // never queue frames faster than they load
    if (idx >= keys.length - 1) return stop();
    void go(idx + 1);
  }

  function play() {
    if (idx >= keys.length - 1) void go(0);
    btn.innerHTML = '&#10073;&#10073;';
    btn.setAttribute('aria-label', 'Pause');
    timer = window.setInterval(tick, 1000 / Number(speed.value));
  }

  function stop() {
    window.clearInterval(timer);
    timer = undefined;
    btn.innerHTML = '&#9654;';
    btn.setAttribute('aria-label', 'Play');
  }

  /**
   * Year / month / day menus built from the keys (YYYY, YYYY-MM or YYYY-MM-DD).
   * Each menu lists only values that exist; picking one jumps to the first key with that prefix.
   */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function renderPicker() {
    const k = keys[idx] ?? '';
    const uniq = (xs: string[]) => [...new Set(xs)];
    const y = k.slice(0, 4);
    const m = k.slice(5, 7);
    const d = k.slice(8, 10);
    const opts = (vals: string[], cur: string, label: (v: string) => string) =>
      vals.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label(v)}</option>`).join('');
    let html = `<select data-p="y" aria-label="Year">${opts(uniq(keys.map((x) => x.slice(0, 4))), y, (v) => v)}</select>`;
    if (k.length >= 7) {
      const ms = uniq(keys.filter((x) => x.startsWith(y)).map((x) => x.slice(5, 7)));
      html += `<select data-p="m" aria-label="Month">${opts(ms, m, (v) => MON[Number(v) - 1])}</select>`;
    }
    if (k.length >= 10) {
      const ds = uniq(keys.filter((x) => x.startsWith(`${y}-${m}`)).map((x) => x.slice(8, 10)));
      html += `<select data-p="d" aria-label="Day">${opts(ds, d, (v) => String(Number(v)))}</select>`;
    }
    picker.innerHTML = html;
    picker.title = fmt(k);
  }
  picker.addEventListener('change', (e) => {
    const s = e.target as HTMLSelectElement;
    const val = (p: string) => picker.querySelector<HTMLSelectElement>(`[data-p="${p}"]`)?.value;
    // Keep the finer parts when they exist in the new period, else take the first available.
    const parts = [val('y'), val('m'), val('d')].filter(Boolean) as string[];
    const level = { y: 1, m: 2, d: 3 }[s.dataset.p as 'y' | 'm' | 'd'];
    for (let n = parts.length; n >= level; n--) {
      const prefix = parts.slice(0, n).join('-');
      const j = keys.findIndex((x) => x.startsWith(prefix));
      if (j >= 0) {
        stop();
        void go(j);
        return;
      }
    }
  });

  btn.onclick = () => (timer ? stop() : play());
  range.oninput = () => void go(Number(range.value));
  speed.onchange = () => {
    if (timer) {
      stop();
      play();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight') void go(idx + 1);
    else if (e.key === 'ArrowLeft') void go(idx - 1);
    else if (e.key === ' ') {
      e.preventDefault();
      timer ? stop() : play();
    }
  };
  window.addEventListener('keydown', onKey);
  range.max = String(keys.length - 1);
  void go(idx);

  return {
    get key() {
      return keys[idx];
    },
    setKeys(next: string[]) {
      const cur = keys[idx];
      keys = next;
      range.max = String(keys.length - 1);
      const j = keys.indexOf(cur);
      void go(j >= 0 ? j : keys.length - 1);
    },
    go: (key: string) => go(keys.indexOf(key)),
    play,
    stop,
    destroy() {
      stop();
      window.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}

/** Horizontal color bar with tick labels. */
export function createLegend(parent: HTMLElement) {
  const el = document.createElement('div');
  el.className = 'gk-legend';
  parent.appendChild(el);
  return {
    update(title: string, ramp: Stop[], ticks: { at: number; label: string }[]) {
      el.innerHTML = `<div class="gk-legend-title">${title}</div>
        <div class="gk-legend-bar" style="background:${cssGradient(ramp)}"></div>
        <div class="gk-legend-ticks">${ticks
          .map((t) => `<span style="left:${(t.at * 100).toFixed(1)}%">${t.label}</span>`)
          .join('')}</div>`;
    },
    destroy: () => el.remove(),
  };
}

/**
 * Zoom in / zoom out / home buttons. Each step halves (or doubles) the camera height,
 * so a step feels the same at every scale. Keys: + and - zoom, 0 or Home resets.
 */
export function createZoomControls(
  viewer: Cesium.Viewer,
  parent: HTMLElement,
  home: { lon: number; lat: number; height: number },
) {
  const el = document.createElement('div');
  el.className = 'gk-zoom';
  el.innerHTML = `
    <button type="button" data-z="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
    <button type="button" data-z="out" aria-label="Zoom out" title="Zoom out (-)">&minus;</button>
    <button type="button" data-z="home" aria-label="Reset view" title="Reset view (0)">&#8962;</button>`;
  parent.appendChild(el);
  const cam = viewer.camera;
  const height = () => viewer.scene.globe.ellipsoid.cartesianToCartographic(cam.positionWC)?.height ?? home.height;
  const ctrl = viewer.scene.screenSpaceCameraController;
  const step = (factor: number) => {
    const h = height();
    const target = Math.min(ctrl.maximumZoomDistance, Math.max(ctrl.minimumZoomDistance, h * factor));
    if (factor < 1) cam.zoomIn(h - target);
    else cam.zoomOut(target - h);
    viewer.scene.requestRender();
  };
  const goHome = () =>
    cam.flyTo({ destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, home.height), duration: 1.2 });
  el.addEventListener('click', (e) => {
    const z = (e.target as HTMLElement).closest('button')?.dataset.z;
    if (z === 'in') step(0.5);
    else if (z === 'out') step(2);
    else if (z === 'home') goHome();
  });
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
    if (e.key === '+' || e.key === '=') step(0.5);
    else if (e.key === '-' || e.key === '_') step(2);
    else if (e.key === '0' || e.key === 'Home') goHome();
  };
  window.addEventListener('keydown', onKey);
  return {
    zoomIn: () => step(0.5),
    zoomOut: () => step(2),
    home: goHome,
    destroy() {
      window.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}

/**
 * Scale bar: ground length of a bar at the centre of the screen, rounded to 1, 2 or 5 x 10^n.
 * Updates while the camera moves; hidden when the screen centre is not on the globe.
 */
export function createScaleBar(viewer: Cesium.Viewer, parent: HTMLElement, maxPx = 120) {
  const el = document.createElement('div');
  el.className = 'gk-scale';
  el.innerHTML = '<div class="gk-scale-label"></div><div class="gk-scale-bar"></div>';
  parent.appendChild(el);
  const label = el.querySelector<HTMLDivElement>('.gk-scale-label')!;
  const bar = el.querySelector<HTMLDivElement>('.gk-scale-bar')!;
  const geodesic = new Cesium.EllipsoidGeodesic();
  function update() {
    const scene = viewer.scene;
    const w = scene.canvas.clientWidth;
    const h = scene.canvas.clientHeight;
    const a = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(w / 2, h / 2), scene.globe.ellipsoid);
    const b = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(w / 2 + 10, h / 2), scene.globe.ellipsoid);
    if (!a || !b) {
      el.style.visibility = 'hidden';
      return;
    }
    geodesic.setEndPoints(Cesium.Cartographic.fromCartesian(a), Cesium.Cartographic.fromCartesian(b));
    const mPerPx = geodesic.surfaceDistance / 10;
    const maxM = mPerPx * maxPx;
    const pow = Math.pow(10, Math.floor(Math.log10(maxM)));
    const nice = [5, 2, 1].map((k) => k * pow).find((v) => v <= maxM) ?? pow;
    bar.style.width = `${Math.round(nice / mPerPx)}px`;
    label.textContent = nice >= 1000 ? `${(nice / 1000).toLocaleString('en')} km` : `${nice} m`;
    el.style.visibility = '';
  }
  viewer.camera.percentageChanged = Math.min(viewer.camera.percentageChanged, 0.05);
  const off1 = viewer.camera.changed.addEventListener(update);
  const off2 = viewer.camera.moveEnd.addEventListener(update);
  window.addEventListener('resize', update);
  update();
  return {
    update,
    destroy() {
      off1();
      off2();
      window.removeEventListener('resize', update);
      el.remove();
    },
  };
}
