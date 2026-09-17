/**
 * Rigorous self-contained boundary verification for withLegacySqliteAccess,
 * the default-deny SQLite guard, and revocable scope tokens.
 *
 * Requirements verified:
 * 1. Self-contained: uses a unique throwaway directory and SQLite path; DATABASE_PATH is set
 *    before dynamic import; no modification of repository's data/dashboard.db; clean teardown.
 * 2. Default-deny: SQLite access is refused when DATABASE_URL or accounts mode is active.
 * 3. Scoped access: withLegacySqliteAccess temporarily enables reading/migrating legacy data.
 * 4. Revocation: The exception is revoked as soon as the scoped block exits.
 * 5. Exception recovery: Even if setup fails / throws, default-deny state is unconditionally restored.
 * 6. Async isolation: Concurrent operations in separate async contexts cannot inherit the exception.
 * 7. Detached descendants: Timers, unawaited promises, and async descendants created inside
 *    the callback see authorization revoked (active: false) and cannot reopen or query SQLite.
 * 8. Nested scopes: Inner scope exiting does not prematurely revoke outer active scope.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-boundary-test-"));
const tempDbPath = path.join(tempDir, "legacy-boundary.db");

// Save all original environment variables before setting test paths
const ORIG_DATABASE_PATH = process.env.DATABASE_PATH;
const ORIG_DATABASE_URL = process.env.DATABASE_URL;
const ORIG_AUTH_MODE = process.env.AUTH_MODE;
const ORIG_UPLOADS_DIR = process.env.UPLOADS_DIR;

// Set DATABASE_PATH and UPLOADS_DIR before importing client
process.env.DATABASE_PATH = tempDbPath;
process.env.UPLOADS_DIR = path.join(tempDir, "uploads");

type DbClient = typeof import("../../src/db/client");
type DbSchema = typeof import("../../src/db/schema");

let client: DbClient;
let schema: DbSchema;

before(async () => {
  client = await import("../../src/db/client");
  schema = await import("../../src/db/schema");
});

after(() => {
  client.closeConnection();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows might briefly retain file handle; closeConnection ensures release
  }

  // Restore environment variables
  if (ORIG_DATABASE_PATH !== undefined) process.env.DATABASE_PATH = ORIG_DATABASE_PATH;
  else delete process.env.DATABASE_PATH;

  if (ORIG_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIG_DATABASE_URL;
  else delete process.env.DATABASE_URL;

  if (ORIG_AUTH_MODE !== undefined) process.env.AUTH_MODE = ORIG_AUTH_MODE;
  else delete process.env.AUTH_MODE;

  if (ORIG_UPLOADS_DIR !== undefined) process.env.UPLOADS_DIR = ORIG_UPLOADS_DIR;
  else delete process.env.UPLOADS_DIR;
});

describe("Legacy SQLite Scoped Boundary Guarantees", () => {
  beforeEach(() => {
    // Simulate active accounts/PostgreSQL configuration for boundary testing
    process.env.DATABASE_URL = "postgres://boundary-user:boundary-pw@localhost:5432/boundary_db";
    process.env.AUTH_MODE = "accounts";
  });

  afterEach(() => {
    client.closeConnection();
  });

  it("proves default-deny guard refuses SQLite connection in accounts mode or when DATABASE_URL is set", () => {
    assert.equal(client.isLegacySqliteAccessAllowed(), false);

    assert.throws(
      () => client.sqlite.prepare("SELECT 1"),
      /SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured\./,
    );

    assert.throws(
      () => client.db.select().from(schema.projects).all(),
      /SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured\./,
    );
  });

  it("allows SQLite access within withLegacySqliteAccess and revokes it immediately upon completion", async () => {
    assert.equal(client.isLegacySqliteAccessAllowed(), false);

    let insideRan = false;
    const result = await client.withLegacySqliteAccess(async () => {
      assert.equal(client.isLegacySqliteAccessAllowed(), true);
      insideRan = true;
      // SQLite handle is accessible within this scope
      const stmt = client.sqlite.prepare("SELECT 1 AS num");
      const row = stmt.get() as { num: number };
      assert.equal(row.num, 1);
      return "migration-complete";
    });

    assert.equal(insideRan, true);
    assert.equal(result, "migration-complete");

    // Immediately after withLegacySqliteAccess returns, access must be revoked
    assert.equal(client.isLegacySqliteAccessAllowed(), false);
    assert.throws(
      () => client.sqlite.prepare("SELECT 1"),
      /SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured\./,
    );
    assert.throws(
      () => client.db.select().from(schema.projects).all(),
      /SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured\./,
    );
  });

  it("restores default-deny state when setup or migration inside withLegacySqliteAccess throws", async () => {
    assert.equal(client.isLegacySqliteAccessAllowed(), false);

    await assert.rejects(
      async () => {
        await client.withLegacySqliteAccess(async () => {
          assert.equal(client.isLegacySqliteAccessAllowed(), true);
          throw new Error("Simulated legacy SQLite migration failure");
        });
      },
      /Simulated legacy SQLite migration failure/,
    );

    // After thrown error, default-deny state must be restored
    assert.equal(client.isLegacySqliteAccessAllowed(), false);
    assert.throws(
      () => client.sqlite.prepare("SELECT 1"),
      /SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured\./,
    );
    assert.throws(
      () => client.db.select().from(schema.projects).all(),
      /SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured\./,
    );
  });

  it("prevents concurrent ordinary accounts requests from inheriting or borrowing legacy SQLite access", async () => {
    let concurrentAttemptDenied = false;

    // Launch a task with legacy SQLite access that pauses mid-execution
    const legacyMigrationPromise = client.withLegacySqliteAccess(async () => {
      assert.equal(client.isLegacySqliteAccessAllowed(), true);
      // Wait to allow concurrent accounts request to execute
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "legacy-done";
    });

    // Concurrently run an ordinary accounts operation in an independent async context
    const concurrentTaskPromise = (async () => {
      // Yield to let legacy migration enter its scope first
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The concurrent task should see isLegacySqliteAccessAllowed() === false
      assert.equal(client.isLegacySqliteAccessAllowed(), false);

      // And attempting to open or query SQLite must throw
      try {
        client.sqlite.prepare("SELECT 1");
      } catch (err: any) {
        if (/SQLite connection refused/.test(err.message)) {
          concurrentAttemptDenied = true;
        }
      }
    })();

    const [legacyResult] = await Promise.all([legacyMigrationPromise, concurrentTaskPromise]);
    assert.equal(legacyResult, "legacy-done");
    assert.equal(concurrentAttemptDenied, true, "Concurrent ordinary request must be refused access to SQLite");

    // After everything finishes, default-deny remains in effect
    assert.equal(client.isLegacySqliteAccessAllowed(), false);
    assert.throws(
      () => client.sqlite.prepare("SELECT 1"),
      /SQLite connection refused/,
    );
  });

  it("revokes authorization from unawaited promise descendants created inside callback after it returns", async () => {
    let detachedPromise: Promise<{ allowed: boolean; queryError: string | null }>;

    await client.withLegacySqliteAccess(async () => {
      // Query succeeds while callback is actively running
      const testStmt = client.sqlite.prepare("SELECT 77 AS val");
      assert.equal((testStmt.get() as { val: number }).val, 77);

      // Spawn a detached async descendant
      detachedPromise = (async () => {
        // Wait until after parent withLegacySqliteAccess finishes and revokes scope token
        await new Promise((resolve) => setTimeout(resolve, 30));

        const allowed = client.isLegacySqliteAccessAllowed();
        let queryError: string | null = null;
        try {
          client.sqlite.prepare("SELECT 1").get();
        } catch (err: any) {
          queryError = err.message;
        }
        return { allowed, queryError };
      })();
    });

    // withLegacySqliteAccess has finished: token.active was set to false
    const detachedResult = await detachedPromise!;
    assert.equal(detachedResult.allowed, false, "Detached descendant must see token revoked");
    assert.match(
      detachedResult.queryError ?? "",
      /SQLite connection refused: cannot open SQLite in accounts mode or when DATABASE_URL is configured\./,
      "Detached descendant cannot reopen or query SQLite",
    );
  });

  it("revokes authorization from detached timer callbacks created inside callback", async () => {
    let timerResult: { allowed: boolean; threwRefusal: boolean } | undefined;

    await client.withLegacySqliteAccess(async () => {
      // Register a detached timer
      setTimeout(() => {
        const allowed = client.isLegacySqliteAccessAllowed();
        let threwRefusal = false;
        try {
          client.sqlite.prepare("SELECT 1").get();
        } catch (err: any) {
          threwRefusal = /SQLite connection refused/.test(err.message);
        }
        timerResult = { allowed, threwRefusal };
      }, 20);
    });

    // Wait for timer to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(timerResult, "Detached timer must execute");
    assert.equal(timerResult.allowed, false, "Detached timer must see legacy access disallowed");
    assert.equal(timerResult.threwRefusal, true, "Detached timer must be refused SQLite access");
  });

  it("preserves safe authorization across nested scopes", async () => {
    await client.withLegacySqliteAccess(async () => {
      assert.equal(client.isLegacySqliteAccessAllowed(), true);
      const r1 = client.sqlite.prepare("SELECT 100 AS num").get() as { num: number };
      assert.equal(r1.num, 100);

      // Nested scope
      await client.withLegacySqliteAccess(async () => {
        assert.equal(client.isLegacySqliteAccessAllowed(), true);
        const r2 = client.sqlite.prepare("SELECT 200 AS num").get() as { num: number };
        assert.equal(r2.num, 200);
      });

      // Outer scope remains authorized after inner finishes
      assert.equal(client.isLegacySqliteAccessAllowed(), true);
      const r3 = client.sqlite.prepare("SELECT 300 AS num").get() as { num: number };
      assert.equal(r3.num, 300);
    });

    // Fully revoked after outer finishes
    assert.equal(client.isLegacySqliteAccessAllowed(), false);
    assert.throws(
      () => client.sqlite.prepare("SELECT 1"),
      /SQLite connection refused/,
    );
  });
});
