import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

export interface Db {
  db: duckdb.AsyncDuckDB;
  /** Shared connection; callers that run long or concurrent queries should open their own with db.connect(). */
  conn: duckdb.AsyncDuckDBConnection;
}

let pending: Promise<Db> | undefined;

async function start(): Promise<Db> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return { db, conn: await db.connect() };
}

/** The DuckDB-WASM engine, loaded once and shared by the static data source and the explorer. */
export function getDb(): Promise<Db> {
  pending ??= start().catch((e) => {
    pending = undefined; // allow a retry after a failed load
    throw e;
  });
  return pending;
}
