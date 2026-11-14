import { ROW_CAP, type ColDef, type DatasetDef, type Kind } from './datasets';
import type { ScopeForm } from './scope';
import { RE_DATE, field, h, qi, ql, select, toNum } from './util';
import { locale, t } from '../i18n';

const TEXT = {
  filters: t('ex.builder.filters'),
  groups: t('ex.builder.groups'),
  measures: t('ex.builder.measures'),
  addFilter: t('ex.builder.addFilter'),
  addGroup: t('ex.builder.addGroup'),
  addMeasure: t('ex.builder.addMeasure'),
  remove: t('ex.builder.remove'),
  field: t('ex.builder.field'),
  operator: t('ex.builder.operator'),
  value: t('ex.builder.value'),
  transform: t('ex.builder.transform'),
  step: t('ex.builder.step'),
  aggregate: t('ex.builder.aggregate'),
  measureField: t('ex.builder.measureField'),
  rowsOption: t('ex.builder.rowsOption'),
  asIs: t('ex.builder.asIs'),
  binned: t('ex.builder.binned'),
  day: t('ex.builder.day'),
  month: t('ex.builder.month'),
  year: t('ex.builder.year'),
  orderBy: t('ex.builder.orderBy'),
  auto: t('ex.builder.auto'),
  desc: t('ex.builder.desc'),
  asc: t('ex.builder.asc'),
  direction: t('ex.builder.direction'),
  limit: t('ex.builder.limit'),
  editSql: t('ex.builder.editSql'),
  generated: t('ex.builder.generated'),
  hintBetween: t('ex.builder.hintBetween'),
  hintIn: t('ex.builder.hintIn'),
  hintValue: t('ex.builder.hintValue'),
  errValue: t('ex.builder.errValue'),
  errBetween: t('ex.builder.errBetween'),
  errIn: t('ex.builder.errIn'),
  errStep: t('ex.builder.errStep'),
  errMeasure: t('ex.builder.errMeasure'),
  errLimit: t('ex.builder.errLimit'),
  opContains: t('ex.builder.opContains'),
  opIn: t('ex.builder.opIn'),
  opBetween: t('ex.builder.opBetween'),
  aggSum: t('ex.builder.aggSum'),
  aggMean: t('ex.builder.aggMean'),
  aggMedian: t('ex.builder.aggMedian'),
  aggMin: t('ex.builder.aggMin'),
  aggMax: t('ex.builder.aggMax'),
  aggCount: t('ex.builder.aggCount'),
} as const;

type Op = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'between' | 'in' | 'contains';
type Tf = '' | 'year' | 'month' | 'bin';
type Agg = 'sum' | 'mean' | 'median' | 'min' | 'max' | 'count';

interface Filter {
  field: string;
  op: Op;
  value: string;
}
interface Dim {
  field: string;
  tf: Tf;
  step: string;
}
interface Measure {
  agg: Agg;
  field: string; // '' = count rows
}
interface Spec {
  filters: Filter[];
  dims: Dim[];
  measures: Measure[];
  order: string;
  desc: boolean;
  limit: string;
}

const OPS: Record<Kind, [Op, string][]> = {
  text: [['=', '='], ['<>', '<>'], ['contains', TEXT.opContains], ['in', TEXT.opIn]],
  int: [['=', '='], ['<>', '<>'], ['>', '>'], ['>=', '>='], ['<', '<'], ['<=', '<='], ['between', TEXT.opBetween], ['in', TEXT.opIn]],
  num: [['=', '='], ['<>', '<>'], ['>', '>'], ['>=', '>='], ['<', '<'], ['<=', '<='], ['between', TEXT.opBetween], ['in', TEXT.opIn]],
  date: [['=', '='], ['<>', '<>'], ['>', '>'], ['>=', '>='], ['<', '<'], ['<=', '<='], ['between', TEXT.opBetween]],
};
const AGGS: Agg[] = ['sum', 'mean', 'median', 'min', 'max', 'count'];
const AGG_LABEL: Record<Agg, string> = { sum: TEXT.aggSum, mean: TEXT.aggMean, median: TEXT.aggMedian, min: TEXT.aggMin, max: TEXT.aggMax, count: TEXT.aggCount };

const emptySpec = (): Spec => ({ filters: [], dims: [], measures: [], order: '', desc: true, limit: '' });
const fmt = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k]));

