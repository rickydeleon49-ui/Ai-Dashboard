/**
 * Fresh-process test:
 * Verifies that with AUTH_MODE=accounts and PostgreSQL DATABASE_URL configured,
 * pointing DATABASE_PATH and UPLOADS_DIR at deliberately unusable locations
 * allows importing and invoking every allowed accounts-mode route and page
 * without throwing SQLITE_CANTOPEN or initializing SQLite, and without creating
 * any SQLite database file (.db, .db-wal, .db-shm) or uploads directory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

describe("Accounts mode: zero SQLite initialization on allowed routes", () => {
  before(async () => {
    await migrate();
  });

  after(async () => {
    await cleanup();
  });

  it("imports and invokes every allowed route in a fresh process without touching SQLite", () => {
    const unusableTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "unusable-paths-"));
    const unusableDbPath = path.join(unusableTestDir, "unusable-dir", "database.db");
    const unusableUploadsDir = path.join(unusableTestDir, "unusable-uploads");

    const scriptPath = path.join(process.cwd(), "tests", `.tmp-no-sqlite-worker-${Date.now()}.ts`);

    // Worker code to run in a brand new fresh Node/tsx process
    const workerScript = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { NextRequest } from "next/server";
import React from "react";

if (typeof (React as any).createContext !== "function") {
  (React as any).createContext = () => ({
    Provider: ({ children }: any) => children,
    Consumer: ({ children }: any) => children(null),
  });
}

(require as any).extensions[".css"] = () => {};

async function run() {
  // Verify ensureDatabaseReady() is a safe no-op
  const { ensureDatabaseReady } = await import("@/db/bootstrap");
  ensureDatabaseReady();

  // 1. Allowed API routes
  const projectsRoute = await import("@/app/api/projects/route");
  const projectsRes = await projectsRoute.GET(new NextRequest("http://localhost/api/projects"));
  assert.equal(projectsRes.status, 401);

  const projectDetailRoute = await import("@/app/api/projects/[id]/route");
  const projectDetailRes = await projectDetailRoute.GET(
    new NextRequest("http://localhost/api/projects/p1"),
    { params: Promise.resolve({ id: "p1" }) }
  );
  assert.equal(projectDetailRes.status, 401);

  const projectTasksRoute = await import("@/app/api/projects/[id]/tasks/route");
  const projectTasksRes = await projectTasksRoute.GET(
    new NextRequest("http://localhost/api/projects/p1/tasks"),
    { params: Promise.resolve({ id: "p1" }) }
  );
  assert.equal(projectTasksRes.status, 401);

  const projectMilestonesRoute = await import("@/app/api/projects/[id]/milestones/route");
  const projectMilestonesRes = await projectMilestonesRoute.GET(
    new NextRequest("http://localhost/api/projects/p1/milestones"),
    { params: Promise.resolve({ id: "p1" }) }
  );
  assert.equal(projectMilestonesRes.status, 401);

  const projectMilestoneDetailRoute = await import("@/app/api/projects/[id]/milestones/[milestoneId]/route");
  const projectMilestoneDetailRes = await projectMilestoneDetailRoute.GET(
    new NextRequest("http://localhost/api/projects/p1/milestones/m1"),
    { params: Promise.resolve({ id: "p1", milestoneId: "m1" }) }
  );
  assert.equal(projectMilestoneDetailRes.status, 401);

  const projectKnowledgeRoute = await import("@/app/api/projects/[id]/knowledge/route");
  const projectKnowledgeRes = await projectKnowledgeRoute.GET(
    new NextRequest("http://localhost/api/projects/p1/knowledge"),
    { params: Promise.resolve({ id: "p1" }) }
  );
  assert.equal(projectKnowledgeRes.status, 401);

  const projectKnowledgeDocRoute = await import("@/app/api/projects/[id]/knowledge/[docId]/route");
  const projectKnowledgeDocRes = await projectKnowledgeDocRoute.GET(
    new NextRequest("http://localhost/api/projects/p1/knowledge/d1"),
    { params: Promise.resolve({ id: "p1", docId: "d1" }) }
  );
  assert.equal(projectKnowledgeDocRes.status, 401);

  const taskDetailRoute = await import("@/app/api/tasks/[id]/route");
  const taskDetailRes = await taskDetailRoute.GET(
    new NextRequest("http://localhost/api/tasks/t1"),
    { params: Promise.resolve({ id: "t1" }) }
  );
  assert.equal(taskDetailRes.status, 401);

  const taskDependenciesRoute = await import("@/app/api/tasks/[id]/dependencies/route");
  const taskDepsRes = await taskDependenciesRoute.GET(
    new NextRequest("http://localhost/api/tasks/t1/dependencies"),
    { params: Promise.resolve({ id: "t1" }) }
  );
  assert.equal(taskDepsRes.status, 401);

  const myWorkRoute = await import("@/app/api/my-work/route");
  const myWorkRes = await myWorkRoute.GET(new NextRequest("http://localhost/api/my-work"));
  assert.equal(myWorkRes.status, 401);

  const workspacesRoute = await import("@/app/api/workspaces/route");
  const workspacesRes = await workspacesRoute.GET(new NextRequest("http://localhost/api/workspaces"));
  assert.equal(workspacesRes.status, 401);

  const workspaceCurrentRoute = await import("@/app/api/workspaces/current/route");
  const workspaceCurrentRes = await workspaceCurrentRoute.PUT(
    new NextRequest("http://localhost/api/workspaces/current", {
      method: "PUT",
      body: JSON.stringify({ workspaceId: "w1" }),
    })
  );
  assert.equal(workspaceCurrentRes.status, 401);

  const workspaceInvitationsRoute = await import("@/app/api/workspaces/[id]/invitations/route");
  const workspaceInvRes = await workspaceInvitationsRoute.GET(
    new NextRequest("http://localhost/api/workspaces/w1/invitations"),
    { params: Promise.resolve({ id: "w1" }) }
  );
  assert.equal(workspaceInvRes.status, 401);

  const workspaceInvitationDetailRoute = await import(
    "@/app/api/workspaces/[id]/invitations/[invitationId]/route"
  );
  const workspaceInvDetailRes = await workspaceInvitationDetailRoute.DELETE(
    new NextRequest("http://localhost/api/workspaces/w1/invitations/i1", { method: "DELETE" }),
    { params: Promise.resolve({ id: "w1", invitationId: "i1" }) }
  );
  assert.equal(workspaceInvDetailRes.status, 401);

  const ownershipClaimRoute = await import("@/app/api/ownership-claim/route");
  const ownershipClaimRes = await ownershipClaimRoute.POST(
    new NextRequest("http://localhost/api/ownership-claim", { method: "POST" })
  );
  assert.equal(ownershipClaimRes.status, 401);

  // Release 2C.6 collaboration inbox: PostgreSQL-only, never the SQLite automation inbox.
  const inboxRoute = await import("@/app/api/inbox/route");
  assert.equal((await inboxRoute.GET(new NextRequest("http://localhost/api/inbox"))).status, 401);
  const inboxCountRoute = await import("@/app/api/inbox/unread-count/route");
  assert.equal((await inboxCountRoute.GET(new NextRequest("http://localhost/api/inbox/unread-count"))).status, 401);
  const inboxItemRoute = await import("@/app/api/inbox/[id]/route");
  assert.equal(
    (
      await inboxItemRoute.PATCH(
        new NextRequest("http://localhost/api/inbox/n1", { method: "PATCH", body: JSON.stringify({ read: true }) }),
        { params: Promise.resolve({ id: "n1" }) }
      )
    ).status,
    401,
  );
  const inboxMarkAllRoute = await import("@/app/api/inbox/mark-all-read/route");
  assert.equal(
    (await inboxMarkAllRoute.POST(new NextRequest("http://localhost/api/inbox/mark-all-read", { method: "POST" }))).status,
    401,
  );
  const inboxPrefsRoute = await import("@/app/api/inbox/preferences/route");
  assert.equal((await inboxPrefsRoute.GET(new NextRequest("http://localhost/api/inbox/preferences"))).status, 401);

  const authRoute = await import("@/app/api/auth/[...nextauth]/route");
  assert.ok(authRoute.GET);
  assert.ok(authRoute.POST);

  const filesRoute = await import("@/app/api/files/[id]/route");
  const filesRes = await filesRoute.GET(
    new NextRequest("http://localhost/api/files/f1"),
    { params: Promise.resolve({ id: "f1" }) }
  );
  assert.equal(filesRes.status, 404);

  const projectFilesRoute = await import("@/app/api/projects/[id]/files/route");
  const projectFilesRes = await projectFilesRoute.GET(
    new NextRequest("http://localhost/api/projects/p1/files"),
    { params: Promise.resolve({ id: "p1" }) }
  );
  assert.equal(projectFilesRes.status, 404);

  // 2. Allowed Page Components & Root Layout: verify importing and invoking
  const pages = [
    { name: "dashboard", importFn: () => import("@/app/page") },
    { name: "projects", importFn: () => import("@/app/projects/page") },
    { name: "favorites", importFn: () => import("@/app/favorites/page") },
    { name: "projectDetail", importFn: () => import("@/app/projects/[id]/page") },
    { name: "projectTasks", importFn: () => import("@/app/projects/[id]/tasks/page") },
    { name: "projectKnowledge", importFn: () => import("@/app/projects/[id]/knowledge/page") },
    { name: "settings", importFn: () => import("@/app/settings/page") },
    { name: "invite", importFn: () => import("@/app/invite/page") },
    { name: "myWork", importFn: () => import("@/app/my-work/page") },
    { name: "inbox", importFn: () => import("@/app/inbox/page") },
    { name: "rootLayout", importFn: () => import("@/app/layout") },
  ];

  for (const p of pages) {
    const mod = await p.importFn();
    assert.ok(mod.default, "Page " + p.name + " must export default");
    try {
      if (typeof mod.default === "function") {
        await (mod.default as any)({
          children: null,
          params: Promise.resolve({ id: "p1" }),
          searchParams: Promise.resolve({}),
        });
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      assert.equal(
        msg.includes("SQLITE"),
        false,
        "Page " + p.name + " must not throw SQLite error: " + msg,
      );
    }
  }

  console.log("ALL_ROUTES_OK");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

    fs.writeFileSync(scriptPath, workerScript, "utf8");

    const isWindows = process.platform === "win32";
    const tsxCmd = isWindows ? "npx.cmd" : "npx";
    const relScriptPath = path.relative(process.cwd(), scriptPath);
    const result = spawnSync(
      tsxCmd,
      ["tsx", "--conditions=react-server", relScriptPath],
      {
        cwd: process.cwd(),
        shell: isWindows,
        env: {
          ...process.env,
          AUTH_MODE: "accounts",
          AUTH_SECRET: "test-auth-secret-32-chars-long-secret-key!!",
          DATABASE_URL:
            process.env.DATABASE_URL ||
            "postgres://ai_dashboard:ai_dashboard_dev@localhost:5432/postgres",
          DATABASE_PATH: unusableDbPath,
          UPLOADS_DIR: unusableUploadsDir,
        },
        encoding: "utf8",
      },
    );

    try {
      if (result.status !== 0) {
        console.error("Worker stdout:", result.stdout);
        console.error("Worker stderr:", result.stderr);
      }
      assert.equal(result.status, 0, `Worker failed with status ${result.status}`);
      assert.match(result.stdout, /ALL_ROUTES_OK/);

      // Verify no SQLite files or directories were created
      assert.equal(
        fs.existsSync(unusableDbPath),
        false,
        "SQLite database file must not be created",
      );
      assert.equal(
        fs.existsSync(unusableDbPath + "-wal"),
        false,
        "SQLite WAL file must not be created",
      );
      assert.equal(
        fs.existsSync(unusableDbPath + "-shm"),
        false,
        "SQLite SHM file must not be created",
      );
      assert.equal(
        fs.existsSync(unusableUploadsDir),
        false,
        "Configured uploads directory must not be created",
      );
      assert.equal(
        fs.existsSync(path.dirname(unusableDbPath)),
        false,
        "Parent directory of SQLite database must not be created",
      );
    } finally {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
      fs.rmSync(unusableTestDir, { recursive: true, force: true });
    }
  });
});
