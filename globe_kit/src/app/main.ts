import * as Cesium from 'cesium';
import {
  BASEMAPS,
  RAMPS,
  TimeRasterLayer,
  createGlobe,
  createLegend,
  createSplitter,
  createTimeSlider,
  createZoomControls,
  createScaleBar,
  type BasemapId,
} from '../globe';
import { createCalendarPanel } from './calendarPanel';
import { createDetectionsPanel } from './detectionsPanel';
import { createExporter } from './exporter';
import { copyLink, readShare, writeShare } from './share';
import { openClimatology, openTable, storeGlobeHash } from './nav';
import { detectSource, lazySource } from './dataSource';
import { createDetail, DETECTION_FRP_TOP, type Pass, type Sat, type Step } from './detail';
import { applyI18n, fmtFixed, locale, monthsShort, t, tOr } from './i18n';
import './app.css';

declare const CESIUM_BASE_URL: string;
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = CESIUM_BASE_URL;

interface Manifest {
  encoding: 'log1p-uint8';
  rectangle: [number, number, number, number];
  harmonized: boolean;
  metrics: Record<string, { label: string; unit: string; max: number }>;
  sensors: Record<string, { label: string; months: string[]; partial_last_month: boolean; metrics?: string[]; max?: number; harmonized?: boolean }>;
}

type Mode = 'MODIS' | 'VIIRS' | 'BOTH' | 'HARM';
const isHarm = (s: string) => s.startsWith('HARM_');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MONTHS = monthsShort;
const fmtMonth = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const fmtDay = (k: string) => `${Number(k.slice(8, 10))} ${fmtMonth(k)}`;
const TODAY = new Date().toISOString().slice(0, 10);
/** All dates of the given months (YYYY-MM), up to today. */
function daysOf(months: string[]): string[] {
  const out: string[] = [];
  for (const m of months) {
    const [y, mo] = m.split('-').map(Number);
    const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    for (let d = 1; d <= n; d++) {
      const k = `${m}-${String(d).padStart(2, '0')}`;
      if (k <= TODAY) out.push(k);
    }
  }
  return out;
}
const fmtNum = (x: number) =>
  x >= 1e6 ? `${fmtFixed(x / 1e6, 1)}M` : x >= 1e3 ? `${fmtFixed(x / 1e3, x >= 1e4 ? 0 : 1)}k` : x >= 10 ? fmtFixed(x, 0) : fmtFixed(x, 1);
const HOME = { lon: 12, lat: 30, height: 18_000_000 };

