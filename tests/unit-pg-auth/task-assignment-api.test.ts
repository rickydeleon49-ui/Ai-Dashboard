/**
 * Release 2C.2 Task Assignment API Integration Tests (Auth.js + PostgreSQL).
 *
 * Verifies:
 * 1. Outsider user ID cannot be assigned through a direct API call (HTTP 422).
 * 2. Suspended, removed, and invited member user IDs cannot be assigned (HTTP 422).
 * 3. Full role matrix for assigning:
 *    - Owner, Admin, Member allowed to create/assign and edit/assign (HTTP 201/200).
 *    - Viewer rejected with HTTP 403 (forbidden).
 *    - Suspended member rejected with HTTP 403 (inactive_member).
 *    - Removed member rejected with HTTP 403 (inactive_member).
 *    - Outsider rejected with HTTP 403 (not_a_member) / 404.
 *    - Unauthenticated rejected with HTTP 401.
 * 4. Client-supplied assignedBy is never honored (server sets actor from session).
 * 5. Assignment filters through the API (GET /api/projects/:id/tasks and GET /api/my-work):
 *    - "me" resolves to session user server-side.
 *    - unassigned=true returns unassigned tasks.
 *    - assignedTo filter.
 *    - assignedBy filter.
 *    - invalid parameters return HTTP 422.
 * 6. Response-shape allowlist:
 *    - Accounts mode includes assignedBy and assignedAt.
 *    - Non-accounts / desktop shape excludes them.
 * 7. Hardening: PATCH /api/workspaces/:id/members/:userId rejects invited -> active with 422.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import { serializeTaskResponse } from "../../src/core/tasks/serialize";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type ProjectTasksRoute = typeof import("../../src/app/api/projects/[id]/tasks/route");
type TaskRoute = typeof import("../../src/app/api/tasks/[id]/route");
type MyWorkRoute = typeof import("../../src/app/api/my-work/route");
type MemberRoute = typeof import("../../src/app/api/workspaces/[id]/members/[userId]/route");

let projectsRoute: ProjectsRoute;
let projectTasksRoute: ProjectTasksRoute;
let taskRoute: TaskRoute;
let myWorkRoute: MyWorkRoute;
let memberRoute: MemberRoute;

let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesService: typeof import("../../src/core/workspaces/service");
let eq: typeof import("drizzle-orm").eq;

before(async () => {
  await migrate();
  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  taskRoute = await import("../../src/app/api/tasks/[id]/route");
  myWorkRoute = await import("../../src/app/api/my-work/route");
  memberRoute = await import("../../src/app/api/workspaces/[id]/members/[userId]/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaceMembers } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");
  ({ eq } = await import("drizzle-orm"));
});

after(() => cleanup());

async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return [await fn(), lines];
  } finally {
    console.log = original;
  }
}

function cookieJar() {
  const jar = new Map<string, string>();
  return {
    header(): string {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    absorb(response: Response): void {
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value === "") jar.delete(key);
        else jar.set(key, value);
      }
    },
  };
}

async function signIn(email: string): Promise<string> {
  const jar = cookieJar();

  const csrfResponse = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
  jar.absorb(csrfResponse);
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const signinBody = new URLSearchParams({ email, csrfToken, callbackUrl: "http://localhost/" });
  const [signinResponse, logs] = await withCapturedLogs(() =>
    handlers.POST(
      new NextRequest("http://localhost/api/auth/signin/nodemailer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
        body: signinBody.toString(),
      }),
    ),
  );
  jar.absorb(signinResponse);

  const magicLinkLine = logs.find((line) => line.includes(`magic link for ${email}`));
  const magicLink = magicLinkLine?.match(/(http:\S+)/)?.[1];
  if (!magicLink) throw new Error(`no magic link logged for ${email}: ${JSON.stringify(logs)}`);

  const callbackResponse = await handlers.GET(
    new NextRequest(magicLink, { headers: { cookie: jar.header() } }),
  );
  jar.absorb(callbackResponse);
  assert.equal(callbackResponse.status, 302, "sign-in callback should redirect on success");

  return jar.header();
}

function withWorkspaceCookie(cookie: string, workspaceId: string): string {
  return `${cookie}; cc-current-workspace=${workspaceId}`;
}

function apiRequest(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function getUserIdByEmail(email: string): Promise<string> {
  const [u] = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!u) throw new Error(`User not found: ${email}`);
  return u.id;
}

describe("Release 2C.2 Task Assignment API: Authorization Matrix & Validation", () => {
  it("rejects unauthenticated requests to task routes with 401", async () => {
    assert.equal(
      (await projectTasksRoute.GET(apiRequest("GET", "/api/projects/p1/tasks"), {
        params: Promise.resolve({ id: "p1" }),
      })).status,
      401,
    );
    assert.equal(
      (await projectTasksRoute.POST(
        apiRequest("POST", "/api/projects/p1/tasks", { body: { title: "T" } }),
        { params: Promise.resolve({ id: "p1" }) },
      )).status,
      401,
    );
    assert.equal(
      (await taskRoute.GET(apiRequest("GET", "/api/tasks/t1"), {
        params: Promise.resolve({ id: "t1" }),
      })).status,
      401,
    );
    assert.equal(
      (await taskRoute.PATCH(
        apiRequest("PATCH", "/api/tasks/t1", { body: { title: "T" } }),
        { params: Promise.resolve({ id: "t1" }) },
      )).status,
      401,
    );
    assert.equal((await myWorkRoute.GET(apiRequest("GET", "/api/my-work"))).status, 401);
  });

  it("enforces role matrix for assigning tasks (owner/admin/member vs viewer/suspended/removed/outsider)", async () => {
    const ownerEmail = `owner_${Date.now()}@example.com`;
    const adminEmail = `admin_${Date.now()}@example.com`;
    const memberEmail = `member_${Date.now()}@example.com`;
    const viewerEmail = `viewer_${Date.now()}@example.com`;
    const outsiderEmail = `outsider_${Date.now()}@example.com`;

    const ownerCookieRaw = await signIn(ownerEmail);
    const adminCookieRaw = await signIn(adminEmail);
    const memberCookieRaw = await signIn(memberEmail);
    const viewerCookieRaw = await signIn(viewerEmail);
    const outsiderCookie = await signIn(outsiderEmail);

    const ownerId = await getUserIdByEmail(ownerEmail);
    const adminId = await getUserIdByEmail(adminEmail);
    const memberId = await getUserIdByEmail(memberEmail);
    const viewerId = await getUserIdByEmail(viewerEmail);

    // Create workspace with owner
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Role Matrix Team");

    // Add members with roles
    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: adminId, role: "admin", status: "active" },
      { workspaceId: ws.id, userId: memberId, role: "member", status: "active" },
      { workspaceId: ws.id, userId: viewerId, role: "viewer", status: "active" },
    ]);

    const ownerCookie = withWorkspaceCookie(ownerCookieRaw, ws.id);
    const adminCookie = withWorkspaceCookie(adminCookieRaw, ws.id);
    const memberCookie = withWorkspaceCookie(memberCookieRaw, ws.id);
    const viewerCookie = withWorkspaceCookie(viewerCookieRaw, ws.id);

    // Create project
    const projRes = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Project Matrix" } }),
    );
    const proj = ((await projRes.json()) as { project: { id: string } }).project;

    // 1. Owner can create task and assign to member
    const ownerCreateRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "Owner Created", assigneeId: memberId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(ownerCreateRes.status, 201);
    const task1 = ((await ownerCreateRes.json()) as { task: any }).task;
    assert.equal(task1.assigneeId, memberId);
    assert.equal(task1.assignedBy, ownerId);
    assert.ok(task1.assignedAt);

    // 2. Admin can create task and assign to owner
    const adminCreateRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: adminCookie,
        body: { title: "Admin Created", assigneeId: ownerId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(adminCreateRes.status, 201);
    const task2 = ((await adminCreateRes.json()) as { task: any }).task;
    assert.equal(task2.assigneeId, ownerId);
    assert.equal(task2.assignedBy, adminId);

    // 3. Member can create task and assign to self or admin
    const memberCreateRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: memberCookie,
        body: { title: "Member Created", assigneeId: adminId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(memberCreateRes.status, 201);
    const task3 = ((await memberCreateRes.json()) as { task: any }).task;
    assert.equal(task3.assigneeId, adminId);
    assert.equal(task3.assignedBy, memberId);

    // 4. Viewer cannot create or assign tasks (403 forbidden)
    const viewerCreateRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: viewerCookie,
        body: { title: "Viewer Created", assigneeId: memberId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(viewerCreateRes.status, 403);

    // 5. Viewer cannot update tasks or assign them (403 forbidden)
    const viewerUpdateRes = await taskRoute.PATCH(
      apiRequest("PATCH", `/api/tasks/${task1.id}`, {
        cookie: viewerCookie,
        body: { assigneeId: adminId },
      }),
      { params: Promise.resolve({ id: task1.id }) },
    );
    assert.equal(viewerUpdateRes.status, 403);

    // 6. Outsider cannot create or assign tasks (403 not_a_member)
    const outsiderCreateRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: withWorkspaceCookie(outsiderCookie, ws.id),
        body: { title: "Outsider Task", assigneeId: memberId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.ok(
      outsiderCreateRes.status === 403 || outsiderCreateRes.status === 404,
      `outsider should be rejected with 403 or 404, got ${outsiderCreateRes.status}`,
    );

    // 7. Suspended member cannot assign or update tasks (rejected with 403 or 404)
    await workspacesService.updateMemberStatus(ws.id, memberId, "suspended", { callerRole: "owner" });

    const suspendedCreateRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: memberCookie,
        body: { title: "Suspended Task", assigneeId: adminId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.ok(
      suspendedCreateRes.status === 403 || suspendedCreateRes.status === 404,
      `suspended member should be rejected with 403 or 404, got ${suspendedCreateRes.status}`,
    );

    // 8. Removed member cannot assign or update tasks (rejected with 403 or 404)
    await workspacesService.removeMember(ws.id, adminId, { callerRole: "owner" });

    const removedCreateRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: adminCookie,
        body: { title: "Removed Task" },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.ok(
      removedCreateRes.status === 403 || removedCreateRes.status === 404,
      `removed member should be rejected with 403 or 404, got ${removedCreateRes.status}`,
    );
  });

  it("rejects direct API calls assigning outsider, suspended, removed, or invited users with 422", async () => {
    const ownerEmail = `guard_owner_${Date.now()}@example.com`;
    const outsiderEmail = `guard_outsider_${Date.now()}@example.com`;
    const suspendedEmail = `guard_suspended_${Date.now()}@example.com`;
    const removedEmail = `guard_removed_${Date.now()}@example.com`;
    const invitedEmail = `guard_invited_${Date.now()}@example.com`;

    const ownerCookieRaw = await signIn(ownerEmail);
    const outsiderCookie = await signIn(outsiderEmail);
    const suspendedCookie = await signIn(suspendedEmail);
    const removedCookie = await signIn(removedEmail);
    const invitedCookie = await signIn(invitedEmail);

    const ownerId = await getUserIdByEmail(ownerEmail);
    const outsiderId = await getUserIdByEmail(outsiderEmail);
    const suspendedId = await getUserIdByEmail(suspendedEmail);
    const removedId = await getUserIdByEmail(removedEmail);
    const invitedId = await getUserIdByEmail(invitedEmail);

    const ws = await workspacesService.createTeamWorkspace(ownerId, "Assignee Guard Co");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: suspendedId, role: "member", status: "suspended" },
      { workspaceId: ws.id, userId: removedId, role: "member", status: "removed" },
      { workspaceId: ws.id, userId: invitedId, role: "member", status: "invited" },
    ]);

    const ownerCookie = withWorkspaceCookie(ownerCookieRaw, ws.id);

    const projRes = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Guard Proj" } }),
    );
    const proj = ((await projRes.json()) as { project: { id: string } }).project;

    // 1. Assigning outsider user ID fails with 422
    const resOutsider = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "T Outsider", assigneeId: outsiderId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(resOutsider.status, 422);
    assert.match(((await resOutsider.json()) as any).error, /active member/i);

    // 2. Assigning suspended member fails with 422
    const resSuspended = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "T Suspended", assigneeId: suspendedId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(resSuspended.status, 422);
    assert.match(((await resSuspended.json()) as any).error, /active member/i);

    // 3. Assigning removed member fails with 422
    const resRemoved = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "T Removed", assigneeId: removedId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(resRemoved.status, 422);
    assert.match(((await resRemoved.json()) as any).error, /active member/i);

    // 4. Assigning invited member fails with 422
    const resInvited = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "T Invited", assigneeId: invitedId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(resInvited.status, 422);
    assert.match(((await resInvited.json()) as any).error, /active member/i);

    // 5. Same guards apply on PATCH
    const validCreate = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "Valid Initial Task" },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    const validTask = ((await validCreate.json()) as { task: any }).task;

    const patchSuspended = await taskRoute.PATCH(
      apiRequest("PATCH", `/api/tasks/${validTask.id}`, {
        cookie: ownerCookie,
        body: { assigneeId: suspendedId },
      }),
      { params: Promise.resolve({ id: validTask.id }) },
    );
    assert.equal(patchSuspended.status, 422);

    const patchRemoved = await taskRoute.PATCH(
      apiRequest("PATCH", `/api/tasks/${validTask.id}`, {
        cookie: ownerCookie,
        body: { assigneeId: removedId },
      }),
      { params: Promise.resolve({ id: validTask.id }) },
    );
    assert.equal(patchRemoved.status, 422);
  });

  it("never honors a client-supplied assignedBy in request body (POST & PATCH)", async () => {
    const ownerEmail = `spoof_owner_${Date.now()}@example.com`;
    const memberEmail = `spoof_member_${Date.now()}@example.com`;
    const victimEmail = `spoof_victim_${Date.now()}@example.com`;

    const ownerCookieRaw = await signIn(ownerEmail);
    const memberCookieRaw = await signIn(memberEmail);
    const victimCookieRaw = await signIn(victimEmail);

    const ownerId = await getUserIdByEmail(ownerEmail);
    const memberId = await getUserIdByEmail(memberEmail);
    const victimId = await getUserIdByEmail(victimEmail);

    const ws = await workspacesService.createTeamWorkspace(ownerId, "Spoofing Co");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: memberId, role: "member", status: "active" },
      { workspaceId: ws.id, userId: victimId, role: "member", status: "active" },
    ]);

    const ownerCookie = withWorkspaceCookie(ownerCookieRaw, ws.id);
    const memberCookie = withWorkspaceCookie(memberCookieRaw, ws.id);

    const projRes = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Spoof Proj" } }),
    );
    const proj = ((await projRes.json()) as { project: { id: string } }).project;

    // 1. In POST: client sends assignedBy: victimId, but session is memberId
    const postRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: memberCookie,
        body: {
          title: "Attempted Spoof POST",
          assigneeId: memberId,
          assignedBy: victimId,
          assigned_by: victimId,
        },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(postRes.status, 201);
    const postTask = ((await postRes.json()) as { task: any }).task;
    assert.equal(postTask.assigneeId, memberId);
    assert.equal(postTask.assignedBy, memberId); // Session user, NOT victimId!

    // 2. In PATCH: client sends assignedBy: victimId, but session is memberId
    const patchRes = await taskRoute.PATCH(
      apiRequest("PATCH", `/api/tasks/${postTask.id}`, {
        cookie: memberCookie,
        body: {
          assigneeId: victimId,
          assignedBy: ownerId,
          assigned_by: ownerId,
        },
      }),
      { params: Promise.resolve({ id: postTask.id }) },
    );
    assert.equal(patchRes.status, 200);
    const patchTask = ((await patchRes.json()) as { task: any }).task;
    assert.equal(patchTask.assigneeId, victimId);
    assert.equal(patchTask.assignedBy, memberId); // Session user, NOT ownerId!
  });

  it("filters tasks by unassigned, assignedTo, and assignedBy through the API with 'me' resolution", async () => {
    const ownerEmail = `filters_owner_${Date.now()}@example.com`;
    const member1Email = `filters_m1_${Date.now()}@example.com`;
    const member2Email = `filters_m2_${Date.now()}@example.com`;

    const ownerCookieRaw = await signIn(ownerEmail);
    const member1CookieRaw = await signIn(member1Email);
    const member2CookieRaw = await signIn(member2Email);

    const ownerId = await getUserIdByEmail(ownerEmail);
    const m1Id = await getUserIdByEmail(member1Email);
    const m2Id = await getUserIdByEmail(member2Email);

    const ws = await workspacesService.createTeamWorkspace(ownerId, "Filters Co");

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: m1Id, role: "member", status: "active" },
      { workspaceId: ws.id, userId: m2Id, role: "member", status: "active" },
    ]);

    const ownerCookie = withWorkspaceCookie(ownerCookieRaw, ws.id);
    const member1Cookie = withWorkspaceCookie(member1CookieRaw, ws.id);

    const projRes = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Filters Project" } }),
    );
    const proj = ((await projRes.json()) as { project: { id: string } }).project;

    // Task 1: Unassigned
    await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "Unassigned Task" },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );

    // Task 2: Assigned to m1 by owner
    await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "Task for M1 by Owner", assigneeId: m1Id },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );

    // Task 3: Assigned to m2 by m1
    await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: member1Cookie,
        body: { title: "Task for M2 by M1", assigneeId: m2Id },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );

    // --- Query tests on /api/projects/:id/tasks ---

    // 1. ?unassigned=true
    const unassignedRes = await projectTasksRoute.GET(
      apiRequest("GET", `/api/projects/${proj.id}/tasks?unassigned=true`, { cookie: member1Cookie }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(unassignedRes.status, 200);
    const unassignedTasks = ((await unassignedRes.json()) as { tasks: any[] }).tasks;
    assert.equal(unassignedTasks.length, 1);
    assert.equal(unassignedTasks[0].title, "Unassigned Task");

    // 2. ?assignedTo=me as member 1
    const m1AssignedToMeRes = await projectTasksRoute.GET(
      apiRequest("GET", `/api/projects/${proj.id}/tasks?assignedTo=me`, { cookie: member1Cookie }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(m1AssignedToMeRes.status, 200);
    const m1Tasks = ((await m1AssignedToMeRes.json()) as { tasks: any[] }).tasks;
    assert.equal(m1Tasks.length, 1);
    assert.equal(m1Tasks[0].title, "Task for M1 by Owner");

    // 3. ?assignedBy=me as member 1
    const m1AssignedByMeRes = await projectTasksRoute.GET(
      apiRequest("GET", `/api/projects/${proj.id}/tasks?assignedBy=me`, { cookie: member1Cookie }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(m1AssignedByMeRes.status, 200);
    const m1AssignedByTasks = ((await m1AssignedByMeRes.json()) as { tasks: any[] }).tasks;
    assert.equal(m1AssignedByTasks.length, 1);
    assert.equal(m1AssignedByTasks[0].title, "Task for M2 by M1");

    // 4. ?assignedBy=<ownerId>
    const ownerAssignedRes = await projectTasksRoute.GET(
      apiRequest("GET", `/api/projects/${proj.id}/tasks?assignedBy=${ownerId}`, { cookie: member1Cookie }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(ownerAssignedRes.status, 200);
    const ownerAssignedTasks = ((await ownerAssignedRes.json()) as { tasks: any[] }).tasks;
    assert.equal(ownerAssignedTasks.length, 1);
    assert.equal(ownerAssignedTasks[0].title, "Task for M1 by Owner");

    // 5. Invalid query parameters return 422
    const invalidParamRes = await projectTasksRoute.GET(
      apiRequest("GET", `/api/projects/${proj.id}/tasks?unassigned=not-a-boolean`, { cookie: member1Cookie }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(invalidParamRes.status, 422);

    // --- Query tests on /api/my-work ---

    // 6. /api/my-work default: returns tasks assigned to me
    const myWorkDefaultRes = await myWorkRoute.GET(
      apiRequest("GET", "/api/my-work", { cookie: member1Cookie }),
    );
    assert.equal(myWorkDefaultRes.status, 200);
    const myWorkDefault = ((await myWorkDefaultRes.json()) as { tasks: any[] }).tasks;
    assert.equal(myWorkDefault.length, 1);
    assert.equal(myWorkDefault[0].title, "Task for M1 by Owner");

    // 7. /api/my-work?assignedBy=me: returns tasks assigned by me
    const myWorkAssignedByRes = await myWorkRoute.GET(
      apiRequest("GET", "/api/my-work?assignedBy=me", { cookie: member1Cookie }),
    );
    assert.equal(myWorkAssignedByRes.status, 200);
    const myWorkAssignedBy = ((await myWorkAssignedByRes.json()) as { tasks: any[] }).tasks;
    assert.equal(myWorkAssignedBy.length, 1);
    assert.equal(myWorkAssignedBy[0].title, "Task for M2 by M1");

    // 8. /api/my-work?unassigned=true: returns unassigned tasks across workspace
    const myWorkUnassignedRes = await myWorkRoute.GET(
      apiRequest("GET", "/api/my-work?unassigned=true", { cookie: member1Cookie }),
    );
    assert.equal(myWorkUnassignedRes.status, 200);
    const myWorkUnassigned = ((await myWorkUnassignedRes.json()) as { tasks: any[] }).tasks;
    assert.equal(myWorkUnassigned.length, 1);
    assert.equal(myWorkUnassigned[0].title, "Unassigned Task");

    // 9. /api/my-work with invalid query returns 422
    const myWorkInvalidRes = await myWorkRoute.GET(
      apiRequest("GET", "/api/my-work?unassigned=invalid", { cookie: member1Cookie }),
    );
    assert.equal(myWorkInvalidRes.status, 422);
  });

  it("enforces response-shape allowlist (accounts mode includes assignedBy/assignedAt, desktop excludes them)", async () => {
    const ownerEmail = `shape_owner_${Date.now()}@example.com`;
    const ownerCookieRaw = await signIn(ownerEmail);
    const ownerId = await getUserIdByEmail(ownerEmail);
    const ws = await workspacesService.createTeamWorkspace(ownerId, "Shape Co");
    const ownerCookie = withWorkspaceCookie(ownerCookieRaw, ws.id);

    const projRes = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Shape Proj" } }),
    );
    const proj = ((await projRes.json()) as { project: { id: string } }).project;

    const taskRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${proj.id}/tasks`, {
        cookie: ownerCookie,
        body: { title: "Shape Task", assigneeId: ownerId },
      }),
      { params: Promise.resolve({ id: proj.id }) },
    );
    assert.equal(taskRes.status, 201);
    const taskJson = ((await taskRes.json()) as { task: any }).task;

    // 1. In accounts mode, assignedBy and assignedAt exist and match expected keys
    assert.equal(taskJson.assigneeId, ownerId);
    assert.equal(taskJson.assignedBy, ownerId);
    assert.ok(taskJson.assignedAt);

    const allowedAccountsKeys = new Set([
      "id",
      "projectId",
      "milestoneId",
      "parentTaskId",
      "title",
      "description",
      "status",
      "priority",
      "assigneeId",
      "assignedBy",
      "assignedAt",
      "dueDate",
      "createdAt",
      "updatedAt",
      "completedAt",
      "blocked",
      "isBlocked",
      "checklistTotal",
      "checklistDone",
    ]);

    for (const key of Object.keys(taskJson)) {
      assert.ok(allowedAccountsKeys.has(key), `Unexpected field ${key} found in task response`);
    }

    // 2. serializeTaskResponse in non-accounts mode strips assignedBy and assignedAt
    const originalAuthMode = process.env.AUTH_MODE;
    try {
      delete process.env.AUTH_MODE;
      const desktopSerialized = serializeTaskResponse(taskJson);
      assert.equal("assignedBy" in desktopSerialized, false, "assignedBy should be stripped in desktop mode");
      assert.equal("assignedAt" in desktopSerialized, false, "assignedAt should be stripped in desktop mode");
      assert.equal(desktopSerialized.id, taskJson.id);
      assert.equal(desktopSerialized.title, taskJson.title);
    } finally {
      process.env.AUTH_MODE = originalAuthMode;
    }
  });

  it("hardening: PATCH /api/workspaces/:id/members/:userId rejects invited -> active with 422", async () => {
    const ownerEmail = `inv_owner_${Date.now()}@example.com`;
    const invitedEmail = `inv_user_${Date.now()}@example.com`;

    const ownerCookieRaw = await signIn(ownerEmail);
    const invitedCookie = await signIn(invitedEmail);

    const ownerId = await getUserIdByEmail(ownerEmail);
    const invitedId = await getUserIdByEmail(invitedEmail);

    const ws = await workspacesService.createTeamWorkspace(ownerId, "Invite Guard Co");
    const ownerCookie = withWorkspaceCookie(ownerCookieRaw, ws.id);

    await db().insert(workspaceMembers).values({
      workspaceId: ws.id,
      userId: invitedId,
      role: "member",
      status: "invited",
    });

    // Attempting to PATCH invited member directly to 'active' must be rejected with 422
    const patchRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${ws.id}/members/${invitedId}`, {
        cookie: ownerCookie,
        body: { status: "active" },
      }),
      { params: Promise.resolve({ id: ws.id, userId: invitedId }) },
    );

    assert.equal(patchRes.status, 422);
    const json = (await patchRes.json()) as { error: string };
    assert.match(json.error, /accepting their invitation/i);
  });

  it("viewer page data path: suspended assignee email, role, and joinedAt are absent (Stage 1A)", async () => {
    const ownerEmail = `viewer_leak_owner_${Date.now()}@example.com`;
    const viewerEmail = `viewer_leak_viewer_${Date.now()}@example.com`;
    const targetEmail = `viewer_leak_target_${Date.now()}@example.com`;

    const ownerCookieRaw = await signIn(ownerEmail);
    const viewerCookieRaw = await signIn(viewerEmail);
    await signIn(targetEmail);

    const ownerId = await getUserIdByEmail(ownerEmail);
    const viewerId = await getUserIdByEmail(viewerEmail);
    const targetId = await getUserIdByEmail(targetEmail);

    const ws = await workspacesService.createTeamWorkspace(ownerId, "Privacy Guard Workspace");
    const ownerCookie = withWorkspaceCookie(ownerCookieRaw, ws.id);
    const viewerCookie = withWorkspaceCookie(viewerCookieRaw, ws.id);

    await db().insert(workspaceMembers).values([
      { workspaceId: ws.id, userId: viewerId, role: "viewer", status: "active" },
      { workspaceId: ws.id, userId: targetId, role: "member", status: "active" },
    ]);

    // Create project and assign task to targetId
    const projectRes = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", {
        cookie: ownerCookie,
        body: { name: "Secret Project" },
      }),
    );
    const proj = ((await projectRes.json()) as { project: { id: string } }).project;
    const projectId = proj.id;

    const taskRes = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${projectId}/tasks`, {
        cookie: ownerCookie,
        body: { title: "Audit Task", assigneeId: targetId },
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    assert.equal(taskRes.status, 201);

    // Suspend target member as owner
    await workspacesService.updateMemberStatus(ws.id, targetId, "suspended", {
      callerRole: "owner",
    });

    // Execute the page's data resolution path as the signed-in viewer:
    // 1. Resolve membership and role for the caller
    const membership = await workspacesService.getMembership(ws.id, viewerId);
    assert.equal(membership?.role, "viewer");
    const callerRole = membership?.role ?? "viewer";

    // 2. Load tasks for the project in this workspace
    const { taskRepository } = await import("../../src/db/repositories");
    const tasks = await taskRepository.list(ws.id, projectId);
    assert.equal(tasks.length, 1);

    // 3. Extract referenced IDs
    const referencedUserIds = Array.from(
      new Set(
        tasks
          .flatMap((t) => [t.assigneeId, t.assignedBy])
          .filter((id): id is string => Boolean(id)),
      ),
    );
    assert.ok(referencedUserIds.includes(targetId));

    // 4. Resolve display summaries with the viewer's actual role
    const displaySummaries = await workspacesService.getMemberDisplaySummaries(
      ws.id,
      referencedUserIds,
      callerRole,
    );
    assert.equal(displaySummaries.length, 2);

    const targetSummary = displaySummaries.find((s) => s.id === targetId)!;
    assert.ok(targetSummary, "target summary must exist");
    assert.equal(targetSummary.status, "suspended");
    assert.equal(targetSummary.email, undefined, "viewer must not receive suspended member's email");
    assert.equal(targetSummary.role, undefined, "viewer must not receive suspended member's role");
    assert.equal(targetSummary.joinedAt, undefined, "viewer must not receive suspended member's joinedAt");
    assert.equal("email" in targetSummary, false, "email key must be completely absent from JSON");
    assert.equal("role" in targetSummary, false, "role key must be completely absent from JSON");
    assert.equal("joinedAt" in targetSummary, false, "joinedAt key must be completely absent from JSON");

    // Meanwhile, active owner's summary has full details
    const ownerSummary = displaySummaries.find((s) => s.id === ownerId)!;
    assert.ok(ownerSummary, "owner summary must exist");
    assert.equal(ownerSummary.email, ownerEmail);
  });
});
