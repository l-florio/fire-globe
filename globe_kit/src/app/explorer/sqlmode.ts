import type { Catalog } from './datasets';
import { h } from './util';

const TEXT = {
  editor: 'SQL query',
  hint: 'Queries are read-only (one SELECT statement) and run locally in your browser with DuckDB; nothing is sent to a server. Ctrl+Enter runs the query.',
  help: 'Tables and columns',
  insert: 'Insert {n} into the query',
  macro: 'In file paths, {data}/ stands for the data folder. Views are created when a query mentions them. Filter on m, lat, lon (grids) or date, lat, lon (points) so that only the needed parts are downloaded.',
  examples: 'Examples',
  exTop: 'Top countries in August',
  exGrid: 'Grid cells, Mediterranean, 2023',
  exPoints: 'Detections per day',
  placeholder: 'SELECT ... FROM regions WHERE ...',
} as const;

const EXAMPLES: [string, string][] = [
  [
    TEXT.exTop,
    `SELECT region, year, detections, usual, ratio_to_usual, signal
FROM regions
WHERE series = 'long' AND region_type = 'country' AND month = 8 AND year = 2023
ORDER BY detections DESC
LIMIT 20`,
  ],
  [
    TEXT.exGrid,
    `SELECT period, sum(n) AS detections, sum(frp) AS frp_mw
FROM grid
WHERE sensor = 'MODIS' AND m BETWEEN 276 AND 287
  AND lat BETWEEN 35 AND 47 AND lon BETWEEN 6 AND 19
GROUP BY period
ORDER BY period`,
  ],
  [
    TEXT.exPoints,
    `SELECT date, count(*) AS detections, round(sum(frp), 1) AS frp_mw
FROM points_viirs_snpp_2024
WHERE date BETWEEN DATE '2024-08-01' AND DATE '2024-08-31'
  AND lat BETWEEN 35 AND 47 AND lon BETWEEN 6 AND 19
GROUP BY date
ORDER BY date`,
  ],
];

export interface SqlMode {
  el: HTMLElement;
  sql(): string;
  setSql(sql: string): void;
  focus(): void;
}

export function createSqlMode(o: { catalog: Catalog; onRun: (sql: string) => void }): SqlMode {
  const editor = h('textarea', { class: 'ex-editor', rows: 7, spellcheck: 'false', 'aria-label': TEXT.editor, placeholder: TEXT.placeholder });
  const insert = (text: string) => {
    const a = editor.selectionStart;
    editor.setRangeText(text, a, editor.selectionEnd, 'end');
    editor.focus();
  };
  const run = () => o.onRun(editor.value);

  const tables = o.catalog.docs.map((d) =>
    h(
      'div',
      { class: 'ex-table' },
      h('button', { type: 'button', class: 'ex-link', title: TEXT.insert.replace('{n}', d.name), onclick: () => insert(d.name.startsWith('points_') ? 'points_viirs_snpp_2024' : d.name) }, d.name),
      h('span', { class: 'ex-note' }, ` ${d.doc}`),
      h('div', { class: 'ex-cols' }, ...d.cols.map((c) => h('code', { title: c.doc }, `${c.name} ${c.kind}`))),
    ),
  );
  const help = h('details', { class: 'ex-help' }, h('summary', {}, TEXT.help), h('p', { class: 'ex-note' }, TEXT.macro), ...tables);
  const examples = h(
    'div',
    { class: 'ex-row ex-examples' },
    h('span', { class: 'ex-flabel' }, TEXT.examples),
    ...EXAMPLES.map(([label, sql]) =>
      h('button', { type: 'button', onclick: () => {
        editor.value = sql;
        editor.focus();
      } }, label),
    ),
  );
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  });
  const el = h('div', { class: 'ex-sqlmode' }, help, examples, editor, h('p', { class: 'ex-note' }, TEXT.hint));

  return {
    el,
    sql: () => editor.value,
    setSql(sql) {
      editor.value = sql;
    },
    focus: () => editor.focus(),
  };
}
