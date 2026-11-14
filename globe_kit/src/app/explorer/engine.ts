import { getDb } from '../duckdb';
import { buildCatalog, ROW_CAP, type Catalog, type Manifest } from './datasets';
import { guardSql } from './sqlguard';
import { ql } from './util';

const TEXT = {
  noManifest: 'The data catalog (static.json) could not be loaded.',
  notSelect: 'Refused: only read-only SELECT queries are allowed.',
  oneStatement: 'Refused: only one statement is allowed.',
} as const;

/**
 * refused: blocked by the read-only guard, never sent to DuckDB; syntax: DuckDB's parser rejected the text;
 * runtime: the query parsed but failed while binding or running (unknown table or column, type error, network...).
 */
export type QueryErrorKind = 'refused' | 'syntax' | 'runtime';

export class QueryError extends Error {
  constructor(
    message: string,
    readonly kind: QueryErrorKind,
    /** 1-based line and column of a syntax error, when DuckDB reports a position. */
    readonly line?: number,
    readonly col?: number,
  ) {
    super(message);
  }
}

/** DuckDB's parser message without its "Parser Error:" label and echoed "LINE n:" excerpt; position from either source. */
function parserError(sql: string, j: { error_message?: string; position?: string | number }): QueryError {
  const raw = (j.error_message ?? '').trim();
  let msg = raw.replace(/^[A-Za-z ]*Error:\s*/, '');
  const m = /\s*LINE (\d+):/.exec(msg);
  let line = m ? Number(m[1]) : undefined;
  let col: number | undefined;
  if (m) msg = msg.slice(0, m.index).trim();
  const pos = j.position === undefined ? NaN : Number(j.position);
  if (Number.isFinite(pos) && pos >= 0 && pos <= sql.length) {
    const upto = sql.slice(0, pos).split(/\r?\n/);
    line = upto.length;
    col = upto[upto.length - 1].length + 1;
  }
  return new QueryError(msg || raw || 'syntax error', 'syntax', line, col);
}

export type Row = Record<string, unknown>;
export interface ResultCol {
  name: string;
  kind: 'num' | 'text' | 'date';
}
export interface QueryResult {
  cols: ResultCol[];
  rows: Row[];
  ms: number;
  /** More rows than the cap were available. */
  truncated: boolean;
}

export interface Engine {
  catalog: Catalog;
  run(sql: string, cap?: number): Promise<QueryResult>;
  /** Run a query typed by the user: refused unless it is a single read-only SELECT. */
  runUser(sql: string, cap?: number): Promise<QueryResult>;
  count(sql: string): Promise<number>;
  cancel(): void;
}

/** A final `;` with only blanks and comments after it (the guard has already ruled out a second statement). */
const TRAILING_SEMICOLON = /;(?:\s|;|--[^\n]*|\/\*[\s\S]*?\*\/)*$/;

// Apache Arrow type ids (stable numbers of the Arrow format).
const ARROW = { Int: 2, Float: 3, Decimal: 7, Date: 8, Timestamp: 10, Bool: 6 };

type ArrowTable = Awaited<ReturnType<Awaited<ReturnType<typeof getDb>>['conn']['query']>>;

/** Decimal128 value (4 little-endian 32-bit words) to a number. */
function decimalToNumber(raw: unknown, scale: number): number {
  if (typeof raw === 'bigint') return Number(raw) / 10 ** scale;
  if (typeof raw === 'number') return raw;
  const words = raw as Uint32Array;
  let v = 0n;
  for (let i = 3; i >= 0; i--) v = (v << 32n) | BigInt(words[i]);
  if (words[3] & 0x80000000) v -= 1n << 128n;
  return Number(v) / 10 ** scale;
}

function converter(typeId: number, scale: number): { kind: ResultCol['kind']; fn: (v: unknown) => unknown } {
  switch (typeId) {
    case ARROW.Int:
    case ARROW.Float:
      return { kind: 'num', fn: (v) => (typeof v === 'bigint' ? Number(v) : v) };
    case ARROW.Decimal:
      return { kind: 'num', fn: (v) => decimalToNumber(v, scale) };
    case ARROW.Date:
      return { kind: 'date', fn: (v) => new Date(v instanceof Date ? v.getTime() : Number(v)).toISOString().slice(0, 10) };
    case ARROW.Timestamp:
      return { kind: 'date', fn: (v) => new Date(v instanceof Date ? v.getTime() : Number(v)).toISOString().replace('T', ' ').slice(0, 19) };
    case ARROW.Bool:
      return { kind: 'text', fn: (v) => String(v) };
    default:
      return { kind: 'text', fn: (v) => (typeof v === 'string' ? v : String(v)) };
  }
}

function toResult(t: ArrowTable, cap: number): Omit<QueryResult, 'ms'> {
  const seen = new Map<string, number>();
  const fields = t.schema.fields.map((f, i) => {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    const type = f.type as unknown as { typeId: number; scale?: number };
    return { name: n > 1 ? `${f.name}_${n}` : f.name, vec: t.getChildAt(i)!, ...converter(type.typeId, type.scale ?? 0) };
  });
  const n = Math.min(t.numRows, cap);
  const rows: Row[] = new Array(n);
  for (let j = 0; j < n; j++) {
    const r: Row = {};
    for (const f of fields) {
      const v = f.vec.get(j);
      r[f.name] = v === null || v === undefined ? null : f.fn(v);
    }
    rows[j] = r;
  }
  return { cols: fields.map((f) => ({ name: f.name, kind: f.kind })), rows, truncated: t.numRows > cap };
}

