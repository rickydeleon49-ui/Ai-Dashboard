import { createRequire } from "node:module";
import { isAccountsMode } from "@/lib/auth-mode";

const require = createRequire(import.meta.url);

/**
 * Idempotent, run-once database preparation.
 *
 * Called at the top of the dashboard layout so that a fresh clone (or a fresh
 * Railway volume) works on first request without a manual migrate step.
 * In accounts mode, PostgreSQL is used and managed separately via migrations,
 * so SQLite preparation and desktop schedulers must never run.
 */
let ready = false;

export function ensureDatabaseReady(): void {
  if (isAccountsMode() || Boolean(process.env.DATABASE_URL)) return;
  if (ready) return;
  ready = true;

  // Run SQLite migrations and start the local scheduler synchronously in
  // desktop and single-password modes. Dynamically required here so that
  // accounts mode never imports SQLite migrators or clients at module evaluation.
  const { runMigrations } = require("./migrate");
  const { startScheduler } = require("@/core/automation/scheduler");
  runMigrations();
  startScheduler();
}
