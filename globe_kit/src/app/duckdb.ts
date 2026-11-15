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

/** A load attempt with no progress for this long is abandoned and retried (a stuck request never ends by itself). */
const STALL_MS = 15_000;
const ATTEMPTS = 3;

let pending: Promise<Db> | undefined;

/** One load attempt. Retries add a query string to the worker and module URLs so that a stuck request is not reused. */
async function attempt(n: number): Promise<Db> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  const fresh = (u: string) => (n ? `${u}${u.includes('?') ? '&' : '?'}retry=${n}` : u);
  const worker = new Worker(fresh(bundle.mainWorker!));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let arm = () => {};
  const stalled = new Promise<never>((_, reject) => {
    arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new Error(`data engine: no progress for ${STALL_MS / 1000} s`)), STALL_MS);
    };
  });
  arm();
  try {
    // Every download progress event of the module restarts the watchdog: a slow but moving download is not cut.
    await Promise.race([db.instantiate(fresh(bundle.mainModule), bundle.pthreadWorker, () => arm()), stalled]);
    arm();
    const conn = await Promise.race([db.connect(), stalled]);
    return { db, conn };
  } catch (e) {
    worker.terminate();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function start(): Promise<Db> {
  for (let n = 0; ; n++) {
    try {
      return await attempt(n);
    } catch (e) {
      console.warn('DuckDB-WASM load attempt failed', n + 1, e);
      if (n + 1 >= ATTEMPTS) throw e;
    }
  }
}

/** The DuckDB-WASM engine, loaded once and shared by the static data source and the explorer. */
export function getDb(): Promise<Db> {
  pending ??= start().catch((e) => {
    pending = undefined; // allow a retry after a failed load
    throw e;
  });
  return pending;
}
