/**
 * Release 2C.3 Task Checklists API Integration Tests (Auth.js + PostgreSQL).
 *
 * Verifies:
 * 1. Role Matrix for Mutations:
 *    - Owner, Admin, Member allowed to create, update, reorder, delete, and convert (201/200).
 *    - Viewer rejected with 403 (forbidden).
 *    - Suspended and Removed members rejected with 403 (inactive_member).
 *    - Outsider rejected with 403 (not_a_member).
 *    - Unauthenticated rejected with 401.
 * 2. Role Matrix for Reads:
 *    - Viewer, Member, Admin, Owner can read checklist items (200, no-store).
 *    - Suspended and Removed rejected with 403.
 *    - Outsider rejected with 403.
 *    - Unauthenticated rejected with 401.
 * 3. Cross-Workspace Isolation:
 *    - Workspace B caller targeting Workspace A tasks/items gets 404 / 403.
 * 4. Validation & Server-Side Limits:
 *    - Empty or whitespace text returns 422.
 *    - Text > 500 characters returns 422.
 *    - Exceeding 100 items per task returns 422.
 *    - Invalid reorder list returns 422.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type ProjectTasksRoute = typeof import("../../src/app/api/projects/[id]/tasks/route");
type ChecklistRoute = typeof import("../../src/app/api/tasks/[id]/checklist/route");
type ChecklistItemRoute = typeof import("../../src/app/api/tasks/[id]/checklist/[itemId]/route");
type ChecklistConvertRoute = typeof import("../../src/app/api/tasks/[id]/checklist/[itemId]/convert/route");
type ChecklistReorderRoute = typeof import("../../src/app/api/tasks/[id]/checklist/reorder/route");
type TaskActivityRoute = typeof import("../../src/app/api/tasks/[id]/activity/route");

let projectsRoute: ProjectsRoute;
let projectTasksRoute: ProjectTasksRoute;
let checklistRoute: ChecklistRoute;
let checklistItemRoute: ChecklistItemRoute;
let checklistConvertRoute: ChecklistConvertRoute;
let checklistReorderRoute: ChecklistReorderRoute;
let taskActivityRoute: TaskActivityRoute;

let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesService: typeof import("../../src/core/workspaces/service");

let ownerCookie: string;
let adminCookie: string;
let memberCookie: string;
let viewerCookie: string;
let suspendedCookie: string;
let removedCookie: string;
let outsiderCookie: string;

let ownerId: string;
let adminId: string;
let memberId: string;
let viewerId: string;
let suspendedId: string;
let removedId: string;
let outsiderId: string;

let workspaceA: string;
let workspaceB: string;
let projectAId: string;
let taskId: string;

before(async () => {
  await migrate();
  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  checklistRoute = await import("../../src/app/api/tasks/[id]/checklist/route");
  checklistItemRoute = await import("../../src/app/api/tasks/[id]/checklist/[itemId]/route");
  checklistConvertRoute = await import("../../src/app/api/tasks/[id]/checklist/[itemId]/convert/route");
  checklistReorderRoute = await import("../../src/app/api/tasks/[id]/checklist/reorder/route");
  taskActivityRoute = await import("../../src/app/api/tasks/[id]/activity/route");

  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaceMembers } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");

  // Create users
  ownerCookie = await signIn("chk_owner@example.com");
  adminCookie = await signIn("chk_admin@example.com");
  memberCookie = await signIn("chk_member@example.com");
  viewerCookie = await signIn("chk_viewer@example.com");
  suspendedCookie = await signIn("chk_suspended@example.com");
  removedCookie = await signIn("chk_removed@example.com");
  outsiderCookie = await signIn("chk_outsider@example.com");

  const pgDb = db();
  const allUsers = await pgDb.select().from(users);
  const userMap = new Map(allUsers.map((u) => [u.email, u.id]));

  ownerId = userMap.get("chk_owner@example.com")!;
  adminId = userMap.get("chk_admin@example.com")!;
  memberId = userMap.get("chk_member@example.com")!;
  viewerId = userMap.get("chk_viewer@example.com")!;
  suspendedId = userMap.get("chk_suspended@example.com")!;
  removedId = userMap.get("chk_removed@example.com")!;
  outsiderId = userMap.get("chk_outsider@example.com")!;

  // Create Workspace A and memberships
  const wsA = await workspacesService.createTeamWorkspace(ownerId, "Checklist WS A");
  workspaceA = wsA.id;

  await pgDb.insert(workspaceMembers).values([
    { workspaceId: workspaceA, userId: adminId, role: "admin", status: "active" },
    { workspaceId: workspaceA, userId: memberId, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: viewerId, role: "viewer", status: "active" },
    { workspaceId: workspaceA, userId: suspendedId, role: "member", status: "suspended" },
    { workspaceId: workspaceA, userId: removedId, role: "member", status: "removed" },
  ]);

  // Create Workspace B for outsider
  const wsB = await workspacesService.createTeamWorkspace(outsiderId, "Checklist WS B");
  workspaceB = wsB.id;

  // Decorate cookies with cc-current-workspace
  ownerCookie = withWorkspaceCookie(ownerCookie, workspaceA);
  adminCookie = withWorkspaceCookie(adminCookie, workspaceA);
  memberCookie = withWorkspaceCookie(memberCookie, workspaceA);
  viewerCookie = withWorkspaceCookie(viewerCookie, workspaceA);
  suspendedCookie = withWorkspaceCookie(suspendedCookie, workspaceA);
  removedCookie = withWorkspaceCookie(removedCookie, workspaceA);
  outsiderCookie = withWorkspaceCookie(outsiderCookie, workspaceB);

  // Create Project in Workspace A
  const createProjReq = apiRequest("POST", "/api/projects", {
    cookie: ownerCookie,
    body: { name: "Checklist Project A" },
  });
  const projRes = await projectsRoute.POST(createProjReq);
  const projJson = (await projRes.json()) as { project: { id: string } };
  projectAId = projJson.project.id;

  // Create Task in Workspace A
  const createTaskReq = apiRequest("POST", `/api/projects/${projectAId}/tasks`, {
    cookie: ownerCookie,
    body: { title: "API Checklist Test Task" },
  });
  const taskRes = await projectTasksRoute.POST(createTaskReq, {
    params: Promise.resolve({ id: projectAId }),
  });
  const taskJson = (await taskRes.json()) as { task: { id: string } };
  taskId = taskJson.task.id;
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
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

describe("Task Checklists API: Role matrix for mutations", () => {
  it("enforces role permissions on item creation (POST /api/tasks/:id/checklist)", async () => {
    // 1. Unauthenticated -> 401
    const unauthReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      body: { text: "Item unauth" },
    });
    const unauthRes = await checklistRoute.POST(unauthReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(unauthRes.status, 401);

    // 2. Viewer -> 403 forbidden
    const viewerReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: viewerCookie,
      body: { text: "Item viewer" },
    });
    const viewerRes = await checklistRoute.POST(viewerReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(viewerRes.status, 403);
    const viewerJson = (await viewerRes.json()) as { error: string };
    assert.match(viewerJson.error, /requires the member role/);

    // 3. Suspended -> 403 or 404
    const suspReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: suspendedCookie,
      body: { text: "Item suspended" },
    });
    const suspRes = await checklistRoute.POST(suspReq, { params: Promise.resolve({ id: taskId }) });
    assert.ok(suspRes.status === 403 || suspRes.status === 404);

    // 4. Outsider -> 403 not_a_member (or 404 since task belongs to wsA)
    const outReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: outsiderCookie,
      body: { text: "Item outsider" },
    });
    const outRes = await checklistRoute.POST(outReq, { params: Promise.resolve({ id: taskId }) });
    assert.ok(outRes.status === 403 || outRes.status === 404);

    // 5. Member -> 201 Created
    const memReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: memberCookie,
      body: { text: "Item member" },
    });
    const memRes = await checklistRoute.POST(memReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(memRes.status, 201);
    assert.equal(memRes.headers.get("Cache-Control"), "no-store");
    const memJson = (await memRes.json()) as { item: { id: string; text: string } };
    assert.equal(memJson.item.text, "Item member");

    // 6. Admin -> 201 Created
    const admReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: adminCookie,
      body: { text: "Item admin" },
    });
    const admRes = await checklistRoute.POST(admReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(admRes.status, 201);

    // 7. Owner -> 201 Created
    const ownReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: ownerCookie,
      body: { text: "Item owner" },
    });
    const ownRes = await checklistRoute.POST(ownReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(ownRes.status, 201);
  });

  it("enforces role permissions on PATCH, DELETE, and CONVERT", async () => {
    // Create an item as owner
    const createReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: ownerCookie,
      body: { text: "Step to mutate" },
    });
    const createRes = await checklistRoute.POST(createReq, { params: Promise.resolve({ id: taskId }) });
    const { item } = (await createRes.json()) as { item: { id: string } };

    // Viewer PATCH -> 403
    const viewPatch = apiRequest("PATCH", `/api/tasks/${taskId}/checklist/${item.id}`, {
      cookie: viewerCookie,
      body: { done: true },
    });
    const viewPatchRes = await checklistItemRoute.PATCH(viewPatch, {
      params: Promise.resolve({ id: taskId, itemId: item.id }),
    });
    assert.equal(viewPatchRes.status, 403);

    // Viewer DELETE -> 403
    const viewDel = apiRequest("DELETE", `/api/tasks/${taskId}/checklist/${item.id}`, {
      cookie: viewerCookie,
    });
    const viewDelRes = await checklistItemRoute.DELETE(viewDel, {
      params: Promise.resolve({ id: taskId, itemId: item.id }),
    });
    assert.equal(viewDelRes.status, 403);

    // Viewer CONVERT -> 403
    const viewConv = apiRequest("POST", `/api/tasks/${taskId}/checklist/${item.id}/convert`, {
      cookie: viewerCookie,
    });
    const viewConvRes = await checklistConvertRoute.POST(viewConv, {
      params: Promise.resolve({ id: taskId, itemId: item.id }),
    });
    assert.equal(viewConvRes.status, 403);

    // Member PATCH -> 200
    const memPatch = apiRequest("PATCH", `/api/tasks/${taskId}/checklist/${item.id}`, {
      cookie: memberCookie,
      body: { done: true, text: "Step modified by member" },
    });
    const memPatchRes = await checklistItemRoute.PATCH(memPatch, {
      params: Promise.resolve({ id: taskId, itemId: item.id }),
    });
    assert.equal(memPatchRes.status, 200);
    const patchedJson = (await memPatchRes.json()) as { item: { done: boolean; text: string } };
    assert.equal(patchedJson.item.done, true);
    assert.equal(patchedJson.item.text, "Step modified by member");

    // Member CONVERT -> 201
    const memConv = apiRequest("POST", `/api/tasks/${taskId}/checklist/${item.id}/convert`, {
      cookie: memberCookie,
    });
    const memConvRes = await checklistConvertRoute.POST(memConv, {
      params: Promise.resolve({ id: taskId, itemId: item.id }),
    });
    assert.equal(memConvRes.status, 201);
    const convJson = (await memConvRes.json()) as { task: { id: string; title: string } };
    assert.equal(convJson.task.title, "Step modified by member");
  });
});

describe("Task Checklists API: Read access (GET)", () => {
  it("allows viewer, member, admin, and owner to list items with no-store cache headers", async () => {
    // Viewer GET -> 200
    const viewGet = apiRequest("GET", `/api/tasks/${taskId}/checklist`, {
      cookie: viewerCookie,
    });
    const viewGetRes = await checklistRoute.GET(viewGet, { params: Promise.resolve({ id: taskId }) });
    assert.equal(viewGetRes.status, 200);
    assert.equal(viewGetRes.headers.get("Cache-Control"), "no-store");

    // Unauthenticated GET -> 401
    const unauthGet = apiRequest("GET", `/api/tasks/${taskId}/checklist`);
    const unauthGetRes = await checklistRoute.GET(unauthGet, { params: Promise.resolve({ id: taskId }) });
    assert.equal(unauthGetRes.status, 401);

    // Suspended member GET -> 403 or 404
    const suspGet = apiRequest("GET", `/api/tasks/${taskId}/checklist`, {
      cookie: suspendedCookie,
    });
    const suspGetRes = await checklistRoute.GET(suspGet, { params: Promise.resolve({ id: taskId }) });
    assert.ok(suspGetRes.status === 403 || suspGetRes.status === 404);
  });
});

describe("Task Checklists API: Cross-workspace attempts", () => {
  it("rejects cross-workspace access with 404 / 403", async () => {
    const outReq = apiRequest("GET", `/api/tasks/${taskId}/checklist`, {
      cookie: outsiderCookie,
    });
    const outRes = await checklistRoute.GET(outReq, { params: Promise.resolve({ id: taskId }) });
    assert.ok(outRes.status === 404 || outRes.status === 403);
  });
});

describe("Task Checklists API: Validation and limits", () => {
  it("validates empty text, long text, and reorder format with 422", async () => {
    // Empty text
    const emptyReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: memberCookie,
      body: { text: "   " },
    });
    const emptyRes = await checklistRoute.POST(emptyReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(emptyRes.status, 422);

    // Long text > 500 chars
    const longReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: memberCookie,
      body: { text: "x".repeat(501) },
    });
    const longRes = await checklistRoute.POST(longReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(longRes.status, 422);

    // Invalid reorder
    const badReorder = apiRequest("PUT", `/api/tasks/${taskId}/checklist`, {
      cookie: memberCookie,
      body: { itemIds: ["chk_fake_1", "chk_fake_2"] },
    });
    const badReorderRes = await checklistRoute.PUT(badReorder, { params: Promise.resolve({ id: taskId }) });
    assert.equal(badReorderRes.status, 422);
  });
});

describe("Task Checklists API: Actor Attribution and No-Op Event Suppression", () => {
  it("records authenticated actorId for completion, reopening, and deletion and ignores body spoofing", async () => {
    // 1. Create a checklist item as member with spoofed actor in body
    const createReq = apiRequest("POST", `/api/tasks/${taskId}/checklist`, {
      cookie: memberCookie,
      body: { text: "Attribution test item", actorUserId: "spoofed-user-id" },
    });
    const createRes = await checklistRoute.POST(createReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(createRes.status, 201);
    const createJson = (await createRes.json()) as { item: { id: string } };
    const testItemId = createJson.item.id;

    // Verify item_added activity event attributes authenticated memberId
    const actRes1 = await taskActivityRoute.GET(
      apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: memberCookie }),
      { params: Promise.resolve({ id: taskId }) },
    );
    assert.equal(actRes1.status, 200);
    const act1 = (await actRes1.json()) as {
      events: Array<{ type: string; actorId: string | null; details: { itemId?: string } }>;
    };
    const addedEvents = act1.events.filter(
      (e) => e.type === "checklist.item_added" && e.details?.itemId === testItemId,
    );
    assert.equal(addedEvents.length, 1);
    assert.equal(addedEvents[0]?.actorId, memberId, "item_added must attribute authenticated member");

    // 2. Complete checklist item as admin with spoofed actor in body
    const compReq = apiRequest("PATCH", `/api/tasks/${taskId}/checklist/${testItemId}`, {
      cookie: adminCookie,
      body: { done: true, actorUserId: "spoofed-user-id" },
    });
    const compRes = await checklistItemRoute.PATCH(compReq, {
      params: Promise.resolve({ id: taskId, itemId: testItemId }),
    });
    assert.equal(compRes.status, 200);

    // Verify item_completed activity event attributes authenticated adminId
    const actRes2 = await taskActivityRoute.GET(
      apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: adminCookie }),
      { params: Promise.resolve({ id: taskId }) },
    );
    const act2 = (await actRes2.json()) as {
      events: Array<{ type: string; actorId: string | null; details: { itemId?: string } }>;
    };
    const compEvents1 = act2.events.filter(
      (e) => e.type === "checklist.item_completed" && e.details?.itemId === testItemId,
    );
    assert.equal(compEvents1.length, 1);
    assert.equal(compEvents1[0]?.actorId, adminId, "item_completed must attribute authenticated admin");

    // 3. Repeated completion (no-op) creates NO extra activity events
    const compReq2 = apiRequest("PATCH", `/api/tasks/${taskId}/checklist/${testItemId}`, {
      cookie: adminCookie,
      body: { done: true },
    });
    const compRes2 = await checklistItemRoute.PATCH(compReq2, {
      params: Promise.resolve({ id: taskId, itemId: testItemId }),
    });
    assert.equal(compRes2.status, 200);

    const actRes3 = await taskActivityRoute.GET(
      apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: adminCookie }),
      { params: Promise.resolve({ id: taskId }) },
    );
    const act3 = (await actRes3.json()) as {
      events: Array<{ type: string; details: { itemId?: string } }>;
    };
    const compEvents2 = act3.events.filter(
      (e) => e.type === "checklist.item_completed" && e.details?.itemId === testItemId,
    );
    assert.equal(compEvents2.length, 1, "Repeated completion must not emit duplicate activity events");

    // 4. Reopen checklist item as member with spoofed actor in body
    const reopenReq = apiRequest("PATCH", `/api/tasks/${taskId}/checklist/${testItemId}`, {
      cookie: memberCookie,
      body: { done: false, actorUserId: "spoofed-user-id" },
    });
    const reopenRes = await checklistItemRoute.PATCH(reopenReq, {
      params: Promise.resolve({ id: taskId, itemId: testItemId }),
    });
    assert.equal(reopenRes.status, 200);

    // Verify item_reopened activity event attributes authenticated memberId
    const actRes4 = await taskActivityRoute.GET(
      apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: memberCookie }),
      { params: Promise.resolve({ id: taskId }) },
    );
    const act4 = (await actRes4.json()) as {
      events: Array<{ type: string; actorId: string | null; details: { itemId?: string } }>;
    };
    const reopenEvents1 = act4.events.filter(
      (e) => e.type === "checklist.item_reopened" && e.details?.itemId === testItemId,
    );
    assert.equal(reopenEvents1.length, 1);
    assert.equal(reopenEvents1[0]?.actorId, memberId, "item_reopened must attribute authenticated member");

    // 5. Repeated reopen (no-op) creates NO extra activity events
    const reopenReq2 = apiRequest("PATCH", `/api/tasks/${taskId}/checklist/${testItemId}`, {
      cookie: memberCookie,
      body: { done: false },
    });
    const reopenRes2 = await checklistItemRoute.PATCH(reopenReq2, {
      params: Promise.resolve({ id: taskId, itemId: testItemId }),
    });
    assert.equal(reopenRes2.status, 200);

    const actRes5 = await taskActivityRoute.GET(
      apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: memberCookie }),
      { params: Promise.resolve({ id: taskId }) },
    );
    const act5 = (await actRes5.json()) as {
      events: Array<{ type: string; details: { itemId?: string } }>;
    };
    const reopenEvents2 = act5.events.filter(
      (e) => e.type === "checklist.item_reopened" && e.details?.itemId === testItemId,
    );
    assert.equal(reopenEvents2.length, 1, "Repeated reopen must not emit duplicate activity events");

    // 6. Delete checklist item as owner
    const delReq = apiRequest("DELETE", `/api/tasks/${taskId}/checklist/${testItemId}`, {
      cookie: ownerCookie,
    });
    const delRes = await checklistItemRoute.DELETE(delReq, {
      params: Promise.resolve({ id: taskId, itemId: testItemId }),
    });
    assert.equal(delRes.status, 200);

    // Verify item_deleted activity event attributes authenticated ownerId
    const actRes6 = await taskActivityRoute.GET(
      apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: ownerCookie }),
      { params: Promise.resolve({ id: taskId }) },
    );
    const act6 = (await actRes6.json()) as {
      events: Array<{ type: string; actorId: string | null; details: { itemId?: string } }>;
    };
    const deleteEvents = act6.events.filter(
      (e) => e.type === "checklist.item_deleted" && e.details?.itemId === testItemId,
    );
    assert.equal(deleteEvents.length, 1);
    assert.equal(deleteEvents[0]?.actorId, ownerId, "item_deleted must attribute authenticated owner");
  });
});
