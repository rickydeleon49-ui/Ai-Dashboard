/**
 * Regression coverage for the fresh-start readiness boundary
 * (`src/instrumentation.ts` + `src/db/bootstrap.ts`).
 *
 * Root cause this guards against: `ensureDatabaseReady()` used to set its
 * `ready` flag *before* `runMigrations()` had actually succeeded, so a
 * migration failure left the process permanently — and silently — marked
 * ready. Separately, calling it only from `layout.tsx` never guaranteed a
 * sibling page's own repository query ran after it, since Next.js renders
 * layouts and pages in parallel (see the app-router "fetching data" guide's
 * own "Parallel data fetching" section, and the HTTP-level reproduction in
 * `tests/e2e/fresh-start-readiness.test.ts`). Every test below exercises
 * that fix from outside `bootstrap.ts`'s public surface — nothing here reads
 * or mutates its private `ready` variable directly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SNAPSHOT_KEYS = [
  "DATABASE_PATH",
  "UPLOADS_DIR",
  "DATABASE_URL",
  "AUTH_MODE",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_DISABLE_SCHEDULER",
  "NEXT_RUNTIME",
] as const;

const env = process.env as Record<string, string | undefined>;
let envSnapshot: Record<string, string | undefined>;

function snapshotEnv(): void {
  envSnapshot = {};
  for (const k of SNAPSHOT_KEYS) envSnapshot[k] = env[k];
}

function restoreEnv(): void {
  for (const k of SNAPSHOT_KEYS) {
    if (envSnapshot[k] === undefined) delete env[k];
    else env[k] = envSnapshot[k];
  }
}

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fresh-start-readiness-"));
}

describe("Fresh-start readiness boundary", () => {
  describe("desktop mode: successful migration on a brand-new database", () => {
    let root: string;

    beforeEach(async () => {
      snapshotEnv();
      root = freshRoot();
      env.DATABASE_PATH = path.join(root, "fresh.db");
      env.UPLOADS_DIR = path.join(root, "uploads");
      delete env.DATABASE_URL;
      delete env.AUTH_MODE;
      delete env.DASHBOARD_PASSWORD;

      const { resetDatabaseReadyForTesting } = await import("../../src/db/bootstrap");
      const { closeConnection } = await import("../../src/db/client");
      closeConnection();
      resetDatabaseReadyForTesting();
    });

    afterEach(async () => {
      const { closeConnection } = await import("../../src/db/client");
      const { resetSchedulerForTesting } = await import("../../src/core/automation/scheduler");
      resetSchedulerForTesting();
      closeConnection();
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("is not ready before the first call, and ready only after it succeeds", async () => {
      const { ensureDatabaseReady, isDatabaseReady } = await import("../../src/db/bootstrap");
      assert.equal(isDatabaseReady(), false);

      ensureDatabaseReady();

      assert.equal(isDatabaseReady(), true);
    });

    it("creates the schema before any repository query can run — the required table exists immediately after", async () => {
      const { ensureDatabaseReady } = await import("../../src/db/bootstrap");
      const { sqlite } = await import("../../src/db/client");

      ensureDatabaseReady();

      const row = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
        .get();
      assert.ok(row, "the projects table must exist immediately after ensureDatabaseReady()");

      // A real repository query — the thing a page component actually does —
      // must succeed against the freshly migrated, still-empty database.
      const { projectRepository, LOCAL_WORKSPACE_ID } = await import("../../src/db/repositories");
      const stats = await projectRepository.stats(LOCAL_WORKSPACE_ID);
      assert.equal(stats.total, 0);
    });

    it("starts the scheduler only after migration succeeds, and only once", async () => {
      const { ensureDatabaseReady } = await import("../../src/db/bootstrap");
      const { isSchedulerRunning } = await import("../../src/core/automation/scheduler");
      assert.equal(isSchedulerRunning(), false);

      ensureDatabaseReady();
      assert.equal(isSchedulerRunning(), true);

      // Idempotent: a second call must not error or double-start it.
      ensureDatabaseReady();
      assert.equal(isSchedulerRunning(), true);
    });

    it("treats many same-tick callers safely — migration work still only completes once", async () => {
      const { ensureDatabaseReady, isDatabaseReady } = await import("../../src/db/bootstrap");
      const { sqlite } = await import("../../src/db/client");

      // Simulates several request handlers (route handlers, the root layout)
      // each calling this independently around the same event-loop turn.
      const callers = Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => ensureDatabaseReady()),
      );
      await assert.doesNotReject(Promise.all(callers));

      assert.equal(isDatabaseReady(), true);
      const migrationRows = sqlite
        .prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations")
        .get() as { n: number };
      // Exactly the migrations that exist on disk were applied exactly once —
      // not zero (never ran) and not duplicated (ran unsafely more than once).
      const journal = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      assert.equal(migrationRows.n, journal.entries.length);
    });
  });

  describe("desktop mode: migration failure does not mark readiness successful", () => {
    let root: string;
    let blockedDbPath: string;

    beforeEach(async () => {
      snapshotEnv();
      root = freshRoot();
      // A file, not a directory, sits where the database's parent directory
      // needs to be created — createConnection()'s fs.mkdirSync(..., {
      // recursive: true }) fails with ENOTDIR before better-sqlite3 ever
      // opens a handle, giving a real (not mocked) migration failure.
      const blockingFile = path.join(root, "not-a-directory");
      fs.writeFileSync(blockingFile, "");
      blockedDbPath = path.join(blockingFile, "sub", "fresh.db");
      env.DATABASE_PATH = blockedDbPath;
      env.UPLOADS_DIR = path.join(root, "uploads");
      delete env.DATABASE_URL;
      delete env.AUTH_MODE;
      delete env.DASHBOARD_PASSWORD;

      const { resetDatabaseReadyForTesting } = await import("../../src/db/bootstrap");
      const { closeConnection } = await import("../../src/db/client");
      closeConnection();
      resetDatabaseReadyForTesting();
    });

    afterEach(async () => {
      const { closeConnection } = await import("../../src/db/client");
      const { resetSchedulerForTesting } = await import("../../src/core/automation/scheduler");
      resetSchedulerForTesting();
      closeConnection();
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("rethrows, leaves readiness false, and never starts the scheduler", async () => {
      const { ensureDatabaseReady, isDatabaseReady } = await import("../../src/db/bootstrap");
      const { isSchedulerRunning } = await import("../../src/core/automation/scheduler");

      assert.throws(() => ensureDatabaseReady());

      assert.equal(isDatabaseReady(), false, "a failed migration must not be recorded as ready");
      assert.equal(isSchedulerRunning(), false, "the scheduler must not start after a failed migration");
    });

    it("a permitted retry after the underlying problem is fixed succeeds safely", async () => {
      const { ensureDatabaseReady, isDatabaseReady } = await import("../../src/db/bootstrap");
      assert.throws(() => ensureDatabaseReady());
      assert.equal(isDatabaseReady(), false);

      // Fix the underlying problem (point at a real, writable path) and
      // retry — exactly what a restarted process or a later request does.
      const { closeConnection } = await import("../../src/db/client");
      closeConnection();
      env.DATABASE_PATH = path.join(root, "recovered.db");

      ensureDatabaseReady();

      assert.equal(isDatabaseReady(), true);
      const { sqlite } = await import("../../src/db/client");
      const row = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
        .get();
      assert.ok(row, "the retried migration must have actually applied the schema");
    });
  });

  describe("existing, already-migrated database", () => {
    let root: string;
    let dbPath: string;

    beforeEach(async () => {
      snapshotEnv();
      root = freshRoot();
      dbPath = path.join(root, "existing.db");
      env.DATABASE_PATH = dbPath;
      env.UPLOADS_DIR = path.join(root, "uploads");
      delete env.DATABASE_URL;
      delete env.AUTH_MODE;
      delete env.DASHBOARD_PASSWORD;

      const { resetDatabaseReadyForTesting } = await import("../../src/db/bootstrap");
      const { closeConnection } = await import("../../src/db/client");
      closeConnection();
      resetDatabaseReadyForTesting();
    });

    afterEach(async () => {
      const { closeConnection } = await import("../../src/db/client");
      const { resetSchedulerForTesting } = await import("../../src/core/automation/scheduler");
      resetSchedulerForTesting();
      closeConnection();
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("starts normally against a database migrated by an earlier process run", async () => {
      const { ensureDatabaseReady, resetDatabaseReadyForTesting, isDatabaseReady } = await import(
        "../../src/db/bootstrap"
      );
      const { closeConnection } = await import("../../src/db/client");

      // First "process run": migrates a fresh database, same as any earlier
      // install would have.
      ensureDatabaseReady();
      assert.equal(isDatabaseReady(), true);
      closeConnection();
      resetDatabaseReadyForTesting();

      // Second "process run" (e.g. the app reopened) against that same,
      // already-migrated database file.
      ensureDatabaseReady();
      assert.equal(isDatabaseReady(), true);

      const { sqlite } = await import("../../src/db/client");
      const row = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
        .get();
      assert.ok(row);
    });
  });

  describe("accounts mode: the startup boundary never touches SQLite", () => {
    let root: string;
    let dbPath: string;
    let uploadsDir: string;

    beforeEach(async () => {
      snapshotEnv();
      root = freshRoot();
      dbPath = path.join(root, "must-not-be-created.db");
      uploadsDir = path.join(root, "must-not-be-created-uploads");
      env.DATABASE_PATH = dbPath;
      env.UPLOADS_DIR = uploadsDir;
      env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
      env.AUTH_MODE = "accounts";

      const { resetDatabaseReadyForTesting } = await import("../../src/db/bootstrap");
      resetDatabaseReadyForTesting();
    });

    afterEach(async () => {
      const { closeConnection } = await import("../../src/db/client");
      const { resetSchedulerForTesting } = await import("../../src/core/automation/scheduler");
      resetSchedulerForTesting();
      closeConnection();
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("ensureDatabaseReady() no-ops and creates no SQLite files", async () => {
      const { ensureDatabaseReady, isDatabaseReady } = await import("../../src/db/bootstrap");

      ensureDatabaseReady();

      assert.equal(isDatabaseReady(), false, "accounts mode never records SQLite readiness");
      assert.equal(fs.existsSync(dbPath), false);
      assert.equal(fs.existsSync(`${dbPath}-wal`), false);
      assert.equal(fs.existsSync(`${dbPath}-shm`), false);
      assert.equal(fs.existsSync(uploadsDir), false);
    });

    it("ensureDatabaseReady() returns early when AUTH_MODE=accounts and DATABASE_URL is unset", async () => {
      delete env.DATABASE_URL;
      env.AUTH_MODE = "accounts";

      const { ensureDatabaseReady, isDatabaseReady } = await import("../../src/db/bootstrap");
      const { isSchedulerRunning } = await import("../../src/core/automation/scheduler");

      ensureDatabaseReady();

      assert.equal(isDatabaseReady(), false, "must leave isDatabaseReady() false when AUTH_MODE=accounts without DATABASE_URL");
      assert.equal(fs.existsSync(dbPath), false, "must not create or migrate the DATABASE_PATH file");
      assert.equal(fs.existsSync(`${dbPath}-wal`), false);
      assert.equal(fs.existsSync(`${dbPath}-shm`), false);
      assert.equal(fs.existsSync(uploadsDir), false);
      assert.equal(isSchedulerRunning(), false, "must not start the scheduler when AUTH_MODE=accounts without DATABASE_URL");
    });

    it("instrumentation's register() no-ops and creates no SQLite files", async () => {
      const { register } = await import("../../src/instrumentation");
      const { isDatabaseReady } = await import("../../src/db/bootstrap");

      env.NEXT_RUNTIME = "nodejs";
      await register();

      assert.equal(isDatabaseReady(), false);
      assert.equal(fs.existsSync(dbPath), false);
      assert.equal(fs.existsSync(`${dbPath}-wal`), false);
      assert.equal(fs.existsSync(`${dbPath}-shm`), false);
      assert.equal(fs.existsSync(uploadsDir), false);
    });
  });

  describe("instrumentation register(): runtime guard", () => {
    let root: string;

    beforeEach(async () => {
      snapshotEnv();
      root = freshRoot();
      env.DATABASE_PATH = path.join(root, "edge-guard.db");
      env.UPLOADS_DIR = path.join(root, "uploads");
      delete env.DATABASE_URL;
      delete env.AUTH_MODE;

      const { resetDatabaseReadyForTesting } = await import("../../src/db/bootstrap");
      const { closeConnection } = await import("../../src/db/client");
      closeConnection();
      resetDatabaseReadyForTesting();
    });

    afterEach(async () => {
      const { closeConnection } = await import("../../src/db/client");
      const { resetSchedulerForTesting } = await import("../../src/core/automation/scheduler");
      resetSchedulerForTesting();
      closeConnection();
      restoreEnv();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("does nothing when NEXT_RUNTIME is not nodejs", async () => {
      const { register } = await import("../../src/instrumentation");
      const { isDatabaseReady } = await import("../../src/db/bootstrap");

      env.NEXT_RUNTIME = "edge";
      await register();

      assert.equal(isDatabaseReady(), false);
      assert.equal(fs.existsSync(env.DATABASE_PATH!), false);
    });

    it("migrates when NEXT_RUNTIME is nodejs", async () => {
      const { register } = await import("../../src/instrumentation");
      const { isDatabaseReady } = await import("../../src/db/bootstrap");

      env.NEXT_RUNTIME = "nodejs";
      await register();

      assert.equal(isDatabaseReady(), true);
    });
  });
});
