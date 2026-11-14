import { createChartPanel } from './chart';
import type { QueryErrorKind, QueryResult, Row } from './engine';
import { createGrid, type GridOptions } from './grid';
import { h, saveBlob, stamp, toCsv } from './util';
import { buildXlsx } from './xlsx';

const TEXT = {
  table: 'Table',
  chart: 'Chart',
  view: 'Result view',
  columns: 'Columns',
  columnsTitle: 'Show, hide and reset columns. Drag headers to reorder, Shift-click to sort by several columns.',
  reset: 'Reset layout',
  csv: 'CSV',
  csvTitle: 'Download the rows left by the filters as CSV',
  xlsx: 'XLSX',
  xlsxTitle: 'Download the rows left by the filters as an Excel file',
  sql: 'SQL',
  cancel: 'Cancel',
  loading: 'Running query...',
  rows: '{n} rows',
  rowsOf: '{a} of {b} rows',
  rowsCap: 'first {n} rows (cap reached)',
  matching: '{n} rows match, only the first {c} are loaded',
  time: '{ms} ms',
  syntax: 'Syntax error: {m}',
  syntaxAt: 'Syntax error (line {l}, column {c}): {m}',
  syntaxLine: 'Syntax error (line {l}): {m}',
  runtime: 'Query error: {m}',
  emptyOk: 'Query OK: 0 rows (no data matches the filters)',
  idle: 'Run a query to see rows here.',
  file: 'fire_{n}_{d}',
} as const;

export interface ResultMeta extends GridOptions {
  title: string;
  sql: string;
  /** Rows matching before the display cap, when known. */
  total?: number;
  /** The row cap used, to word the truncation notice. */
  cap: number;
}

export interface Results {
  el: HTMLElement;
  running(on: boolean): void;
  show(result: QueryResult, meta: ResultMeta): void;
  /** kind 'refused' (read-only guard) and 'input' (a filter needs fixing) show the message as given. */
  error(message: string, kind?: QueryErrorKind | 'input', at?: { line?: number; col?: number }): void;
  /** A neutral note (query cancelled). */
  info(message: string): void;
  resize(): void;
}

const n = (v: number) => v.toLocaleString('en');

