/**
 * Runs once per server process, before Next.js accepts any request.
 *
 * This is the fresh-start readiness boundary: `register()` is called from
 * `prepareImpl()` inside Next.js's own server bootstrap (see
 * `ensureInstrumentationRegistered()` in
 * `next/dist/server/lib/router-utils/instrumentation-globals.external.js`),
 * awaited there before the server is considered ready to serve anything.
 * Concurrent invocations of that framework-level call already share one
 * cached promise, so migrations can never run twice in parallel; a rejected
 * `register()` call propagates out of `prepareImpl()` and fails server
 * startup outright, rather than letting the process come up half-ready.
 *
 * That guarantee is what layout- or page-level calls to
 * `ensureDatabaseReady()` alone cannot provide: Next.js renders layouts and
 * pages in parallel (see "Parallel data fetching" in the framework's own
 * data-fetching guide), so a page's own repository query is never guaranteed
 * to run after its layout's readiness call. Routed through here instead,
 * nothing in the app can be reached by any request — layout, page, or route
 * handler — until this has already completed.
 *
 * `NEXT_RUNTIME` is checked because Next.js also calls `register()` for an
 * Edge runtime instance if one exists in this deployment; better-sqlite3 is
 * a native Node addon (`serverExternalPackages` in next.config.ts) and must
 * never be reached from there. This app has no Edge-runtime entry point
 * today, but the guard is the documented, no-cost way to keep it that way.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureDatabaseReady } = await import("@/db/bootstrap");
  ensureDatabaseReady();
}
