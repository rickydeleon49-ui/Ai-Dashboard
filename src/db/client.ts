// Server-only by construction: this module loads better-sqlite3, a native addon that
// cannot be bundled for the browser. It deliberately omits the `server-only` guard
// so that the migrate and seed CLI scripts can import it under plain Node.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { resolveDatabasePath } from "./path";

/**
 * A single long-lived SQLite connection per process.
 *
 * Next.js dev-mode module reloading would otherwise open a new handle on every
 * edit, so the instance is cached on globalThis.
 */
const globalForDb = globalThis as unknown as {
  __dashboardDb?: Database.Database;
};

function createConnection(): Database.Database {
  const file = resolveDatabasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const connection = new Database(file);
  // WAL keeps reads non-blocking while a write is in flight.
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  connection.pragma("busy_timeout = 5000");
  return connection;
}

export const sqlite = globalForDb.__dashboardDb ?? createConnection();
if (process.env.NODE_ENV !== "production") globalForDb.__dashboardDb = sqlite;

export const db = drizzle(sqlite, { schema });
export { schema };
