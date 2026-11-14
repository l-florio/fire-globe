import type { Catalog } from './datasets';
import type { CmEditor } from './sqleditor';
import { h } from './util';
import { t } from '../i18n';

const TEXT = {
  editor: t('ex.sqlmode.editor'),
  hint: t('ex.sqlmode.hint'),
  help: t('ex.sqlmode.help'),
  insert: t('ex.sqlmode.insert'),
  macro: t('ex.sqlmode.macro'),
  examples: t('ex.sqlmode.examples'),
  exTop: t('ex.sqlmode.exTop'),
  exGrid: t('ex.sqlmode.exGrid'),
  exPoints: t('ex.sqlmode.exPoints'),
  placeholder: t('ex.sqlmode.placeholder'),
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
  /** SQL mode was shown: load the code editor on first use, re-measure it afterwards. */
  activate(): void;
}


export function createSqlMode(o: { catalog: Catalog; onRun: (sql: string) => void }): SqlMode {
  const hintId = 'ex-sql-hint';
  // A plain textarea from the start; it is swapped for the CodeMirror editor (highlighting, suggestions) once that
  // chunk has loaded, and stays in use if it cannot be loaded.
  const area = h('textarea', { class: 'ex-textarea', rows: 7, spellcheck: 'false', 'aria-label': TEXT.editor, 'aria-describedby': hintId, placeholder: TEXT.placeholder });
  const host = h('div', { class: 'ex-editor' }, area);
  let cm: CmEditor | undefined;
  let loading = false;
  const get = () => (cm ? cm.get() : area.value);
  const set = (text: string) => {
    if (cm) cm.set(text);
    else area.value = text;
  };
  const focus = () => (cm ? cm.focus() : area.focus());
  const run = () => o.onRun(get());
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  });
  const insert = (text: string) => {
    if (cm) cm.insert(text);
    else area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
    focus();
  };

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
    ...EXAMPLES.map(([label, text]) =>
      h('button', { type: 'button', onclick: () => {
        set(text);
        focus();
      } }, label),
    ),
  );
  const el = h('div', { class: 'ex-sqlmode' }, help, examples, host, h('p', { class: 'ex-note', id: hintId }, TEXT.hint));

  async function load() {
    loading = true;
    try {
      const { createCmEditor } = await import('./sqleditor');
      const text = area.value;
      const hadFocus = document.activeElement === area;
      area.hidden = true;
      cm = createCmEditor({ parent: host, catalog: o.catalog, doc: text, label: TEXT.editor, describedBy: hintId, placeholder: TEXT.placeholder, onRun: run });
      if (hadFocus) cm.focus();
    } catch {
      loading = false; // the textarea keeps working
    }
  }

  return {
    el,
    sql: get,
    setSql: set,
    focus,
    activate() {
      if (cm) cm.measure();
      else if (!loading) void load();
    },
  };
}
