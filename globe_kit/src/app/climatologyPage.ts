import { Chart, registerables, type ChartConfiguration, type Plugin } from 'chart.js';
import { loadClimatology, matchCountry, regionKey, type BandPoint, type Climatology, type Region } from './climatologyData';
import { saveBlob, toCsv } from './explorer/util';
import { applyI18n, fmtInt, locale, monthsShort, t, tOr } from './i18n';
import { mountAppBar } from './appBar';
import { aboutHref } from './nav';
import { readShare, writeShare } from './share';
import './tablePage.css';
import './climatologyPage.css';

Chart.register(...registerables);

// Climatology page: typical range (5-95%) of the 7-day total of fire detections for each day of the year, from the
// years 2012-2025, with the current year over it. Descriptive, not a forecast. No Cesium.
mountAppBar({ current: 'climatology', timeKey: () => state.t.slice(0, 7) });
applyI18n();
document.title = t('clim.title');

const DAY = 864e5;
const INCOMPLETE_DAYS = 2; // the last days of the NRT file are still filling in
const DEFAULT_AREA = 'region:c:EU';
const INK = '#c8d2e0';
const GRID = 'rgba(255,255,255,0.09)';
const COL_BAND = 'rgba(86,180,233,0.28)';
const COL_MEDIAN = '#9fb4cc';
const COL_CUR = '#ff8a3d';
const COL_CUR_LIGHT = 'rgba(255,138,61,0.55)';

const parse = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Day of the year on the leap reference calendar of the band (Feb 29 = 60, Mar 1 = 61). */
const refDoy = (ms: number) => {
  const d = new Date(ms);
  return Math.round((Date.UTC(2000, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2000, 0, 1)) / DAY) + 1;
};
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH_STARTS = Array.from({ length: 12 }, (_, m) => refDoy(Date.UTC(2000, m, 1)));
const num = (v: number) => fmtInt(v);

// ------------------------------------------------------------------ layout
const main = document.getElementById('clim-main')!;
main.innerHTML = `
  <h1>${t('clim.h1')}</h1>
  <p class="clim-badge" role="note">${t('clim.badge')}</p>
  <div class="clim-controls">
    <label>${t('clim.filter.label')}<input type="search" id="clim-filter" placeholder="${t('clim.filter.placeholder')}" autocomplete="off" /></label>
    <label>${t('clim.area.label')}<select id="clim-area"></select></label>
    <label>${t('clim.date.label')}<input type="date" id="clim-date" /></label>
    <span class="clim-hint" id="clim-datehint"></span>
  </div>
  <p class="clim-status" id="clim-status" role="status" aria-live="polite">${t('clim.loading')}</p>
  <div id="clim-body" hidden>
    <p class="clim-sumtitle" id="clim-sumtitle"></p>
    <dl class="clim-cards" id="clim-cards"></dl>
    <p class="clim-next" id="clim-next"></p>
    <p class="clim-prov" id="clim-prov"></p>
    <div class="clim-chartbox"><canvas id="clim-canvas" role="img" aria-label="${t('clim.chart.aria')}"></canvas></div>
    <details class="clim-data">
      <summary>${t('a11yb.clim.table.toggle')}</summary>
      <div class="clim-tabwrap"><table id="clim-table"></table></div>
    </details>
    <div class="clim-actions">
      <button type="button" id="clim-png" title="${t('clim.png.title')}">${t('clim.png')}</button>
      <button type="button" id="clim-csv" title="${t('clim.csv.title')}">${t('clim.csv')}</button>
    </div>
  </div>
  <section class="clim-method" aria-labelledby="clim-mh">
    <h2 id="clim-mh">${t('clim.method.title')}</h2>
    <p>${t('clim.method.1')}</p>
    <p>${t('clim.method.2')}</p>
    <p>${t('clim.method.3')}</p>
    <p><span id="clim-credit"></span> <a href="${aboutHref()}" target="_blank" rel="noopener">${t('about.link')}</a></p>
  </section>`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const filterIn = $<HTMLInputElement>('clim-filter');
