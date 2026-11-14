import './explorer.css';
import { createBuilder } from './builder';
import { ROW_CAP, type Catalog } from './datasets';
import { createEngine, type Engine, type Row } from './engine';
import { createResults, type ResultMeta } from './results';
import { createScopeForm } from './scope';
import { createSqlMode } from './sqlmode';
import { h } from './util';

const TEXT = {
  title: 'Data explorer',
  modes: 'Explorer mode',
  table: 'Table',
  builder: 'Builder',
  sql: 'SQL',
  load: 'Load table',
  hideControls: 'Hide controls',
  showControls: 'Show controls',
  loadingEngine: 'Loading the data engine...',
  failed: 'Could not start the explorer: {m}',
  retry: 'Retry',
  cancelled: 'Query cancelled.',
  tableHint: 'Pick a dataset and an area or period, then load it. Use the filters in the column headers; Shift-click headers to sort by several columns.',
  unknown: 'Unknown error',
} as const;

type Mode = 'table' | 'builder' | 'sql';
const MODES: Mode[] = ['table', 'builder', 'sql'];

export interface ExplorerOptions {
  /** `${import.meta.env.BASE_URL}data/` */
  baseUrl: string;
  /** A region row was chosen: show it on the globe. */
  onPick: (type: 'country' | 'gfed', id: string, name: string) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : TEXT.unknown);

/**
 * Data explorer: harmonized regions, grids and single detections read with DuckDB-WASM, as an Excel-like table,
 * a no-code query builder or SQL, with charts. The engine and the data load on first show.
 */
