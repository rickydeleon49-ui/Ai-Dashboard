import { isAccountsMode } from "@/lib/auth-mode";
import { runMigrations } from "./migrate";
import { startScheduler } from "@/core/automation/scheduler";

/**
 * Idempotent, run-once database preparation.
 *
 * The authoritative call is `src/instrumentation.ts`'s `register()`, which
 * Next.js invokes exactly once per server process — and, per its own
 * `prepareImpl()`/`ensureInstrumentationRegistered()` implementation, awaits
 * to completion (sharing one promise across any concurrent callers) *before*
 * the server is considered ready to handle any request. That closes the race
 * a per-route or per-layout call alone cannot: Next.js renders layouts and
 * pages in parallel, so `layout.tsx` calling this on its own never guaranteed
 * a sibling page's own repository query wouldn't run first against an
 * unmigrated database. Routed through `register()` instead, nothing can
 * reach a layout, page, or route handler at all until this has already
 * succeeded once for the process.
 *
 * Every route handler and the root layout also still call this directly —
 * not because they need to (that would be exactly the "readiness calls on
 * dozens of pages" this design avoids), but because it is a harmless,
 * already-satisfied no-op once `register()` has run, and a real safety net
 * if it somehow didn't (e.g. a future custom server that skips `prepare()`).
 *
 * In accounts mode, PostgreSQL is used and managed separately via
 * migrations, so SQLite preparation and desktop schedulers must never run —
 * safe to import these modules unconditionally here because `db/client.ts`'s
 * SQLite connection is opened lazily on first property access, not at
 * module evaluation, and `startScheduler()` itself no-ops in accounts mode.
 *
 * Readiness is recorded ONLY once `runMigrations()` returns successfully. A
 * thrown migration error leaves `ready` false and rethrows to the caller —
 * `register()` surfaces it as a failed server startup (Next.js's own
 * `prepareImpl()` fails, so the process never starts accepting requests),
 * rather than this module silently treating a half-migrated database as
 * ready. `runMigrations()` is idempotent (Drizzle only applies migrations
 * not yet recorded in `__drizzle_migrations`), so retrying — whether via a
 * restarted process picking `register()` back up, or a later request
 * reaching one of the per-route calls above if `register()` itself never
 * ran — is always safe.
 *
 * No promise or lock bookkeeping is needed for callers that *do* race within
 * one process: `runMigrations()` and `startScheduler()` are both fully
 * synchronous (no `await` anywhere in their call graph — better-sqlite3 has
 * no async API), so once a caller enters this function nothing else runs on
 * the single JS thread until it returns or throws. A concurrent caller from
 * another in-flight request can only ever observe `ready` as not-yet-true or
 * already-true — never a partially migrated state.
 */
let ready = false;

export function ensureDatabaseReady(): void {
  if (isAccountsMode() || Boolean(process.env.DATABASE_URL)) return;
  if (ready) return;

  runMigrations();
  ready = true;
  startScheduler();
}

/** Test-only: true once migrations have completed successfully this process. */
export function isDatabaseReady(): boolean {
  return ready;
}

/**
 * Test-only: clears readiness so the next `ensureDatabaseReady()` call
 * re-attempts migration, e.g. after a test deliberately forces a failure.
 */
export function resetDatabaseReadyForTesting(): void {
  ready = false;
}
