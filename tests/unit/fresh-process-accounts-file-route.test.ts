/**
 * Fresh-process test: verifies that importing the project files route in active
 * accounts mode with a nonexistent SQLite database path does NOT initialize,
 * create, or read SQLite, and that rejected GET and POST requests do NOT create
 * SQLite files or write upload blobs.
 *
 * CRITICAL: SQLite MUST NOT be initialized before or during this test!
 *
 * Distinction:
 * - What the test observes: With DATABASE_PATH pointing to a nonexistent file
 *   in a nonexistent directory, importing the route and dispatching GET and POST
 *   returns 404 without throwing SQLite initialization errors, without creating
 *   the database file or directory, and without creating the configured UPLOADS_DIR.
 * - What code inspection establishes: When isAccountsMode() is true, GET and POST
 *   return 404 prior to dynamic imports of @/db/bootstrap, @/db/repositories,
 *   and @/core/files/service, so no SQLite read/write queries are ever executed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-accounts-file-route-"));
const nonexistentDir = path.join(tempDir, "nonexistent-db-dir");
const nonexistentDb = path.join(nonexistentDir, "definitely-not-created.db");
const nonexistentUploads = path.join(tempDir, "nonexistent-configured-uploads");
const defaultUploadsFallback = path.resolve(process.cwd(), "data", "uploads");

const SNAPSHOT_KEYS = [
  "NODE_ENV",
  "AUTH_MODE",
  "DATABASE_URL",
  "DATABASE_PATH",
  "UPLOADS_DIR",
] as const;

const env = process.env as Record<string, string | undefined>;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const k of SNAPSHOT_KEYS) {
    envSnapshot[k] = env[k];
  }
  // Ensure accounts mode, nonexistent SQLite DB path, and nonexistent UPLOADS_DIR
  env.AUTH_MODE = "accounts";
  env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
  env.DATABASE_PATH = nonexistentDb;
  env.UPLOADS_DIR = nonexistentUploads;
});

afterEach(() => {
  for (const k of SNAPSHOT_KEYS) {
    if (envSnapshot[k] === undefined) {
      delete env[k];
    } else {
      env[k] = envSnapshot[k];
    }
  }
});

// Set accounts mode and nonexistent paths BEFORE initial top-level module import
env.AUTH_MODE = "accounts";
env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
env.DATABASE_PATH = nonexistentDb;
env.UPLOADS_DIR = nonexistentUploads;

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on temp dir
  }
});

describe("fresh-process accounts-mode file route isolation (no SQLite initialization)", () => {
  it("proves importing the file route does not initialize, open, or create SQLite", async () => {
    // Prior to import, ensure the nonexistent path and its parent dir do not exist
    assert.equal(fs.existsSync(nonexistentDb), false, "SQLite DB file must not exist before import");
    assert.equal(fs.existsSync(nonexistentDir), false, "SQLite parent dir must not exist before import");
    assert.equal(fs.existsSync(nonexistentUploads), false, "Configured UPLOADS_DIR must not exist before import");

    // Dynamic import of route
    const route = await import("../../src/app/api/projects/[id]/files/route");

    // Assert that importing the module in active accounts mode did NOT create the SQLite file or directory
    assert.equal(
      fs.existsSync(nonexistentDb),
      false,
      "Importing route in accounts mode must not create SQLite DB file",
    );
    assert.equal(
      fs.existsSync(nonexistentDir),
      false,
      "Importing route in accounts mode must not create SQLite parent directory",
    );
    assert.equal(
      fs.existsSync(nonexistentUploads),
      false,
      "Importing route must not create configured UPLOADS_DIR",
    );
    assert.ok(typeof route.GET === "function", "GET must be exported");
    assert.ok(typeof route.POST === "function", "POST must be exported");
  });

  it("proves rejected GET does not create, open, or read SQLite", async () => {
    const route = await import("../../src/app/api/projects/[id]/files/route");
    const request = new Request("http://localhost/api/projects/prj_accounts_test/files");
    const context = { params: Promise.resolve({ id: "prj_accounts_test" }) };

    const response = await route.GET(request, context);
    assert.equal(response.status, 404, "GET must fail closed with 404 in accounts mode");
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Not found.");

    assert.equal(
      fs.existsSync(nonexistentDb),
      false,
      "Rejected GET must not create SQLite DB file",
    );
    assert.equal(
      fs.existsSync(nonexistentDir),
      false,
      "Rejected GET must not create SQLite directory",
    );
  });

  it("proves rejected POST does not create or read SQLite or write upload data", async () => {
    const route = await import("../../src/app/api/projects/[id]/files/route");
    const { NextRequest } = await import("next/server");

    // Record state of default uploads dir before POST if it exists
    const defaultUploadsExistedBefore = fs.existsSync(defaultUploadsFallback);
    const defaultUploadsFilesBefore = defaultUploadsExistedBefore
      ? fs.readdirSync(defaultUploadsFallback)
      : [];

    const request = new NextRequest("http://localhost/api/projects/prj_accounts_test/files", {
      method: "POST",
      body: "sensitive payload that must not be parsed or written",
    });
    const context = { params: Promise.resolve({ id: "prj_accounts_test" }) };

    const response = await route.POST(request, context);
    assert.equal(response.status, 404, "POST must fail closed with 404 in accounts mode");
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Not found.");

    // Verify nonexistent DB was not touched/created
    assert.equal(
      fs.existsSync(nonexistentDb),
      false,
      "Rejected POST must not create SQLite DB file",
    );
    assert.equal(
      fs.existsSync(nonexistentDir),
      false,
      "Rejected POST must not create SQLite directory",
    );

    // Verify configured UPLOADS_DIR was not created or written to
    assert.equal(
      fs.existsSync(nonexistentUploads),
      false,
      "Rejected POST must not create configured UPLOADS_DIR or write blobs",
    );

    // Verify default fallback directory did not receive any unexpected files
    if (defaultUploadsExistedBefore) {
      const defaultUploadsFilesAfter = fs.readdirSync(defaultUploadsFallback);
      assert.deepEqual(
        defaultUploadsFilesAfter,
        defaultUploadsFilesBefore,
        "No files should be written to default uploads directory",
      );
    }
  });

  it("proves /api/files/[id] GET and DELETE fail closed with 404 without initializing SQLite or creating dirs", async () => {
    // Dynamic import of /api/files/[id]/route
    const directFileRoute = await import("../../src/app/api/files/[id]/route");

    // Assert that importing did NOT create nonexistentDb or nonexistentDir
    assert.equal(fs.existsSync(nonexistentDb), false, "Importing direct file route must not create DB");
    assert.equal(fs.existsSync(nonexistentDir), false, "Importing direct file route must not create DB dir");
    assert.equal(fs.existsSync(nonexistentUploads), false, "Importing direct file route must not create uploads dir");

    const getRequest = new Request("http://localhost/api/files/file_accounts_123");
    const getContext = { params: Promise.resolve({ id: "file_accounts_123" }) };
    const getResponse = await directFileRoute.GET(getRequest, getContext);

    assert.equal(getResponse.status, 404, "GET /api/files/:id must fail closed with 404");
    const getBody = (await getResponse.json()) as { error?: string };
    assert.equal(getBody.error, "Not found.");

    assert.equal(fs.existsSync(nonexistentDb), false, "GET must not create DB");
    assert.equal(fs.existsSync(nonexistentDir), false, "GET must not create DB dir");
    assert.equal(fs.existsSync(nonexistentUploads), false, "GET must not create uploads dir");

    const deleteRequest = new Request("http://localhost/api/files/file_accounts_123", { method: "DELETE" });
    const deleteContext = { params: Promise.resolve({ id: "file_accounts_123" }) };
    const deleteResponse = await directFileRoute.DELETE(deleteRequest, deleteContext);

    assert.equal(deleteResponse.status, 404, "DELETE /api/files/:id must fail closed with 404");
    const deleteBody = (await deleteResponse.json()) as { error?: string };
    assert.equal(deleteBody.error, "Not found.");

    assert.equal(fs.existsSync(nonexistentDb), false, "DELETE must not create DB");
    assert.equal(fs.existsSync(nonexistentDir), false, "DELETE must not create DB dir");
    assert.equal(fs.existsSync(nonexistentUploads), false, "DELETE must not create uploads dir");
  });
});
