import { TabulatorFull as Tabulator } from 'tabulator-tables';
import type { CellComponent, ColumnDefinition } from 'tabulator-tables';
import 'tabulator-tables/dist/css/tabulator.min.css';
import type { QueryResult, ResultCol, Row } from './engine';
import { h, readJson, writeJson } from './util';
import { locale, t } from '../i18n';
import { SIGNAL } from './datasets';

const TEXT = {
  empty: t('ex.grid.empty'),
  min: t('ex.grid.min'),
  max: t('ex.grid.max'),
  minOf: t('ex.grid.minOf'),
  maxOf: t('ex.grid.maxOf'),
  globe: t('ex.grid.globe'),
  globeTitle: t('ex.grid.globeTitle'),
  globeAria: t('ex.grid.globeAria'),
  contains: t('ex.grid.contains'),
  noResults: t('ex.grid.noResults'),
} as const;

/** Header-filter list texts (Tabulator's defaults are English). */
const LIST_PARAMS = { placeholderEmpty: TEXT.noResults, placeholderLoading: TEXT.noResults };

const MAX_LIST = 300; // text columns with at most this many distinct values get a value list
const MAX_INT_LIST = 40; // so do integer columns (year, month, class...)
const STORE = 'fg.explorer.cols.v1.';
const GLOBE = '__globe';
/** Numbers shown without thousands separators. */
const PLAIN = new Set(['year', 'month', 'm', 'lat', 'lon', 'cls', 'type', 'o']);

interface Layout {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

export interface GridOptions {
  /** Persist the column layout under this key (one per dataset). */
  layoutKey?: string;
  defaultCols?: string[];
  docs?: Record<string, string>;
  /** Rows with region_type and region_id get a button that opens the region on the globe. */
  onGlobe?: (row: Row) => void;
}

export interface Grid {
  load(result: QueryResult, o?: GridOptions): void;
  clear(): void;
  /** Columns in their current order. */
  columns(): { name: string; visible: boolean }[];
  setVisible(name: string, on: boolean): void;
  resetLayout(): void;
  /** Rows after the column filters and sort, visible columns only, in display order. */
  exportData(): { head: string[]; rows: unknown[][] };
  counts(): { total: number; shown: number };
  redraw(): void;
}

function fmtNum(v: number, name: string): string {
  if (!Number.isFinite(v)) return '';
  if (name === 'lat' || name === 'lon') return v.toLocaleString(locale, { maximumFractionDigits: 6, useGrouping: false });
  const plain = PLAIN.has(name);
  if (Number.isInteger(v)) return plain || Math.abs(v) < 10000 ? String(v) : v.toLocaleString(locale);
  const a = Math.abs(v);
  return v.toLocaleString(locale, { maximumFractionDigits: a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4, useGrouping: a >= 10000 && !plain });
}

/** Distinct non-null values of a column, or undefined when there are more than `limit`. */
function distinct(rows: Row[], name: string, limit: number): (string | number)[] | undefined {
  const seen = new Set<string | number>();
  for (const r of rows) {
    const v = r[name];
    if (v === null || v === undefined) continue;
    seen.add(v as string | number);
    if (seen.size > limit) return undefined;
  }
  return [...seen].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), locale, { numeric: true })));
}

interface Range {
  lo: string;
  hi: string;
}

function minMaxEditor(col: string) {
  return (_cell: CellComponent, _onRendered: unknown, success: (v: Range) => void): HTMLElement => {
    const lo = h('input', { type: 'number', step: 'any', placeholder: TEXT.min, 'aria-label': TEXT.minOf.replace('{c}', col) });
    const hi = h('input', { type: 'number', step: 'any', placeholder: TEXT.max, 'aria-label': TEXT.maxOf.replace('{c}', col) });
    let timer: number | undefined;
    const push = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => success({ lo: lo.value, hi: hi.value }), 300);
    };
    lo.addEventListener('input', push);
    hi.addEventListener('input', push);
    return h('span', { class: 'ex-minmax' }, lo, hi);
  };
}

