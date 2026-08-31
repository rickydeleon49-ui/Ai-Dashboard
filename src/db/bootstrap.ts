import { runMigrations } from "./migrate";
import { startScheduler } from "@/core/automation/scheduler";

/**
 * Idempotent, run-once database preparation.
 *
 * Called at the top of the dashboard layout so that a fresh clone (or a fresh
 * Railway volume) works on first request without a manual migrate step.
 */
let ready = false;

export function ensureDatabaseReady(): void {
  if (ready) return;
  runMigrations();
  ready = true;

  // Started here rather than at module load so it can never run before the
  // tables it queries exist.
  startScheduler();
}