export function createExplorer(o: ExplorerOptions) {
  const root = h('section', { class: 'panel tablepanel explorer', 'aria-label': TEXT.title });
  root.hidden = true;
  document.body.appendChild(root);

  let month = '';
  let mode: Mode = 'table';
  let starting: Promise<void> | undefined;
  let session: Session | undefined;
  let stale = false; // the month changed while hidden

  const tabs = new Map<Mode, HTMLButtonElement>();
  const tablist = h('div', { class: 'ex-tabs', role: 'tablist', 'aria-label': TEXT.modes });
  for (const m of MODES) {
    const b = h('button', { type: 'button', role: 'tab', id: `ex-tab-${m}`, onclick: () => setMode(m) }, TEXT[m]);
    b.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = MODES[(MODES.indexOf(m) + step + MODES.length) % MODES.length];
      setMode(next);
      tabs.get(next)?.focus();
    });
    tabs.set(m, b);
    tablist.append(b);
  }
  const toggle = h('button', { type: 'button', class: 'ex-toggle', 'aria-expanded': 'true' }, TEXT.hideControls);
  const head = h('header', { class: 'ex-head' }, h('h2', {}, TEXT.title), tablist, toggle);
  const body = h('div', { class: 'ex-body' });
  root.append(head, body);

  function setMode(m: Mode) {
    mode = m;
    for (const [k, b] of tabs) {
      b.setAttribute('aria-selected', String(k === m));
      b.tabIndex = k === m ? 0 : -1;
    }
    session?.apply(m);
  }

  interface Session {
    nodes: HTMLElement[];
    apply(m: Mode): void;
    scopeChanged(): void;
    setMonth(m: string): void;
    resize(): void;
    autoRun(): void;
  }

  function start() {
    starting ??= (async () => {
      body.replaceChildren(h('p', { class: 'ex-note', role: 'status' }, TEXT.loadingEngine));
      try {
        const engine = await createEngine(o.baseUrl);
        session = build(engine);
        body.replaceChildren(...session.nodes);
        session.setMonth(month);
        setMode(mode);
        session.autoRun();
      } catch (e) {
        starting = undefined;
        const retry = h('button', { type: 'button', onclick: start }, TEXT.retry);
        body.replaceChildren(h('p', { class: 'ex-note', role: 'alert' }, TEXT.failed.replace('{m}', message(e))), retry);
      }
    })();
  }

  function build(engine: Engine): Session {
    const cat: Catalog = engine.catalog;
    let req = 0;
    let timer: number | undefined;

    const onGlobe = (row: Row) => {
      const type = row.region_type === 'gfed' ? 'gfed' : 'country';
      const id = String(row.region_id ?? row.region);
      o.onPick(type, id, type === 'gfed' ? (cat.gfedNames[id] ?? id) : id);
    };
    const results = createResults({
      onGlobe,
      onCancel: () => {
        req++;
        engine.cancel();
        results.running(false);
        results.error(TEXT.cancelled);
      },
    });

    async function exec(sql: string, meta: Pick<ResultMeta, 'title' | 'layoutKey' | 'defaultCols' | 'docs'>, countSql?: string) {
      const my = ++req;
      results.running(true);
      try {
        const r = await engine.run(sql);
        if (my !== req) return;
        const total = r.truncated && countSql ? await engine.count(countSql).catch(() => undefined) : undefined;
        if (my !== req) return;
        results.show(r, { ...meta, sql, total, cap: ROW_CAP, onGlobe });
      } catch (e) {
        if (my === req) results.error(message(e));
      } finally {
        if (my === req) results.running(false);
      }
    }

    const form = createScopeForm(cat, () => scopeChanged());
    const docsOf = () => Object.fromEntries(form.dataset().cols.map((c) => [c.name, c.doc]));
    const autoDataset = () => form.dataset().id.startsWith('regions');

    function runTable() {
      const ds = form.dataset();
      const scope = form.scope();
      const err = ds.check(scope);
      if (err) return results.error(err);
      const rel = ds.relation(scope);
      void exec(rel + (ds.order ? `\nORDER BY ${ds.order}` : ''), { title: ds.id, layoutKey: ds.id, defaultCols: ds.defaultCols, docs: docsOf() }, rel);
    }

    function runBuilder() {
      const ds = form.dataset();
      const err = ds.check(form.scope());
      const built = builder.build();
      if (err || built.error) return results.error((err ?? built.error)!);
      void exec(built.sql, { title: `${ds.id}_query`, layoutKey: built.raw ? ds.id : undefined, defaultCols: built.raw ? ds.defaultCols : undefined, docs: docsOf() });
    }

    const builder = createBuilder({
      form,
      onRun: runBuilder,
      onEditSql: (sql) => {
        sqlMode.setSql(sql);
        setMode('sql');
        sqlMode.focus();
      },
    });
    const sqlMode = createSqlMode({ catalog: cat, onRun: (sql) => void exec(sql, { title: 'sql' }) });

    const loadBtn = h('button', { type: 'button', class: 'ex-primary', onclick: runTable }, TEXT.load);
    const tablePane = h('div', { class: 'ex-row' }, loadBtn, h('span', { class: 'ex-note' }, TEXT.tableHint));
    const controls = h('div', { class: 'ex-controls' }, form.el, tablePane, builder.el, sqlMode.el);
    const panes: Record<Mode, HTMLElement[]> = { table: [form.el, tablePane], builder: [form.el, builder.el], sql: [sqlMode.el] };

    toggle.onclick = () => {
      const hidden = controls.hidden;
      controls.hidden = !hidden;
      toggle.setAttribute('aria-expanded', String(hidden));
      toggle.textContent = hidden ? TEXT.hideControls : TEXT.showControls;
      results.resize();
    };

    function scopeChanged() {
      builder.refresh();
      if (mode !== 'table' || !autoDataset()) return;
      if (root.hidden) {
        stale = true;
        return;
      }
      clearTimeout(timer);
      timer = window.setTimeout(runTable, 120);
    }

    return {
      nodes: [controls, results.el],
      apply(m) {
        const shown = new Set(panes[m]);
        for (const e of Object.values(panes).flat()) e.hidden = !shown.has(e);
        if (m === 'builder') builder.refresh();
        results.resize();
      },
      scopeChanged,
      setMonth: (m) => form.setMonth(m),
      resize: () => results.resize(),
      autoRun() {
        stale = false;
        clearTimeout(timer);
        if (mode === 'table' && autoDataset() && !root.hidden) runTable();
      },
    };
  }

  return {
    get visible() {
      return !root.hidden;
    },
    show(on: boolean) {
      root.hidden = !on;
      if (!on) return;
      if (!session) return start();
      session.resize();
      if (stale) session.autoRun();
    },
    /** Follow the time slider (YYYY-MM or YYYY-MM-DD): "Regions this month" shows that month. */
    select(key: string) {
      const m = key.slice(0, 7);
      if (m === month) return;
      month = m;
      session?.setMonth(m);
    },
  };
}
