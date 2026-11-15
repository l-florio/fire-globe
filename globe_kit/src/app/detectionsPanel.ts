import * as Cesium from 'cesium';
import type { DetectionRecord } from './detail';
import { flightSeconds } from '../globe/a11y';
import { fmtFixed, fmtInt, t, tn } from './i18n';

const TEXT = {
  title: t('det.title'),
  close: t('det.close'),
  csv: t('det.csv'),
  csvTitle: t('det.csvTitle'),
  empty: t('det.empty'),
  shown: (n: number, total: number) => (n < total ? t('det.strongestOf', { n: fmtInt(n), total: fmtInt(total) }) : tn('det.count', total)),
  shownOf: (n: number, m: number) => t('det.shownOf', { n: fmtInt(n), m: fmtInt(m) }),
  clear: t('det.clear'),
  sortBy: (c: string) => t('det.sortBy', { col: c }),
  filterBy: (c: string) => t('det.filterBy', { col: c }),
  min: t('det.min'),
  max: t('det.max'),
  noMatch: t('det.noMatch'),
  hint: t('a11yb.det.hint'),
  cols: [t('det.col.date'), t('det.col.utc'), t('det.col.type'), t('det.col.sat'), t('det.col.frp'), t('det.col.conf'), t('det.col.pass'), t('det.col.pos')],
  day: t('det.day'),
  night: t('det.night'),
  kind: { vegetation: t('det.kind.vegetation'), volcano: t('det.kind.volcano'), industrial: t('det.kind.industrial'), offshore: t('det.kind.offshore') },
  conf: { low: t('det.conf.low'), nominal: t('det.conf.nominal'), high: t('det.conf.high') },
};

export interface DetectionsPanelOptions {
  viewer: Cesium.Viewer;
  list: (limit?: number) => { rows: DetectionRecord[]; total: number };
  highlight: (r: DetectionRecord | undefined) => void;
}

const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;
const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const str = (a: string, b: string) => a.localeCompare(b);
const CONF_ORDER = { low: 0, nominal: 1, high: 2 } as const;

interface Col {
  label: string;
  /** Text shown in the cell (also what the contains filter matches). */
  text: (d: DetectionRecord) => string;
  cmp: (a: DetectionRecord, b: DetectionRecord) => number;
  /** Present on numeric columns: min/max filter instead of contains. */
  num?: (d: DetectionRecord) => number;
}