const minMaxFilter = (hv: Range, rv: unknown) => {
  if (hv.lo === '' && hv.hi === '') return true;
  if (rv === null || rv === undefined) return false;
  const v = Number(rv);
  return (hv.lo === '' || v >= Number(hv.lo)) && (hv.hi === '' || v <= Number(hv.hi));
};

const inListFilter = (hv: unknown, rv: unknown) => {
  if (!Array.isArray(hv) || !hv.length) return true;
  return rv !== null && rv !== undefined && hv.some((x) => String(x) === String(rv));
};

function filterDef(c: ResultCol, rows: Row[]): Partial<ColumnDefinition> {
  if (c.kind === 'num') {
    const few = distinct(rows, c.name, MAX_INT_LIST);
    if (few && few.every((v) => Number.isInteger(v)))
      return { headerFilter: 'list', headerFilterParams: { values: few, multiselect: true, clearable: true, ...LIST_PARAMS }, headerFilterFunc: inListFilter };
    return {
      headerFilter: minMaxEditor(c.name) as unknown as ColumnDefinition['headerFilter'],
      headerFilterFunc: minMaxFilter as ColumnDefinition['headerFilterFunc'],
      headerFilterEmptyCheck: (v: unknown) => !v || ((v as Range).lo === '' && (v as Range).hi === ''),
    };
  }
  const values = distinct(rows, c.name, MAX_LIST);
  if (values) return { headerFilter: 'list', headerFilterParams: { values, multiselect: true, clearable: true, ...LIST_PARAMS }, headerFilterFunc: inListFilter };
  return { headerFilter: 'input', headerFilterPlaceholder: TEXT.contains, headerFilterFunc: 'like' };
}

function signalCell(cell: CellComponent): HTMLElement | string {
  const v = cell.getValue() as string | null;
  if (!v) return '';
  const kind = v === SIGNAL.above ? 'above' : v === SIGNAL.below ? 'below' : 'within';
  return h('span', { class: `ex-sig ex-sig-${kind}` }, v);
}

function columnDef(c: ResultCol, rows: Row[], o: GridOptions, width: number | undefined): ColumnDefinition {
  const num = c.kind === 'num';
  return {
    title: c.name,
    field: c.name,
    headerTooltip: o.docs?.[c.name] ?? c.name,
    hozAlign: num ? 'right' : 'left',
    headerHozAlign: num ? 'right' : 'left',
    sorter: num ? 'number' : 'string',
    sorterParams: { alignEmptyValues: 'bottom' },
    minWidth: 70,
    width,
    ...(c.name === 'signal' ? { formatter: signalCell } : num ? { formatter: (cell: CellComponent) => fmtNum(cell.getValue() as number, c.name) } : {}),
    ...filterDef(c, rows),
  };
}

function globeColumn(onGlobe: (row: Row) => void): ColumnDefinition {
  return {
    title: '',
    field: GLOBE,
    width: 84,
    hozAlign: 'center',
    headerSort: false,
    resizable: false,
    frozen: true,
    formatter: (cell: CellComponent) => {
      const row = cell.getData() as Row;
      return h('button', { type: 'button', class: 'ex-globe', title: TEXT.globeTitle, 'aria-label': TEXT.globeAria.replace('{r}', String(row.region ?? row.region_id)) }, TEXT.globe);
    },
    cellClick: (_e, cell) => onGlobe(cell.getData() as Row),
  };
}