/** Read queries get an outer LIMIT so a huge result never reaches the page; other statements run as written. */
function capped(sql: string, cap: number): string {
  const body = sql.trim().replace(/;+\s*$/, '');
  return /^(with|select|from)\b/i.test(body) ? `SELECT * FROM (\n${body}\n) LIMIT ${cap + 1}` : body;
}

export async function createEngine(baseUrl: string): Promise<Engine> {
  const res = await fetch(`${baseUrl}static.json`).catch(() => undefined);
  if (!res?.ok) throw new Error(TEXT.noManifest);
  const man = (await res.json()) as Manifest;
  const gfed = await fetch(`${import.meta.env.BASE_URL}regions_gfed.json`)
    .then((r) => (r.ok ? (r.json() as Promise<{ regions: { code: string; name: string }[] }>) : undefined))
    .catch(() => undefined);
  const catalog = buildCatalog(man, Object.fromEntries((gfed?.regions ?? []).map((g) => [g.code, g.name])));

  const { db } = await getDb();
  const conn = await db.connect(); // own connection: explorer queries never interleave with the globe's
  const dataBase = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`, document.baseURI).href;
  const expand = (sql: string) => sql.replaceAll('{data}/', dataBase);

  const names = Object.entries(catalog.gfedNames).map(([c, n]) => `(${ql(c)}, ${ql(n)})`);
  await conn.query(
    names.length
      ? `CREATE OR REPLACE TABLE region_names AS SELECT * FROM (VALUES ${names.join(', ')}) t(code, name)`
      : 'CREATE OR REPLACE TABLE region_names (code VARCHAR, name VARCHAR)',
  );
  // Setup is over: user SQL cannot change any setting from here on.
  await conn.query('SET lock_configuration = true');

  const made = new Set<string>();
  /** Views are created the first time a query mentions them: binding one reads a file footer over HTTP. */
  async function ensureViews(sql: string) {
    const bare = sql.replace(/'(?:[^']|'')*'/g, "''").toLowerCase();
    for (const tok of new Set(bare.match(/[a-z_][a-z0-9_]*/g) ?? [])) {
      const def = catalog.views.get(tok);
      if (!def || made.has(tok)) continue;
      await conn.query(`CREATE OR REPLACE VIEW ${tok} AS ${expand(def)}`);
      made.add(tok);
    }
  }

  /** DuckDB's own parser: json_serialize_sql only accepts SELECT statements and lists every statement it finds. */
  async function checkWithDuckDb(sql: string): Promise<void> {
    const stmt = await conn.prepare('SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS j');
    try {
      const t = await stmt.query(sql);
      const j = JSON.parse(String(t.getChild('j')!.get(0))) as { error: boolean; error_type?: string; error_message?: string; position?: string | number; statements?: unknown[] };
      if (j.error) throw j.error_type === 'parser' && j.error_message ? parserError(sql, j) : new QueryError(TEXT.notSelect, 'refused');
      if (j.statements?.length !== 1) throw new QueryError(TEXT.oneStatement, 'refused');
    } finally {
      await stmt.close();
    }
  }

  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => undefined);
    return p;
  };

  const run = (sql: string, cap = ROW_CAP) =>
    serial(async () => {
      const t0 = performance.now();
      try {
        await ensureViews(sql);
        const t = await conn.query(expand(capped(sql, cap)));
        return { ...toResult(t, cap), ms: performance.now() - t0 };
      } catch (e) {
        if (e instanceof QueryError) throw e;
        // The query runs wrapped as "SELECT * FROM (\n<query>\n) LIMIT n": DuckDB's "LINE n:" refers to the
        // wrapped text, one line below the user's; report the user's line and drop the echoed excerpt.
        const raw = e instanceof Error ? e.message : String(e);
        const m = /\s*LINE (\d+):/.exec(raw);
        const line = m ? Math.max(1, Number(m[1]) - (/^(with|select|from)\b/i.test(sql.trim()) ? 1 : 0)) : undefined;
        throw new QueryError(m ? raw.slice(0, m.index).trim() : raw, 'runtime', line);
      }
    });

  return {
    catalog,
    run,
    runUser: async (sql, cap) => {
      const refused = guardSql(sql);
      if (refused) throw new QueryError(refused, 'refused');
      const query = expand(sql.replace(TRAILING_SEMICOLON, ''));
      await serial(() => checkWithDuckDb(query));
      return run(query, cap);
    },
    count: (sql) =>
      serial(async () => {
        await ensureViews(sql);
        const t = await conn.query(expand(`SELECT count(*) AS c FROM (\n${sql}\n)`));
        return Number(t.getChild('c')!.get(0));
      }),
    cancel() {
      void conn.cancelSent().catch(() => undefined);
    },
  };
}