function literal(kind: Kind, value: string): string | undefined {
  const t = value.trim();
  if (kind === 'int' || kind === 'num') {
    const n = toNum(t);
    return n === undefined ? undefined : String(n);
  }
  if (kind === 'date') return RE_DATE.test(t) && !Number.isNaN(Date.parse(t)) ? `DATE ${ql(t)}` : undefined;
  return ql(t);
}

function filterSql(f: Filter, col: ColDef): { sql?: string; error?: string } {
  const id = qi(f.field);
  const bad = (v: string) => ({ error: fmt(TEXT.errValue, { f: f.field, v }) });
  if (f.op === 'contains') return { sql: `contains(lower(CAST(${id} AS VARCHAR)), lower(${ql(f.value)}))` };
  if (f.op === 'in' || f.op === 'between') {
    const items = f.value.split(',').map((x) => x.trim()).filter((x) => x !== '');
    if (f.op === 'between' && items.length !== 2) return { error: fmt(TEXT.errBetween, { f: f.field }) };
    if (!items.length) return { error: fmt(TEXT.errIn, { f: f.field }) };
    const lits = items.map((x) => literal(col.kind, x));
    const miss = lits.findIndex((x) => x === undefined);
    if (miss >= 0) return bad(items[miss]);
    return { sql: f.op === 'in' ? `${id} IN (${lits.join(', ')})` : `${id} BETWEEN ${lits[0]} AND ${lits[1]}` };
  }
  const lit = literal(col.kind, f.value);
  return lit === undefined ? bad(f.value) : { sql: `${id} ${f.op} ${lit}` };
}

function dimSql(d: Dim): { expr?: string; alias: string; error?: string } {
  const id = qi(d.field);
  if (d.tf === 'year') return { expr: `year(${id})`, alias: `${d.field}_year` };
  if (d.tf === 'month') return { expr: `strftime(${id}, '%Y-%m')`, alias: `${d.field}_month` };
  if (d.tf === 'bin') {
    const step = toNum(d.step);
    if (step === undefined || step <= 0) return { alias: d.field, error: fmt(TEXT.errStep, { f: d.field }) };
    return { expr: `CAST(floor(${id} / ${step}) * ${step} AS DOUBLE)`, alias: `${d.field}_bin` };
  }
  return { expr: id, alias: d.field };
}

function measureSql(m: Measure): { expr?: string; alias: string; error?: string } {
  if (m.agg === 'count') return m.field ? { expr: `count(${qi(m.field)})`, alias: `count_${m.field}` } : { expr: 'count(*)', alias: 'count' };
  if (!m.field) return { alias: m.agg, error: fmt(TEXT.errMeasure, { a: AGG_LABEL[m.agg] }) };
  const fn = m.agg === 'mean' ? 'avg' : m.agg;
  return { expr: `CAST(${fn}(${qi(m.field)}) AS DOUBLE)`, alias: `${m.agg}_${m.field}` };
}

export interface Built {
  sql: string;
  /** Output column names, for the order selector. */
  outputs: string[];
  /** True when no grouping or measure is chosen: plain rows. */
  raw: boolean;
  error?: string;
}

/** SQL for a builder state over the dataset's scoped relation. */
export function buildSql(ds: DatasetDef, relation: string, spec: Spec): Built {
  const kindOf = (name: string) => ds.cols.find((c) => c.name === name);
  const where: string[] = [];
  let error: string | undefined;
  for (const f of spec.filters) {
    const col = kindOf(f.field);
    if (!col) continue;
    const r = filterSql(f, col);
    if (r.error) error ??= r.error;
    else where.push(r.sql!);
  }
  const used = new Set<string>();
  const unique = (a: string) => {
    let n = a;
    for (let i = 2; used.has(n); i++) n = `${a}_${i}`;
    used.add(n);
    return n;
  };
  // Only known columns of the dataset ever reach the SQL (as quoted identifiers).
  const dims = spec.dims.filter((d) => kindOf(d.field)).map((d) => ({ ...dimSql(d) }));
  const meas = spec.measures.filter((m) => !m.field || kindOf(m.field)).map((m) => measureSql(m));
  const raw = !dims.length && !meas.length;
  for (const x of [...dims, ...meas]) {
    if (x.error) error ??= x.error;
    x.alias = unique(x.alias);
  }
  const outputs = raw ? ds.cols.map((c) => c.name) : [...dims, ...meas].map((x) => x.alias);
  const limitN = spec.limit.trim() === '' ? (raw ? 1000 : 10000) : toNum(spec.limit);
  if (limitN === undefined || limitN < 1 || limitN > ROW_CAP || !Number.isInteger(limitN)) error ??= fmt(TEXT.errLimit, { n: ROW_CAP.toLocaleString(locale) });

  const select = raw ? '*' : [...dims, ...meas].map((x) => `${x.expr ?? 'NULL'} AS ${qi(x.alias)}`).join(',\n       ');
  const order = outputs.includes(spec.order) ? spec.order : raw ? '' : meas.length ? meas[0].alias : dims[0].alias;
  const dir = outputs.includes(spec.order) ? (spec.desc ? 'DESC' : 'ASC') : meas.length ? 'DESC' : 'ASC';
  const sql = [
    `WITH src AS (\n${relation}\n)`,
    `SELECT ${select}`,
    'FROM src',
    where.length ? `WHERE ${where.join('\n  AND ')}` : '',
    dims.length ? `GROUP BY ${dims.map((_, i) => i + 1).join(', ')}` : '',
    order ? `ORDER BY ${qi(order)} ${dir}` : '',
    `LIMIT ${limitN ?? 1000}`,
  ].filter(Boolean).join('\n');
  return { sql, outputs, raw, error };
}

