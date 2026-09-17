// Server-only by construction: this module loads better-sqlite3, a native addon that
// cannot be bundled for the browser. It deliberately omits the `server-only` guard
// so that the migrate and seed CLI scripts can import it under plain Node.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { resolveDatabasePath } from "./path";
import { isAccountsMode } from "@/lib/auth-mode";

/**
 * A single long-lived SQLite connection per process.
 *
 * Next.js dev-mode module reloading would otherwise open a new handle on every
 * edit, so the instance is cached on globalThis.
 */
const globalForDb = globalThis as unknown as {
  __dashboardDb?: Database.Database;
};

interface LegacyScopeToken {
  active: boolean;
}

const legacyAccessStorage = new AsyncLocalStorage<LegacyScopeToken>();

export function isLegacySqliteAccessAllowed(): boolean {
  return legacyAccessStorage.getStore()?.active === true;
}

/**
 * Scopes explicit, temporary access to the legacy SQLite database.
 * Used exclusively for reading/migrating legacy single-password/desktop data
 * into PostgreSQL during ownership claim operations and migration tests.
 *
 * Guarantees:
 * - Scoped via AsyncLocalStorage with a revocable scope token: concurrent accounts
 *   requests on separate async contexts cannot inherit or see this access.
 * - Revocation: the scope token's active flag is set to false in finally before
 *   closing connections, revoking authorization from detached timers, unawaited
 *   promises, and async descendants.
 * - Auto-cleanup: cleans up and closes the connection in a finally block so no handle leaks.
 * - Always restores default-deny state, even on uncaught errors or failed setup.
 */
export async function withLegacySqliteAccess<T>(fn: () => Promise<T> | T): Promise<T> {
  const token: LegacyScopeToken = { active: true };
  return legacyAccessStorage.run(token, async () => {
    try {
      return await fn();
    } finally {
      token.active = false;
      closeConnection();
    }
  });
}

function createConnection(): Database.Database {
  if (!isLegacySqliteAccessAllowed() && (isAccountsMode() || Boolean(process.env.DATABASE_URL))) {
    throw new Error(
      "SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured.",
    );
  }

  const file = resolveDatabasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const connection = new Database(file);
  // Set before any other pragma. Next.js runs several build workers as
  // separate processes against this same file, each running migrations on
  // first connect; without a timeout in place first, the next pragma call
  // below can land mid another worker's write lock and fail immediately
  // with SQLITE_BUSY instead of waiting for it to release.
  connection.pragma("busy_timeout = 5000");
  // WAL keeps reads non-blocking while a write is in flight.
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  return connection;
}

function getSqlite(): Database.Database {
  if (!isLegacySqliteAccessAllowed() && (isAccountsMode() || Boolean(process.env.DATABASE_URL))) {
    throw new Error(
      "SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured.",
    );
  }
  if (!globalForDb.__dashboardDb) {
    globalForDb.__dashboardDb = createConnection();
  }
  return globalForDb.__dashboardDb;
}

let cachedDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  getSqlite();
  if (!cachedDb) {
    cachedDb = drizzle(getSqlite(), { schema });
  }
  return cachedDb;
}

export const sqlite = new Proxy({} as Database.Database, {
  get(_target, prop, receiver) {
    const conn = getSqlite();
    const val = Reflect.get(conn, prop, receiver);
    if (typeof val === "function") {
      return val.bind(conn);
    }
    return val;
  },
  has(_target, prop) {
    return Reflect.has(getSqlite(), prop);
  },
});

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    const realDb = getDb();
    const val = Reflect.get(realDb, prop, receiver);
    if (typeof val === "function") {
      return val.bind(realDb);
    }
    return val;
  },
  has(_target, prop) {
    return Reflect.has(getDb(), prop);
  },
});

export { schema };

/**
 * Closes the connection. Tests use this before deleting the temporary
 * directory that holds their throwaway database: on Windows, an open SQLite
 * file cannot be removed, so skipping this turns every cleanup into an
 * `EPERM` rather than a no-op.
 */
export function closeConnection(): void {
  try {
    if (globalForDb.__dashboardDb?.open) {
      globalForDb.__dashboardDb.close();
    }
  } finally {
    globalForDb.__dashboardDb = undefined;
    cachedDb = undefined;
  }
}
