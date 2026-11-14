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
import { detectSource } from './dataSource';
import { createDetail, DETECTION_FRP_TOP, type Pass, type Sat, type Step } from './detail';
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
  x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}k` : x >= 10 ? x.toFixed(0) : x.toFixed(1);
const HOME = { lon: 12, lat: 30, height: 18_000_000 };

async function main() {
  const base = `${import.meta.env.BASE_URL}frames`;
  const manifest: Manifest = await (await fetch(`${base}/manifest.json`)).json();
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
  createZoomControls(viewer, zoomBox, HOME);
  const scaleBox = document.createElement('div');
  scaleBox.id = 'scale';
  document.body.appendChild(scaleBox);
  createScaleBar(viewer, scaleBox);

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
    .map((b) => `<option value="${b}">${BASEMAPS[b].label}</option>`)
    .join('');

  let mode: Mode = 'BOTH';
  let step: Step = 'month';
  // Local service when it runs, else static Parquet files queried in the browser (DuckDB-WASM).
  const ds = await detectSource().catch((e) => {
    console.warn('No data source for detections', e);
    return undefined;
  });
  const apiOk = !!ds;
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
  const splitter = createSplitter(viewer, document.body, (f) => {
    labL.style.right = `${(1 - f) * 100}%`;
    labL.style.marginRight = '12px';
    labR.style.left = `${f * 100}%`;
    labR.style.marginLeft = '12px';
  });

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
      legend.update('Single detection: fire radiative power (MW, log scale)', RAMPS.fire, ticks);
      return;
    }
    const s0 = shown()[0];
    const top = displayMax(s0);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
      at: t,
      label: `${t === 1 ? '≥ ' : ''}${fmtNum(Math.expm1(t * Math.log1p(top)))}`,
    }));
    if (isHarm(s0)) {
      const unit = s0 === 'HARM_LONG' ? 'Aqua-equivalent detections' : 'VIIRS detections (S-NPP level)';
      legend.update(`Harmonized: ${unit} / 1 degree cell / month, log scale`, RAMPS.fire, ticks);
      return;
    }
    const m = manifest.metrics[metricSel.value];
    legend.update(`${m.label} (${m.unit}, log scale)`, RAMPS.fire, ticks);
  }

  function refreshLabels(key: string) {
    const fmt = step === 'day' ? fmtDay : fmtMonth;
    const day = key;
    key = key.slice(0, 7);
    const [a, b] = shown();
    const lab = (s: string) => `${manifest.sensors[s].label}${manifest.sensors[s].months.includes(key) ? '' : ' - no data'}`;
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
      partial.length && step === 'month' ? `${fmtMonth(key)} is a partial month (data up to today).` : '',
      missing.length ? `No ${missing.map((s) => manifest.sensors[s].label).join(', ')} data for ${fmt(day)}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** Apply mode, VIIRS satellite and side order to layers, UI and time axis. */
  function applySelection() {
    const [a, b] = shown();
    for (const btn of modeSeg.querySelectorAll<HTMLButtonElement>('button'))
      btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    viirsWrap.style.display = mode !== 'MODIS' && mode !== 'HARM' && viirsSensors.length > 1 ? '' : 'none';
    harmWrap.hidden = mode !== 'HARM';
    $('data-badge').textContent = mode === 'HARM' ? 'MODIS and VIIRS harmonized: one consistent series' : 'Raw per-sensor data, not harmonized';
    $('sub-text').textContent = mode === 'HARM' ? 'NASA FIRMS, monthly, 1° cells.' : 'NASA FIRMS, monthly, 0.25° grid.';
    metricSel.disabled = mode === 'HARM';
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
  const refreshControls = () => {
    for (const btn of stepSeg.querySelectorAll<HTMLButtonElement>('button')) {
      btn.setAttribute('aria-checked', String(btn.dataset.step === step));
      if (btn.dataset.step === 'day') {
        btn.disabled = !apiOk || mode === 'HARM';
        btn.title =
          mode === 'HARM'
            ? 'The harmonized series is monthly'
            : apiOk
              ? 'One day at a time, individual detections'
              : 'Needs the data service or the static data files';
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
      '<option value="0">All days</option>' +
      Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${MONTHS[m - 1]} ${i + 1}</option>`).join('');
    daySel.value = String(keep);
    detail?.setFilters({ day: keep });
  };

  const slider = createTimeSlider($('time'), {
    keys: allKeys(),
    format: (k) => (k.length > 7 ? fmtDay(k) : fmtMonth(k)),
    onChange: async (key) => {
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
  };
  passSeg.onclick = (e) => {
    const p = (e.target as HTMLElement).closest('button')?.dataset.pass as Pass | undefined;
    if (!p) return;
    pass = p;
    detail?.setFilters({ pass });
    refreshControls();
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
        if (!on) detailNote.textContent = 'Zoom in below 2,500 km to see individual detections.';
      },
      onStatus(text) {
        if (text) detailNote.textContent = text;
      },
    },
  );
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
  calBtn.textContent = 'Area fire calendar';
  calBtn.disabled = !apiOk;
  calBtn.title = apiOk ? `Calendar of fire activity for an area, with CSV export. ${ds!.note}` : 'Needs the data service or the static data files';
  calBtn.onclick = () => calPanel?.toggle();
  document.body.appendChild(calBtn);
  calPanel.select(slider.key);
  detail.setPeriod(step, slider.key);
  refreshControls();

  applySelection();
  refreshLegend();
  // Debug handle for the browser console.
  Object.assign(window, { globe, left, right, slider });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:absolute;top:0;color:#f88">${String(e)}</pre>`);
});