/** Popup listing the single detections loaded for the current view, linked to the globe by hover and click. Sortable and filterable (plain DOM). */
export function createDetectionsPanel(o: DetectionsPanelOptions) {
  const dateTime = (a: DetectionRecord, b: DetectionRecord) => str(a.date, b.date) || a.hourUtc - b.hourUtc;
  const COLS: Col[] = [
    { label: TEXT.cols[0], text: (d) => d.date, cmp: dateTime },
    { label: TEXT.cols[1], text: (d) => hhmm(d.hourUtc), cmp: dateTime },
    { label: TEXT.cols[2], text: (d) => TEXT.kind[d.kind], cmp: (a, b) => str(TEXT.kind[a.kind], TEXT.kind[b.kind]) },
    { label: TEXT.cols[3], text: (d) => d.satellite, cmp: (a, b) => str(a.satellite, b.satellite) },
    { label: TEXT.cols[4], text: (d) => fmtFixed(d.frp, 1), cmp: (a, b) => a.frp - b.frp, num: (d) => d.frp },
    { label: TEXT.cols[5], text: (d) => TEXT.conf[d.confidence], cmp: (a, b) => CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence] },
    { label: TEXT.cols[6], text: (d) => (d.night ? TEXT.night : TEXT.day), cmp: (a, b) => Number(a.night) - Number(b.night) },
    { label: TEXT.cols[7], text: (d) => `${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}`, cmp: (a, b) => a.lat - b.lat || a.lon - b.lon },
  ];

  const el = document.createElement('aside');
  el.className = 'panel calpanel detpanel';
  el.hidden = true;
  el.setAttribute('aria-label', TEXT.title);
  const filterCell = (c: Col, i: number) =>
    c.num
      ? `<th class="det-f"><span class="det-minmax"><input type="number" step="any" data-f="${i}" data-b="min" placeholder="${TEXT.min}" aria-label="${esc(TEXT.filterBy(c.label))} (${TEXT.min})">` +
        `<input type="number" step="any" data-f="${i}" data-b="max" placeholder="${TEXT.max}" aria-label="${esc(TEXT.filterBy(c.label))} (${TEXT.max})"></span></th>`
      : `<th class="det-f"><input type="text" data-f="${i}" aria-label="${esc(TEXT.filterBy(c.label))}"></th>`;
  el.innerHTML = `
    <header class="cal-head"><h2>${TEXT.title}</h2>
      <span class="det-actions"><button type="button" data-a="csv" title="${esc(TEXT.csvTitle)}">${TEXT.csv}</button>
      <button type="button" class="cal-x" aria-label="${TEXT.close}">&times;</button></span></header>
    <p class="note det-count"></p>
    <p class="det-tools"><button type="button" data-a="clear" hidden>${TEXT.clear}</button></p>
    <div class="det-wrap"><table><thead>
      <tr>${COLS.map((c, i) => `<th aria-sort="none"><button type="button" class="det-sort" data-s="${i}" title="${esc(TEXT.sortBy(c.label))}">${c.label}<span class="det-arrow" aria-hidden="true"></span></button></th>`).join('')}</tr>
      <tr class="det-frow">${COLS.map(filterCell).join('')}</tr>
    </thead><tbody></tbody></table></div>
    <p class="note" id="det-hint">${TEXT.hint}</p>`;
  document.body.appendChild(el);
  const tbody = el.querySelector('tbody')!;
  const thead = el.querySelector('thead')!;
  const countEl = el.querySelector<HTMLParagraphElement>('.det-count')!;
  const clearBtn = el.querySelector<HTMLButtonElement>('[data-a=clear]')!;
  const csvBtn = el.querySelector<HTMLButtonElement>('[data-a=csv]')!;
  const inputs = [...el.querySelectorAll<HTMLInputElement>('input[data-f]')];
  const ths = [...el.querySelectorAll<HTMLTableCellElement>('thead tr:first-child th')];
  let all: DetectionRecord[] = [];
  let total = 0;
  let rows: DetectionRecord[] = []; // rows currently shown: filtered and sorted
  let sort: { col: number; dir: 1 | -1 } | undefined;

  function applyView() {
    const tests: ((d: DetectionRecord) => boolean)[] = [];
    for (const i of inputs) {
      const v = i.value.trim();
      if (!v) continue;
      const c = COLS[Number(i.dataset.f)];
      if (c.num) {
        const x = Number(v);
        if (Number.isNaN(x)) continue;
        tests.push(i.dataset.b === 'min' ? (d) => c.num!(d) >= x : (d) => c.num!(d) <= x);
      } else {
        const q = v.toLowerCase();
        tests.push((d) => c.text(d).toLowerCase().includes(q));
      }
    }
    rows = tests.length ? all.filter((d) => tests.every((fn) => fn(d))) : all.slice();
    if (sort) {
      const { col, dir } = sort;
      rows.sort((a, b) => dir * COLS[col].cmp(a, b));
    }
    clearBtn.hidden = !tests.length;
    ths.forEach((th, i) => {
      const on = sort?.col === i;
      th.setAttribute('aria-sort', on ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none');
      th.querySelector('.det-arrow')!.textContent = on ? (sort!.dir === 1 ? ' ▲' : ' ▼') : '';
    });
    countEl.textContent = total ? `${TEXT.shown(all.length, total)} ${TEXT.shownOf(rows.length, all.length)}` : TEXT.empty;
    tbody.innerHTML = rows.length
      ? rows.map((d, i) => `<tr data-i="${i}" tabindex="0">${COLS.map((c) => `<td>${c.text(d)}</td>`).join('')}</tr>`).join('')
      : all.length
        ? `<tr><td colspan="${COLS.length}" class="det-none">${TEXT.noMatch}</td></tr>`
        : '';
    o.highlight(undefined);
  }

  function refresh() {
    if (el.hidden) return;
    const r = o.list();
    all = r.rows;
    total = r.total;
    applyView();
  }

  // click or Enter/Space on a header button: none -> ascending -> descending -> none (FRP starts descending)
  thead.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
    if (!b) return;
    const col = Number(b.dataset.s);
    const first: 1 | -1 = COLS[col].num ? -1 : 1;
    sort = sort?.col !== col ? { col, dir: first } : sort.dir === first ? { col, dir: (-first) as 1 | -1 } : undefined;
    applyView();
  });
  thead.addEventListener('input', applyView);
  clearBtn.onclick = () => {
    for (const i of inputs) i.value = '';
    applyView();
    inputs[0]?.focus();
  };

  const rowOf = (e: Event) => rows[Number((e.target as HTMLElement).closest('tr')?.dataset.i ?? -1)];
  tbody.addEventListener('mouseover', (e) => o.highlight(rowOf(e)));
  tbody.addEventListener('focusin', (e) => o.highlight(rowOf(e)));
  tbody.addEventListener('mouseleave', () => o.highlight(undefined));
  const fly = (r: DetectionRecord | undefined) => {
    if (!r) return;
    o.highlight(r);
    o.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 25_000), duration: flightSeconds(1.2) });
  };
  tbody.addEventListener('click', (e) => fly(rowOf(e)));
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); // Space would scroll the list
    fly(rowOf(e));
  });
  el.querySelector<HTMLButtonElement>('.cal-x')!.onclick = () => panel.toggle(false);
  csvBtn.onclick = () => {
    // the rows currently shown (filtered and sorted)
    const head = 'acq_date,acq_time_utc,type,satellite,frp_mw,confidence,daynight,latitude,longitude';
    const lines = rows.map((d) =>
      [d.date, hhmm(d.hourUtc).replace(':', ''), d.kind, d.satellite, d.frp.toFixed(2), d.confidence, d.night ? 'N' : 'D', d.lat.toFixed(5), d.lon.toFixed(5)].join(','),
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head, ...lines].join('\n') + '\n'], { type: 'text/csv' }));
    a.download = 'detections_in_view.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const panel = {
    get visible() {
      return !el.hidden;
    },
    toggle(on?: boolean) {
      el.hidden = on === undefined ? !el.hidden : !on;
      if (el.hidden) o.highlight(undefined);
      else refresh();
      return !el.hidden;
    },
    /** New data or filters: rebuild the list if open. */
    refresh,
  };
  return panel;
}