const areaSel = $<HTMLSelectElement>('clim-area');
const dateIn = $<HTMLInputElement>('clim-date');
const statusEl = $('clim-status');
const bodyEl = $('clim-body');
const canvas = $<HTMLCanvasElement>('clim-canvas');
const tableEl = $<HTMLTableElement>('clim-table');

// ------------------------------------------------------------------ state
const state: { area: string; t: string } = { area: DEFAULT_AREA, t: '' };
let clim: Climatology;
let last = 0; // ms of the last date of the current-year file
let lastComplete = 0;
let firstT = 0;
let year = new Date().getUTCFullYear();
let region: Region | undefined;
let chart: Chart | undefined;

interface Series {
  band: (BandPoint | undefined)[];
  cur: (number | null)[];
  prov: boolean[];
  inc: boolean[];
}
let series: Series | undefined;
const mk = { idx: -1, idxEnd: -1 };

// ------------------------------------------------------------------ area list
const labelOf = (r: Region) =>
  r.type === 'continent' ? tOr(`cal.continent.${r.id}`, r.id) : r.type === 'gfed' ? `${tOr(`cal.gfed.${r.id}`, r.id)} (${r.id})` : r.id;
const specOf = (r: Region) => (r.type === 'continent' ? `region:c:${r.id}` : r.type === 'gfed' ? `region:g:${r.id}` : `country:${r.id}`);

function regionFromSpec(spec: string): Region | undefined {
  const m = /^region:([cg]):(.+)$/.exec(spec);
  if (m) {
    const type = m[1] === 'c' ? 'continent' : 'gfed';
    return clim.regions.find((r) => r.type === type && r.id.toLowerCase() === m[2].toLowerCase());
  }
  if (spec.startsWith('country:')) return matchCountry(spec.slice(8), clim.regions);
  return undefined;
}

function fillAreas() {
  const q = filterIn.value.trim().toLowerCase();
  areaSel.textContent = '';
  const groups: [string, Region['type']][] = [
    [t('clim.group.continents'), 'continent'],
    [t('clim.group.gfed'), 'gfed'],
    [t('clim.group.countries'), 'country'],
  ];
  let shown = 0;
  for (const [label, type] of groups) {
    const items = clim.regions
      .filter((r) => r.type === type)
      .map((r) => ({ r, l: labelOf(r) }))
      .filter((x) => !q || x.l.toLowerCase().includes(q) || x.r.id.toLowerCase().includes(q))
      .sort((a, b) => a.l.localeCompare(b.l, locale));
    if (!items.length) continue;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const x of items) g.append(new Option(x.l, specOf(x.r)));
    areaSel.append(g);
    shown += items.length;
  }
  if (!shown) {
    const o = new Option(t('clim.noMatch'), '');
    o.disabled = true;
    areaSel.append(o);
  }
  areaSel.value = region ? specOf(region) : '';
  if (!region) areaSel.selectedIndex = -1;
}

// ------------------------------------------------------------------ series and summary
function buildSeries(r: Region): Series | undefined {
  const band = clim.band(r);
  if (!band) return undefined;
  const counts = clim.current(r);
  const cur: (number | null)[] = new Array(366).fill(null);
  const prov: boolean[] = new Array(366).fill(false);
  const inc: boolean[] = new Array(366).fill(false);
  const start = Date.UTC(year, 0, 7);
  for (let d = start; d <= last; d += DAY) {
    let sum = 0;
    let p = false;
    for (let k = 0; k < 7; k++) {
      const c = counts.get(iso(d - k * DAY));
      if (c) {
        sum += c.n;
        p ||= c.prov;
      }
    }
    const i = refDoy(d) - 1;
    cur[i] = sum;
    prov[i] = p;
    inc[i] = d > lastComplete;
  }
  return { band, cur, prov, inc };
}

const regionName = () => (region ? labelOf(region) : '');

