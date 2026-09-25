/**
 * Release 2D.2 timeline — accounts-mode API authorization (Auth.js + PostgreSQL).
 * Real magic-link sessions, real route handlers, no overrides.
 *
 * 1. Unauthenticated → 401; suspended / removed (cookie naming the workspace) → 403.
 * 2. Owner, admin, member and viewer all read it (read-only for everyone);
 *    the viewer still cannot write through the existing task route.
 * 3. Foreign and nonexistent project ids → the same generic 404; an outsider
 *    forging the workspace cookie resolves to their own workspace.
 * 4. Workspace switching: the result follows the active-workspace cookie.
 * 5. Strict validation; payloads carry assignee names only — no email, image,
 *    role, descriptions or auth fields.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";
import { assertNoForbiddenKeys } from "../helpers/timeline-fixtures";
import type { TimelineResponse } from "../../src/core/timeline/types";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

let timelineRoute: typeof import("../../src/app/api/projects/[id]/timeline/route");
let projectsRoute: typeof import("../../src/app/api/projects/route");
let projectTasksRoute: typeof import("../../src/app/api/projects/[id]/tasks/route");
let dependenciesRoute: typeof import("../../src/app/api/tasks/[id]/dependencies/route");
let milestonesRoute: typeof import("../../src/app/api/projects/[id]/milestones/route");
let taskRoute: typeof import("../../src/app/api/tasks/[id]/route");
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let schema: typeof import("../../src/db/schema.pg");

const EMAILS = {
  owner: "tl_owner@example.com",
  admin: "tl_admin@example.com",
  member: "tl_member@example.com",
  viewer: "tl_viewer@example.com",
  suspended: "tl_suspended@example.com",
  removed: "tl_removed@example.com",
  outsider: "tl_outsider@example.com",
} as const;
type Role = keyof typeof EMAILS;
const session = {} as Record<Role, string>;
const id = {} as Record<Role, string>;
let wsA: string;
let wsB: string;
let projectA: string;
let projectB: string;
let blockedTaskA: string;

const QUERY = "zoom=month&anchor=2026-10-15&tz=America/New_York";

function cookie(role: Role, ws = role === "outsider" ? wsB : wsA) {
  return `${session[role]}; cc-current-workspace=${ws}`;
}

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function signIn(email: string): Promise<string> {
  const jar = new Map<string, string>();
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (r: Response) => {
    for (const raw of r.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      if (v === "") jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), v);
    }
  };
  const csrf = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
  absorb(csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const logs: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  let signin: Response;
  try {
    signin = await handlers.POST(
      new NextRequest("http://localhost/api/auth/signin/nodemailer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
        body: new URLSearchParams({ email, csrfToken, callbackUrl: "http://localhost/" }).toString(),
      }),
    );
  } finally {
    console.log = original;
  }
  absorb(signin);
  const link = logs.find((l) => l.includes(`magic link for ${email}`))?.match(/(http:\S+)/)?.[1];
  if (!link) throw new Error(`no magic link for ${email}`);
  const cb = await handlers.GET(new NextRequest(link, { headers: { cookie: header() } }));
  absorb(cb);
  assert.equal(cb.status, 302);
  return header();
}

async function timeline(c: string | undefined, projectId: string, query = QUERY) {
  const res = await timelineRoute.GET(req("GET", `/api/projects/${projectId}/timeline?${query}`, { cookie: c }), {
    params: Promise.resolve({ id: projectId }),
  });
  const text = await res.text();
  return { res, text, body: res.status === 200 ? (JSON.parse(text) as TimelineResponse) : null };
}

before(async () => {
  await migrate();
  timelineRoute = await import("../../src/app/api/projects/[id]/timeline/route");
  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  dependenciesRoute = await import("../../src/app/api/tasks/[id]/dependencies/route");
  milestonesRoute = await import("../../src/app/api/projects/[id]/milestones/route");
  taskRoute = await import("../../src/app/api/tasks/[id]/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  schema = await import("../../src/db/schema.pg");
  const workspaces = await import("../../src/core/workspaces/service");

  for (const role of Object.keys(EMAILS) as Role[]) session[role] = await signIn(EMAILS[role]);
  const users = await db().select().from(schema.users);
  for (const role of Object.keys(EMAILS) as Role[]) {
    id[role] = users.find((u) => u.email === EMAILS[role])!.id;
    await db().update(schema.users).set({ name: `TL ${role}` }).where(eq(schema.users.id, id[role]));
  }
  wsA = (await workspaces.createTeamWorkspace(id.owner, "Timeline WS A")).id;
  wsB = (await workspaces.createTeamWorkspace(id.outsider, "Timeline WS B")).id;
  await db().insert(schema.workspaceMembers).values([
    { workspaceId: wsA, userId: id.admin, role: "admin", status: "active" },
    { workspaceId: wsA, userId: id.member, role: "member", status: "active" },
    { workspaceId: wsA, userId: id.viewer, role: "viewer", status: "active" },
    { workspaceId: wsA, userId: id.suspended, role: "member", status: "suspended" },
    { workspaceId: wsA, userId: id.removed, role: "member", status: "removed" },
    { workspaceId: wsB, userId: id.member, role: "member", status: "active" },
  ]);

  const mkProject = async (c: string, name: string) =>
    ((await (await projectsRoute.POST(req("POST", "/api/projects", { cookie: c, body: { name } }))).json()) as {
      project: { id: string };
    }).project.id;
  const mkTask = async (c: string, projectId: string, body: Record<string, unknown>) => {
    const res = await projectTasksRoute.POST(req("POST", `/api/projects/${projectId}/tasks`, { cookie: c, body }), {
      params: Promise.resolve({ id: projectId }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { task: { id: string } }).task.id;
  };
  const depend = async (c: string, taskId: string, dependsOnTaskId: string) => {
    const res = await dependenciesRoute.POST(
      req("POST", `/api/tasks/${taskId}/dependencies`, { cookie: c, body: { dependsOnTaskId } }),
      { params: Promise.resolve({ id: taskId }) },
    );
    assert.equal(res.status, 201);
  };

  projectA = await mkProject(cookie("owner"), "Timeline Project A");
  projectB = await mkProject(cookie("outsider"), "Timeline Project B secret");
  const blocker = await mkTask(cookie("owner"), projectA, { title: "A blocker", dueDate: "2026-10-20" });
  blockedTaskA = await mkTask(cookie("owner"), projectA, {
    title: "A blocked task",
    dueDate: "2026-10-08",
    assigneeId: id.member,
  });
  await depend(cookie("owner"), blockedTaskA, blocker);
  await milestonesRoute.POST(
    req("POST", `/api/projects/${projectA}/milestones`, { cookie: cookie("owner"), body: { title: "A milestone", dueDate: "2026-10-15" } }),
    { params: Promise.resolve({ id: projectA }) },
  );
  await mkTask(cookie("owner"), projectA, { title: "A undated" });
  const bTask = await mkTask(cookie("outsider"), projectB, { title: "B secret task", dueDate: "2026-10-08" });
  const bBlocker = await mkTask(cookie("outsider"), projectB, { title: "B secret blocker" });
  await depend(cookie("outsider"), bTask, bBlocker);
});

after(() => cleanup());

describe("Release 2D.2 timeline API — authentication and roles", () => {
  it("unauthenticated → 401, no-store", async () => {
    const { res } = await timeline(undefined, projectA);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  for (const role of ["owner", "admin", "member", "viewer"] as const) {
    it(`${role}: reads the project timeline (read-only), with assignee names only`, async () => {
      const { res, body, text } = await timeline(cookie(role), projectA);
      assert.equal(res.status, 200, text);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body!.workspaceId, wsA);
      assert.equal(body!.editable, false);
      assert.deepEqual(body!.items.map((i) => `${i.date} ${i.kind} ${i.title}`), [
        "2026-10-08 task A blocked task",
        "2026-10-15 milestone A milestone",
        "2026-10-20 task A blocker",
      ]);
      const blocked = body!.items[0]!;
      assert.ok(blocked.kind === "task" && blocked.blocked);
      if (blocked.kind === "task") assert.deepEqual(blocked.conflicts, ["due_before_blocker"]);
      assert.deepEqual(body!.undated.map((i) => i.title), ["A undated"]);
      assert.deepEqual(body!.assignees, [{ id: id.member, name: "TL member" }]);
      assert.ok(!text.includes("@example.com"), "no email anywhere in the payload");
      assertNoForbiddenKeys(body);
      assert.equal(body!.timeZone, "America/New_York");
    });
  }

  it("the viewer's read-only access is unchanged: the existing task route still refuses writes", async () => {
    const res = await taskRoute.PATCH(
      req("PATCH", `/api/tasks/${blockedTaskA}`, { cookie: cookie("viewer"), body: { dueDate: "2026-10-09" } }),
      { params: Promise.resolve({ id: blockedTaskA }) },
    );
    assert.equal(res.status, 403);
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) assert.ok(!(verb in timelineRoute), `timeline exports no ${verb}`);
  });

  it("suspended and removed members naming the workspace → 403", async () => {
    for (const role of ["suspended", "removed"] as const) {
      const { res } = await timeline(cookie(role), projectA);
      assert.equal(res.status, 403, role);
    }
  });
});

describe("Release 2D.2 timeline API — isolation and not-found", () => {
  it("a foreign project id reads exactly like a nonexistent one", async () => {
    const foreign = await timeline(cookie("owner"), projectB);
    const missing = await timeline(cookie("owner"), "prj_does_not_exist");
    assert.equal(foreign.res.status, 404);
    assert.equal(missing.res.status, 404);
    assert.equal(foreign.text, missing.text);
    assert.equal(foreign.text, '{"error":"Project not found"}');
  });

  it("an outsider forging workspace A in the cookie resolves to their own workspace and never sees A", async () => {
    const forged = await timeline(cookie("outsider", wsA), projectA);
    assert.equal(forged.res.status, 404);
    assert.ok(!forged.text.includes("Timeline Project A"));
    const own = await timeline(cookie("outsider"), projectB);
    assert.equal(own.res.status, 200);
    assert.equal(own.body!.workspaceId, wsB);
    assert.ok(!JSON.stringify(own.body).includes("A blocked task"));
  });

  it("follows the active-workspace cookie for a member of both workspaces", async () => {
    const inA = await timeline(cookie("member", wsA), projectA);
    assert.equal(inA.res.status, 200);
    const switched = await timeline(cookie("member", wsB), projectA);
    assert.equal(switched.res.status, 404, "project A is not in workspace B");
    const inB = await timeline(cookie("member", wsB), projectB);
    assert.equal(inB.res.status, 200);
    assert.equal(inB.body!.workspaceId, wsB);
    assert.ok(!JSON.stringify(inB.body).includes("Timeline Project A"));
  });

  it("rejects malformed, repeated and unknown parameters, including a workspace override", async () => {
    for (const q of [
      "zoom=decade&anchor=2026-10-15",
      "zoom=month&anchor=2026-10-32",
      "zoom=month&anchor=2026-10-15&anchor=2026-10-16",
      `zoom=month&anchor=2026-10-15&workspaceId=${wsB}`,
      "zoom=month&anchor=2026-10-15&tz=Nowhere/Land",
    ]) {
      const { res } = await timeline(cookie("owner"), projectA, q);
      assert.equal(res.status, 400, q);
    }
  });
});
