import type * as Cesium from 'cesium';
import { areaLabel, cellsFromGeoJson, createAreaPicker, createCalendarHeatmap, type Area, type CellArea } from '../globe';
import type { DataSource, MonthRow } from './dataSource';

interface IntervalBins {
  level_upper_edges: (number | null)[];
  q05: number[];
  q95: number[];
  by_year?: Record<string, { q05: number[]; q95: number[] }>;
}
interface IntervalTable {
  long: { aqua_obs: unknown; viirs_conv: IntervalBins };
  detail: { viirs_native: IntervalBins };
}

interface Place {
  display_name: string;
  addresstype?: string;
  type?: string;
  lat: string;
  lon: string;
  geojson?: { type: string; coordinates: unknown };
}
interface GfedRegions {
  regions: { code: string; name: string; ids: number[]; bbox: [number, number, number, number] }[];
}
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtInt = (v: number) => Math.round(v).toLocaleString('en');
const fmtMw = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0));

export interface CalendarPanelOptions {
  viewer: Cesium.Viewer;
  data: DataSource;
  sensors: Record<string, { label: string; months: string[]; partial_last_month?: boolean; harmonized?: boolean }>;
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
      <form class="cal-search" role="search">
        <input name="q" type="search" placeholder="Town, region, country or address" aria-label="Search a place" required />
        <button type="submit">Search</button>
      </form>
      <div class="cal-results" hidden></div>
      <select data-c="region" aria-label="Continental region"><option value="">Or a continental region (GFED)...</option></select>
      <form class="cal-pt">
        <input name="lat" type="number" step="any" min="-90" max="90" placeholder="Lat" aria-label="Latitude" required />
        <input name="lon" type="number" step="any" min="-180" max="180" placeholder="Lon" aria-label="Longitude" required />
        <input name="km" type="number" step="any" min="1" max="2000" value="25" aria-label="Radius in km" title="Radius (km)" />
        <button type="submit">Point + km</button>
      </form>
      <p class="cal-area note">No area yet: search a place, pick a region, draw a box, use the view, or enter a point and a radius.</p>
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
    <p class="note cal-src"></p>
    <p class="note">Place search: <a href="https://nominatim.openstreetmap.org/" target="_blank" rel="noopener">Nominatim</a>, data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>. Regions: GFED basis regions (Giglio et al. 2013).</p>`;
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
  sensorSel.value = sensors.includes('HARM_LONG') ? 'HARM_LONG' : sensors.includes('VIIRS_SNPP') ? 'VIIRS_SNPP' : sensors[0];
  const isHarm = () => sensorSel.value.startsWith('HARM_');
  // 90% intervals of the harmonized series (data_pipeline interval_table.json, copied next to the site data).
  let itab: IntervalTable | undefined;
  fetch(`${import.meta.env.BASE_URL}data/interval_table.json`)
    .then((r) => (r.ok ? r.json() : undefined))
    .then((j) => {
      itab = j;
      if (rows.length) draw();
    })
    .catch(() => undefined);
  $<HTMLParagraphElement>('.cal-src').textContent = o.data.note;

  const picker = createAreaPicker(o.viewer);
  const heat = createCalendarHeatmap($('.cal-heat'), {
    onSelect: (k) => o.onSelectMonth(k),
    format: (v) => (varSel.value === 'frp' ? fmtMw(v) : fmtInt(v)),
  });
  let area: Area | undefined;
  let rows: MonthRow[] = [];
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
      $<HTMLParagraphElement>('.cal-src').textContent = o.data.note;
      rows = j.months;
      sourceNote =
        j.source === 'harmonized'
          ? sensorSel.value === 'HARM_LONG'
            ? `Harmonized long-term series, Aqua-equivalent detections on 1 degree cells ${area?.kind === 'cells' ? 'overlapping the place' : 'whose centre is in the area'}. 2003-2021 measured by Aqua; from 2022 (and Aug 2020) converted from VIIRS, with a 90% interval.`
            : 'Harmonized detail series, VIIRS 375 m detections at S-NPP level (2013+), 1 degree cells. The band is the spread between satellite pairs, not a confidence interval.'
          : j.source === 'grid'
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
    heat.setData(new Map(rows.map((r) => [r[0], r[k] as number])), s.months, part, isHarm() ? intervalsFor(rows) : new Map());
    heat.setMode(modeSel.value as 'value' | 'anomaly');
    heat.select(selected);
    legendEl.textContent =
      sourceNote +
      (modeSel.value === 'anomaly'
        ? ' Colour: ratio to the median of the same month in the other years, blue 1/4x, white 1x, red 4x.'
        : ' Colour: viridis, log scale.');
    summary();
  }

  function intervalsFor(rs: MonthRow[]): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    if (!itab) return out;
    for (const r of rs) {
      const v = r[1];
      const origin = r[3] ?? 2;
      if (sensorSel.value === 'HARM_LONG' && origin === 0) {
        out.set(r[0], [v, v]); // measured by Aqua
        continue;
      }
      const t =
        sensorSel.value === 'HARM_LONG'
          ? itab.long.viirs_conv.by_year?.[r[0].slice(0, 4)] ?? itab.long.viirs_conv
          : itab.detail.viirs_native;
      const edges = (sensorSel.value === 'HARM_LONG' ? itab.long.viirs_conv : itab.detail.viirs_native).level_upper_edges;
      let i = edges.findIndex((e) => e !== null && e > v);
      if (i < 0) i = edges.length - 1;
      out.set(r[0], [Math.max(0, (v + 1) * t.q05[i] - 1), (v + 1) * t.q95[i] - 1]);
    }
    return out;
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
      if (s.lo !== undefined && s.hi !== undefined && s.hi > s.lo) {
        const what = sensorSel.value === 'HARM_LONG' ? '90% interval' : 'spread between satellite pairs';
        parts.push(
          `${what}: ${f(s.lo)}-${f(s.hi)}. ` +
            (s.significant === undefined
              ? ''
              : s.significant
                ? 'The difference from the median is larger than the uncertainty.'
                : 'The median is inside the interval: the difference is within the uncertainty.'),
        );
      } else if (isHarm() && rows.find((r) => r[0] === s.key)?.[3] === 0) {
        parts.push('Measured by Aqua MODIS (no conversion).');
      }
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

  const NO_AREA = 'No area yet: search a place, pick a region, draw a box, use the view, or enter a point and a radius.';
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
    regionSel.value = '';
    resultsEl.hidden = true;
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
    const head = `sensor,year,month,${varSel.value === 'frp' ? 'frp_mw' : 'detections'},median_same_month_other_years,ratio_to_median,percentile_vs_other_years${isHarm() ? ',lo90,hi90,origin' : ''}`;
    const ORIG = ['aqua_obs', 'viirs_conv', 'viirs_native'];
    const lines = [...o.sensors[sensorSel.value].months].sort().map((key) => {
      const s = heat.stats(key);
      const v = rows.find((r) => r[0] === key)?.[k] ?? 0;
      const row = rows.find((r) => r[0] === key);
      const extra = isHarm() ? [s?.lo?.toFixed(2) ?? '', s?.hi?.toFixed(2) ?? '', row?.[3] !== undefined ? ORIG[row[3]] : ''] : [];
      return [sensorSel.value, key.slice(0, 4), key.slice(5, 7), v, s?.median ?? '', s?.ratio?.toFixed(3) ?? '', s?.percentile?.toFixed(1) ?? '', ...extra].join(',');
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

  // ---- place search (OpenStreetMap Nominatim: on submit only, at most one request per second)
  const resultsEl = $<HTMLDivElement>('.cal-results');
  const regionSel = $<HTMLSelectElement>('[data-c=region]');
  let places: Place[] = [];
  let lastSearch = 0;
  function useArea(a: Area) {
    picker.show(a);
    picker.zoomTo(a);
    setArea(a);
  }
  function usePlace(p: Place) {
    const name = p.display_name.split(',').slice(0, 3).join(',').trim();
    const g = p.geojson;
    let a: Area | undefined = g && /Polygon$/.test(g.type) ? cellsFromGeoJson(g, name) : undefined;
    if (!a) {
      // An address or a point: point + radius, as with the form below.
      const km = Number($<HTMLInputElement>('.cal-pt [name=km]').value) || 25;
      a = { kind: 'circle', lat: Number(p.lat), lon: Number(p.lon), km };
      $<HTMLInputElement>('.cal-pt [name=lat]').value = Number(p.lat).toFixed(4);
      $<HTMLInputElement>('.cal-pt [name=lon]').value = Number(p.lon).toFixed(4);
    }
    regionSel.value = '';
    resultsEl.hidden = true;
    useArea(a);
  }
  $<HTMLFormElement>('.cal-search').onsubmit = (e) => {
    e.preventDefault();
    void search(String(new FormData(e.target as HTMLFormElement).get('q') ?? '').trim());
  };
  /** featureType: Nominatim filter (country, state, city, settlement). */
  async function search(q: string, featureType?: string) {
    if (!q) return;
    const wait = lastSearch + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearch = Date.now();
    resultsEl.hidden = false;
    resultsEl.textContent = 'Searching...';
    try {
      const ft = featureType ? `&featureType=${featureType}` : '';
      const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&polygon_geojson=1&polygon_threshold=0.01&accept-language=en${ft}&q=${encodeURIComponent(q)}`;
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      places = (await r.json()) as Place[];
      if (!places.length) {
        resultsEl.textContent = 'No place found.';
        return;
      }
      if (places.length === 1) return usePlace(places[0]);
      resultsEl.innerHTML = places
        .map((p, i) => `<button type="button" data-p="${i}"><b>${esc(p.addresstype ?? p.type ?? 'place')}</b> ${esc(p.display_name)}</button>`)
        .join('');
    } catch (err) {
      resultsEl.textContent = `Search failed: ${(err as Error).message}`;
    }
  }
  resultsEl.addEventListener('click', (e) => {
    const i = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.p;
    if (i !== undefined) usePlace(places[Number(i)]);
  });

  // ---- continental regions: the 14 GFED basis regions on 1 degree cells (public/regions_gfed.json)
  let gfed: GfedRegions | undefined;
  fetch(`${import.meta.env.BASE_URL}regions_gfed.json`)
    .then((r) => (r.ok ? (r.json() as Promise<GfedRegions>) : undefined))
    .then((j) => {
      gfed = j;
      for (const g of j?.regions ?? []) regionSel.add(new Option(`${g.name} (${g.code})`, g.code));
    })
    .catch(() => (regionSel.hidden = true));
  regionSel.onchange = () => pickRegion(regionSel.value);
  function pickRegion(code: string) {
    const g = gfed?.regions.find((x) => x.code === code);
    if (!g) return;
    regionSel.value = code;
    const a: CellArea = { kind: 'cells', res: 1, ids: g.ids, bbox: g.bbox, label: `${g.name} (GFED ${g.code})` };
    resultsEl.hidden = true;
    useArea(a);
  }
  $<HTMLFormElement>('.cal-pt').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const a: Area = { kind: 'circle', lat: Number(f.get('lat')), lon: Number(f.get('lon')), km: Number(f.get('km')) || 25 };
    regionSel.value = '';
    useArea(a);
  };
  function refreshHarmControls() {
    const h = isHarm();
    if (h) varSel.value = 'n';
    varSel.disabled = h;
    excl.disabled = h; // the static-source mask is already applied in the harmonized series
    const pts = $<HTMLButtonElement>('[data-a=csvpts]');
    pts.disabled = h;
    pts.title = h ? 'Single detections: choose MODIS or a VIIRS satellite' : '';
  }
  refreshHarmControls();
  sensorSel.onchange = () => {
    refreshHarmControls();
    void load();
  };
  excl.onchange = () => void load();
  varSel.onchange = draw;
  modeSel.onchange = draw;

  const panel = {
    /** Open the calendar on a place by name (e.g. a country chosen in the table). */
    searchPlace(name: string, featureType?: string) {
      panel.toggle(true);
      $<HTMLInputElement>('.cal-search [name=q]').value = name;
      void search(name, featureType);
    },
    /** Open the calendar on a GFED region by code. */
    pickRegion(code: string) {
      panel.toggle(true);
      pickRegion(code);
    },
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