function renderSummary() {
  if (!series || !region) return;
  const tm = parse(state.t);
  const i = refDoy(tm) - 1;
  const b = series.band[i];
  const c = series.cur[i];
  $('clim-sumtitle').textContent = `${regionName()} - ${t('clim.sum.title', { date: fmtDate(tm) })}`;
  const cards: string[] = [];
  const card = (dt: string, dd: string, small = '') => cards.push(`<div class="clim-card"><dt>${dt}</dt><dd>${dd}${small ? `<small>${small}</small>` : ''}</dd></div>`);
  if (c === null || !b) {
    $('clim-cards').innerHTML = `<div class="clim-card"><dd>${t('clim.sum.none')}</dd></div>`;
    $('clim-prov').textContent = '';
  } else {
    const pos = c < b.q05 ? 'below' : c > b.q95 ? 'above' : 'within';
    card(t('clim.sum.current'), num(c));
    card(t('clim.sum.typical'), num(b.q50), t('clim.sum.typicalRange', { lo: num(b.q05), hi: num(b.q95) }));
    card(t('clim.sum.position'), t(`clim.pos.${pos}` as 'clim.pos.below'));
    card(t('clim.sum.pct'), b.q50 > 0 ? `${fmtInt((c / b.q50) * 100)}%` : t('clim.sum.pct.na'));
    $('clim-cards').innerHTML = cards.join('');
    $('clim-prov').textContent = series.prov[i] ? t('clim.sum.prov') : '';
  }
  // text alternative of the chart: the same facts as the cards, in one sentence
  const sum =
    c === null || !b
      ? t('a11yb.clim.summary.none', { area: regionName(), date: fmtDate(tm) })
      : t('a11yb.clim.summary', {
          area: regionName(),
          date: fmtDate(tm),
          cur: num(c),
          med: num(b.q50),
          lo: num(b.q05),
          hi: num(b.q95),
          pos: t(`clim.pos.${c < b.q05 ? 'below' : c > b.q95 ? 'above' : 'within'}` as 'clim.pos.below'),
        });
  canvas.setAttribute('aria-label', `${t('clim.chart.aria')} ${sum}`);
  const n7 = series.band[refDoy(tm + 7 * DAY) - 1];
  $('clim-next').textContent = n7
    ? t('clim.sum.next', { from: fmtDay(tm + DAY), to: fmtDay(tm + 7 * DAY), q50: num(n7.q50), q05: num(n7.q05), q95: num(n7.q95) })
    : '';
  mk.idx = i;
  mk.idxEnd = refDoy(tm + 7 * DAY) - 1;
}

/** The plotted series as a table (1st and 15th of each month): the text alternative of the chart. */
function renderTable() {
  if (!series) return;
  const s = series;
  const th = (x: string, scope = 'col') => `<th scope="${scope}">${x}</th>`;
  const rows: string[] = [];
  for (let m = 0; m < 12; m++) {
    for (const d of [1, 15]) {
      const ms = Date.UTC(2000, m, d);
      const i = refDoy(ms) - 1;
      const b = s.band[i];
      const c = s.cur[i];
      const cell = (v: number | null | undefined) => `<td>${v === null || v === undefined ? '-' : num(v)}</td>`;
      rows.push(`<tr>${th(fmtDay(ms), 'row')}${cell(c)}${cell(b?.q50)}${cell(b?.q05)}${cell(b?.q95)}</tr>`);
    }
  }
  tableEl.innerHTML =
    `<caption>${t('a11yb.clim.table.caption')}</caption><thead><tr>${th(t('a11yb.clim.col.date'))}${th(`${t('clim.sum.current')} ${year}`)}` +
    `${th(t('clim.sum.typical'))}${th(t('a11yb.clim.col.lo'))}${th(t('a11yb.clim.col.hi'))}</tr></thead><tbody>${rows.join('')}</tbody>`;
}