export function createGrid(host: HTMLElement, onChange: () => void): Grid {
  let table: Tabulator | undefined;
  let built = false;
  let key: string | undefined;
  let names: string[] = [];
  let hidden = new Set<string>();
  let widths: Record<string, number> = {};
  let current: { result: QueryResult; opts: GridOptions } | undefined;

  const save = () => {
    if (!key || !table || !built) return;
    const order = table.getColumns().map((c) => c.getField()).filter((f) => f && f !== GLOBE);
    const w: Record<string, number> = {};
    for (const c of table.getColumns()) if (c.getField() !== GLOBE) w[c.getField()] = c.getWidth();
    const layout: Layout = { order, hidden: [...hidden], widths: w };
    writeJson(STORE + key, layout);
  };

  function destroy() {
    table?.destroy();
    table = undefined;
    built = false;
    host.replaceChildren();
  }

  function build(result: QueryResult, o: GridOptions, useSaved: boolean) {
    destroy();
    key = o.layoutKey;
    const have = result.cols.map((c) => c.name);
    const saved = useSaved && key ? readJson<Layout>(STORE + key) : undefined;
    const first = saved?.order.filter((n) => have.includes(n)) ?? (o.defaultCols ?? []).filter((n) => have.includes(n));
    names = [...first, ...have.filter((n) => !first.includes(n))];
    hidden = new Set(saved ? saved.hidden.filter((n) => have.includes(n)) : o.defaultCols ? have.filter((n) => !o.defaultCols!.includes(n)) : []);
    widths = saved?.widths ?? {};
    const byName = new Map(result.cols.map((c) => [c.name, c]));
    const defs = names.map((n) => ({ ...columnDef(byName.get(n)!, result.rows, o, widths[n]), visible: !hidden.has(n) }) as ColumnDefinition);
    const firstVisible = defs.find((d) => d.visible !== false);
    if (firstVisible) firstVisible.frozen = true;
    const hasRegion = o.onGlobe && have.includes('region_type') && have.includes('region_id');
    if (hasRegion) defs.push(globeColumn(o.onGlobe!));

    const el = h('div', { class: 'ex-tab' });
    host.append(el);
    table = new Tabulator(el, {
      data: result.rows,
      columns: defs,
      layout: 'fitDataFill',
      height: '100%',
      rowHeight: 26,
      movableColumns: true,
      columnHeaderSortMulti: true,
      nestedFieldSeparator: false,
      headerFilterLiveFilterDelay: 300,
      placeholder: TEXT.empty,
    });
    // Keyboard: sortable headers get a tab stop, and Enter or Space sorts (Shift: add to a multi-column sort), like a click.
    const focusable = () => el.querySelectorAll<HTMLElement>('.tabulator-col.tabulator-sortable').forEach((c) => (c.tabIndex = 0));
    el.addEventListener('keydown', (e) => {
      const col = e.target as HTMLElement;
      if ((e.key !== 'Enter' && e.key !== ' ') || !col.classList.contains('tabulator-col') || !col.classList.contains('tabulator-sortable')) return;
      e.preventDefault();
      col.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey }));
    });
    table.on('tableBuilt', () => {
      built = true;
      focusable();
      onChange();
    });
    table.on('renderComplete', focusable);
    table.on('dataFiltered', onChange);
    table.on('columnMoved', () => {
      save();
      onChange();
    });
    table.on('columnResized', save);
  }

  return {
    load(result, o = {}) {
      current = { result, opts: o };
      build(result, o, true);
    },
    clear() {
      current = undefined;
      destroy();
    },
    columns() {
      if (table && built) return table.getColumns().filter((c) => c.getField() !== GLOBE).map((c) => ({ name: c.getField(), visible: c.isVisible() }));
      return names.map((n) => ({ name: n, visible: !hidden.has(n) }));
    },
    setVisible(name, on) {
      if (on) hidden.delete(name);
      else hidden.add(name);
      if (table && built) {
        const col = table.getColumn(name);
        if (on) void col.show();
        else void col.hide();
      }
      save();
      onChange();
    },
    resetLayout() {
      if (!current) return;
      if (key) writeJson(STORE + key, undefined);
      build(current.result, current.opts, false);
    },
    exportData() {
      const cols = this.columns().filter((c) => c.visible).map((c) => c.name);
      const rows = table && built ? (table.getData('active') as Row[]) : (current?.result.rows ?? []);
      return { head: cols, rows: rows.map((r) => cols.map((c) => r[c])) };
    },
    counts() {
      const total = current?.result.rows.length ?? 0;
      return { total, shown: table && built ? table.getDataCount('active') : total };
    },
    redraw() {
      if (table && built) table.redraw(true);
    },
  };
}
