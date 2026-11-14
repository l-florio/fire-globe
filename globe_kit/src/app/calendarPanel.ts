import type * as Cesium from 'cesium';
import { areaLabel, cellsFromGeoJson, createAreaPicker, createCalendarHeatmap, type Area, type CellArea } from '../globe';
import type { DataSource, MonthRow } from './dataSource';
import { fmtFixed, fmtInt, lang, locale, monthsShort, monthInitials, t, tOr, tn } from './i18n';

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
  category?: string;
  type?: string;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  boundingbox?: string[]; // south, north, west, east
  geojson?: { type: string; coordinates: unknown };
}
/** Continents (Natural Earth) on 1 degree cells: public/continents.json; also typed names, English and Italian. */
const CONTINENT_NAMES: Record<string, string> = {
  africa: 'AF', asia: 'AS', europe: 'EU', europa: 'EU', 'north america': 'NA', 'nord america': 'NA', 'america del nord': 'NA',
  'south america': 'SA', 'sud america': 'SA', 'america del sud': 'SA', 'america meridionale': 'SA', oceania: 'OC', australia: 'OC',
};
/** OpenStreetMap feature types shown in the result list (translated through the place.* keys). */
const KIND: Record<string, string> = { highway: 'street', building: 'address', place: 'place', boundary: 'area', amenity: 'place', shop: 'place' };
const kindName = (k: string) => tOr(`place.${k}`, k);
interface GfedRegions {
  regions: { code: string; name: string; ids: number[]; bbox: [number, number, number, number] }[];
}
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const MON = monthsShort;
const fmtMw = (v: number) => (v >= 1e6 ? `${fmtFixed(v / 1e6, 1)}M` : v >= 1e3 ? `${fmtFixed(v / 1e3, 1)}k` : fmtFixed(v, 0));

