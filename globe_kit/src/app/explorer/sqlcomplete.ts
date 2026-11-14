import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { Catalog, ColDef } from './datasets';

const TEXT = {
  view: 'view',
  table: 'table',
  column: 'column',
  keyword: 'keyword',
  fn: 'function',
} as const;

const KEYWORDS = [
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'WITH', 'AS', 'JOIN', 'LEFT JOIN', 'INNER JOIN',
  'CROSS JOIN', 'ON', 'USING', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'IS NULL',
  'IS NOT NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'NULLS LAST', 'NULLS FIRST', 'OVER', 'PARTITION BY', 'FILTER', 'DATE',
  'INTERVAL', 'TRUE', 'FALSE', 'NULL', 'EXISTS', 'QUALIFY', 'WINDOW', 'ALL', 'ANY', 'LATERAL',
];

/** [name, signature hint] of common DuckDB functions. */
const FUNCTIONS: [string, string][] = [
  ['count', 'count(*) | count(x)'], ['sum', 'sum(x)'], ['avg', 'avg(x)'], ['min', 'min(x)'], ['max', 'max(x)'], ['median', 'median(x)'],
  ['quantile_cont', 'quantile_cont(x, q)'], ['stddev', 'stddev(x)'], ['arg_max', 'arg_max(arg, val)'], ['arg_min', 'arg_min(arg, val)'],
  ['string_agg', 'string_agg(x, sep)'], ['list', 'list(x)'], ['any_value', 'any_value(x)'], ['approx_count_distinct', 'approx_count_distinct(x)'],
  ['round', 'round(x, digits)'], ['floor', 'floor(x)'], ['ceil', 'ceil(x)'], ['abs', 'abs(x)'], ['sqrt', 'sqrt(x)'], ['ln', 'ln(x)'],
  ['log10', 'log10(x)'], ['power', 'power(x, y)'], ['greatest', 'greatest(a, b, ...)'], ['least', 'least(a, b, ...)'],
  ['coalesce', 'coalesce(a, b, ...)'], ['nullif', 'nullif(a, b)'], ['ifnull', 'ifnull(a, b)'], ['cast', 'cast(x AS type)'], ['try_cast', 'try_cast(x AS type)'],
  ['lower', 'lower(s)'], ['upper', 'upper(s)'], ['length', 'length(s)'], ['substr', 'substr(s, start, len)'], ['replace', 'replace(s, from, to)'],
  ['trim', 'trim(s)'], ['concat', 'concat(a, b, ...)'], ['contains', 'contains(s, part)'], ['starts_with', 'starts_with(s, prefix)'],
  ['regexp_matches', 'regexp_matches(s, pattern)'], ['strftime', 'strftime(date, format)'], ['date_trunc', "date_trunc('month', d)"],
  ['date_part', "date_part('year', d)"], ['date_diff', "date_diff('day', a, b)"], ['year', 'year(d)'], ['month', 'month(d)'], ['day', 'day(d)'],
  ['dayofyear', 'dayofyear(d)'], ['make_date', 'make_date(y, m, d)'], ['row_number', 'row_number() OVER (...)'], ['rank', 'rank() OVER (...)'],
  ['lag', 'lag(x, n) OVER (...)'], ['lead', 'lead(x, n) OVER (...)'], ['first_value', 'first_value(x) OVER (...)'], ['cume_dist', 'cume_dist() OVER (...)'],
  ['unnest', 'unnest(list)'], ['range', 'range(start, stop)'], ['generate_series', 'generate_series(start, stop)'],
];

/** Single words of the keyword list, for highlighting. */
export const KEYWORD_WORDS = new Set(KEYWORDS.flatMap((k) => k.toLowerCase().split(' ')).concat(['by', 'is', 'null', 'natural', 'right', 'full', 'outer', 'cast', 'distinct']));
export const FUNCTION_NAMES = new Set(FUNCTIONS.map(([n]) => n));

/** True when `pos` is inside a string, quoted name or comment (a small scanner, no parse tree needed). */
function inLiteral(text: string, pos: number): boolean {
  let i = 0;
  while (i < pos) {
    const two = text.slice(i, i + 2);
    if (two === '--') {
      const e = text.indexOf(String.fromCharCode(10), i);
      if (e < 0 || e >= pos) return true;
      i = e + 1;
    } else if (two === '/*') {
      const e = text.indexOf('*/', i + 2);
      if (e < 0 || e + 2 > pos) return true;
      i = e + 2;
    } else if (text[i] === "'" || text[i] === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === text[i] && text[j + 1] !== text[i])) j += text[j] === text[i] ? 2 : 1;
      if (j >= pos) return true;
      i = j + 1;
    } else i++;
  }
  return false;
}

const RESERVED_ALIAS = new Set([
  'where', 'join', 'on', 'using', 'group', 'order', 'limit', 'offset', 'having', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'union',
  'intersect', 'except', 'window', 'qualify', 'lateral', 'as', 'and', 'or',
]);

