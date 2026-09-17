import { isAccountsMode } from "@/lib/auth-mode";
import { runMigrations } from "./migrate";
import { startScheduler } from "@/core/automation/scheduler";

/**
 * Idempotent, run-once database preparation.
 *
 * Called at the top of the dashboard layout so that a fresh clone (or a fresh
 * Railway volume) works on first request without a manual migrate step.
 * In accounts mode, PostgreSQL is used and managed separately via migrations,
 * so SQLite preparation and desktop schedulers must never run — safe to import
 * these modules unconditionally here because `db/client.ts`'s SQLite connection
 * is opened lazily on first property access, not at module evaluation, and
 * `startScheduler()` itself no-ops in accounts mode.
 */
let ready = false;

export function ensureDatabaseReady(): void {
  if (isAccountsMode() || Boolean(process.env.DATABASE_URL)) return;
  if (ready) return;
  ready = true;

  runMigrations();
  startScheduler();
}