export interface Builder {
  el: HTMLElement;
  /** Current SQL (or an error) for the selected dataset and scope. */
  build(): Built;
  /** Call when the dataset or scope changed. */
  refresh(): void;
}

export function createBuilder(o: { form: ScopeForm; onEditSql: (sql: string) => void }): Builder {
  let spec = emptySpec();
  let dsId = '';

  const filterBox = h('div', { class: 'ex-list' });
  const dimBox = h('div', { class: 'ex-list' });
  const measBox = h('div', { class: 'ex-list' });
  const orderSel = select([]);
  const dirSel = select([['desc', TEXT.desc], ['asc', TEXT.asc]], 'desc', TEXT.direction);
  const limitIn = h('input', { type: 'number', min: '1', max: ROW_CAP, placeholder: '10000' });
  const sqlBox = h('textarea', { class: 'ex-sqlview', readonly: true, rows: 6, spellcheck: 'false', 'aria-label': TEXT.generated });
  const editBtn = h('button', { type: 'button' }, TEXT.editSql);

  const group = (title: string, addLabel: string, add: () => void, box: HTMLElement) =>
    h('fieldset', { class: 'ex-group' }, h('legend', {}, title), box, h('button', { type: 'button', class: 'ex-add', onclick: add }, addLabel));
  const el = h(
    'div',
    { class: 'ex-builder' },
    group(TEXT.filters, TEXT.addFilter, () => addFilter(), filterBox),
    group(TEXT.groups, TEXT.addGroup, () => addDim(), dimBox),
    group(TEXT.measures, TEXT.addMeasure, () => addMeasure(), measBox),
    h('div', { class: 'ex-row' }, field(TEXT.orderBy, orderSel), field(TEXT.direction, dirSel), field(TEXT.limit, limitIn), editBtn),
    h('label', { class: 'ex-field ex-grow' }, h('span', { class: 'ex-flabel' }, TEXT.generated), sqlBox),
  );

  const ds = () => o.form.dataset();
  const cols = () => ds().cols;
  const colOpts = (list: ColDef[]) => list.map((c) => [c.name, c.name] as [string, string]);
  const nums = () => cols().filter((c) => c.kind === 'int' || c.kind === 'num');
  const remover = (list: unknown[], item: unknown, rerender: () => void) =>
    h('button', {
      type: 'button',
      class: 'ex-x',
      title: TEXT.remove,
      'aria-label': TEXT.remove,
      onclick: () => {
        list.splice(list.indexOf(item), 1);
        rerender();
        refresh();
      },
    }, '×');

  function filterRow(f: Filter): HTMLElement {
    const fieldSel = select(colOpts(cols()), f.field, TEXT.field);
    const opSel = select([], undefined, TEXT.operator);
    const val = h('input', { type: 'text', 'aria-label': TEXT.value });
    val.value = f.value;
    const sync = () => {
      const kind = cols().find((c) => c.name === f.field)?.kind ?? 'text';
      const ops = OPS[kind];
      opSel.replaceChildren(...ops.map(([v, l]) => h('option', { value: v }, l)));
      if (!ops.some(([v]) => v === f.op)) f.op = ops[0][0];
      opSel.value = f.op;
      val.placeholder = f.op === 'between' ? TEXT.hintBetween : f.op === 'in' ? TEXT.hintIn : kind === 'date' ? t('ex.scope.dateFmt') : TEXT.hintValue;
    };
    fieldSel.addEventListener('change', () => {
      f.field = fieldSel.value;
      sync();
      refresh();
    });
    opSel.addEventListener('change', () => {
      f.op = opSel.value as Op;
      sync();
      refresh();
    });
    val.addEventListener('input', () => {
      f.value = val.value;
      refresh();
    });
    sync();
    return h('div', { class: 'ex-item' }, fieldSel, opSel, val, remover(spec.filters, f, renderFilters));
  }

  function dimRow(d: Dim): HTMLElement {
    const fieldSel = select(colOpts(cols()), d.field, TEXT.field);
    const tfSel = select([], undefined, TEXT.transform);
    const step = h('input', { type: 'number', min: '0', step: 'any', 'aria-label': TEXT.step, placeholder: TEXT.step });
    step.value = d.step;
    const sync = () => {
      const kind = cols().find((c) => c.name === d.field)?.kind ?? 'text';
      const opts: [string, string][] =
        kind === 'date' ? [['', TEXT.day], ['month', TEXT.month], ['year', TEXT.year]] : kind === 'text' ? [['', TEXT.asIs]] : [['', TEXT.asIs], ['bin', TEXT.binned]];
      tfSel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
      if (!opts.some(([v]) => v === d.tf)) d.tf = '';
      tfSel.value = d.tf;
      tfSel.hidden = opts.length < 2;
      step.hidden = d.tf !== 'bin';
    };
    fieldSel.addEventListener('change', () => {
      d.field = fieldSel.value;
      sync();
      refresh();
    });
    tfSel.addEventListener('change', () => {
      d.tf = tfSel.value as Tf;
      sync();
      refresh();
    });
    step.addEventListener('input', () => {
      d.step = step.value;
      refresh();
    });
    sync();
    return h('div', { class: 'ex-item' }, fieldSel, tfSel, step, remover(spec.dims, d, renderDims));
  }

  function measureRow(m: Measure): HTMLElement {
    const aggSel = select(AGGS.map((a) => [a, AGG_LABEL[a]] as [string, string]), m.agg, TEXT.aggregate);
    const fieldSel = select([], undefined, TEXT.measureField);
    const sync = () => {
      const opts: [string, string][] = [...(m.agg === 'count' ? [['', TEXT.rowsOption] as [string, string]] : []), ...colOpts(m.agg === 'count' ? cols() : nums())];
      fieldSel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
      if (!opts.some(([v]) => v === m.field)) m.field = opts[0]?.[0] ?? '';
      fieldSel.value = m.field;
    };
    aggSel.addEventListener('change', () => {
      m.agg = aggSel.value as Agg;
      sync();
      refresh();
    });
    fieldSel.addEventListener('change', () => {
      m.field = fieldSel.value;
      refresh();
    });
    sync();
    return h('div', { class: 'ex-item' }, aggSel, fieldSel, remover(spec.measures, m, renderMeasures));
  }

  const renderFilters = () => filterBox.replaceChildren(...spec.filters.map(filterRow));
  const renderDims = () => dimBox.replaceChildren(...spec.dims.map(dimRow));
  const renderMeasures = () => measBox.replaceChildren(...spec.measures.map(measureRow));

  function addFilter() {
    spec.filters.push({ field: cols()[0].name, op: '=', value: '' });
    renderFilters();
    refresh();
  }
  function addDim() {
    spec.dims.push({ field: cols()[0].name, tf: '', step: '1' });
    renderDims();
    refresh();
  }
  function addMeasure() {
    spec.measures.push({ agg: 'sum', field: nums()[0]?.name ?? '' });
    renderMeasures();
    refresh();
  }

  const build = () => buildSql(ds(), ds().relation(o.form.scope()), spec);

  function refresh() {
    if (dsId !== ds().id) {
      dsId = ds().id;
      spec = emptySpec();
      limitIn.value = '';
      renderFilters();
      renderDims();
      renderMeasures();
    }
    spec.limit = limitIn.value;
    spec.desc = dirSel.value === 'desc';
    const first = build();
    // The order list follows the output columns of the current state.
    orderSel.replaceChildren(h('option', { value: '' }, TEXT.auto), ...first.outputs.map((c) => h('option', { value: c }, c)));
    orderSel.value = first.outputs.includes(spec.order) ? spec.order : '';
    spec.order = orderSel.value;
    sqlBox.value = build().sql;
  }

  orderSel.addEventListener('change', () => {
    spec.order = orderSel.value;
    refresh();
  });
  dirSel.addEventListener('change', refresh);
  limitIn.addEventListener('input', refresh);
  editBtn.onclick = () => o.onEditSql(build().sql);

  return { el, build, refresh };
}
