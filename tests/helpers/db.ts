/**
 * A throwaway database per test file.
 *
 * DATABASE_PATH and UPLOADS_DIR are configured before callers import or query
 * application modules so the lazy SQLite connection and uploads storage resolve
 * to this test run's isolated temporary directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "cc-test-"));

process.env.DATABASE_PATH = path.join(root, "test.db");
process.env.UPLOADS_DIR = path.join(root, "uploads");

export const testRoot = root;

export async function cleanup(): Promise<void> {
  // Closed before the directory holding it is removed: Windows cannot delete
  // a file an open handle still references, so skipping this turns every
  // cleanup into an EPERM there instead of a no-op.
  const { stopScheduler } = await import("../../src/core/automation/scheduler");
  stopScheduler();
  const { closeConnection } = await import("../../src/db/client");
  closeConnection();
  rmSync(root, { recursive: true, force: true });
}

/** Applies the schema. Imported lazily so the env above is already in place. */
export async function migrate(): Promise<void> {
  const { withLegacySqliteAccess } = await import("../../src/db/client");
  await withLegacySqliteAccess(async () => {
    const { runMigrations } = await import("../../src/db/migrate");
    runMigrations();
  });
}

/**
 * Scopes explicit temporary access to the test legacy SQLite database.
 * Used by ownership migration integration suites while PostgreSQL is active.
 */
export async function withLegacySqlite<T>(fn: () => Promise<T> | T): Promise<T> {
  const { withLegacySqliteAccess } = await import("../../src/db/client");
  return withLegacySqliteAccess(fn);
}
