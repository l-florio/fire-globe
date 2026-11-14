const TEXT = {
  empty: 'Write a query first.',
  multi: 'Query refused: only one statement is allowed.',
  notSelect: 'Query refused: only read-only SELECT queries (or WITH ... SELECT) are allowed.',
  keyword: 'Query refused: {k} is not allowed, only read-only SELECT queries run here. Quote a column with that name ("name").',
  unterminated: 'Query refused: an unterminated string, quoted name or comment.',
  escapeString: "Query refused: E'...' strings are not supported; use a plain '...' string.",
} as const;

const FORBIDDEN = [
  'insert', 'update', 'delete', 'create', 'drop', 'alter', 'copy', 'attach', 'detach', 'install', 'load', 'pragma', 'set', 'reset',
  'export', 'import', 'call', 'checkpoint', 'vacuum', 'use',
];
const STARTS = ['select', 'with', 'from'];

/**
 * The query with comments removed and every string literal or quoted name emptied, so that only real SQL tokens
 * remain. Returns undefined when a string, quoted name or comment is not closed.
 */
function stripLiterals(sql: string): string | undefined {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? n : e;
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const p = sql.slice(i, i + 2);
        if (p === '/*') (depth++, (i += 2));
        else if (p === '*/') (depth--, (i += 2));
        else i++;
      }
      if (depth > 0) return undefined;
      out += ' ';
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) return undefined;
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += c === "'" ? "''" : '""';
      i = j + 1;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (!tag) {
        out += c;
        i++;
        continue;
      }
      const e = sql.indexOf(tag, i + tag.length);
      if (e < 0) return undefined;
      out += "''";
      i = e + tag.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** First problem that makes a user query unacceptable (read-only, one statement), or undefined when it passes. */
export function guardSql(sql: string): string | undefined {
  const code = stripLiterals(sql);
  if (code === undefined) return TEXT.unterminated;
  const body = code.trim().replace(/;[\s;]*$/, '');
  if (!body) return TEXT.empty;
  if (body.includes(';')) return TEXT.multi;
  if (/(^|[^A-Za-z0-9_$])[eE]''/.test(body)) return TEXT.escapeString;
  const words = body.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? [];
  if (!STARTS.includes(words[0] ?? '')) return TEXT.notSelect;
  const bad = words.find((w) => FORBIDDEN.includes(w));
  return bad ? TEXT.keyword.replace('{k}', bad.toUpperCase()) : undefined;
}
