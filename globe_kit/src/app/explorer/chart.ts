import { Chart, registerables, type ChartConfiguration, type ChartDataset } from 'chart.js';
import type { QueryResult, ResultCol, Row } from './engine';
import { field, h, saveBlob, select, stamp, toCsv } from './util';

Chart.register(...registerables);

const TEXT = {
  type: 'Chart type',
  line: 'Line',
  bar: 'Bar',
  scatter: 'Scatter',
  x: 'X axis',
  y: 'Y axis',
  series: 'Series / colour',
  none: '(none)',
  png: 'PNG',
  pngTitle: 'Download the chart as an image',
  csv: 'Chart data CSV',
  csvTitle: 'Download the plotted values as CSV',
  noNumeric: 'Run a query with at least one numeric column to draw a chart.',
  capX: 'Only the first {n} x values are drawn: filter or aggregate for the rest.',
  capSeries: 'Only the {n} largest series are drawn.',
  capPoints: 'Only the first {n} points are drawn.',
  dup: 'Rows with the same x and series are summed.',
  noPoints: 'No plottable values: scatter needs a numeric or date x column.',
  empty: '(empty)',
  csvX: 'x',
  csvSeries: 'series',
  csvY: 'y',
  file: 'fire_chart_{d}',
} as const;

const MAX_X = 600;
const MAX_SERIES = 12;
const MAX_POINTS = 20_000;
const PALETTE = ['#56b4e9', '#e69f00', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#b0b8c4', '#8dd3c7', '#bebada', '#fb8072', '#80b1d3'];
const INK = '#c8d2e0';
const GRID = 'rgba(255,255,255,0.09)';
const TIME_NAMES = /^(period|date|ym|year|month|m|day)$/i;

type PlotType = 'line' | 'bar' | 'scatter';
interface Plot {
  datasets: ChartDataset[];
  labels?: string[];
  notes: string[];
  /** x, series, y for the CSV export */
  table: [string | number, string, number | null][];
}

const fill = (t: string, n: number) => t.replace('{n}', n.toLocaleString('en'));

/** Fills the canvas with the panel colour so exported PNGs are not transparent. */
const background = {
  id: 'exbg',
  beforeDraw(chart: Chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#0a0f19';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};

const text = (v: unknown) => (v === null || v === undefined || v === '' ? TEXT.empty : String(v));

function toX(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '');
  const t = Date.parse(s.length === 7 ? `${s}-01` : s);
  return Number.isNaN(t) ? parseFloat(s) : t;
}

function limitSeries(totals: Map<string, number>, notes: string[]): Set<string> {
  const keep = [...totals].sort((a, b) => b[1] - a[1]).slice(0, MAX_SERIES).map(([k]) => k);
  if (totals.size > MAX_SERIES) notes.push(fill(TEXT.capSeries, MAX_SERIES));
  return new Set(keep);
}

function categorical(rows: Row[], type: 'line' | 'bar', xc: ResultCol, y: string, s: string): Plot {
  const notes: string[] = [];
  const values = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  const xs = new Map<string, unknown>();
  let dup = false;
  for (const r of rows) {
    const yv = r[y];
    if (typeof yv !== 'number') continue;
    const sn = s ? text(r[s]) : y;
    const xk = text(r[xc.name]);
    xs.set(xk, r[xc.name]);
    const m = values.get(sn) ?? new Map<string, number>();
    values.set(sn, m);
    if (m.has(xk)) dup = true;
    m.set(xk, (m.get(xk) ?? 0) + yv);
    totals.set(sn, (totals.get(sn) ?? 0) + Math.abs(yv));
  }
  const keep = limitSeries(totals, notes);
  let labels = [...xs.keys()].sort((a, b) =>
    xc.kind === 'num' ? Number(xs.get(a)) - Number(xs.get(b)) : a.localeCompare(b, 'en', { numeric: true }),
  );
  if (labels.length > MAX_X) {
    labels = labels.slice(0, MAX_X);
    notes.push(fill(TEXT.capX, MAX_X));
  }
  if (dup) notes.push(TEXT.dup);
  const table: Plot['table'] = [];
  const datasets = [...values].filter(([k]) => keep.has(k)).map(([name, m], i) => {
    const data = labels.map((l) => m.get(l) ?? null);
    labels.forEach((l, j) => table.push([l, name, data[j]]));
    const color = PALETTE[i % PALETTE.length];
    return { label: name, data, borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: labels.length > 120 ? 0 : 2, tension: 0, spanGaps: type === 'line' } as ChartDataset;
  });
  return { datasets, labels, notes, table };
}

function scatter(rows: Row[], xc: ResultCol, y: string, s: string): Plot {
  const notes: string[] = [];
  const groups = new Map<string, { x: number; y: number }[]>();
  const totals = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const yv = r[y];
    const xv = toX(r[xc.name]);
    if (typeof yv !== 'number' || Number.isNaN(xv)) continue;
    if (n >= MAX_POINTS) {
      notes.push(fill(TEXT.capPoints, MAX_POINTS));
      break;
    }
    n++;
    const sn = s ? text(r[s]) : y;
    const g = groups.get(sn) ?? [];
    groups.set(sn, g);
    g.push({ x: xv, y: yv });
    totals.set(sn, (totals.get(sn) ?? 0) + 1);
  }
  const keep = limitSeries(totals, notes);
  if (!n) notes.push(TEXT.noPoints);
  const table: Plot['table'] = [];
  const datasets = [...groups].filter(([k]) => keep.has(k)).map(([name, pts], i) => {
    for (const p of pts) table.push([p.x, name, p.y]);
    const color = PALETTE[i % PALETTE.length];
    return { label: name, data: pts, borderColor: color, backgroundColor: color, pointRadius: 2.5, showLine: false } as ChartDataset;
  });
  return { datasets, notes, table };
}

export interface ChartPanel {
  el: HTMLElement;
  setResult(r: QueryResult | undefined): void;
  resize(): void;
}

export function createChartPanel(): ChartPanel {
  const typeSel = select([['line', TEXT.line], ['bar', TEXT.bar], ['scatter', TEXT.scatter]], 'bar', TEXT.type);
  const xSel = select([]);
  const ySel = select([]);
  const sSel = select([]);
  const note = h('p', { class: 'ex-note ex-chart-note', role: 'status' });
  const canvas = h('canvas', { role: 'img', 'aria-label': TEXT.line });
  const wrap = h('div', { class: 'ex-chart-canvas' }, canvas);
  const png = h('button', { type: 'button', title: TEXT.pngTitle }, TEXT.png);
  const csvBtn = h('button', { type: 'button', title: TEXT.csvTitle }, TEXT.csv);
  const bar = h(
    'div',
    { class: 'ex-bar' },
    field(TEXT.type, typeSel),
    field(TEXT.x, xSel),
    field(TEXT.y, ySel),
    field(TEXT.series, sSel),
    png,
    csvBtn,
  );
  const el = h('div', { class: 'ex-chart' }, bar, note, wrap);

  let result: QueryResult | undefined;
  let chart: Chart | undefined;
  let plot: Plot | undefined;

  const fillSelect = (sel: HTMLSelectElement, cols: string[], keep: string, withNone: boolean) => {
    sel.replaceChildren();
    if (withNone) sel.append(h('option', { value: '' }, TEXT.none));
    for (const c of cols) sel.append(h('option', { value: c }, c));
    sel.value = cols.includes(keep) ? keep : withNone ? '' : (cols[0] ?? '');
  };

  function defaults(cols: ResultCol[]) {
    const names = cols.map((c) => c.name);
    const nums = cols.filter((c) => c.kind === 'num').map((c) => c.name);
    const x = cols.find((c) => TIME_NAMES.test(c.name))?.name ?? cols.find((c) => c.kind !== 'num')?.name ?? names[0];
    const y = nums.find((n) => n !== x) ?? nums[0] ?? '';
    return { x, y, type: TIME_NAMES.test(x) ? 'line' : 'bar' };
  }

  function draw() {
    chart?.destroy();
    chart = undefined;
    plot = undefined;
    note.textContent = '';
    if (!result) return;
    const xc = result.cols.find((c) => c.name === xSel.value);
    if (!xc || !ySel.value) {
      note.textContent = TEXT.noNumeric;
      return;
    }
    const type = typeSel.value as PlotType;
    plot = type === 'scatter' ? scatter(result.rows, xc, ySel.value, sSel.value) : categorical(result.rows, type, xc, ySel.value, sSel.value);
    note.textContent = plot.notes.join(' ');
    canvas.setAttribute('aria-label', `${typeSel.selectedOptions[0].textContent}: ${ySel.value} by ${xSel.value}`);
    const axis = (title: string) => ({
      title: { display: true, text: title, color: INK },
      ticks: { color: INK, maxTicksLimit: 12 },
      grid: { color: GRID },
      border: { color: GRID },
    });
    const config = {
      type,
      data: { labels: plot.labels, datasets: plot.datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: type === 'scatter' ? 'nearest' : 'index', intersect: false },
        scales: { x: { type: type === 'scatter' ? 'linear' : 'category', ...axis(xSel.value) }, y: axis(ySel.value) },
        plugins: { legend: { display: plot.datasets.length > 1, labels: { color: INK } } },
      },
      plugins: [background],
    } as unknown as ChartConfiguration;
    chart = new Chart(canvas, config);
  }

  png.onclick = () => canvas.toBlob((b) => b && saveBlob(b, `${TEXT.file.replace('{d}', stamp())}.png`), 'image/png');
  csvBtn.onclick = () => {
    if (!plot) return;
    const rows = plot.table.map(([x, s, y]) => [x, s, y]);
    saveBlob(new Blob([toCsv([xSel.value || TEXT.csvX, sSel.value || TEXT.csvSeries, ySel.value || TEXT.csvY], rows)], { type: 'text/csv' }), `${TEXT.file.replace('{d}', stamp())}.csv`);
  };
  for (const s of [typeSel, xSel, ySel, sSel]) s.addEventListener('change', draw);

  return {
    el,
    setResult(r) {
      result = r;
      if (!r) return draw();
      const names = r.cols.map((c) => c.name);
      const nums = r.cols.filter((c) => c.kind === 'num').map((c) => c.name);
      const keep = xSel.value && names.includes(xSel.value) && ySel.value && nums.includes(ySel.value);
      const d = defaults(r.cols);
      if (!keep) typeSel.value = d.type;
      fillSelect(xSel, names, keep ? xSel.value : d.x, false);
      fillSelect(ySel, nums, keep ? ySel.value : d.y, false);
      fillSelect(sSel, names, keep ? sSel.value : '', true);
      draw();
    },
    resize() {
      chart?.resize();
    },
  };
}