/** Texts for the generic globe library (areaLabel and the calendar heatmap), translated here. */
const AREA_LABELS = {
  locale,
  cells: (n: number, res: number, km2: string) => t('area.cells', { n, res, km2 }),
  place: (label: string, cells: string, placeKm2?: string) =>
    placeKm2 === undefined ? t('area.cellsPlain', { label, cells }) : t('area.cellsPlace', { label, cells, place: placeKm2 }),
  box: (s: string, n: string, w: string, e: string, km2: string) => t('area.box', { s, n, w, e, km2 }),
  circle: (km: number, lat: string, lon: string) => t('area.circle', { km, lat, lon }),
};
const HEAT_LABELS = {
  months: MON,
  initials: monthInitials,
  empty: t('heat.empty'),
  year: t('heat.year'),
  medianRow: t('heat.median'),
  noData: (month: string, year: number) => t('heat.noData', { month, year }),
  partial: (tip: string) => t('heat.partial', { tip }),
  tip: (p: { month: string; year: number; value: string; unit?: string; interval?: [string, string]; ratio?: string; median?: string; years?: number; percentile?: number }) =>
    t('heat.tip', { month: p.month, year: p.year, value: p.value + (p.unit ? ' ' + p.unit : '') }) +
    (p.interval ? t('heat.tip.interval', { lo: p.interval[0], hi: p.interval[1] }) : '') +
    (p.median !== undefined
      ? t('heat.tip.median', {
          ratio: p.ratio ?? '',
          month: p.month,
          median: p.median,
          years: tn('heat.tip.years', p.years ?? 0),
          pct: Math.round(p.percentile ?? 0),
        })
      : ''),
  medianTip: (month: string, value: string) => t('heat.medianTip', { month, value }),
};

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
    <header class="cal-head"><h2>${t('cal.title')}</h2><button type="button" class="cal-x" aria-label="${t('cal.close')}">&times;</button></header>
    <section class="cal-sec">
      <div class="cal-btns">
        <button type="button" data-a="draw">${t('cal.draw')}</button>
        <button type="button" data-a="view">${t('cal.view')}</button>
        <button type="button" data-a="clear" title="${t('cal.clear.title')}">${t('cal.clear')}</button>
      </div>
      <form class="cal-search" role="search">
        <input name="q" type="search" placeholder="${t('cal.search.placeholder')}" aria-label="${t('cal.search.aria')}" required />
        <button type="submit">${t('cal.search.btn')}</button>
      </form>
      <div class="cal-results" hidden></div>
      <select data-c="region" aria-label="${t('cal.region.aria')}"><option value="">${t('cal.region.placeholder')}</option></select>
      <form class="cal-pt">
        <input name="lat" type="number" step="any" min="-90" max="90" placeholder="${t('cal.lat')}" aria-label="${t('cal.lat.aria')}" required />
        <input name="lon" type="number" step="any" min="-180" max="180" placeholder="${t('cal.lon')}" aria-label="${t('cal.lon.aria')}" required />
        <input name="km" type="number" step="any" min="0.5" max="2000" value="25" aria-label="${t('cal.km.aria')}" title="${t('cal.km.title')}" />
        <button type="submit">${t('cal.pt.btn')}</button>
      </form>
      <p class="cal-area note">${t('cal.noArea')}</p>
    </section>
    <div class="cal-row3">
      <label>${t('cal.sensor')}<select data-c="sensor">${sensors.map((s) => `<option value="${s}">${o.sensors[s].label}</option>`).join('')}</select></label>
      <label>${t('cal.variable')}<select data-c="var"><option value="n">${t('cal.var.n')}</option><option value="frp">${t('cal.var.frp')}</option></select></label>
      <label>${t('cal.colour')}<select data-c="mode"><option value="value">${t('cal.colour.value')}</option><option value="anomaly">${t('cal.colour.anomaly')}</option></select></label>
    </div>
    <label class="cal-types">${t('cal.types.label')}<select data-c="types">
      <option value="veg">${t('cal.types.veg')}</option><option value="all">${t('cal.types.all')}</option><option value="static">${t('cal.types.static')}</option>
    </select></label>
    <section class="cal-period">
      <span class="cal-period-row">${t('cal.period.from')}
        <select data-c="fy" aria-label="${t('cal.period.fromYear')}"></select><select data-c="fm" aria-label="${t('cal.period.fromMonth')}"></select></span>
      <span class="cal-period-row">${t('cal.period.to')}
        <select data-c="ty" aria-label="${t('cal.period.toYear')}"></select><select data-c="tm" aria-label="${t('cal.period.toMonth')}"></select></span>
      <button type="button" data-a="period-all" title="${t('cal.period.all.title')}">${t('cal.period.all')}</button>
      <p class="note cal-period-note">${t('cal.period.note')}</p>
    </section>
    <div class="cal-body">
      <p class="cal-area-copy note"></p>
      <div class="cal-heat"></div>
      <div class="cal-legend note"></div>
      <div class="cal-stats"></div>
    </div>
    <section class="cal-sec cal-export">
      <button type="button" data-a="csvcal">${t('cal.csvCal')}</button>
      <button type="button" data-a="pngcal" title="${t('cal.pngCal.title')}">${t('cal.pngCal')}</button>
      <span class="cal-range">${t('cal.range.from')} <input type="date" data-c="from" /> ${t('cal.range.to')} <input type="date" data-c="to" /></span>
      <button type="button" data-a="csvpts">${t('cal.csvPts')}</button>
    </section>
    <p class="note cal-raw">${t('cal.raw')}</p>
    <p class="note cal-src"></p>
    <p class="note">${t('cal.credits', {
      nominatim: '<a href="https://nominatim.openstreetmap.org/" target="_blank" rel="noopener">Nominatim</a>',
      osm: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
    })}</p>`;
  document.body.appendChild(el);

  const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const sensorSel = $<HTMLSelectElement>('[data-c=sensor]');
  const varSel = $<HTMLSelectElement>('[data-c=var]');
  const modeSel = $<HTMLSelectElement>('[data-c=mode]');
  const typesSel = $<HTMLSelectElement>('[data-c=types]');
  const fySel = $<HTMLSelectElement>('[data-c=fy]');
  const fmSel = $<HTMLSelectElement>('[data-c=fm]');
  const tySel = $<HTMLSelectElement>('[data-c=ty]');
  const tmSel = $<HTMLSelectElement>('[data-c=tm]');
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
    locale,
    labels: HEAT_LABELS,
  });
  let area: Area | undefined;
  let rows: MonthRow[] = [];
  let selected = '';
  let req = 0;
  let sourceNote = '';

  /** FIRMS `type` list sent to the data source: vegetation fires (default), everything, or static sources only. */
  const TYPES: Record<string, string> = { veg: '0,-1', all: '0,1,2,3,-1', static: '1,2,3' };
  const types = () => TYPES[typesSel.value] ?? TYPES.veg;

  // ---- period of the calendar: '' = from the first / up to the last month of the sensor
  let fromKey = '';
  let toKey = '';
  const sensorMonths = () => [...o.sensors[sensorSel.value].months].sort();
  const firstKey = () => sensorMonths()[0] ?? '';
  const lastKey = () => sensorMonths().slice(-1)[0] ?? '';
  const effFrom = () => (fromKey && fromKey >= firstKey() && fromKey <= lastKey() ? fromKey : firstKey());
  const effTo = () => (toKey && toKey >= firstKey() && toKey <= lastKey() ? toKey : lastKey());
  const customRange = () => effFrom() !== firstKey() || effTo() !== lastKey();
  const inRange = (k: string) => k >= effFrom() && k <= effTo();
  const monthName = (k: string) => `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

  function fillPeriodSelects() {
    const keys = sensorMonths();
    if (!keys.length) return;
    const y0 = Number(keys[0].slice(0, 4));
    const y1 = Number(keys[keys.length - 1].slice(0, 4));
    const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => `<option>${y0 + i}</option>`).join('');
    const months = MON.map((m, i) => `<option value="${String(i + 1).padStart(2, '0')}">${m}</option>`).join('');
    for (const s of [fySel, tySel]) s.innerHTML = years;
    for (const s of [fmSel, tmSel]) s.innerHTML = months;
    showPeriod();
  }
  function showPeriod() {
    const [f, t2] = [effFrom(), effTo()];
    fySel.value = f.slice(0, 4);
    fmSel.value = f.slice(5, 7);
    tySel.value = t2.slice(0, 4);
    tmSel.value = t2.slice(5, 7);
  }
  /** Read the selects; the bound that did not move is adjusted when they cross. */
  function readPeriod(changed: 'from' | 'to') {
    let f = `${fySel.value}-${fmSel.value}`;
    let t2 = `${tySel.value}-${tmSel.value}`;
    if (f > t2) {
      if (changed === 'from') t2 = f;
      else f = t2;
    }
    fromKey = f <= firstKey() ? '' : f;
    toKey = t2 >= lastKey() ? '' : t2;
    showPeriod();
    applyPeriod();
  }
  function applyPeriod() {
    const custom = customRange();
    heat.setRange(custom ? effFrom() : undefined, custom ? effTo() : undefined);
    if (custom) {
      // The hotspots export defaults to the same period.
      fromIn.value = `${effFrom()}-01`;
      const [y, m] = effTo().split('-').map(Number);
      toIn.value = `${effTo()}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    }
    if (rows.length) draw();
    panel.onChange?.();
  }
  const visibleRows = () => rows.filter((r) => inRange(r[0]));

  async function load() {
    if (!area) return;
    const my = ++req;
    statsEl.textContent = t('cal.loading');
    try {
      const j = await o.data.calendar(sensorSel.value, area, types());
      if (my !== req) return;
      $<HTMLParagraphElement>('.cal-src').textContent = o.data.note;
      rows = j.months;
      sourceNote =
        j.source === 'harmonized'
          ? t(sensorSel.value === 'HARM_LONG' ? 'cal.src.harmLong' : 'cal.src.harmDetail')
          : t(j.source === 'grid' ? 'cal.src.grid' : 'cal.src.detections');
      draw();
    } catch (err) {
      statsEl.textContent = t('cal.loadError', { msg: (err as Error).message });
    }
  }

  function draw() {
    $<HTMLParagraphElement>('.cal-area-copy').textContent = area
      ? t('cal.areaCopy', {
          area: areaLabel(area, AREA_LABELS),
          sensor: o.sensors[sensorSel.value].label,
          var: varSel.value === 'frp' ? t('cal.var.frp') : t('cal.var.n.lower'),
        }) + (customRange() ? t('cal.areaCopy.period', { from: monthName(effFrom()), to: monthName(effTo()) }) : '')
      : '';
    const k = varSel.value === 'frp' ? 2 : 1;
    const s = o.sensors[sensorSel.value];
    const part = s.partial_last_month ? [s.months[s.months.length - 1]] : [];
    heat.setData(new Map(rows.map((r) => [r[0], r[k] as number])), s.months, part, isHarm() ? intervalsFor(rows) : new Map());
    heat.setMode(modeSel.value as 'value' | 'anomaly');
    heat.select(selected);
    legendEl.textContent =
      sourceNote +
      t(modeSel.value === 'anomaly' ? 'cal.legend.anomaly' : 'cal.legend.value') +
      (customRange() && modeSel.value === 'anomaly' ? t('cal.legend.baseline') : '');
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
    const unit = varSel.value === 'frp' ? 'MW' : t('cal.var.n.lower');
    const f = varSel.value === 'frp' ? fmtMw : fmtInt;
    const s = selected ? heat.stats(selected) : undefined;
    const parts: string[] = [];
    if (s) {
      const name = `${MON[Number(s.key.slice(5, 7)) - 1]} ${s.key.slice(0, 4)}`;
      parts.push(
        t('cal.sum.month', { name, value: f(s.value), unit }) +
          (s.partial
            ? t('cal.sum.partial')
            : s.median !== undefined && s.ratio !== undefined
            ? t('cal.sum.median', {
                ratio: fmtFixed(s.ratio, 1),
                median: f(s.median),
                years: tn('cal.sum.years', s.baselineYears),
                pct: Math.round(s.percentile!),
              })
            : '.'),
      );
      if (s.lo !== undefined && s.hi !== undefined && s.hi > s.lo) {
        const what = t(sensorSel.value === 'HARM_LONG' ? 'cal.sum.interval' : 'cal.sum.spread');
        parts.push(
          t('cal.sum.intervalLine', { what, lo: f(s.lo), hi: f(s.hi) }) +
            (s.significant === undefined ? '' : t(s.significant ? 'cal.sum.sig' : 'cal.sum.notSig')),
        );
      } else if (isHarm() && rows.find((r) => r[0] === s.key)?.[3] === 0) {
        parts.push(t('cal.sum.aqua'));
      }
    } else if (selected) {
      parts.push(t('cal.sum.noData', { sensor: o.sensors[sensorSel.value].label, key: selected }));
    }
    // Seasonality and top years.
    const byMonth = Array.from({ length: 12 }, (_, m) => {
      const mm = String(m + 1).padStart(2, '0');
      const v = visibleRows().filter((r) => r[0].slice(5, 7) === mm).map((r) => (varSel.value === 'frp' ? r[2] : r[1]));
      return v.reduce((a, b) => a + b, 0);
    });
    const peak = byMonth.indexOf(Math.max(...byMonth));
    const years = new Map<string, number>();
    for (const r of visibleRows()) years.set(r[0].slice(0, 4), (years.get(r[0].slice(0, 4)) ?? 0) + (varSel.value === 'frp' ? r[2] : r[1]));
    const top = [...years.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (visibleRows().length) {
      parts.push(t('cal.sum.peak', { month: MON[peak], years: top.map(([y, v]) => `${y} (${f(v)})`).join(', ') }));
    }
    statsEl.innerHTML = parts.map((p) => `<p>${p}</p>`).join('');
  }

  const NO_AREA = t('cal.noArea');
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
    areaSpec = undefined;
    panel.onChange?.();
  }

  /**
   * The current area as a short text for shareable links:
   * box:w,s,e,n | pt:lat,lon,km | region:c:EU / region:g:EURO | osm:R123 (OpenStreetMap object, outline re-fetched).
   */
  let areaSpec: string | undefined;
  let cellSpec: string | undefined; // set by the place / region pickers just before a cell area is used
  const r4 = (v: number) => String(Math.round(v * 1e4) / 1e4);
  function specOf(a: Area): string | undefined {
    if (a.kind === 'bbox') return `box:${[a.west, a.south, a.east, a.north].map(r4).join(',')}`;
    if (a.kind === 'circle') return `pt:${r4(a.lat)},${r4(a.lon)},${a.km}`;
    return cellSpec;
  }
  function setArea(a: Area | undefined) {
    if (!a) return;
    area = a;
    areaSpec = specOf(a);
    cellSpec = undefined;
    panel.onChange?.();
    areaP.textContent = areaLabel(a, AREA_LABELS);
    void load();
  }

  function downloadCalendar() {
    if (!area) return;
    const k = varSel.value === 'frp' ? 2 : 1;
    const head = `sensor,year,month,${varSel.value === 'frp' ? 'frp_mw' : 'detections'},median_same_month_other_years,ratio_to_median,percentile_vs_other_years${isHarm() ? ',lo90,hi90,origin' : ''}`;
    const ORIG = ['aqua_obs', 'viirs_conv', 'viirs_native'];
    const lines = sensorMonths().filter(inRange).map((key) => {
      const s = heat.stats(key);
      const v = rows.find((r) => r[0] === key)?.[k] ?? 0;
      const row = rows.find((r) => r[0] === key);
      const extra = isHarm() ? [s?.lo?.toFixed(2) ?? '', s?.hi?.toFixed(2) ?? '', row?.[3] !== undefined ? ORIG[row[3]] : ''] : [];
      return [sensorSel.value, key.slice(0, 4), key.slice(5, 7), v, s?.median ?? '', s?.ratio?.toFixed(3) ?? '', s?.percentile?.toFixed(1) ?? '', ...extra].join(',');
    });
    const what = isHarm()
      ? `harmonized ${sensorSel.value === 'HARM_LONG' ? 'long-term series (Aqua-equivalent detections, 1 degree cells overlapping the area)' : 'detail series (VIIRS 375 m at S-NPP level, 1 degree cells overlapping the area)'}`
      : 'raw values of one sensor, not harmonized';
    const last = o.sensors[sensorSel.value].partial_last_month ? `; last month ${o.sensors[sensorSel.value].months.slice(-1)[0]} is partial` : '';
    const period = customRange() ? `period: ${effFrom()} to ${effTo()} (median and percentile use the whole record); ` : '';
    const meta = `# area: ${areaLabel(area)}; ${period}types: ${types()}; ${what}${last}; ratio_to_median = value / median (empty when the median is 0); source: NASA FIRMS`;
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
    btn.textContent = t('cal.preparing');
    try {
      const blob = await o.data.exportCsv(sensorSel.value, area, fromIn.value, toIn.value, types());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `firms_${sensorSel.value.toLowerCase()}_${fromIn.value}_${toIn.value}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      statsEl.textContent = t('cal.exportFailed', { msg: (err as Error).message });
    } finally {
      btn.disabled = false;
      btn.textContent = t('cal.csvPts');
    }
  }

  el.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.a;
    if (act === 'draw') {
      areaP.textContent = t('cal.drawHint');
      setArea(await picker.drawBox());
      if (!area) areaP.textContent = NO_AREA;
    } else if (act === 'view') setArea(picker.fromView());
    else if (act === 'clear') clearArea();
    else if (act === 'csvcal') downloadCalendar();
    else if (act === 'pngcal') {
      // The exported image carries the area and the sensor (shown only while exporting).
      const body = $<HTMLDivElement>('.cal-body');
      body.classList.add('exporting');
      void Promise.resolve(panel.onExportPng?.(body)).finally(() => body.classList.remove('exporting'));
    }
    else if (act === 'csvpts') void downloadPoints();
    else if (act === 'period-all') {
      fromKey = toKey = '';
      showPeriod();
      applyPeriod();
    }
  });
  $('.cal-x').onclick = () => panel.toggle(false);

  // ---- place search (OpenStreetMap Nominatim: on submit only, at most one request per second)
  const resultsEl = $<HTMLDivElement>('.cal-results');
  const regionSel = $<HTMLSelectElement>('[data-c=region]');
  let places: Place[] = [];
  let lastSearch = 0;
  /** Screen pixels covered by panels, so that the area is framed in the visible part of the globe. */
  function viewPadding() {
    const W = innerWidth;
    const H = innerHeight;
    const pad = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const e of document.querySelectorAll<HTMLElement>('#panel, .calpanel:not([hidden])')) {
      const r = e.getBoundingClientRect();
      if (!r.width) continue;
      if (r.width > W * 0.6) pad.top = Math.max(pad.top, r.bottom);
      else if (r.left + r.width / 2 < W / 2) pad.left = Math.max(pad.left, r.right);
      else pad.right = Math.max(pad.right, W - r.left);
    }
    const b = document.getElementById('bottom')?.getBoundingClientRect();
    if (b) pad.bottom = H - b.top;
    return pad;
  }
  function useArea(a: Area) {
    picker.show(a);
    picker.zoomTo(a, viewPadding());
    setArea(a);
  }
  const ptInput = (n: string) => $<HTMLInputElement>(`.cal-pt [name=${n}]`);
  /** A place or region replaces the point + radius: the form goes back to its defaults. */
  function resetPoint() {
    $<HTMLFormElement>('.cal-pt').reset();
  }
  /** Readable label: no postcode (often wrong in OpenStreetMap for streets), no repeated parts. */
  function placeLabel(p: Place) {
    const parts = p.display_name.split(', ').filter((x, i, arr) => !/^\d{4,6}$/.test(x) && arr.indexOf(x) === i);
    return parts.join(', ');
  }
  function placeKind(p: Place) {
    if (p.addresstype && p.category !== 'highway' && p.category !== 'building') return kindName(p.addresstype);
    return kindName(KIND[p.category ?? ''] ?? p.addresstype ?? p.type ?? 'place');
  }
  async function nominatim(url: string) {
    const wait = lastSearch + 1100 - Date.now(); // usage policy: at most one request per second
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearch = Date.now();
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Place[];
  }
  /** Point + radius around an address or a point place (default 1 km: about one satellite pixel around it). */
  function usePoint(p: Place, label: string) {
    const km = 1;
    ptInput('lat').value = Number(p.lat).toFixed(5);
    ptInput('lon').value = Number(p.lon).toFixed(5);
    ptInput('km').value = String(km);
    regionSel.value = '';
    resultsEl.hidden = true;
    useArea({ kind: 'circle', lat: Number(p.lat), lon: Number(p.lon), km });
    areaP.textContent = t('cal.usePoint', { label, area: areaP.textContent ?? '', btn: t('cal.pt.btn') });
  }
  async function usePlace(p: Place) {
    if (p.addresstype === 'continent' || p.type === 'continent') {
      const code = CONTINENT_NAMES[p.display_name.split(',')[0].trim().toLowerCase()];
      if (code) return pickRegion(`c:${code}`);
    }
    const label = placeLabel(p).split(', ').slice(0, 3).join(', ');
    // Areas (relations, closed ways): fetch the outline, simplified in proportion to the size of the place,
    // so that small places keep their real shape and countries stay light.
    if (p.osm_type && p.osm_type !== 'node' && p.osm_id) {
      const [s, n, w, e] = (p.boundingbox ?? []).map(Number);
      const span = Math.max(Math.abs(n - s) || 0, Math.abs(e - w) || 0);
      const tol = Math.min(0.01, Math.max(0.0002, span / 4000));
      resultsEl.hidden = false;
      resultsEl.textContent = t('cal.outline.loading');
      try {
        const [d] = await nominatim(
          `https://nominatim.openstreetmap.org/lookup?format=jsonv2&polygon_geojson=1&polygon_threshold=${tol}&osm_ids=${p.osm_type[0].toUpperCase()}${p.osm_id}`,
        );
        const g = d?.geojson;
        const a = g && /Polygon$/.test(g.type) ? cellsFromGeoJson(g, label) : undefined;
        if (a) {
          resetPoint();
          regionSel.value = '';
          resultsEl.hidden = true;
          cellSpec = `osm:${p.osm_type[0].toUpperCase()}${p.osm_id}`;
          return useArea(a);
        }
      } catch (err) {
        resultsEl.textContent = t('cal.outline.error', { msg: (err as Error).message });
        return;
      }
    }
    usePoint(p, label);
  }
  $<HTMLFormElement>('.cal-search').onsubmit = (e) => {
    e.preventDefault();
    void search(String(new FormData(e.target as HTMLFormElement).get('q') ?? '').trim());
  };
  /** featureType: Nominatim filter (country, state, city, settlement). */
  async function search(q: string, featureType?: string) {
    if (!q) return;
    // Continents are points in OpenStreetMap: use the continent cells instead.
    const cont = CONTINENT_NAMES[q.trim().toLowerCase()];
    if (cont) return pickRegion(`c:${cont}`);
    resultsEl.hidden = false;
    resultsEl.textContent = t('cal.searching');
    try {
      const ft = featureType ? `&featureType=${featureType}` : '';
      const found = await nominatim(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=${lang}${ft}&q=${encodeURIComponent(q)}`,
      );
      // The same street is often several OpenStreetMap ways: keep one result per label.
      const seen = new Set<string>();
      places = found.filter((p) => {
        const k = `${placeKind(p)}|${placeLabel(p)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 6);
      if (!places.length) {
        resultsEl.textContent = t('cal.noPlace');
        return;
      }
      if (places.length === 1) return usePlace(places[0]);
      resultsEl.innerHTML = places
        .map((p, i) => `<button type="button" data-p="${i}"><b>${esc(placeKind(p))}</b> ${esc(placeLabel(p))}</button>`)
        .join('');
    } catch (err) {
      resultsEl.textContent = t('cal.searchFailed', { msg: (err as Error).message });
    }
  }
  resultsEl.addEventListener('click', (e) => {
    const i = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.p;
    if (i !== undefined) void usePlace(places[Number(i)]);
  });

  // ---- continents (Natural Earth, public/continents.json) and the 14 GFED basis regions (public/regions_gfed.json),
  // both on 1 degree cells; select values "c:<code>" and "g:<code>".
  const sets: Record<'c' | 'g', GfedRegions | undefined> = { c: undefined, g: undefined };
  /** Region names come from the JSON files in English: use the dictionary when it has the code. */
  const regionName = (k: 'c' | 'g', g: { code: string; name: string }) => tOr(`cal.${k === 'c' ? 'continent' : 'gfed'}.${g.code}`, g.name);
  const loadSet = (k: 'c' | 'g', file: string, label: string, suffix: (code: string) => string) =>
    fetch(`${import.meta.env.BASE_URL}${file}`)
      .then((r) => (r.ok ? (r.json() as Promise<GfedRegions>) : undefined))
      .then((j) => {
        sets[k] = j;
        if (!j) return;
        const grp = document.createElement('optgroup');
        grp.label = label;
        for (const g of j.regions) {
          g.name = regionName(k, g);
          grp.appendChild(new Option(`${g.name}${suffix(g.code)}`, `${k}:${g.code}`));
        }
        regionSel.appendChild(grp);
      })
      .catch(() => undefined);
  const setsReady = loadSet('c', 'continents.json', t('cal.region.continents'), () => '').then(() =>
    loadSet('g', 'regions_gfed.json', t('cal.region.gfed'), (c) => ` (${c})`),
  );
  regionSel.onchange = () => void pickRegion(regionSel.value);
  /** value: "c:EU" (continent), "g:EURO" (GFED region) or a bare GFED code. */
  async function pickRegion(value: string) {
    await setsReady;
    const [k, code] = value.includes(':') ? (value.split(':') as ['c' | 'g', string]) : (['g', value] as const);
    const g = sets[k]?.regions.find((x) => x.code === code);
    if (!g) return;
    regionSel.value = `${k}:${code}`;
    const label = k === 'c' ? t('cal.regionLabel.continent', { name: g.name }) : t('cal.regionLabel.gfed', { name: g.name, code: g.code });
    const a: CellArea = { kind: 'cells', res: 1, ids: g.ids, bbox: g.bbox, label };
    resultsEl.hidden = true;
    resetPoint();
    cellSpec = `region:${k}:${code}`;
    useArea(a);
  }
  $<HTMLFormElement>('.cal-pt').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const a: Area = { kind: 'circle', lat: Number(f.get('lat')), lon: Number(f.get('lon')), km: Number(f.get('km')) || 25 };
    regionSel.value = '';
    resultsEl.hidden = true;
    useArea(a);
  };
  function refreshHarmControls() {
    const h = isHarm();
    $<HTMLParagraphElement>('.cal-raw').hidden = h; // the warning is about raw counts only
    if (h) varSel.value = 'n';
    varSel.disabled = h;
    typesSel.disabled = h; // the static-source mask is already applied in the harmonized series
    typesSel.title = h ? t('cal.types.harm') : '';
    const pts = $<HTMLButtonElement>('[data-a=csvpts]');
    pts.disabled = h;
    pts.title = h ? t('cal.csvPts.harm') : '';
  }
  refreshHarmControls();
  fillPeriodSelects();
  /** Restore an area from a shareable link (see areaSpec). */
  async function applyAreaSpec(spec: string) {
    const [kind, ...rest] = spec.split(':');
    const val = rest.join(':');
    const nums = val.split(',').map(Number);
    if (kind === 'box' && nums.length === 4 && nums.every(Number.isFinite)) {
      useArea({ kind: 'bbox', west: nums[0], south: nums[1], east: nums[2], north: nums[3] });
    } else if (kind === 'pt' && nums.length === 3 && nums.every(Number.isFinite)) {
      ptInput('lat').value = String(nums[0]);
      ptInput('lon').value = String(nums[1]);
      ptInput('km').value = String(nums[2]);
      useArea({ kind: 'circle', lat: nums[0], lon: nums[1], km: nums[2] });
    } else if (kind === 'region') {
      await pickRegion(val);
    } else if (kind === 'osm' && /^[NWR]\d+$/.test(val)) {
      resultsEl.hidden = false;
      resultsEl.textContent = t('cal.outline.loading');
      try {
        const [p] = await nominatim(`https://nominatim.openstreetmap.org/lookup?format=jsonv2&accept-language=${lang}&osm_ids=${val}`);
        if (p) await usePlace(p);
        else resultsEl.textContent = t('cal.noPlace');
      } catch (err) {
        resultsEl.textContent = t('cal.outline.error', { msg: (err as Error).message });
      }
    }
  }

  sensorSel.onchange = () => {
    refreshHarmControls();
    fillPeriodSelects();
    applyPeriod();
    void load();
    panel.onChange?.();
  };
  typesSel.onchange = () => {
    void load();
    panel.onChange?.();
  };
  fySel.onchange = fmSel.onchange = () => readPeriod('from');
  tySel.onchange = tmSel.onchange = () => readPeriod('to');
  varSel.onchange = () => {
    draw();
    panel.onChange?.();
  };
  modeSel.onchange = () => {
    draw();
    panel.onChange?.();
  };

  const panel = {
    /** Called when the area or the calendar options change (the app updates the shareable link). */
    onChange: undefined as (() => void) | undefined,
    /** Calendar state for a shareable link. */
    get state() {
      return {
        area: areaSpec,
        sensor: sensorSel.value,
        variable: varSel.value,
        colour: modeSel.value,
        open: !el.hidden,
        from: effFrom() !== firstKey() ? effFrom() : undefined,
        to: effTo() !== lastKey() ? effTo() : undefined,
        src: typesSel.value,
      };
    },
    /** Restore the calendar from a shareable link. */
    async applyState(s: { area?: string; sensor?: string; variable?: string; colour?: string; from?: string; to?: string; src?: string }) {
      panel.toggle(true);
      if (s.sensor && sensors.includes(s.sensor)) {
        sensorSel.value = s.sensor;
        refreshHarmControls();
        fillPeriodSelects();
      }
      const ym = (v?: string) => (v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : '');
      fromKey = ym(s.from);
      toKey = ym(s.to);
      if (fromKey && toKey && fromKey > toKey) [fromKey, toKey] = [toKey, fromKey];
      showPeriod();
      applyPeriod();
      if (s.src && s.src in TYPES) typesSel.value = s.src;
      if (s.variable && [...varSel.options].some((x) => x.value === s.variable) && !varSel.disabled) varSel.value = s.variable;
      if (s.colour && [...modeSel.options].some((x) => x.value === s.colour)) modeSel.value = s.colour;
      if (s.area) await applyAreaSpec(s.area);
      else void load();
    },
    /** Set by the app: export an element (the calendar with its legend) as PNG. */
    onExportPng: undefined as ((el: HTMLElement) => Promise<void>) | undefined,
    /** Open the calendar on a place by name (e.g. a country chosen in the table). */
    searchPlace(name: string, featureType?: string) {
      panel.toggle(true);
      $<HTMLInputElement>('.cal-search [name=q]').value = name;
      void search(name, featureType);
    },
    /** Open the calendar on a GFED region by code. */
    pickRegion(code: string) {
      panel.toggle(true);
      void pickRegion(code);
    },
    toggle(on?: boolean) {
      el.hidden = on === undefined ? !el.hidden : !on;
      if (el.hidden) picker.cancel();
      panel.onChange?.();
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