async function main() {
  applyI18n();
  const base = `${import.meta.env.BASE_URL}frames`;
  const manifest: Manifest = await (await fetch(`${base}/manifest.json`)).json();
  // Names from the data manifest are English: use the translated ones when the dictionary has them.
  for (const [k, m] of Object.entries(manifest.metrics)) {
    m.label = tOr(`metric.${k}`, m.label);
    m.unit = tOr(`metric.${k}.unit`, m.unit);
  }
  for (const [k, v] of Object.entries(manifest.sensors)) v.label = tOr(`sensor.${k}`, v.label);
  const metrics = Object.keys(manifest.metrics);
  const viirsSensors = Object.keys(manifest.sensors).filter((s) => s.startsWith('VIIRS'));
  const harmSensors = Object.keys(manifest.sensors).filter(isHarm);

  const globe = createGlobe({
    container: 'globe',
    basemap: 'gibs-bluemarble',
    overlays: ['gibs-coastlines', 'esri-labels'],
    view: HOME,
  });
  const { viewer } = globe;
  const zoomBox = document.createElement('div');
  zoomBox.id = 'zoom';
  document.body.appendChild(zoomBox);
  createZoomControls(viewer, zoomBox, HOME, {
    zoomIn: t('zoom.in'),
    zoomInTitle: t('zoom.in.title'),
    zoomOut: t('zoom.out'),
    zoomOutTitle: t('zoom.out.title'),
    home: t('zoom.home'),
    homeTitle: t('zoom.home.title'),
  });
  const scaleBox = document.createElement('div');
  scaleBox.id = 'scale';
  document.body.appendChild(scaleBox);
  createScaleBar(viewer, scaleBox, 120, locale);

  // ---- controls
  const metricSel = $<HTMLSelectElement>('metric');
  const modeSeg = $<HTMLDivElement>('mode');
  const viirsWrap = $<HTMLLabelElement>('viirs-wrap');
  const viirsSel = $<HTMLSelectElement>('viirs');
  const sides = $<HTMLDivElement>('sides');
  const swapBtn = $<HTMLButtonElement>('swap');
  const gain = $<HTMLInputElement>('gain');
  const basemapSel = $<HTMLSelectElement>('basemap');
  const borders = $<HTMLInputElement>('borders');
  metricSel.innerHTML = metrics.map((m) => `<option value="${m}">${manifest.metrics[m].label}</option>`).join('');
  viirsSel.innerHTML = viirsSensors.map((s) => `<option value="${s}">${manifest.sensors[s].label}</option>`).join('');
  const harmSel = $<HTMLSelectElement>('harm');
  const harmWrap = $<HTMLLabelElement>('harm-wrap');
  harmSel.innerHTML = harmSensors.map((s) => `<option value="${s}">${manifest.sensors[s].label}</option>`).join('');
  if (!harmSensors.length) modeSeg.querySelector<HTMLButtonElement>('[data-mode=HARM]')!.hidden = true;
  basemapSel.innerHTML = (Object.keys(BASEMAPS) as BasemapId[])
    .map((b) => `<option value="${b}">${tOr(`basemap.${b}`, BASEMAPS[b].label)}</option>`)
    .join('');

  let mode: Mode = 'BOTH';
  /** Globe sources filter -> FIRMS type list for single detections, and the nearest calendar equivalent. */
  const SRC_TYPES: Record<string, string> = { veg: '0,-1', all: '0,1,2,3,-1', volcano: '1', static: '2', offshore: '3' };
  const SRC_CAL: Record<string, string> = { veg: 'veg', all: 'all', volcano: 'static', static: 'static', offshore: 'static' };
  const srcSel = $<HTMLSelectElement>('sources');
  let step: Step = 'month';
  // Local service when it runs, else static Parquet files queried in the browser (DuckDB-WASM).
  // Resolved in the background: the globe and the controls do not wait for DuckDB-WASM.
  const dsReady = detectSource().catch((e) => {
    console.warn('No data source for detections', e);
    return undefined;
  });
  const ds = lazySource(dsReady);
  let apiOk = true;
  let swapped = false; // false: MODIS left, VIIRS right

  /** Sensors on screen: [left] in single mode, [left, right] in compare mode. */
  function shown(): string[] {
    const v = viirsSel.value;
    if (mode === 'HARM') return [harmSel.value];
    if (mode === 'MODIS') return ['MODIS'];
    if (mode === 'VIIRS') return [v];
    return swapped ? [v, 'MODIS'] : ['MODIS', v];
  }

  // ---- display scale: frames hold log1p(x)/log1p(max); the slider sets the value at the top of the ramp
  // Harmonized series have their own colour scale (1 degree cells) and detections only.
  const metricOf = (s: string) => (isHarm(s) ? 'n' : metricSel.value);
  const maxOf = (s: string) => (isHarm(s) ? manifest.sensors[s].max ?? 1 : manifest.metrics[metricSel.value].max);
  const displayMax = (s = shown()[0]) => Math.expm1(Number(gain.value) * Math.log1p(maxOf(s))) || 1;
  const transfer = (s = shown()[0]) => {
    const k = Math.log1p(maxOf(s)) / Math.log1p(displayMax(s));
    return (b: number) => (b / 255) * k;
  };

  const frameUrl = (sensor: string) => (key: string) => `${base}/${metricOf(sensor)}/${sensor}/${key}.png`;
  const mk = (sensor: string) =>
    new TimeRasterLayer(viewer, {
      frameUrl: frameUrl(sensor),
      keys: manifest.sensors[sensor].months,
      rectangle: manifest.rectangle,
      ramp: RAMPS.fire,
      transfer: transfer(sensor),
    });
  const [s0, s1] = shown();
  const left = mk(s0);
  const right = mk(s1 ?? s0);

  const labL = $<HTMLSpanElement>('lab-left');
  const labR = $<HTMLSpanElement>('lab-right');
  const splitter = createSplitter(
    viewer,
    document.body,
    (f) => {
      labL.style.right = `${(1 - f) * 100}%`;
      labL.style.marginRight = '12px';
      labR.style.left = `${f * 100}%`;
      labR.style.marginLeft = '12px';
    },
    { drag: t('split.drag') },
  );

  const legend = createLegend($('legend'));
  const note = $<HTMLParagraphElement>('note');

  function allKeys() {
    const months = [...new Set(shown().flatMap((s) => manifest.sensors[s].months))].sort();
    return step === 'month' ? months : daysOf(months);
  }

  function refreshLegend() {
    if (detail?.active || step === 'day') {
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
        at: t,
        label: `${t === 1 ? '≥ ' : ''}${fmtNum(Math.expm1(t * Math.log1p(DETECTION_FRP_TOP)))}`,
      }));
      legend.update(t('legend.detection'), RAMPS.fire, ticks);
      return;
    }
    const s0 = shown()[0];
    const top = displayMax(s0);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
      at: t,
      label: `${t === 1 ? '≥ ' : ''}${fmtNum(Math.expm1(t * Math.log1p(top)))}`,
    }));
    if (isHarm(s0)) {
      const unit = s0 === 'HARM_LONG' ? t('legend.harm.long') : t('legend.harm.detail');
      legend.update(t('legend.harm', { unit }), RAMPS.fire, ticks);
      return;
    }
    const m = manifest.metrics[metricSel.value];
    legend.update(t('legend.metric', { label: m.label, unit: m.unit }), RAMPS.fire, ticks);
  }

  function refreshLabels(key: string) {
    const fmt = step === 'day' ? fmtDay : fmtMonth;
    const day = key;
    key = key.slice(0, 7);
    const [a, b] = shown();
    const lab = (s: string) => `${manifest.sensors[s].label}${manifest.sensors[s].months.includes(key) ? '' : t('note.noData')}`;
    labL.textContent = lab(a);
    labR.textContent = b ? lab(b) : '';
    labR.style.display = b ? '' : 'none';
    // In single mode the left label sits at the screen centre.
    labL.style.display = '';
    const missing = shown().filter((s) => !manifest.sensors[s].months.includes(key));
    const partial = shown().filter((s) => {
      const ms = manifest.sensors[s].months;
      return manifest.sensors[s].partial_last_month && ms[ms.length - 1] === key;
    });
    note.textContent = [
      partial.length && step === 'month' ? t('note.partial', { month: fmtMonth(key) }) : '',
      missing.length ? t('note.missing', { sensors: missing.map((s) => manifest.sensors[s].label).join(', '), date: fmt(day) }) : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  // ---- shareable link: the state is written to the URL hash (see share.ts) once the start-up state is applied
  let urlReady = false;
  let urlTimer: number | undefined;
  function syncUrl() {
    if (!urlReady) return;
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      const c = viewer.camera.positionCartographic;
      const cal = calPanel?.state;
      writeShare({
        t: slider.key,
        mode,
        harm: mode === 'HARM' ? harmSel.value : undefined,
        viirs: mode === 'VIIRS' || mode === 'BOTH' ? viirsSel.value : undefined,
        metric: mode === 'HARM' ? undefined : metricSel.value,
        step: step === 'day' ? 'day' : undefined,
        cam: [Cesium.Math.toDegrees(c.longitude).toFixed(3), Cesium.Math.toDegrees(c.latitude).toFixed(3), Math.round(c.height)].join(','),
        cal: cal?.open ? '1' : undefined,
        area: cal?.area,
        cs: cal?.open || cal?.area ? cal.sensor : undefined,
        cv: cal?.variable === 'frp' ? 'frp' : undefined,
        cm: cal?.colour === 'anomaly' ? 'anomaly' : undefined,
        cf: cal?.from,
        ct: cal?.to,
        src: cal && cal.src !== 'veg' ? cal.src : undefined,
        gsrc: srcSel.value !== 'veg' ? srcSel.value : undefined,
      });
    }, 300);
  }

  /** Apply mode, VIIRS satellite and side order to layers, UI and time axis. */
  function applySelection() {
    syncUrl();
    const [a, b] = shown();
    for (const btn of modeSeg.querySelectorAll<HTMLButtonElement>('button'))
      btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    viirsWrap.style.display = mode !== 'MODIS' && mode !== 'HARM' && viirsSensors.length > 1 ? '' : 'none';
    harmWrap.hidden = mode !== 'HARM';
    $('data-badge').textContent = t(mode === 'HARM' ? 'badge.harm' : 'badge.raw');
    $('sub-text').textContent = t(mode === 'HARM' ? 'sub.harm' : 'sub.raw');
    metricSel.disabled = mode === 'HARM';
    srcSel.disabled = mode === 'HARM'; // harmonized series are built on vegetation fires only
    srcSel.title = t(mode === 'HARM' ? 'ctl.sources.harm' : 'ctl.sources.title');
    if (mode === 'HARM' && step === 'day') {
      step = 'month';
      slider.setKeys(allKeys());
    }
    sides.style.display = b ? '' : 'none';
    $('side-l').textContent = a.startsWith('VIIRS') ? 'VIIRS' : 'MODIS';
    $('side-r').textContent = b ? (b.startsWith('VIIRS') ? 'VIIRS' : 'MODIS') : '';
    splitter.setVisible(!!b);
    left.setSplit(b ? Cesium.SplitDirection.LEFT : Cesium.SplitDirection.NONE);
    right.setSplit(Cesium.SplitDirection.RIGHT);
    left.setSource(frameUrl(a), manifest.sensors[a].months);
    left.restyle({ transfer: transfer(a) });
    if (b) {
      right.setSource(frameUrl(b), manifest.sensors[b].months);
      right.restyle({ transfer: transfer(b) });
    } else right.destroy();
    refreshLegend();
    if (!b) {
      labL.style.right = '50%';
      labL.style.marginRight = '0';
      labL.style.transform = 'translateX(50%)';
    } else {
      labL.style.transform = '';
      splitter.place(viewer.scene.splitPosition);
    }
    slider.setKeys(allKeys());
    refreshControls();
    refreshZoomNote();
    // Single detections exist for the sensors, not for the harmonized series.
    detail?.setSides(
      shown().filter((s) => !isHarm(s)).map((s, k) => ({
        sensor: s,
        raster: k === 0 ? left : right,
        split: !b ? Cesium.SplitDirection.NONE : k === 0 ? Cesium.SplitDirection.LEFT : Cesium.SplitDirection.RIGHT,
      })),
    );
  }

  // eslint-disable-next-line prefer-const
  let calPanel: ReturnType<typeof createCalendarPanel> | undefined;
  // eslint-disable-next-line prefer-const
  let detail: ReturnType<typeof createDetail> | undefined;
  const daySel = $<HTMLSelectElement>('day');
  const dayWrap = $<HTMLLabelElement>('day-wrap');
  const detailNote = $<HTMLParagraphElement>('detail-note');
  const stepSeg = $<HTMLDivElement>('step');
  const passSeg = $<HTMLDivElement>('pass');
  const satSel = $<HTMLSelectElement>('sat');
  const filters = $<HTMLDivElement>('filters');
  const gainWrap = $<HTMLLabelElement>('gain-wrap');
  let pass: Pass = 'all';
  /** Hint shown while no single detections are loaded; warns when the raster cannot follow the Sources filter. */
  function refreshZoomNote() {
    const rasterLimited = mode !== 'HARM' && srcSel.value !== 'veg';
    detailNote.classList.toggle('warn', rasterLimited);
    detailNote.textContent = t(mode === 'HARM' ? 'note.harmDetections' : rasterLimited ? 'note.srcRaster' : 'note.zoom');
  }
  const refreshControls = () => {
    for (const btn of stepSeg.querySelectorAll<HTMLButtonElement>('button')) {
      btn.setAttribute('aria-checked', String(btn.dataset.step === step));
      if (btn.dataset.step === 'day') {
        btn.disabled = !apiOk || mode === 'HARM';
        btn.title = t(mode === 'HARM' ? 'ctl.stepDay.harm' : apiOk ? 'ctl.stepDay.ok' : 'ctl.stepDay.noData');
      }
    }
    for (const btn of passSeg.querySelectorAll<HTMLButtonElement>('button'))
      btn.setAttribute('aria-checked', String(btn.dataset.pass === pass));
    filters.hidden = !(detail?.active || step === 'day');
    $('sat-wrap').style.display = shown().includes('MODIS') ? '' : 'none';
    dayWrap.hidden = !(detail?.active && step === 'month');
    gainWrap.style.display = step === 'month' ? '' : 'none';
  };
  const fillDays = (key: string) => {
    const [y, m] = key.split('-').map(Number);
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const keep = Math.min(Number(daySel.value) || 0, n);
    daySel.innerHTML =
      `<option value="0">${t('ctl.allDays')}</option>` +
      Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${t('ctl.dayOfMonth', { m: MONTHS[m - 1], d: i + 1 })}</option>`).join('');
    daySel.value = String(keep);
    detail?.setFilters({ day: keep });
  };

  const slider = createTimeSlider($('time'), {
    keys: allKeys(),
    format: (k) => (k.length > 7 ? fmtDay(k) : fmtMonth(k)),
    months: MONTHS,
    labels: {
      play: t('slider.play'),
      pause: t('slider.pause'),
      time: t('slider.time'),
      date: t('slider.date'),
      speed: t('slider.speed'),
      year: t('slider.year'),
      month: t('slider.month'),
      day: t('slider.day'),
    },
    onChange: async (key) => {
      syncUrl();
      refreshLabels(key);
      calPanel?.select(key);
      detail?.setPeriod(step, key);
      if (step === 'day') return;
      fillDays(key);
      const jobs = [left.show(key)];
      if (shown().length > 1) jobs.push(right.show(key));
      await Promise.all(jobs);
      globe.raiseOverlays();
    },
  });

  // ---- wiring
  // Collapsible control panel: starts collapsed on phones so the globe stays visible.
  const panelEl = $<HTMLElement>('panel');
  const panelToggle = $<HTMLButtonElement>('panel-toggle');
  const setPanel = (open: boolean) => {
    panelEl.classList.toggle('collapsed', !open);
    panelToggle.textContent = t(open ? 'panel.hide' : 'panel.controls');
    panelToggle.setAttribute('aria-expanded', String(open));
  };
  setPanel(!window.matchMedia('(max-width: 760px)').matches);
  panelToggle.onclick = () => setPanel(panelEl.classList.contains('collapsed'));
  stepSeg.onclick = (e) => {
    const s = (e.target as HTMLElement).closest('button')?.dataset.step as Step | undefined;
    if (!s || s === step) return;
    const cur = slider.key;
    step = s;
    // Month -> its first day with data; day -> its month.
    const keys = allKeys();
    const target = step === 'day' ? keys.find((k) => k.startsWith(cur)) ?? keys[keys.length - 1] : cur.slice(0, 7);
    detail?.setPeriod(step, target);
    slider.setKeys(keys);
    void slider.go(target);
    refreshControls();
    refreshLegend();
    syncUrl();
  };
  passSeg.onclick = (e) => {
    const p = (e.target as HTMLElement).closest('button')?.dataset.pass as Pass | undefined;
    if (!p) return;
    pass = p;
    detail?.setFilters({ pass });
    refreshControls();
  };
  srcSel.onchange = () => {
    detail?.setTypes(SRC_TYPES[srcSel.value] ?? SRC_TYPES.veg);
    calPanel?.setSources(SRC_CAL[srcSel.value] ?? 'veg');
    if (!detail?.active) refreshZoomNote();
    syncUrl();
  };
  satSel.onchange = () => detail?.setFilters({ sat: satSel.value as Sat });
  modeSeg.onclick = (e) => {
    const m = (e.target as HTMLElement).closest('button')?.dataset.mode as Mode | undefined;
    if (!m || m === mode) return;
    mode = m;
    applySelection();
  };
  viirsSel.onchange = applySelection;
  harmSel.onchange = applySelection;
  swapBtn.onclick = () => {
    swapped = !swapped;
    applySelection();
  };
  metricSel.onchange = () => applySelection();
  gain.oninput = () => refreshLegend();
  gain.onchange = () => {
    const [a, b] = shown();
    left.restyle({ transfer: transfer(a) });
    if (b) right.restyle({ transfer: transfer(b) });
  };
  basemapSel.onchange = () => globe.setBasemap(basemapSel.value as BasemapId);
  borders.onchange = () => {
    globe.setOverlay('gibs-coastlines', borders.checked);
    globe.setOverlay('esri-labels', borders.checked);
  };

  detail = createDetail(
    viewer,
    Object.fromEntries(Object.entries(manifest.sensors).map(([k, v]) => [k, v.label])),
    ds,
    {
      onMode(on) {
        refreshControls();
        refreshLegend();
        if (!on) refreshZoomNote();
      },
      onStatus(text, busy) {
        if (!text) return;
        detailNote.classList.remove('warn');
        detailNote.textContent = text;
        // Loaded detections: a button opens the list (strongest first, linked to the globe).
        if (detail?.active && !busy) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'det-open';
          b.textContent = t('ctl.list');
          b.title = t('ctl.list.title');
          b.onclick = () => {
            calPanel?.toggle(false);
            detPanel.toggle(true);
          };
          detailNote.append(' ', b);
        }
        detPanel.refresh();
      },
    },
  );
  const detPanel = createDetectionsPanel({
    viewer,
    list: (n) => detail?.list(n) ?? { rows: [], total: 0 },
    highlight: (r) => detail?.highlight(r),
  });
  daySel.onchange = () => detail?.setFilters({ day: Number(daySel.value) });

  // ---- area fire calendar
  calPanel = createCalendarPanel({
    viewer,
    data: ds!,
    sensors: manifest.sensors,
    onSelectMonth: (m) => {
      const target = step === 'month' ? m : allKeys().find((k) => k.startsWith(m));
      if (target) void slider.go(target);
    },
  });
  const calBtn = document.createElement('button');
  calBtn.id = 'cal-toggle';
  calBtn.type = 'button';
  calBtn.textContent = t('cal.button');
  calBtn.disabled = !apiOk;
  calBtn.title = apiOk ? t('cal.button.title', { note: ds!.note }) : t('ctl.stepDay.noData');
  calBtn.onclick = () => {
    if (calPanel?.toggle()) detPanel.toggle(false);
  };
  void dsReady.then((d) => {
    apiOk = !!d;
    calBtn.disabled = !apiOk;
    calBtn.title = apiOk ? t('cal.button.title', { note: d!.note }) : t('ctl.stepDay.noData');
    refreshControls();
  });
  // ---- top-right actions: export, area calendar
  const exporter = createExporter({
    viewer,
    slider,
    keys: allKeys,
    formatKey: (k) => (k.length > 7 ? fmtDay(k) : fmtMonth(k)),
    title: () => [labL.textContent, labR.style.display === 'none' ? '' : labR.textContent].filter(Boolean).join('  |  '),
    legend: () => $('legend').querySelector<HTMLElement>('.gk-legend'),
  });
  exporter.button.id = 'export-toggle';
  calPanel.onExportPng = (el) => exporter.exportElementPng(el, 'fire_calendar.png');
  const actions = document.createElement('div');
  actions.id = 'top-actions';
  const shareBtn = document.createElement('button');
  shareBtn.id = 'share-btn';
  shareBtn.type = 'button';
  shareBtn.textContent = t('share.btn');
  shareBtn.title = t('share.title');
  shareBtn.onclick = async () => {
    window.clearTimeout(urlTimer);
    urlReady = true;
    syncUrl();
    await new Promise((r) => setTimeout(r, 350));
    const ok = await copyLink();
    shareBtn.textContent = ok ? t('share.copied') : t('share.manual');
    setTimeout(() => (shareBtn.textContent = t('share.btn')), 2500);
  };
  actions.append(shareBtn, exporter.button, calBtn);
  calPanel.onChange = syncUrl;
  viewer.camera.moveEnd.addEventListener(syncUrl);
  document.body.appendChild(actions);
  calPanel.select(slider.key);

  // ---- Globe | Table | Climatology: separate pages (table.html, climatology.html); the globe state is kept for the way back
  const tabs = document.createElement('div');
  tabs.id = 'view-tabs';
  tabs.className = 'seg seg3';
  tabs.setAttribute('role', 'tablist');
  tabs.innerHTML = `<button type="button" role="tab" aria-selected="true">${t('view.globe')}</button><button type="button" role="tab" aria-selected="false" title="${t('view.table.title')}">${t('view.table')}</button><button type="button" role="tab" aria-selected="false" title="${t('view.climatology.title')}">${t('view.climatology')}</button>`;
  tabs.children[1].addEventListener('click', () => {
    storeGlobeHash(location.hash);
    openTable(slider.key);
  });
  tabs.children[2].addEventListener('click', () => {
    storeGlobeHash(location.hash);
    openClimatology(/^\d{4}-\d{2}(-\d{2})?$/.test(slider.key) ? `t=${slider.key}` : '');
  });
  document.body.appendChild(tabs);
  detail.setPeriod(step, slider.key);
  refreshControls();

  applySelection();
  refreshLegend();

  // ---- start-up state from a shareable link
  const st = readShare();
  const has = (sel: HTMLSelectElement, v?: string) => !!v && [...sel.options].some((o) => o.value === v);
  if (st.mode && ['MODIS', 'VIIRS', 'BOTH', 'HARM'].includes(st.mode)) mode = st.mode as Mode;
  if (has(harmSel, st.harm)) harmSel.value = st.harm!;
  if (has(viirsSel, st.viirs)) viirsSel.value = st.viirs!;
  if (has(metricSel, st.metric)) metricSel.value = st.metric!;
  if (st.step === 'day' && mode !== 'HARM' && (step as Step) !== 'day') {
    step = 'day';
    slider.setKeys(allKeys());
    refreshControls();
  }
  if (st.gsrc && st.gsrc in SRC_TYPES && st.gsrc !== 'veg') {
    srcSel.value = st.gsrc;
    detail.setTypes(SRC_TYPES[st.gsrc]);
    calPanel.setSources(SRC_CAL[st.gsrc]);
    refreshZoomNote();
  }
  if (st.mode || st.harm || st.viirs || st.metric) applySelection();
  if (st.t) {
    const keys = allKeys();
    const key = keys.includes(st.t) ? st.t : keys.find((k) => k.startsWith(st.t!.slice(0, 7)));
    if (key) await slider.go(key);
  }
  const cam = (st.cam ?? '').split(',').map(Number);
  if (cam.length === 3 && cam.every(Number.isFinite) && !st.area)
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(cam[0], cam[1], cam[2]) });
  if (st.cal === '1' || st.area) {
    detPanel.toggle(false);
    await calPanel.applyState({ area: st.area, sensor: st.cs, variable: st.cv, colour: st.cm, from: st.cf, to: st.ct, src: st.src });
    // Opened from the table on a country: find it by name.
    if (st.q && !st.area) calPanel.searchPlace(st.q, 'country');
  }
  urlReady = true;
  syncUrl();
  // Debug handle for the browser console.
  Object.assign(window, { globe, left, right, slider });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:absolute;top:0;color:#f88">${String(e)}</pre>`);
});
