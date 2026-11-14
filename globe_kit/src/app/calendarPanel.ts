import type * as Cesium from 'cesium';
import { areaLabel, createAreaPicker, createCalendarHeatmap, type Area } from '../globe';
import type { DataSource } from './dataSource';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtInt = (v: number) => Math.round(v).toLocaleString('en');
const fmtMw = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0));

export interface CalendarPanelOptions {
  viewer: Cesium.Viewer;
  data: DataSource;
  sensors: Record<string, { label: string; months: string[]; partial_last_month?: boolean }>;
  /** A calendar cell was clicked (YYYY-MM). */
  onSelectMonth: (key: string) => void;
}

/**
 * Area fire calendar: pick an area (box, current view, or point + radius), see the year x month
 * calendar of hotspots for one sensor, its anomaly against the monthly median, and export CSV.
 * Data from the local service: /api/calendar and /api/export.
 */
export function createCalendarPanel(o: CalendarPanelOptions) {
  const sensors = Object.keys(o.sensors);
  const el = document.createElement('aside');
  el.className = 'panel calpanel';
  el.hidden = true;
  el.innerHTML = `
    <header class="cal-head"><h2>Area fire calendar</h2><button type="button" class="cal-x" aria-label="Close">&times;</button></header>
    <section class="cal-sec">
      <div class="cal-btns">
        <button type="button" data-a="draw">Draw a box</button>
        <button type="button" data-a="view">Use current view</button>
        <button type="button" data-a="clear" title="Remove the area from the globe and reset the calendar">Clear area</button>
      </div>
      <form class="cal-pt">
        <input name="lat" type="number" step="any" min="-90" max="90" placeholder="Lat" aria-label="Latitude" required />
        <input name="lon" type="number" step="any" min="-180" max="180" placeholder="Lon" aria-label="Longitude" required />
        <input name="km" type="number" step="any" min="1" max="2000" value="25" aria-label="Radius in km" title="Radius (km)" />
        <button type="submit">Point + km</button>
      </form>
      <p class="cal-area note">No area yet: draw a box, use the view, or enter a point and a radius.</p>
    </section>
    <div class="cal-row3">
      <label>Sensor<select data-c="sensor">${sensors.map((s) => `<option value="${s}">${o.sensors[s].label}</option>`).join('')}</select></label>
      <label>Variable<select data-c="var"><option value="n">Detections</option><option value="frp">FRP (MW)</option></select></label>
      <label>Colour<select data-c="mode"><option value="value">Value</option><option value="anomaly">vs median</option></select></label>
    </div>
    <label class="check"><input type="checkbox" data-c="excl" checked /> Exclude volcanoes and industrial sources</label>
    <div class="cal-heat"></div>
    <div class="cal-legend note"></div>
    <div class="cal-stats"></div>
    <section class="cal-sec cal-export">
      <button type="button" data-a="csvcal">Calendar CSV</button>
      <span class="cal-range">Hotspots from <input type="date" data-c="from" /> to <input type="date" data-c="to" /></span>
      <button type="button" data-a="csvpts">Hotspots CSV</button>
    </section>
    <p class="note">Raw counts of one sensor. MODIS and VIIRS are not comparable until harmonized.</p>
    <p class="note cal-src"></p>`;
  document.body.appendChild(el);

  const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const sensorSel = $<HTMLSelectElement>('[data-c=sensor]');
  const varSel = $<HTMLSelectElement>('[data-c=var]');
  const modeSel = $<HTMLSelectElement>('[data-c=mode]');
  const excl = $<HTMLInputElement>('[data-c=excl]');
  const fromIn = $<HTMLInputElement>('[data-c=from]');
  const toIn = $<HTMLInputElement>('[data-c=to]');
  const areaP = $<HTMLParagraphElement>('.cal-area');
  const statsEl = $<HTMLDivElement>('.cal-stats');
  const legendEl = $<HTMLDivElement>('.cal-legend');
  sensorSel.value = sensors.includes('VIIRS_SNPP') ? 'VIIRS_SNPP' : sensors[0];
  $<HTMLParagraphElement>('.cal-src').textContent = o.data.note;

  const picker = createAreaPicker(o.viewer);
  const heat = createCalendarHeatmap($('.cal-heat'), {
    onSelect: (k) => o.onSelectMonth(k),
    format: (v) => (varSel.value === 'frp' ? fmtMw(v) : fmtInt(v)),
  });
  let area: Area | undefined;
  let rows: [string, number, number][] = [];
  let selected = '';
  let req = 0;
  let sourceNote = '';

  const types = () => (excl.checked ? '0,-1' : '0,1,2,3,-1');

  async function load() {
    if (!area) return;
    const my = ++req;
    statsEl.textContent = 'Loading...';
    try {
      const j = await o.data.calendar(sensorSel.value, area, types());
      if (my !== req) return;
      rows = j.months;
      sourceNote =
        j.source === 'grid'
          ? 'Counted on the 0.25 degree grid (cells whose centre is in the area).'
          : 'Counted from single detections.';
      draw();
    } catch (err) {
      statsEl.textContent = `Could not load the calendar: ${(err as Error).message}`;
    }
  }

  function draw() {
    const k = varSel.value === 'frp' ? 2 : 1;
    const s = o.sensors[sensorSel.value];
    const part = s.partial_last_month ? [s.months[s.months.length - 1]] : [];
    heat.setData(new Map(rows.map((r) => [r[0], r[k]])), s.months, part);
    heat.setMode(modeSel.value as 'value' | 'anomaly');
    heat.select(selected);
    legendEl.textContent =
      sourceNote +
      (modeSel.value === 'anomaly'
        ? ' Colour: ratio to the median of the same month in the other years, blue 1/4x, white 1x, red 4x.'
        : ' Colour: viridis, log scale.');
    summary();
  }

  function summary() {
    if (!area) return;
    const unit = varSel.value === 'frp' ? 'MW' : 'detections';
    const f = varSel.value === 'frp' ? fmtMw : fmtInt;
    const s = selected ? heat.stats(selected) : undefined;
    const parts: string[] = [];
    if (s) {
      const name = `${MON[Number(s.key.slice(5, 7)) - 1]} ${s.key.slice(0, 4)}`;
      parts.push(
        `<b>${name}</b>: ${f(s.value)} ${unit}` +
          (s.median !== undefined
            ? `, <b>${s.ratio!.toFixed(1)}x</b> the median of the same month (${f(s.median)}, ${s.baselineYears} other years), higher than ${Math.round(s.percentile!)}% of them.`
            : '.'),
      );
    } else if (selected) {
      parts.push(`No ${o.sensors[sensorSel.value].label} data for ${selected}.`);
    }
    // Seasonality and top years.
    const byMonth = Array.from({ length: 12 }, (_, m) => {
      const mm = String(m + 1).padStart(2, '0');
      const v = rows.filter((r) => r[0].slice(5, 7) === mm).map((r) => (varSel.value === 'frp' ? r[2] : r[1]));
      return v.reduce((a, b) => a + b, 0);
    });
    const peak = byMonth.indexOf(Math.max(...byMonth));
    const years = new Map<string, number>();
    for (const r of rows) years.set(r[0].slice(0, 4), (years.get(r[0].slice(0, 4)) ?? 0) + (varSel.value === 'frp' ? r[2] : r[1]));
    const top = [...years.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (rows.length) {
      parts.push(`Peak month over the record: <b>${MON[peak]}</b>. Most active years: ${top.map(([y, v]) => `${y} (${f(v)})`).join(', ')}.`);
    }
    statsEl.innerHTML = parts.map((p) => `<p>${p}</p>`).join('');
  }

  const NO_AREA = 'No area yet: draw a box, use the view, or enter a point and a radius.';
  function clearArea() {
    req++; // drop answers still in flight
    picker.cancel();
    picker.clear();
    area = undefined;
    rows = [];
    sourceNote = '';
    heat.setData(new Map(), []);
    legendEl.textContent = '';
    statsEl.textContent = '';
    areaP.textContent = NO_AREA;
    const f = $<HTMLFormElement>('.cal-pt');
    f.reset();
  }

  function setArea(a: Area | undefined) {
    if (!a) return;
    area = a;
    areaP.textContent = areaLabel(a);
    void load();
  }

  function downloadCalendar() {
    if (!area) return;
    const k = varSel.value === 'frp' ? 2 : 1;
    const head = `sensor,year,month,${varSel.value === 'frp' ? 'frp_mw' : 'detections'},median_same_month_other_years,ratio_to_median,percentile_vs_other_years`;
    const lines = [...o.sensors[sensorSel.value].months].sort().map((key) => {
      const s = heat.stats(key);
      const v = rows.find((r) => r[0] === key)?.[k] ?? 0;
      return [sensorSel.value, key.slice(0, 4), key.slice(5, 7), v, s?.median ?? '', s?.ratio?.toFixed(3) ?? '', s?.percentile?.toFixed(1) ?? ''].join(',');
    });
    const meta = `# area: ${areaLabel(area)}; types: ${types()}; raw sensor values, not harmonized; source: NASA FIRMS`;
    const blob = new Blob([[meta, head, ...lines].join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fire_calendar_${sensorSel.value.toLowerCase()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function downloadPoints() {
    if (!area || !fromIn.value || !toIn.value) return;
    const btn = $<HTMLButtonElement>('[data-a=csvpts]');
    btn.disabled = true;
    btn.textContent = 'Preparing...';
    try {
      const blob = await o.data.exportCsv(sensorSel.value, area, fromIn.value, toIn.value, types());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `firms_${sensorSel.value.toLowerCase()}_${fromIn.value}_${toIn.value}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      statsEl.textContent = `Export failed: ${(err as Error).message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Hotspots CSV';
    }
  }

  el.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.a;
    if (act === 'draw') {
      areaP.textContent = 'Click two opposite corners on the globe (Esc cancels).';
      setArea(await picker.drawBox());
      if (!area) areaP.textContent = NO_AREA;
    } else if (act === 'view') setArea(picker.fromView());
    else if (act === 'clear') clearArea();
    else if (act === 'csvcal') downloadCalendar();
    else if (act === 'csvpts') void downloadPoints();
  });
  $('.cal-x').onclick = () => panel.toggle(false);
  $<HTMLFormElement>('.cal-pt').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const a: Area = { kind: 'circle', lat: Number(f.get('lat')), lon: Number(f.get('lon')), km: Number(f.get('km')) || 25 };
    picker.show(a);
    picker.zoomTo(a);
    setArea(a);
  };
  sensorSel.onchange = () => void load();
  excl.onchange = () => void load();
  varSel.onchange = draw;
  modeSel.onchange = draw;

  const panel = {
    toggle(on?: boolean) {
      el.hidden = on === undefined ? !el.hidden : !on;
      if (el.hidden) picker.cancel();
      return !el.hidden;
    },
    /** Follow the time slider: highlight the month and preset the export range. */
    select(key: string) {
      selected = key.slice(0, 7);
      heat.select(selected);
      const [y, m] = selected.split('-').map(Number);
      fromIn.value = `${selected}-01`;
      toIn.value = `${selected}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
      summary();
    },
    get visible() {
      return !el.hidden;
    },
  };
  return panel;
}