// ------------------------------------------------------------------ chart
const background: Plugin = {
  id: 'climBg',
  beforeDraw(c) {
    const { ctx, width, height } = c;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#0a0f19';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};
/** Vertical marker on the date of interest and a light shade over the next 7 days. */
const marker: Plugin = {
  id: 'climMarker',
  afterDatasetsDraw(c) {
    if (mk.idx < 0) return;
    const x = c.scales.x;
    const { top, bottom, left, right } = c.chartArea;
    const x0 = x.getPixelForValue(mk.idx);
    const x1 = Math.min(right, x.getPixelForValue(mk.idxEnd >= mk.idx ? mk.idxEnd : 365));
    const { ctx } = c;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x0, top, Math.max(0, x1 - x0), bottom - top);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, top);
    ctx.lineTo(x0, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    const text = `${t('clim.marker')}: ${fmtDay(parse(state.t))}`;
    const w = ctx.measureText(text).width;
    ctx.textAlign = x0 + w + 8 > right ? 'right' : 'left';
    ctx.fillText(text, x0 + (ctx.textAlign === 'right' ? -4 : 4), top + 12);
    if (x1 - x0 > 40) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.textAlign = 'left';
      ctx.fillText(t('clim.next7'), Math.max(left, x0 + 4), top + 26);
    }
    ctx.restore();
  },
};

function drawChart() {
  chart?.destroy();
  if (!series) return;
  const s = series;
  const small = window.innerWidth < 600;
  const labels = Array.from({ length: 366 }, (_, i) => String(i + 1));
  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'q05', data: s.band.map((b) => b?.q05 ?? null), borderWidth: 0, pointRadius: 0, backgroundColor: COL_BAND, fill: false },
        {
          label: t('clim.series.band'),
          data: s.band.map((b) => b?.q95 ?? null),
          borderWidth: 0,
          pointRadius: 0,
          backgroundColor: COL_BAND,
          fill: '-1',
        },
        { label: t('clim.series.median'), data: s.band.map((b) => b?.q50 ?? null), borderColor: COL_MEDIAN, borderWidth: 1.5, pointRadius: 0, backgroundColor: COL_MEDIAN, fill: false },
        {
          label: t('clim.series.current', { year }),
          data: s.cur,
          borderColor: COL_CUR,
          backgroundColor: COL_CUR,
          borderWidth: 2.2,
          pointRadius: 0,
          pointHoverRadius: 4,
          spanGaps: true,
          fill: false,
          segment: {
            borderDash: (ctx: { p1DataIndex: number }) => (s.inc[ctx.p1DataIndex] ? [2, 3] : s.prov[ctx.p1DataIndex] ? [6, 4] : undefined),
            borderColor: (ctx: { p1DataIndex: number }) => (s.inc[ctx.p1DataIndex] ? COL_CUR_LIGHT : COL_CUR),
          },
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: {
            color: INK,
            autoSkip: false,
            maxRotation: 0,
            font: { size: 12 },
            callback: (_v: unknown, i: number) => {
              const m = MONTH_STARTS.indexOf(i + 1);
              return m >= 0 && (!small || m % 2 === 0) ? monthsShort[m] : '';
            },
          },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          title: { display: !small, text: t('clim.axis.y'), color: INK },
          ticks: { color: INK, callback: (v: number | string) => num(Number(v)) },
          grid: { color: GRID },
        },
      },
      plugins: {
        title: { display: true, color: '#ffffff', font: { size: small ? 12 : 14 }, text: [`${regionName()}`, t('clim.badge')] },
        legend: {
          labels: { color: INK, boxWidth: 16, font: { size: 12 }, filter: (item: { text: string }) => item.text !== 'q05' },
        },
        tooltip: {
          filter: (item: { dataset: { label?: string } }) => item.dataset.label !== 'q05',
          callbacks: {
            title: (items: { dataIndex: number }[]) => (items.length ? fmtDay(Date.UTC(2000, 0, items[0].dataIndex + 1)) : ''),
            label: (item: { dataset: { label?: string }; parsed: { y: number | null } }) =>
              item.parsed.y === null ? '' : `${item.dataset.label}: ${num(item.parsed.y)}`,
          },
        },
      },
    },
    plugins: [background, marker],
  } as unknown as ChartConfiguration;
  chart = new Chart(canvas, config);
}

// ------------------------------------------------------------------ apply state
function clampT(ms: number) {
  return Math.min(lastComplete, Math.max(firstT, ms));
}

