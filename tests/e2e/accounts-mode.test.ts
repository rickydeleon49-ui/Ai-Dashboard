/**
 * Release 2C.2 / Phase 2C Accounts-Mode End-to-End Tests.
 *
 * Runs against a Next.js development server (`next dev`) configured with AUTH_MODE=accounts
 * backed by a throwaway PostgreSQL database. Running under development mode (NODE_ENV=development)
 * allows AUTH_LOG_MAGIC_LINK to log magic links to console output without weakening production guards.
 * Note that this suite runs against the dev server, so it does not cover production-build behavior
 * (which is exercised by test:e2e).
 *
 * Verifies critical accounts-mode workflows over HTTP using native fetch and pg:
 * 1. Owner flow:
 *    - Members API / page lists all member statuses (active, suspended)
 *    - Suspending a member succeeds (200)
 *    - Changing / demoting own membership returns 403 forbidden
 * 2. Viewer flow:
 *    - Members API returns active members only (non-active request returns 403)
 *    - Project tasks page server-rendered data contains NO email for suspended assignee (Stage 1A leak fix)
 *    - Task mutations return 403 forbidden
 * 3. Member flow:
 *    - Can create task and assign to active member (201)
 *    - Assigning a suspended member is rejected with 422
 *    - "assignedBy=me" and "unassigned=true" filters return correct tasks
 * 4. Historical attribution preservation:
 *    - Updating only the title of a task with a suspended assignee succeeds (200)
 *    - Preserves assignee_id and assigned_by intact in PostgreSQL
 * 5. Release 2C.6 collaboration notifications, driven in a real Chromium browser:
 *    - workspace-specific unread count on the header bell, panel open/close by keyboard
 *    - mark read, mark all read, archive and restore; unread styling is not colour-only
 *    - switching workspaces through the Settings UI never shows the other workspace's notifications
 *    - empty and error states (with retry)
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL?.trim() ||
  "postgres://ai_dashboard:ai_dashboard_dev@localhost:5432/postgres";

const dbName = `cc_e2e_accts_${crypto.randomBytes(6).toString("hex")}`;
const testDbUrl = new URL(adminUrl);
testDbUrl.pathname = `/${dbName}`;

let baseURL = "";
let serverProcess: ChildProcess | null = null;
let dbClient: Client;

const loggedLines: string[] = [];
const magicLinkWaiters = new Map<string, (url: string) => void>();

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("No free port available"))));
    });
  });
}

function createCookieJar() {
  const jar = new Map<string, string>();
  return {
    header(): string {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    absorb(response: Response): void {
      const headers = response.headers as unknown as { getSetCookie?: () => string[] };
      const rawCookies: string[] = headers.getSetCookie
        ? headers.getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")!]
          : [];

      for (const raw of rawCookies) {
        const pair = raw.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (eq > 0) {
          const k = pair.slice(0, eq).trim();
          const v = pair.slice(eq + 1).trim();
          if (v === "") jar.delete(k);
          else jar.set(k, v);
        }
      }
    },
    set(key: string, value: string): void {
      jar.set(key, value);
    },
  };
}

async function waitForServer(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(`${url}/api/auth/csrf`, {
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status < 500) return;
    } catch {
      // Server not accepting connections yet or aborted
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

function waitForMagicLink(email: string, timeoutMs = 60_000): Promise<string> {
  const existing = loggedLines.find((l) => l.includes(`magic link for ${email}`));
  if (existing) {
    const match = existing.match(/(http\S+)/);
    if (match?.[1]) return Promise.resolve(match[1].trim());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      magicLinkWaiters.delete(email);
      reject(new Error(`Timeout waiting for magic link for ${email}. Logged:\n${loggedLines.join("\n")}`));
    }, timeoutMs);

    magicLinkWaiters.set(email, (url) => {
      clearTimeout(timer);
      resolve(url);
    });
  });
}

async function signInUser(email: string, workspaceId: string): Promise<ReturnType<typeof createCookieJar>> {
  const jar = createCookieJar();

  // 1. Get CSRF token
  const csrfRes = await fetch(`${baseURL}/api/auth/csrf`, { headers: { cookie: jar.header() } });
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  assert.ok(csrfToken, "csrfToken required");

  // 2. Request magic link
  const linkPromise = waitForMagicLink(email);
  const signinBody = new URLSearchParams({
    email,
    csrfToken,
    callbackUrl: `${baseURL}/`,
  });

  const signinRes = await fetch(`${baseURL}/api/auth/signin/nodemailer`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: jar.header(),
    },
    body: signinBody.toString(),
    redirect: "manual",
  });
  jar.absorb(signinRes);

  // 3. Await logged magic link from server stdout
  const magicLink = await linkPromise;
  assert.ok(magicLink, `Magic link for ${email} must be captured`);

  // 4. Follow magic link callback to obtain session token
  const callbackRes = await fetch(magicLink, {
    headers: { cookie: jar.header() },
    redirect: "manual",
  });
  jar.absorb(callbackRes);
  assert.equal(callbackRes.status, 302, "Magic link callback should redirect");

  // 5. Attach current workspace cookie
  jar.set("cc-current-workspace", workspaceId);

  return jar;
}

const WS_ID = "ws_e2e_team";
const PROJ_ID = "proj_e2e_main";
const OWNER_EMAIL = "owner_e2e@example.com";
const MEMBER_EMAIL = "member_e2e@example.com";
const VIEWER_EMAIL = "viewer_e2e@example.com";
const SUSPENDED_EMAIL = "suspended_e2e@example.com";
const TEMP_EMAIL = "temp_e2e@example.com";

let ownerJar: ReturnType<typeof createCookieJar>;
let memberJar: ReturnType<typeof createCookieJar>;
let viewerJar: ReturnType<typeof createCookieJar>;

before(async () => {
  // 1. Create throwaway PostgreSQL database
  const adminClient = new Client({ connectionString: adminUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminClient.end();
  }

  // 2. Run migrations
  process.env.DATABASE_URL = testDbUrl.toString();
  const { runPgMigrations } = await import("../../src/db/migrate.pg");
  await runPgMigrations();

  // 3. Seed data directly in PostgreSQL
  dbClient = new Client({ connectionString: testDbUrl.toString() });
  dbClient.on("error", () => {}); // Swallow termination error on teardown
  await dbClient.connect();

  // Seed Users
  await dbClient.query(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified")
    VALUES
      ('usr_owner', 'Alice Owner', '${OWNER_EMAIL}', NOW()),
      ('usr_member', 'Bob Member', '${MEMBER_EMAIL}', NOW()),
      ('usr_viewer', 'Charlie Viewer', '${VIEWER_EMAIL}', NOW()),
      ('usr_suspended', 'Dave Suspended', '${SUSPENDED_EMAIL}', NOW()),
      ('usr_temp', 'Temp Colleague', '${TEMP_EMAIL}', NOW())
  `);

  // Seed Workspace
  await dbClient.query(`
    INSERT INTO "workspace" ("id", "name", "slug", "kind", "created_by", "created_at", "updated_at")
    VALUES ('${WS_ID}', 'Acme Corporation', 'acme-corporation', 'team', 'usr_owner', NOW(), NOW())
  `);

  // Seed Memberships
  await dbClient.query(`
    INSERT INTO "workspace_member" ("workspace_id", "user_id", "role", "status", "created_at")
    VALUES
      ('${WS_ID}', 'usr_owner', 'owner', 'active', NOW()),
      ('${WS_ID}', 'usr_member', 'member', 'active', NOW()),
      ('${WS_ID}', 'usr_viewer', 'viewer', 'active', NOW()),
      ('${WS_ID}', 'usr_suspended', 'member', 'suspended', NOW()),
      ('${WS_ID}', 'usr_temp', 'member', 'active', NOW())
  `);

  // Seed Project
  await dbClient.query(`
    INSERT INTO "project" ("id", "workspace_id", "name", "status", "created_at", "updated_at")
    VALUES ('${PROJ_ID}', '${WS_ID}', 'Acme Main Project', 'active', NOW(), NOW())
  `);

  // Seed Tasks:
  // - task_suspended: assigned to Dave Suspended, assigned_by Alice Owner
  // - task_unassigned: unassigned
  // - task_member_assigned: assigned to Bob Member, assigned_by Bob Member
  await dbClient.query(`
    INSERT INTO "task" (
      "id", "workspace_id", "project_id", "title", "status", "priority",
      "assignee_id", "assigned_by", "assigned_at", "created_at", "updated_at"
    )
    VALUES
      ('task_suspended', '${WS_ID}', '${PROJ_ID}', 'Task with Suspended Assignee', 'todo', 'medium', 'usr_suspended', 'usr_owner', NOW(), NOW(), NOW()),
      ('task_unassigned', '${WS_ID}', '${PROJ_ID}', 'Unassigned Task', 'todo', 'medium', NULL, NULL, NULL, NOW(), NOW()),
      ('task_member_assigned', '${WS_ID}', '${PROJ_ID}', 'Task Assigned By Member', 'todo', 'high', 'usr_member', 'usr_member', NOW(), NOW(), NOW())
  `);

  // 4. Start Next.js development server
  const port = await getFreePort();
  baseURL = `http://127.0.0.1:${port}`;
  const nextBin = require.resolve("next/dist/bin/next");

  serverProcess = spawn(
    process.execPath,
    [nextBin, "dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: "development",
        AUTH_MODE: "accounts",
        DATABASE_URL: testDbUrl.toString(),
        AUTH_SECRET: "test-accounts-mode-e2e-secret-very-long-32-chars",
        AUTH_URL: baseURL,
        AUTH_TRUST_HOST: "true",
        AUTH_LOG_MAGIC_LINK: "true",
        DASHBOARD_DISABLE_SCHEDULER: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdoutBuffer = "";
  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      loggedLines.push(line);
      const match = line.match(/\[auth\] magic link for ([^:]+):\s*(http\S+)/);
      if (match) {
        const email = match[1]?.trim();
        const url = match[2]?.trim();
        if (email && url) {
          const waiter = magicLinkWaiters.get(email);
          if (waiter) {
            magicLinkWaiters.delete(email);
            waiter(url);
          }
        }
      }
    }
  });

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    const errText = chunk.toString("utf8");
    // Ignore benign Next.js telemetry / fast refresh logs
    if (!errText.includes("Fast Refresh")) {
      loggedLines.push(`[stderr] ${errText.replace(/\r$/, "")}`);
    }
  });

  await waitForServer(baseURL);

  // 5. Sign in owner, member, and viewer
  ownerJar = await signInUser(OWNER_EMAIL, WS_ID);
  memberJar = await signInUser(MEMBER_EMAIL, WS_ID);
  viewerJar = await signInUser(VIEWER_EMAIL, WS_ID);
});

after(async () => {
  // 1. Terminate server process group
  if (serverProcess?.pid) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"]);
      } else {
        process.kill(-serverProcess.pid, "SIGTERM");
      }
    } catch {
      serverProcess.kill("SIGTERM");
    }
  }

  // 2. Close db client and pool
  if (dbClient) {
    try {
      await dbClient.end();
    } catch {
      // Ignore
    }
  }
  try {
    const { closePgPool } = await import("../../src/db/pg-client");
    await closePgPool();
  } catch {
    // Ignore
  }

  // 3. Drop throwaway database
  const adminClient = new Client({ connectionString: adminUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM public;`);
    await adminClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
    );
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}";`);
  } finally {
    await adminClient.end();
  }
});

describe("Accounts Mode E2E Workflows (HTTP + Real Next.js + PostgreSQL)", () => {
  describe("Owner Flow", () => {
    it("the members page / API lists all statuses for owner", async () => {
      const res = await fetch(`${baseURL}/api/workspaces/${WS_ID}/members?status=all`, {
        headers: { cookie: ownerJar.header() },
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as { members: Array<{ id: string; status: string }> };
      assert.ok(data.members.length >= 4);

      const statuses = new Set(data.members.map((m) => m.status));
      assert.ok(statuses.has("active"), "should contain active members");
      assert.ok(statuses.has("suspended"), "should contain suspended members");
    });

    it("suspending a member works", async () => {
      const patchRes = await fetch(`${baseURL}/api/workspaces/${WS_ID}/members/usr_temp`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: ownerJar.header(),
        },
        body: JSON.stringify({ status: "suspended" }),
      });
      assert.equal(patchRes.status, 200);

      // Verify in DB
      const check = await dbClient.query(
        `SELECT status FROM "workspace_member" WHERE workspace_id = $1 AND user_id = $2`,
        [WS_ID, "usr_temp"],
      );
      assert.equal(check.rows[0]?.status, "suspended");
    });

    it("changing your own membership returns 403", async () => {
      // Owner self-demotion rejected
      const demoteRes = await fetch(`${baseURL}/api/workspaces/${WS_ID}/members/usr_owner`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: ownerJar.header(),
        },
        body: JSON.stringify({ role: "member" }),
      });
      assert.equal(demoteRes.status, 403);

      // Owner self-suspension rejected
      const suspendRes = await fetch(`${baseURL}/api/workspaces/${WS_ID}/members/usr_owner`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: ownerJar.header(),
        },
        body: JSON.stringify({ status: "suspended" }),
      });
      assert.equal(suspendRes.status, 403);
    });
  });

  describe("Viewer Flow", () => {
    it("the members API returns active only (status=all returns 403)", async () => {
      // Default / active query works
      const activeRes = await fetch(`${baseURL}/api/workspaces/${WS_ID}/members`, {
        headers: { cookie: viewerJar.header() },
      });
      assert.equal(activeRes.status, 200);
      const data = (await activeRes.json()) as { members: Array<{ id: string; status: string }> };
      for (const member of data.members) {
        assert.equal(member.status, "active", "viewer must only see active members");
      }

      // Requesting non-active / all returns 403
      const allRes = await fetch(`${baseURL}/api/workspaces/${WS_ID}/members?status=all`, {
        headers: { cookie: viewerJar.header() },
      });
      assert.equal(allRes.status, 403);
    });

    it("the project tasks page data contains no email for a suspended assignee (Stage 1A)", async () => {
      const pageRes = await fetch(`${baseURL}/projects/${PROJ_ID}/tasks`, {
        headers: { cookie: viewerJar.header() },
      });
      assert.equal(pageRes.status, 200);
      const html = await pageRes.text();

      // Renders the task and member name
      assert.ok(html.includes("Task with Suspended Assignee"), "task title should render");
      assert.ok(html.includes("Dave Suspended"), "assignee display name should render");
      assert.ok(html.includes("(Suspended)"), "suspended chip should render");

      // CRITICAL SECURITY ASSERTION (Stage 1A leak fix):
      // The suspended member's email must NOT be present anywhere in the server-rendered HTML or payload
      assert.equal(
        html.includes(SUSPENDED_EMAIL),
        false,
        "suspended member email must NOT be leaked to viewer in page data",
      );
    });

    it("task mutations return 403", async () => {
      // Create rejected
      const createRes = await fetch(`${baseURL}/api/projects/${PROJ_ID}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: viewerJar.header(),
        },
        body: JSON.stringify({ title: "Viewer Forbidden Task" }),
      });
      assert.equal(createRes.status, 403);

      // Edit rejected
      const editRes = await fetch(`${baseURL}/api/tasks/task_unassigned`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: viewerJar.header(),
        },
        body: JSON.stringify({ title: "Viewer Hacked Task" }),
      });
      assert.equal(editRes.status, 403);
    });

    it("viewer read-only behavior: task selection checkboxes and bulk actions bar are not rendered", async () => {
      const pageRes = await fetch(`${baseURL}/projects/${PROJ_ID}/tasks`, {
        headers: { cookie: viewerJar.header() },
      });
      assert.equal(pageRes.status, 200);
      const html = await pageRes.text();
      assert.equal(html.includes("Select all visible"), false);
      assert.equal(html.includes("Select task"), false);
      assert.equal(html.includes("BulkActionsBar"), false);
    });
  });

  describe("Member Flow", () => {
    it("can assign a task to an active member", async () => {
      const createRes = await fetch(`${baseURL}/api/projects/${PROJ_ID}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: memberJar.header(),
        },
        body: JSON.stringify({
          title: "Member Created and Assigned",
          assigneeId: "usr_member",
        }),
      });
      assert.equal(createRes.status, 201);
      const json = (await createRes.json()) as { task: { assigneeId: string; assignedBy: string } };
      assert.equal(json.task.assigneeId, "usr_member");
      assert.equal(json.task.assignedBy, "usr_member");
    });

    it("assigning a suspended member returns 422", async () => {
      // On create
      const createRes = await fetch(`${baseURL}/api/projects/${PROJ_ID}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: memberJar.header(),
        },
        body: JSON.stringify({
          title: "Assign Suspended",
          assigneeId: "usr_suspended",
        }),
      });
      assert.equal(createRes.status, 422);

      // On patch
      const patchRes = await fetch(`${baseURL}/api/tasks/task_unassigned`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: memberJar.header(),
        },
        body: JSON.stringify({
          assigneeId: "usr_suspended",
        }),
      });
      assert.equal(patchRes.status, 422);
    });

    it("'assignedBy=me' and 'unassigned=true' filters return the right tasks", async () => {
      // 1. Filter: assignedBy=me
      const byMeRes = await fetch(`${baseURL}/api/projects/${PROJ_ID}/tasks?assignedBy=me`, {
        headers: { cookie: memberJar.header() },
      });
      assert.equal(byMeRes.status, 200);
      const byMeData = (await byMeRes.json()) as { tasks: Array<{ id: string; assignedBy: string }> };
      assert.ok(byMeData.tasks.length >= 1);
      for (const t of byMeData.tasks) {
        assert.equal(t.assignedBy, "usr_member", "tasks should be assigned by Bob Member");
      }

      // 2. Filter: unassigned=true
      const unassignedRes = await fetch(`${baseURL}/api/projects/${PROJ_ID}/tasks?unassigned=true`, {
        headers: { cookie: memberJar.header() },
      });
      assert.equal(unassignedRes.status, 200);
      const unassignedData = (await unassignedRes.json()) as {
        tasks: Array<{ id: string; assigneeId: string | null }>;
      };
      assert.ok(unassignedData.tasks.length >= 1);
      for (const t of unassignedData.tasks) {
        assert.equal(t.assigneeId, null, "tasks should be unassigned");
      }
    });

    it("editing only the title of a task whose assignee is suspended succeeds and keeps assignee_id and assigned_by", async () => {
      // Verify initial state in DB
      const before = await dbClient.query(
        `SELECT title, assignee_id, assigned_by FROM "task" WHERE id = 'task_suspended'`,
      );
      assert.equal(before.rows[0]?.assignee_id, "usr_suspended");
      assert.equal(before.rows[0]?.assigned_by, "usr_owner");

      // Edit only title as member
      const patchRes = await fetch(`${baseURL}/api/tasks/task_suspended`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: memberJar.header(),
        },
        body: JSON.stringify({
          title: "Safely Updated Title on Suspended Assignee Task",
        }),
      });
      assert.equal(patchRes.status, 200);

      // Verify in database: title updated, but assignee_id and assigned_by remain intact!
      const after = await dbClient.query(
        `SELECT title, assignee_id, assigned_by FROM "task" WHERE id = 'task_suspended'`,
      );
      assert.equal(after.rows[0]?.title, "Safely Updated Title on Suspended Assignee Task");
      assert.equal(after.rows[0]?.assignee_id, "usr_suspended");
      assert.equal(after.rows[0]?.assigned_by, "usr_owner");
    });

    it("bulk assignee search supports workspaces with > 100 members and finds member beyond page 1", async () => {
      // Seed 105 active members into workspace
      for (let i = 1; i <= 104; i++) {
        const uId = `usr_e2e_scale_${i}`;
        await dbClient.query(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified")
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [uId, `Scale Member ${i}`, `e2e_member_${i}@test.local`],
        );
        await dbClient.query(
          `INSERT INTO "workspace_member" ("workspace_id", "user_id", "role", "status", "created_at")
           VALUES ($1, $2, 'member', 'active', NOW())
           ON CONFLICT DO NOTHING`,
          [WS_ID, uId],
        );
      }

      const targetId = "usr_e2e_zulu_105";
      await dbClient.query(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified")
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [targetId, "Zulu Member 105", "zulu_member_105@test.local"],
      );
      await dbClient.query(
        `INSERT INTO "workspace_member" ("workspace_id", "user_id", "role", "status", "created_at")
         VALUES ($1, $2, 'member', 'active', NOW())
         ON CONFLICT DO NOTHING`,
        [WS_ID, targetId],
      );

      // Search members via API
      const searchRes = await fetch(
        `${baseURL}/api/workspaces/${WS_ID}/members?status=active&search=Zulu%20Member%20105`,
        {
          headers: { cookie: memberJar.header() },
        },
      );
      assert.equal(searchRes.status, 200);
      const searchData = (await searchRes.json()) as { members: Array<{ id: string; name: string }> };
      assert.ok(searchData.members.some((m) => m.id === targetId));

      // Perform bulk update assigning to this member
      const bulkRes = await fetch(`${baseURL}/api/tasks/bulk`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: memberJar.header(),
        },
        body: JSON.stringify({
          taskIds: ["task_unassigned"],
          changes: { assigneeId: targetId },
        }),
      });
      assert.equal(bulkRes.status, 200);
      const bulkData = (await bulkRes.json()) as { updated: number; failed: number };
      assert.equal(bulkData.updated, 1);
      assert.equal(bulkData.failed, 0);

      // Verify in DB
      const check = await dbClient.query(
        `SELECT assignee_id FROM "task" WHERE id = 'task_unassigned'`,
      );
      assert.equal(check.rows[0]?.assignee_id, targetId);
    });
  });
});

describe("Release 2C.6 collaboration notifications (real browser)", () => {
  const WS2_ID = "ws_e2e_second";
  const PROJ2_ID = "proj_e2e_second";
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  async function createAssignedTask(jar: ReturnType<typeof createCookieJar>, projectId: string, title: string) {
    const res = await fetch(`${baseURL}/api/projects/${projectId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify({ title, assigneeId: "usr_member" }),
    });
    assert.equal(res.status, 201, `create ${title}: ${res.status}`);
  }

  async function pageFor(jar: ReturnType<typeof createCookieJar>): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    const cookies = jar
      .header()
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        return { name: pair.slice(0, eq), value: pair.slice(eq + 1), url: baseURL };
      });
    await context.addCookies(cookies);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    return page;
  }

  const bell = (page: Page) => page.getByRole("button", { name: /^Notifications/ });
  const panel = (page: Page) => page.getByRole("dialog", { name: "Notifications" });

  before(async () => {
    browser = await chromium.launch();

    // A second workspace the member also belongs to.
    await dbClient.query(
      `INSERT INTO "workspace" ("id", "name", "slug", "kind", "created_by", "created_at", "updated_at")
       VALUES ($1, 'Beta Workspace', 'beta-workspace', 'team', 'usr_owner', NOW(), NOW())`,
      [WS2_ID],
    );
    await dbClient.query(
      `INSERT INTO "workspace_member" ("workspace_id", "user_id", "role", "status", "created_at")
       VALUES ($1, 'usr_owner', 'owner', 'active', NOW()), ($1, 'usr_member', 'member', 'active', NOW())`,
      [WS2_ID],
    );
    await dbClient.query(
      `INSERT INTO "project" ("id", "workspace_id", "name", "status", "created_at", "updated_at")
       VALUES ($1, $2, 'Beta Project', 'active', NOW(), NOW())`,
      [PROJ2_ID, WS2_ID],
    );

    // Start from a clean inbox for the member, then have the owner assign work.
    await dbClient.query(`DELETE FROM "notification" WHERE "recipient_id" = 'usr_member'`);
    await createAssignedTask(ownerJar, PROJ_ID, "Alpha notice one");
    await createAssignedTask(ownerJar, PROJ_ID, "Alpha notice two");
    await createAssignedTask(ownerJar, PROJ_ID, "Alpha notice three");

    const ownerInWs2 = createCookieJar();
    for (const pair of ownerJar.header().split("; ").filter(Boolean)) {
      const eq = pair.indexOf("=");
      ownerInWs2.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    ownerInWs2.set("cc-current-workspace", WS2_ID);
    await createAssignedTask(ownerInWs2, PROJ2_ID, "Beta only notice");
  });

  after(async () => {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close();
  });

  it("shows the unread count, opens and closes the panel by keyboard, and marks read", async () => {
    const page = await pageFor(memberJar);
    await page.goto(`${baseURL}/my-work`);
    await page.getByRole("button", { name: "Notifications, 3 unread" }).waitFor();
    assert.equal(await page.getByTestId("inbox-unread-badge").textContent(), "3");

    await bell(page).focus();
    await page.keyboard.press("Enter");
    await panel(page).waitFor();
    assert.equal(await bell(page).getAttribute("aria-expanded"), "true");
    const items = panel(page).getByRole("listitem");
    await items.first().waitFor();
    assert.equal(await items.count(), 3);
    assert.equal(await panel(page).getByText("Unread", { exact: true }).count(), 3, "text label, not colour only");
    assert.ok(!(await panel(page).textContent())?.includes("Beta only notice"), "no other-workspace rows");

    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup")), "dialog");

    // Keyboard-operate "Mark as read" on the newest notification.
    await page.keyboard.press("Enter");
    await panel(page).waitFor();
    const markRead = panel(page).getByRole("button", { name: /^Mark as read: .*Alpha notice three/ });
    await markRead.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Notifications, 2 unread" }).waitFor();
    await panel(page).getByRole("button", { name: /^Mark as unread: .*Alpha notice three/ }).waitFor();
    assert.equal(await panel(page).getByText("Unread", { exact: true }).count(), 2);

    await panel(page).getByRole("button", { name: "Mark all read" }).click();
    await page.getByRole("button", { name: "Notifications, no unread" }).waitFor();
    assert.equal(await panel(page).getByText("Unread", { exact: true }).count(), 0);
  });

  it("archives from the panel and restores from the inbox page", async () => {
    const page = await pageFor(memberJar);
    await page.goto(`${baseURL}/my-work`);
    await page.getByRole("button", { name: "Notifications, no unread" }).waitFor();
    await bell(page).click();
    await panel(page).getByRole("button", { name: /^Archive: .*Alpha notice two/ }).click();
    await panel(page).getByText("Alpha notice two").waitFor({ state: "detached" });

    await panel(page).getByRole("link", { name: "Open inbox" }).click();
    await page.waitForURL(/\/inbox$/);
    await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Archived", pressed: false }).click();
    const archivedList = page.getByRole("list", { name: "Archived notifications" });
    await archivedList.getByText("Alpha notice two").waitFor();
    await archivedList.getByRole("button", { name: /^Restore: .*Alpha notice two/ }).click();
    await page.getByText("No archived notifications").waitFor();

    await page.getByRole("button", { name: "Inbox", pressed: false }).click();
    await page.getByRole("list", { name: "Notifications" }).getByText("Alpha notice two").waitFor();

    // The task link goes to the task on its project board.
    const link = page.getByRole("link", { name: "Alpha notice two" });
    assert.match((await link.getAttribute("href")) ?? "", /^\/projects\/proj_e2e_main\/tasks#task-/);
  });

  it("switching workspaces in Settings swaps the inbox without leaking the other workspace", async () => {
    const page = await pageFor(memberJar);
    await page.goto(`${baseURL}/settings`);
    await page.getByRole("button", { name: "Notifications, no unread" }).waitFor();

    const betaRow = page.getByRole("listitem").filter({ hasText: "Beta Workspace" });
    await betaRow.getByRole("button", { name: "Switch" }).click();
    await page.getByRole("button", { name: "Notifications, 1 unread" }).waitFor();

    await bell(page).click();
    await panel(page).getByText("Beta only notice").waitFor();
    const text = (await panel(page).textContent()) ?? "";
    assert.ok(!text.includes("Alpha notice"), "workspace A notifications never appear in workspace B");
    await page.keyboard.press("Escape");

    // And back again.
    const acmeRow = page.getByRole("listitem").filter({ hasText: "Acme Corporation" });
    await acmeRow.getByRole("button", { name: "Switch" }).click();
    await page.getByRole("button", { name: "Notifications, no unread" }).waitFor();
    await bell(page).click();
    await panel(page).getByText("Alpha notice one").waitFor();
    assert.ok(!((await panel(page).textContent()) ?? "").includes("Beta only notice"));
  });

  it("shows an empty state for a member with no notifications", async () => {
    const page = await pageFor(viewerJar);
    await page.goto(`${baseURL}/inbox`);
    await page.getByText("You're all caught up").waitFor();
    await page.getByRole("button", { name: "Notifications, no unread" }).waitFor();
    await page.getByRole("button", { name: "Archived" }).click();
    await page.getByText("No archived notifications").waitFor();
  });

  it("shows an error state with a working retry", async () => {
    const page = await pageFor(memberJar);
    let fail = true;
    await page.route(/\/api\/inbox\?/, async (route) => {
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      else await route.continue();
    });
    await page.goto(`${baseURL}/inbox`);
    const alert = page.getByRole("alert").filter({ hasText: "Couldn't load notifications." });
    await alert.waitFor();
    fail = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await page.getByRole("list", { name: "Notifications" }).getByText("Alpha notice one").waitFor();
  });
});