interface Table {
  name: string;
  doc: string;
  cols: ColDef[];
}

/** Views and tables of the catalog, with `points_<sensor>_<year>` expanded to every real view name. */
export function schemaOf(catalog: Catalog): Table[] {
  const out: Table[] = [];
  const points = catalog.docs.find((d) => d.name.startsWith('points_<'));
  for (const d of catalog.docs) if (d !== points) out.push({ name: d.name, doc: d.doc, cols: d.cols });
  if (points) for (const name of catalog.views.keys()) if (name.startsWith('points_')) out.push({ name, doc: points.doc, cols: points.cols });
  return out;
}

/** Tables mentioned after FROM / JOIN (or a comma) and the aliases they were given. */
function references(text: string, known: Map<string, Table>): { aliases: Map<string, Table>; used: Table[] } {
  const aliases = new Map<string, Table>();
  const used = new Set<Table>();
  const add = (name: string, alias: string | undefined) => {
    const t = known.get(name.toLowerCase());
    if (!t) return;
    used.add(t);
    aliases.set(name.toLowerCase(), t);
    if (alias && !RESERVED_ALIAS.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), t);
  };
  for (const m of text.matchAll(/\b(?:from|join)\s+([A-Za-z_]\w*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi)) add(m[1], m[2]);
  for (const m of text.matchAll(/,\s*([A-Za-z_]\w*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/g)) add(m[1], m[2]);
  return { aliases, used: [...used] };
}

/**
 * Autocomplete over the SQL editor: views and their columns, `alias.` / `view.` columns, keywords and DuckDB functions.
 * Context aware: after FROM or JOIN only views are offered; columns of the views already named in the query rank first.
 */
export function sqlCompletions(catalog: Catalog): CompletionSource {
  const tables = schemaOf(catalog);
  const known = new Map(tables.map((t) => [t.name.toLowerCase(), t]));

  const tableOpt = (t: Table, boost: number): Completion => ({ label: t.name, type: 'class', detail: TEXT.view, info: t.doc, boost });
  const colOpt = (c: ColDef, boost: number, owner?: string): Completion => ({
    label: c.name,
    type: 'property',
    detail: owner ? `${c.kind} - ${owner}` : c.kind,
    info: c.doc || undefined,
    boost,
  });
  const keywordOpts: Completion[] = KEYWORDS.map((k) => ({ label: k, type: 'keyword', detail: TEXT.keyword, boost: -1 }));
  const fnOpts: Completion[] = FUNCTIONS.map(([name, sig]) => ({
    label: name,
    type: 'function',
    detail: TEXT.fn,
    info: sig,
    boost: -2,
    apply(view, _c, from, to) {
      view.dispatch({ changes: { from, to, insert: `${name}()` }, selection: { anchor: from + name.length + 1 }, userEvent: 'input.complete' });
    },
  }));

  return (ctx: CompletionContext): CompletionResult | null => {
    const text = ctx.state.doc.toString();
    if (inLiteral(text, ctx.pos)) return null;
    const { aliases, used } = references(text, known);

    // "alias." or "view." followed by a partial column name
    const dotted = ctx.matchBefore(/[A-Za-z_]\w*\.\w*/);
    if (dotted) {
      const dot = dotted.text.indexOf('.');
      const t = aliases.get(dotted.text.slice(0, dot).toLowerCase()) ?? known.get(dotted.text.slice(0, dot).toLowerCase());
      if (!t) return null;
      return { from: dotted.from + dot + 1, options: t.cols.map((c) => colOpt(c, 0)), validFor: /^\w*$/ };
    }

    const word = ctx.matchBefore(/[A-Za-z_]\w*/);
    if (!word && !ctx.explicit) return null;
    const from = word ? word.from : ctx.pos;
    const before = text.slice(0, from).replace(/\s+$/, '');
    const prev = /([A-Za-z_]+)$/.exec(before)?.[1]?.toLowerCase();
    const afterFrom = (prev === 'from' || prev === 'join') && before.length < from;
    const afterComma = before.endsWith(',') && /\bfrom\b[^()]*$/i.test(before);

    if (afterFrom || afterComma) return { from, options: tables.map((t) => tableOpt(t, 0)), validFor: /^\w*$/ };

    const options: Completion[] = [];
    const cols = used.length ? used : [];
    const multi = used.length > 1;
    const seen = new Set<string>();
    for (const t of cols)
      for (const c of t.cols) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        options.push(colOpt(c, 5, multi ? t.name : undefined));
      }
    if (!used.length) {
      // no FROM yet (typing the SELECT list first): offer every distinct column name, ranked below the keywords
      for (const t of tables)
        for (const c of t.cols) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          options.push(colOpt(c, -3));
        }
    }
    options.push(...tables.map((t) => tableOpt(t, -1)), ...keywordOpts, ...fnOpts);
    return { from, options, validFor: /^\w*$/ };
  };
}