function parseT(s: string | undefined): number {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = parse(s);
    if (new Date(ms).getUTCFullYear() === year) return clampT(ms);
  }
  if (s && /^\d{4}-\d{2}$/.test(s) && Number(s.slice(0, 4)) === year) {
    const m = Number(s.slice(5, 7));
    if (m >= 1 && m <= 12) return clampT(Date.UTC(year, m, 0)); // last day of that month
  }
  return lastComplete;
}

function sync() {
  writeShare({ area: state.area === DEFAULT_AREA ? undefined : state.area, t: state.t });
}

function apply(spec: string) {
  state.area = spec;
  region = regionFromSpec(spec);
  series = region ? buildSeries(region) : undefined;
  fillAreas();
  if (!region || !series) {
    bodyEl.hidden = true;
    chart?.destroy();
    chart = undefined;
    statusEl.textContent = t('clim.noClimatology', { name: spec.replace(/^country:/, '') });
    return;
  }
  if (region) state.area = specOf(region);
  statusEl.textContent = [...clim.current(region)].length ? '' : t('clim.noCurrent');
  bodyEl.hidden = false;
  renderSummary();
  renderTable();
  drawChart();
  sync();
}

function setT(ms: number) {
  state.t = iso(clampT(ms));
  dateIn.value = state.t;
  if (series) {
    renderSummary();
    chart?.update('none');
  }
  sync();
}

// ------------------------------------------------------------------ events
areaSel.addEventListener('change', () => areaSel.value && apply(areaSel.value));
filterIn.addEventListener('input', fillAreas);
filterIn.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = areaSel.querySelector<HTMLOptionElement>('option:not(:disabled)');
  if (first?.value) apply(first.value);
});
dateIn.addEventListener('change', () => {
  if (dateIn.value) setT(parse(dateIn.value));
  else dateIn.value = state.t;
});

$('clim-png').addEventListener('click', () => canvas.toBlob((b) => b && saveBlob(b, `fire_climatology_${slug()}_${state.t}.png`), 'image/png'));
$('clim-csv').addEventListener('click', () => {
  if (!series) return;
  const s = series;
  const rows: unknown[][] = [];
  for (let i = 0; i < 366; i++) {
    const d = Date.UTC(2000, 0, i + 1);
    const leapOnly = i === 59;
    const date = leapOnly && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1 ? '' : `${year}-${iso(d).slice(5)}`;
    const b = s.band[i];
    rows.push([date, i + 1, b?.q05 ?? '', b?.q50 ?? '', b?.q95 ?? '', s.cur[i] ?? '', s.cur[i] === null ? '' : s.inc[i] ? 'incomplete' : s.prov[i] ? 'near-real-time' : 'final']);
  }
  const head = ['date', 'day_of_year_leap_ref', 'typical_q05', 'typical_median_q50', 'typical_q95', `total_7_days_${year}`, 'status'];
  saveBlob(new Blob([toCsv(head, rows)], { type: 'text/csv' }), `fire_climatology_${slug()}_${year}.csv`);
});
const slug = () => (region ? regionKey(region).replace(/[^A-Za-z0-9]+/g, '_') : 'area');

let resizeT: number | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = window.setTimeout(() => series && drawChart(), 200);
});

// ------------------------------------------------------------------ start
(async () => {
  try {
    clim = await loadClimatology(`${import.meta.env.BASE_URL}data/`);
  } catch (e) {
    statusEl.textContent = t('clim.error', { msg: (e as Error).message });
    return;
  }
  const lastStr = clim.last ?? iso(Date.now() - DAY);
  last = parse(lastStr);
  year = new Date(last).getUTCFullYear();
  lastComplete = last - INCOMPLETE_DAYS * DAY;
  firstT = Math.min(lastComplete, Date.UTC(year, 0, 7));
  dateIn.min = iso(firstT);
  dateIn.max = iso(lastComplete);
  $('clim-datehint').textContent = t('clim.date.hint', { date: fmtDate(lastComplete) });
  $('clim-credit').textContent = t('clim.method.credit', { last: fmtDate(last) });
  const st = readShare();
  state.t = iso(parseT(st.t));
  dateIn.value = state.t;
  apply(st.area || DEFAULT_AREA);
})();
