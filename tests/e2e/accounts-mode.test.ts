/**
 * Release 2C.2 / Phase 2C Accounts-Mode End-to-End Tests.
 *
 * Boots a real built production Next.js server configured with AUTH_MODE=accounts
 * backed by a throwaway PostgreSQL database.
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
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

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

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/auth/csrf`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // Server not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

function waitForMagicLink(email: string, timeoutMs = 20_000): Promise<string> {
  const existing = loggedLines.find((l) => l.includes(`magic link for ${email}`));
  if (existing) {
    const match = existing.match(/(http\S+)/);
    if (match?.[1]) return Promise.resolve(match[1]);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      magicLinkWaiters.delete(email);
      reject(new Error(`Timeout waiting for magic link for ${email}. Logged: ${loggedLines.join("\n")}`));
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

  // 4. Start Next.js built production server
  const port = await getFreePort();
  baseURL = `http://127.0.0.1:${port}`;
  const nextBin = require.resolve("next/dist/bin/next");

  serverProcess = spawn(
    process.execPath,
    [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTH_MODE: "accounts",
        DATABASE_URL: testDbUrl.toString(),
        AUTH_SECRET: "test-accounts-mode-e2e-secret-very-long-32-chars",
        AUTH_URL: baseURL,
        AUTH_TRUST_HOST: "true",
        AUTH_LOG_MAGIC_LINK: "true",
        DASHBOARD_DISABLE_SCHEDULER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdoutBuffer = "";
  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
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
    // Ignore benign Next.js telemetry warnings
    if (!errText.includes("Fast Refresh")) {
      loggedLines.push(`[stderr] ${errText}`);
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
  });
});
