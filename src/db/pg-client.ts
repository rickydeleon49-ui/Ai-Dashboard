// Server-only by construction, same as client.ts: this loads `pg`, a native
// binding not meant for the browser. Omits the `server-only` guard so the
// migrate CLI script can import it under plain Node.
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.pg";
import { resolveDatabaseUrl } from "./path";

/**
 * One pooled connection per process, cached on globalThis for the same reason
 * as client.ts's SQLite handle: Next.js dev-mode module reloading would
 * otherwise open a new pool on every edit.
 *
 * Unlike SQLite there is no single "the" connection to open eagerly at module
 * load — hosted multi-user mode is optional, and importing this module must
 * not itself require DATABASE_URL to be set (schema.pg.ts's placeholder state,
 * and code that merely checks whether hosted mode is available, both need to
 * import this safely). The pool is created lazily, on first real use.
 */
const globalForDb = globalThis as unknown as {
  __dashboardPgPool?: Pool;
};

function createPool(): Pool {
  const url = resolveDatabaseUrl();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Hosted multi-user mode requires a Postgres " +
        "connection string; desktop and today's single-password hosted mode " +
        "never need this.",
    );
  }
  return new Pool({ connectionString: url });
}

function getPool(): Pool {
  if (!globalForDb.__dashboardPgPool) {
    globalForDb.__dashboardPgPool = createPool();
  }
  return globalForDb.__dashboardPgPool;
}

let cachedDb: NodePgDatabase<typeof schema> | undefined;

/** The Postgres drizzle client. Throws if DATABASE_URL is not configured. */
export function getPgDb(): NodePgDatabase<typeof schema> {
  if (!cachedDb) cachedDb = drizzle(getPool(), { schema });
  return cachedDb;
}

export { schema as pgSchema };

/** Runs a function using a dedicated client from the pool (e.g. for advisory locks). */
export async function withPgClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Closes the pool. Tests use this so a throwaway database can be dropped afterward. */
export async function closePgPool(): Promise<void> {
  if (globalForDb.__dashboardPgPool) {
    await globalForDb.__dashboardPgPool.end();
    globalForDb.__dashboardPgPool = undefined;
    cachedDb = undefined;
  }
}