export function createResults(o: { onGlobe: (row: Row) => void; onCancel: () => void }): Results {
  let view: 'table' | 'chart' = 'table';
  let meta: ResultMeta | undefined;
  let result: QueryResult | undefined;
  let chartDirty = false;

  const status = h('span', { class: 'ex-status', role: 'status', 'aria-live': 'polite' }, TEXT.idle);
  const tabBtn = h('button', { type: 'button', 'aria-pressed': 'true' }, TEXT.table);
  const chartBtn = h('button', { type: 'button', 'aria-pressed': 'false' }, TEXT.chart);
  const seg = h('div', { class: 'ex-seg', role: 'group', 'aria-label': TEXT.view }, tabBtn, chartBtn);
  const colList = h('div', { class: 'ex-collist' });
  const resetBtn = h('button', { type: 'button' }, TEXT.reset);
  const menu = h('details', { class: 'ex-menu' }, h('summary', { title: TEXT.columnsTitle }, TEXT.columns), h('div', { class: 'ex-menubody' }, colList, resetBtn));
  const csvBtn = h('button', { type: 'button', title: TEXT.csvTitle }, TEXT.csv);
  const xlsxBtn = h('button', { type: 'button', title: TEXT.xlsxTitle }, TEXT.xlsx);
  const cancelBtn = h('button', { type: 'button', hidden: true }, TEXT.cancel);
  const bar = h('div', { class: 'ex-bar ex-rbar' }, seg, status, menu, csvBtn, xlsxBtn, cancelBtn);
  const msgBox = h('div', { class: 'ex-msgbox', hidden: true });
  const sqlText = h('pre', { class: 'ex-sqlshow' });
  const sqlBox = h('details', { class: 'ex-sqlbox', hidden: true }, h('summary', {}, TEXT.sql), sqlText);
  const gridHost = h('div', { class: 'ex-grid' });
  const chart = createChartPanel();
  chart.el.hidden = true;
  const body = h('div', { class: 'ex-rbody' }, gridHost, chart.el);
  const el = h('section', { class: 'ex-results' }, bar, msgBox, sqlBox, body);

  const grid = createGrid(gridHost, () => refresh());

  /** A new element each time, so that assistive technology announces the alert or status reliably. */
  function say(kind: 'error' | 'info', text: string) {
    msgBox.replaceChildren(
      kind === 'error'
        ? h('p', { class: 'ex-msg ex-msg-error', role: 'alert' }, h('span', { class: 'ex-msg-icon', 'aria-hidden': 'true' }, '!'), text)
        : h('p', { class: 'ex-msg ex-msg-info', role: 'status' }, h('span', { class: 'ex-msg-icon', 'aria-hidden': 'true' }, 'i'), text),
    );
    msgBox.hidden = false;
    body.hidden = true;
  }
  function clearMessage() {
    msgBox.replaceChildren();
    msgBox.hidden = true;
    body.hidden = false;
  }

  function refresh() {
    const c = grid.counts();
    colList.replaceChildren(
      ...grid.columns().map((col) => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = col.visible;
        cb.addEventListener('change', () => grid.setVisible(col.name, cb.checked));
        return h('label', { class: 'ex-check' }, cb, col.name);
      }),
    );
    if (!result || !meta) return;
    const parts = [c.shown === c.total ? TEXT.rows.replace('{n}', n(c.total)) : TEXT.rowsOf.replace('{a}', n(c.shown)).replace('{b}', n(c.total))];
    if (meta.total !== undefined && meta.total > c.total) parts.push(TEXT.matching.replace('{n}', n(meta.total)).replace('{c}', n(c.total)));
    else if (result.truncated) parts.push(TEXT.rowsCap.replace('{n}', n(meta.cap)));
    parts.push(TEXT.time.replace('{ms}', n(Math.round(result.ms))));
    status.textContent = parts.join(' · ');
  }

  function setView(v: 'table' | 'chart') {
    view = v;
    tabBtn.setAttribute('aria-pressed', String(v === 'table'));
    chartBtn.setAttribute('aria-pressed', String(v === 'chart'));
    gridHost.hidden = v !== 'table';
    chart.el.hidden = v !== 'chart';
    for (const b of [menu, csvBtn, xlsxBtn]) b.hidden = v !== 'table';
    if (v === 'chart') {
      if (chartDirty) chart.setResult(result);
      chartDirty = false;
      chart.resize();
    } else grid.redraw();
  }

  const fileName = (ext: string) => `${TEXT.file.replace('{n}', (meta?.title ?? 'data').replace(/[^a-z0-9]+/gi, '_').toLowerCase()).replace('{d}', stamp())}.${ext}`;
  csvBtn.onclick = () => {
    const d = grid.exportData();
    saveBlob(new Blob([toCsv(d.head, d.rows)], { type: 'text/csv' }), fileName('csv'));
  };
  xlsxBtn.onclick = () => {
    const d = grid.exportData();
    saveBlob(buildXlsx(meta?.title ?? 'Data', d.head, d.rows), fileName('xlsx'));
  };
  resetBtn.onclick = () => grid.resetLayout();
  tabBtn.onclick = () => setView('table');
  chartBtn.onclick = () => setView('chart');
  cancelBtn.onclick = o.onCancel;
  /** Fit the column chooser in the viewport: limit its height to the room available and open upward when there is more above. */
  const menuBody = menu.querySelector<HTMLElement>('.ex-menubody')!;
  const fitMenu = () => {
    if (!menu.open) return;
    const r = menu.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 180 && above > below;
    menuBody.classList.toggle('ex-up', up);
    menuBody.style.boxSizing = 'border-box'; // the limit includes padding and border
    menuBody.style.maxHeight = `${Math.max(120, Math.floor(up ? above : below))}px`;
  };
  menu.addEventListener('toggle', fitMenu);
  window.addEventListener('resize', fitMenu);
  window.addEventListener('scroll', fitMenu, true);
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });

  return {
    el,
    running(on) {
      cancelBtn.hidden = !on;
      if (on) {
        status.textContent = TEXT.loading;
        clearMessage();
      }
    },
    show(r, m) {
      result = r;
      meta = m;
      sqlText.textContent = m.sql.replaceAll('{data}/', 'data/');
      sqlBox.hidden = false;
      grid.load(r, m);
      chartDirty = true;
      refresh();
      setView(view);
      if (r.rows.length === 0) say('info', TEXT.emptyOk);
      else clearMessage();
    },
    error(message, kind = 'runtime', at = {}) {
      status.textContent = '';
      const text =
        kind === 'syntax'
          ? (at.line !== undefined && at.col !== undefined ? TEXT.syntaxAt.replace('{l}', String(at.line)).replace('{c}', String(at.col)) : at.line !== undefined ? TEXT.syntaxLine.replace('{l}', String(at.line)) : TEXT.syntax).replace('{m}', message)
          : kind === 'runtime'
            ? TEXT.runtime.replace('{m}', message)
            : message;
      say('error', text);
    },
    info(message) {
      status.textContent = '';
      say('info', message);
    },
    resize() {
      if (view === 'table') grid.redraw();
      else chart.resize();
    },
  };
}
