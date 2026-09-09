/**
 * A throwaway database per test file.
 *
 * DATABASE_PATH and UPLOADS_DIR must be set before anything imports the client,
 * because it opens the connection at module load. Callers therefore import this
 * module first and use its dynamic `load` helpers rather than importing the
 * application modules at the top of the file.
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
  const { closeConnection } = await import("../../src/db/client");
  closeConnection();
  rmSync(root, { recursive: true, force: true });
}

/** Applies the schema. Imported lazily so the env above is already in place. */
export async function migrate(): Promise<void> {
  const { runMigrations } = await import("../../src/db/migrate");
  runMigrations();
}
