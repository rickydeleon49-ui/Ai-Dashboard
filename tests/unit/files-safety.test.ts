/**
 * Regression tests for accounts-mode file safety, blob cleanup on failure,
 * desktop and single-password mode file operations, and proxy gating.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate, testRoot } from "../helpers/db";
import {
  LOCAL_WORKSPACE_ID,
  type ProjectRepository,
} from "../../src/db/repositories/project-repository";
import type { NextFetchEvent } from "next/server";
import React from "react";

if (typeof (React as { createContext?: unknown }).createContext !== "function") {
  (React as { createContext?: unknown }).createContext = () => ({
    Provider: ({ children }: { children: unknown }) => children,
    Consumer: ({ children }: { children: (val: unknown) => unknown }) => children(null),
  });
}

process.env.AUTH_SECRET = "test-secret-for-files-safety-unit-tests-only";

let filesService: typeof import("../../src/core/files/service");
let storageModule: typeof import("../../src/core/storage");
let projectRepository: ProjectRepository;
let filesRoute: typeof import("../../src/app/api/projects/[id]/files/route");
let openRoute: typeof import("../../src/app/api/projects/[id]/open/route");
let proxyModule: typeof import("../../src/proxy");
let NextRequest: typeof import("next/server").NextRequest;

const SNAPSHOT_KEYS = [
  "NODE_ENV",
  "AUTH_MODE",
  "DATABASE_URL",
  "DATABASE_PATH",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_LOCAL",
  "DESKTOP_INTERNAL_SECRET",
  "AUTH_SECRET",
  "AUTH_LOG_MAGIC_LINK",
  "EMAIL_SERVER",
  "UPLOADS_DIR",
] as const;

let envSnapshot: Record<string, string | undefined>;

const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const k of SNAPSHOT_KEYS) {
    envSnapshot[k] = env[k];
  }
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

before(async () => {
  await migrate();
  filesService = await import("../../src/core/files/service");
  storageModule = await import("../../src/core/storage");
  const { DrizzleProjectRepository } = await import(
    "../../src/db/repositories/drizzle-project-repository"
  );
  projectRepository = new DrizzleProjectRepository();
  filesRoute = await import("../../src/app/api/projects/[id]/files/route");
  openRoute = await import("../../src/app/api/projects/[id]/open/route");
  proxyModule = await import("../../src/proxy");
  ({ NextRequest } = await import("next/server"));
});

after(() => cleanup());

const uploadsDir = () => path.join(testRoot, "uploads");

describe("blob cleanup on database metadata insert failure", () => {
  it("deletes newly written blob when SQLite foreign key constraint fails (successful cleanup)", async () => {
    const invalidProjectId = "prj_nonexistent_foreign_key_fail";
    const testFile = new File(["some confidential bytes"], "test_upload.pdf", {
      type: "application/pdf",
    });

    await assert.rejects(
      async () => {
        await filesService.addProjectFile(invalidProjectId, testFile);
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /FOREIGN KEY constraint failed/);
        return true;
      },
    );

    // Verify no orphaned blob remains on disk
    const projectDir = path.join(uploadsDir(), invalidProjectId);
    const blobs = fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : [];
    assert.equal(blobs.length, 0, "No orphaned blobs should remain on disk");
  });

  it("re-throws original error and logs detectable error when disk cleanup fails with sensitive path text", async () => {
    const invalidProjectId = "prj_cleanup_fail_nonexistent";
    const testFile = new File(["sensitive customer payroll data"], "confidential_payroll.pdf", {
      type: "application/pdf",
    });

    const sensitivePathText = "C:\\Sensitive\\Internal\\ClientData\\confidential_payroll.pdf";

    // Mock storage.delete to fail and throw an error containing sensitive path text
    const originalDelete = storageModule.storage.delete;
    const errorLogs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map(String).join(" "));
    };

    try {
      storageModule.storage.delete = async () => {
        throw new Error(`EACCES: permission denied, unlink '${sensitivePathText}'`);
      };

      await assert.rejects(
        async () => {
          await filesService.addProjectFile(invalidProjectId, testFile);
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          // Crucial: the original database error must NOT be masked by the cleanup error
          assert.match(error.message, /FOREIGN KEY constraint failed/);
          return true;
        },
      );

      // Verify detectable reconciliation logging occurred with fixed error code and safe correlation ID
      assert.equal(errorLogs.length, 1);
      assert.match(errorLogs[0]!, /\[ERR_FILE_CLEANUP_FAILED\]/);
      assert.match(errorLogs[0]!, /correlation_id=file_/);

      // Verify the log NEVER exposes storage key, project ID, filename, extension, path, or raw error message
      assert.ok(!errorLogs[0]!.includes(sensitivePathText), "Log must never expose sensitive path text");
      assert.ok(!errorLogs[0]!.includes("confidential_payroll"), "Log must never expose filename");
      assert.ok(!errorLogs[0]!.includes(".pdf"), "Log must never expose filename extension");
      assert.ok(!errorLogs[0]!.includes(invalidProjectId), "Log must never expose project ID");
      assert.ok(!errorLogs[0]!.includes("EACCES"), "Log must never expose raw error code");
      assert.ok(!errorLogs[0]!.includes("permission denied"), "Log must never expose raw error text");
      assert.ok(!errorLogs[0]!.includes("unlink"), "Log must never expose raw error syscall");
      assert.ok(!errorLogs[0]!.includes("sensitive customer payroll data"), "Log must never expose file contents");
    } finally {
      storageModule.storage.delete = originalDelete;
      console.error = originalConsoleError;
    }
  });

  it("cleans up disk blobs in batch uploads when database insert fails", async () => {
    const invalidProjectId = "prj_batch_fail_nonexistent";
    const testFile = new File(["batch upload bytes"], "batch_file.txt", {
      type: "text/plain",
    });

    const outcomes = await filesService.addProjectFiles(invalidProjectId, [testFile]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.ok, false);
    assert.match(outcomes[0]?.error ?? "", /FOREIGN KEY constraint failed/);

    const projectDir = path.join(uploadsDir(), invalidProjectId);
    const blobs = fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : [];
    assert.equal(blobs.length, 0, "Batch failure must leave 0 orphaned blobs on disk");
  });
});

describe("desktop and single-password mode normal file behavior", () => {
  it("stores the file, creates database row, and keeps disk blob for valid project", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, {
      name: "Desktop Normal Project",
      source: "manual",
      type: "software",
      status: "active",
    });

    const file = new File(["regular project notes"], "notes.txt", {
      type: "text/plain",
    });

    const outcomes = await filesService.addProjectFiles(project.id, [file]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.ok, true);

    const saved = outcomes[0]!.file;
    assert.equal(saved.filename, "notes.txt");
    assert.equal(saved.projectId, project.id);

    const diskPath = path.resolve(uploadsDir(), saved.storageKey);
    assert.ok(fs.existsSync(diskPath), "Disk blob must exist for successful upload");

    const listed = await filesService.listProjectFiles(project.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, saved.id);
  });
});

describe("AUTH_MODE=accounts fail-closed routes", () => {
  it("POST /api/projects/:id/files fails closed with 404 before parsing upload bytes", async () => {
    process.env.AUTH_MODE = "accounts";
    process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";

    const context = { params: Promise.resolve({ id: "prj_accounts_test" }) };
    const request = new NextRequest("http://localhost/api/projects/prj_accounts_test/files", {
      method: "POST",
    });

    const response = await filesRoute.POST(request, context);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Not found.");

    // Verify no disk writes occurred
    const targetDir = path.join(uploadsDir(), "prj_accounts_test");
    assert.ok(
      !fs.existsSync(targetDir),
      "No disk directory or blobs should be created on rejected POST",
    );
  });

  it("GET /api/projects/:id/files fails closed with 404", async () => {
    process.env.AUTH_MODE = "accounts";
    process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";

    const context = { params: Promise.resolve({ id: "prj_accounts_test" }) };
    const request = new Request("http://localhost/api/projects/prj_accounts_test/files");

    const response = await filesRoute.GET(request, context);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Not found.");
  });

  it("GET /api/projects/:id/files fails closed with 404 even for known legacy SQLite project", async () => {
    const legacyProject = await projectRepository.create(LOCAL_WORKSPACE_ID, {
      name: "Legacy SQLite Project",
      source: "manual",
      type: "software",
      status: "active",
    });
    const { closeConnection } = await import("../../src/db/client");
    closeConnection();

    process.env.AUTH_MODE = "accounts";
    process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";

    const context = { params: Promise.resolve({ id: legacyProject.id }) };
    const request = new Request(`http://localhost/api/projects/${legacyProject.id}/files`);

    const response = await filesRoute.GET(request, context);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Not found.");
  });
});

describe("fresh-process accounts-mode route execution check", () => {
  it("runs fresh-process isolation test in a separate node process with nonexistent SQLite DB", () => {
    const testFile = path.resolve(__dirname, "fresh-process-accounts-file-route.test.ts");
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const output = execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--test",
        testFile,
      ],
      { encoding: "utf8", env: childEnv },
    );
    assert.match(output, /fresh-process accounts-mode file route isolation/);
    assert.match(output, /pass [34]/);
    assert.match(output, /fail 0/);
  });
});

describe("proxy.ts accounts-mode and single-password mode route gating", () => {
  it("denies anonymous access to /api/projects/:id/files with 401 in accounts mode", async () => {
    process.env.AUTH_MODE = "accounts";
    process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";

    const request = new NextRequest("http://localhost/api/projects/prj_test/files", {
      headers: { host: "localhost", "x-forwarded-proto": "http" },
    });

    const response = await proxyModule.proxy(request, {} as NextFetchEvent);
    assert.ok(response);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Authentication required.");
  });

  it("single-password mode requires valid Basic auth and allows files route", async () => {
    delete process.env.AUTH_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.DASHBOARD_LOCAL;
    env.NODE_ENV = "production";
    process.env.DASHBOARD_PASSWORD = "supersecretpassword";

    const unauthRequest = new NextRequest("http://localhost/api/projects/prj_test/files", {
      method: "GET",
      headers: { host: "localhost" },
    });
    const unauthResponse = await proxyModule.proxy(unauthRequest, {} as NextFetchEvent);
    assert.ok(unauthResponse);
    assert.equal(unauthResponse.status, 401);

    const validAuth = Buffer.from(":supersecretpassword").toString("base64");
    const authRequest = new NextRequest("http://localhost/api/projects/prj_test/files", {
      method: "GET",
      headers: { host: "localhost", authorization: `Basic ${validAuth}` },
    });
    const authResponse = await proxyModule.proxy(authRequest, {} as NextFetchEvent);
    assert.ok(authResponse);
    assert.notEqual(authResponse.status, 401);
  });
});

describe("/api/projects/:id/open route behavior", () => {
  it("keeps /api/projects/:id/open working for valid projects", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, {
      name: "Openable Project",
      source: "manual",
      type: "software",
      status: "active",
    });

    const context = { params: Promise.resolve({ id: project.id }) };
    const request = new NextRequest(`http://localhost/api/projects/${project.id}/open`, {
      method: "POST",
    });

    const response = await openRoute.POST(request, context);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { project?: { id: string; lastOpenedAt: string | null } };
    assert.equal(body.project?.id, project.id);
    assert.ok(body.project?.lastOpenedAt !== null, "lastOpenedAt must be stamped");
  });
});
