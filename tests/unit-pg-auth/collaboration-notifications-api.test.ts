/**
 * Release 2C.6 collaboration inbox — accounts-mode API authorization (Auth.js + PostgreSQL).
 *
 * Real sessions via the magic-link flow; real route handlers; no overrides.
 *
 * 1. Unauthenticated: every /api/inbox route 401s.
 * 2. Owner / admin / member / viewer: may list, count, update and set
 *    preferences for their OWN notifications only.
 * 3. Suspended / removed members: 403 on every route, even when they hold
 *    notifications from before the change of status.
 * 4. Outsider: sees only their own workspace; never this workspace's rows.
 * 5. Foreign, unknown and malformed notification ids: identical 404s that change nothing.
 * 6. Cross-workspace recipient and workspace switching: counts, lists and
 *    mark-all-read follow the active-workspace cookie and never bleed across.
 * 7. Generation through the real routes: task PATCH, bulk editing (only
 *    successful, materially changed tasks), comments with mentions; failed
 *    or unauthorized requests (viewer PATCH, outsider mention) create nothing.
 * 8. Preferences: strict validation, partial updates, per-user isolation, enforced at creation.
 *    Includes the mentioned-assignee precedence matrix driven entirely through
 *    the preferences, comment and inbox routes.
 * 9. Responses are no-store and contain no comment bodies.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

type Route<T> = T;
let inboxRoute: Route<typeof import("../../src/app/api/inbox/route")>;
let countRoute: Route<typeof import("../../src/app/api/inbox/unread-count/route")>;
let itemRoute: Route<typeof import("../../src/app/api/inbox/[id]/route")>;
let markAllRoute: Route<typeof import("../../src/app/api/inbox/mark-all-read/route")>;
let prefsRoute: Route<typeof import("../../src/app/api/inbox/preferences/route")>;
let projectsRoute: Route<typeof import("../../src/app/api/projects/route")>;
let projectTasksRoute: Route<typeof import("../../src/app/api/projects/[id]/tasks/route")>;
let taskRoute: Route<typeof import("../../src/app/api/tasks/[id]/route")>;
let bulkRoute: Route<typeof import("../../src/app/api/tasks/bulk/route")>;
let commentsRoute: Route<typeof import("../../src/app/api/tasks/[id]/comments/route")>;

let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let schema: typeof import("../../src/db/schema.pg");
let workspacesService: typeof import("../../src/core/workspaces/service");

const EMAILS = {
  owner: "ntf_owner@example.com",
  admin: "ntf_admin@example.com",
  member: "ntf_member@example.com",
  viewer: "ntf_viewer@example.com",
  suspended: "ntf_suspended@example.com",
  removed: "ntf_removed@example.com",
  outsider: "ntf_outsider@example.com",
} as const;
type Role = keyof typeof EMAILS;

const session: Record<Role, string> = {} as Record<Role, string>;
const id: Record<Role, string> = {} as Record<Role, string>;
let workspaceA: string;
let workspaceB: string;
let projectA: string;
let projectB: string;

function cookieFor(role: Role, workspaceId = role === "outsider" ? workspaceB : workspaceA): string {
  return `${session[role]}; cc-current-workspace=${workspaceId}`;
}

function apiRequest(method: string, path: string, options: { cookie?: string; body?: unknown } = {}) {
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

async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return [await fn(), lines];
  } finally {
    console.log = original;
  }
}

async function signIn(email: string): Promise<string> {
  const jar = new Map<string, string>();
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (response: Response) => {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      const value = pair.slice(eq + 1);
      if (value === "") jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), value);
    }
  };
  const csrf = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
  absorb(csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const [signinResponse, logs] = await withCapturedLogs(() =>
    handlers.POST(
      new NextRequest("http://localhost/api/auth/signin/nodemailer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: header() },
        body: new URLSearchParams({ email, csrfToken, callbackUrl: "http://localhost/" }).toString(),
      }),
    ),
  );
  absorb(signinResponse);
  const link = logs.find((l) => l.includes(`magic link for ${email}`))?.match(/(http:\S+)/)?.[1];
  if (!link) throw new Error(`no magic link for ${email}`);
  const callback = await handlers.GET(new NextRequest(link, { headers: { cookie: header() } }));
  absorb(callback);
  assert.equal(callback.status, 302);
  return header();
}

// ---- route helpers --------------------------------------------------------

interface ListBody {
  workspaceId: string;
  notifications: Array<{
    id: string;
    category: string;
    read: boolean;
    archived: boolean;
    task: { id: string; title: string } | null;
    actor: { id: string; name: string | null } | null;
  }>;
  nextCursor: string | null;
  unreadCount: number;
}

async function list(cookie: string, query = "") {
  const res = await inboxRoute.GET(apiRequest("GET", `/api/inbox${query}`, { cookie }));
  return { res, body: res.status === 200 ? ((await res.json()) as ListBody) : null };
}

async function count(cookie: string) {
  const res = await countRoute.GET(apiRequest("GET", "/api/inbox/unread-count", { cookie }));
  return { res, body: res.status === 200 ? ((await res.json()) as { workspaceId: string; unreadCount: number }) : null };
}

async function patchItem(cookie: string, notificationId: string, body: unknown) {
  return itemRoute.PATCH(apiRequest("PATCH", `/api/inbox/${notificationId}`, { cookie, body }), {
    params: Promise.resolve({ id: notificationId }),
  });
}

async function createTask(cookie: string, projectId: string, body: Record<string, unknown>) {
  const res = await projectTasksRoute.POST(apiRequest("POST", `/api/projects/${projectId}/tasks`, { cookie, body }), {
    params: Promise.resolve({ id: projectId }),
  });
  assert.equal(res.status, 201, `task create failed: ${res.status}`);
  return ((await res.json()) as { task: { id: string } }).task.id;
}

async function patchTask(cookie: string, taskId: string, body: Record<string, unknown>) {
  return taskRoute.PATCH(apiRequest("PATCH", `/api/tasks/${taskId}`, { cookie, body }), {
    params: Promise.resolve({ id: taskId }),
  });
}

async function wipeNotifications() {
  await db().delete(schema.notifications);
  await db().delete(schema.notificationPreferences);
}

before(async () => {
  await migrate();
  inboxRoute = await import("../../src/app/api/inbox/route");
  countRoute = await import("../../src/app/api/inbox/unread-count/route");
  itemRoute = await import("../../src/app/api/inbox/[id]/route");
  markAllRoute = await import("../../src/app/api/inbox/mark-all-read/route");
  prefsRoute = await import("../../src/app/api/inbox/preferences/route");
  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  taskRoute = await import("../../src/app/api/tasks/[id]/route");
  bulkRoute = await import("../../src/app/api/tasks/bulk/route");
  commentsRoute = await import("../../src/app/api/tasks/[id]/comments/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  schema = await import("../../src/db/schema.pg");
  workspacesService = await import("../../src/core/workspaces/service");

  for (const role of Object.keys(EMAILS) as Role[]) session[role] = await signIn(EMAILS[role]);
  const allUsers = await db().select().from(schema.users);
  for (const role of Object.keys(EMAILS) as Role[]) {
    id[role] = allUsers.find((u) => u.email === EMAILS[role])!.id;
    await db().update(schema.users).set({ name: `N ${role}` }).where(
      (await import("drizzle-orm")).eq(schema.users.id, id[role]),
    );
  }

  workspaceA = (await workspacesService.createTeamWorkspace(id.owner, "Notif WS A")).id;
  workspaceB = (await workspacesService.createTeamWorkspace(id.outsider, "Notif WS B")).id;
  await db().insert(schema.workspaceMembers).values([
    { workspaceId: workspaceA, userId: id.admin, role: "admin", status: "active" },
    { workspaceId: workspaceA, userId: id.member, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: id.viewer, role: "viewer", status: "active" },
    { workspaceId: workspaceA, userId: id.suspended, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: id.removed, role: "member", status: "active" },
    // The member also belongs to workspace B: the cross-workspace recipient.
    { workspaceId: workspaceB, userId: id.member, role: "member", status: "active" },
  ]);

  const projRes = await projectsRoute.POST(
    apiRequest("POST", "/api/projects", { cookie: cookieFor("owner"), body: { name: "Notif Project A" } }),
  );
  projectA = ((await projRes.json()) as { project: { id: string } }).project.id;
  const projResB = await projectsRoute.POST(
    apiRequest("POST", "/api/projects", { cookie: cookieFor("outsider"), body: { name: "Notif Project B" } }),
  );
  projectB = ((await projResB.json()) as { project: { id: string } }).project.id;

  // Give the soon-to-be suspended/removed members a notification each while active.
  await createTask(cookieFor("owner"), projectA, { title: "For suspended", assigneeId: id.suspended });
  await createTask(cookieFor("owner"), projectA, { title: "For removed", assigneeId: id.removed });
  const { eq, and } = await import("drizzle-orm");
  await db()
    .update(schema.workspaceMembers)
    .set({ status: "suspended" })
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceA), eq(schema.workspaceMembers.userId, id.suspended)));
  await db()
    .update(schema.workspaceMembers)
    .set({ status: "removed" })
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceA), eq(schema.workspaceMembers.userId, id.removed)));
});

after(() => cleanup());

describe("Release 2C.6 inbox API — authentication and roles", () => {
  it("every route rejects an unauthenticated caller with 401 and no-store", async () => {
    const anyId = "00000000-0000-4000-8000-000000000000";
    const responses = [
      await inboxRoute.GET(apiRequest("GET", "/api/inbox")),
      await countRoute.GET(apiRequest("GET", "/api/inbox/unread-count")),
      await itemRoute.PATCH(apiRequest("PATCH", `/api/inbox/${anyId}`, { body: { read: true } }), {
        params: Promise.resolve({ id: anyId }),
      }),
      await markAllRoute.POST(apiRequest("POST", "/api/inbox/mark-all-read")),
      await prefsRoute.GET(apiRequest("GET", "/api/inbox/preferences")),
      await prefsRoute.PATCH(apiRequest("PATCH", "/api/inbox/preferences", { body: { mention: false } })),
    ];
    for (const res of responses) {
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  for (const role of ["owner", "admin", "member", "viewer"] as const) {
    it(`${role}: lists, counts, updates and marks read only their own notifications`, async () => {
      await wipeNotifications();
      const actor = role === "owner" ? "admin" : "owner";
      await createTask(cookieFor(actor), projectA, { title: `For ${role}`, assigneeId: id[role] });
      await createTask(cookieFor(actor), projectA, { title: `Also ${role}`, assigneeId: id[role] });
      // Noise for someone else in the same workspace.
      await createTask(cookieFor("owner"), projectA, {
        title: "Noise",
        assigneeId: role === "member" ? id.admin : id.member,
      });

      const { res, body } = await list(cookieFor(role));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body!.workspaceId, workspaceA);
      assert.equal(body!.notifications.length, 2);
      assert.ok(body!.notifications.every((n) => n.task?.title.endsWith(role)));
      assert.equal(body!.unreadCount, 2);
      assert.equal((await count(cookieFor(role))).body!.unreadCount, 2);

      const target = body!.notifications[0]!;
      const patched = await patchItem(cookieFor(role), target.id, { read: true });
      assert.equal(patched.status, 200);
      const patchedBody = (await patched.json()) as { notification: { read: boolean }; unreadCount: number };
      assert.equal(patchedBody.notification.read, true);
      assert.equal(patchedBody.unreadCount, 1);

      const archived = await patchItem(cookieFor(role), target.id, { archived: true });
      assert.equal(archived.status, 200);
      assert.equal((await list(cookieFor(role), "?view=archived")).body!.notifications.length, 1);
      assert.equal((await patchItem(cookieFor(role), target.id, { archived: false })).status, 200);

      const markAll = await markAllRoute.POST(apiRequest("POST", "/api/inbox/mark-all-read", { cookie: cookieFor(role) }));
      assert.equal(markAll.status, 200);
      const markAllBody = (await markAll.json()) as { updated: number; unreadCount: number };
      assert.equal(markAllBody.updated, 1);
      assert.equal(markAllBody.unreadCount, 0);

      const other = role === "member" ? "admin" : "member";
      assert.equal((await count(cookieFor(other))).body!.unreadCount, 1, "someone else's row is untouched");
    });
  }

  for (const role of ["suspended", "removed"] as const) {
    it(`${role} member: every route 403s even though they hold notifications`, async () => {
      const held = await db()
        .select()
        .from(schema.notifications)
        .where((await import("drizzle-orm")).eq(schema.notifications.recipientId, id[role]));
      // The rows were created while active; they must be unreachable now.
      const noteId = held[0]?.id ?? "00000000-0000-4000-8000-000000000000";
      const cookie = cookieFor(role);
      const responses = [
        (await list(cookie)).res,
        (await count(cookie)).res,
        await patchItem(cookie, noteId, { read: true }),
        await markAllRoute.POST(apiRequest("POST", "/api/inbox/mark-all-read", { cookie })),
        await prefsRoute.GET(apiRequest("GET", "/api/inbox/preferences", { cookie })),
        await prefsRoute.PATCH(apiRequest("PATCH", "/api/inbox/preferences", { cookie, body: { mention: false } })),
      ];
      for (const res of responses) assert.equal(res.status, 403);
      if (held[0]) {
        const [after] = await db()
          .select()
          .from(schema.notifications)
          .where((await import("drizzle-orm")).eq(schema.notifications.id, held[0].id));
        assert.equal(after?.readAt, null, "nothing was changed");
      }
    });
  }

  it("suspended and removed members receive no new notifications", async () => {
    await wipeNotifications();
    const taskId = await createTask(cookieFor("owner"), projectA, { title: "Mention target" });
    const suspendedMention = await commentsRoute.POST(
      apiRequest("POST", `/api/tasks/${taskId}/comments`, {
        cookie: cookieFor("owner"),
        body: { body: `@${id.suspended} @${id.removed}` },
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
    assert.equal(suspendedMention.status, 422);
    const assignSuspended = await patchTask(cookieFor("owner"), taskId, { assigneeId: id.suspended });
    assert.equal(assignSuspended.status >= 400, true);
    const all = await db().select().from(schema.notifications);
    assert.equal(all.length, 0);
  });

  it("an outsider only ever sees their own workspace, never workspace A's rows", async () => {
    await wipeNotifications();
    await createTask(cookieFor("owner"), projectA, { title: "A secret task", assigneeId: id.member });
    // Outsider forging workspace A in the cookie falls back to one of their own
    // workspaces (their personal one) — never A.
    for (const cookie of [cookieFor("outsider"), cookieFor("outsider", workspaceA)]) {
      const { res, body } = await list(cookie);
      assert.equal(res.status, 200);
      assert.notEqual(body!.workspaceId, workspaceA);
      assert.equal(body!.notifications.length, 0);
      assert.equal((await count(cookie)).body!.unreadCount, 0);
    }
  });
});

describe("Release 2C.6 inbox API — resource boundaries", () => {
  it("foreign, unknown and malformed ids get the same 404 and change nothing", async () => {
    await wipeNotifications();
    await createTask(cookieFor("owner"), projectA, { title: "Member's", assigneeId: id.member });
    const [memberNote] = (await list(cookieFor("member"))).body!.notifications;
    assert.ok(memberNote);

    const attempts = [
      await patchItem(cookieFor("admin"), memberNote.id, { read: true }),
      await patchItem(cookieFor("owner"), memberNote.id, { archived: true }),
      await patchItem(cookieFor("outsider"), memberNote.id, { read: true }),
      await patchItem(cookieFor("member", workspaceB), memberNote.id, { read: true }),
      await patchItem(cookieFor("member"), "11111111-1111-4111-8111-111111111111", { read: true }),
      await patchItem(cookieFor("member"), "not-a-uuid", { read: true }),
    ];
    const bodies = await Promise.all(attempts.map((r) => r.json()));
    for (let i = 0; i < attempts.length; i += 1) {
      assert.equal(attempts[i]!.status, 404, `attempt ${i}`);
      assert.deepEqual(bodies[i], { error: "Notification not found." });
    }
    const still = (await list(cookieFor("member"))).body!.notifications[0]!;
    assert.equal(still.read, false);
    assert.equal(still.archived, false);
  });

  it("rejects malformed bodies, queries and cursors with 400", async () => {
    const [n] = (await list(cookieFor("member"))).body!.notifications;
    assert.ok(n);
    for (const body of [{}, { read: "yes" }, { read: true, recipientId: id.admin }, [1]]) {
      assert.equal((await patchItem(cookieFor("member"), n.id, body)).status, 400, JSON.stringify(body));
    }
    for (const query of ["?limit=0", "?limit=500", "?view=everything", "?cursor=%%%", "?cursor=abc", "?view=inbox&view=archived", "?recipientId=x"]) {
      assert.equal((await list(cookieFor("member"), query)).res.status, 400, query);
    }
  });

  it("cross-workspace recipient: counts, lists and mark-all-read follow the active workspace", async () => {
    await wipeNotifications();
    await createTask(cookieFor("owner"), projectA, { title: "A1", assigneeId: id.member });
    await createTask(cookieFor("owner"), projectA, { title: "A2", assigneeId: id.member });
    await createTask(cookieFor("outsider"), projectB, { title: "B1", assigneeId: id.member });

    const inA = await list(cookieFor("member", workspaceA));
    const inB = await list(cookieFor("member", workspaceB));
    assert.equal(inA.body!.workspaceId, workspaceA);
    assert.equal(inB.body!.workspaceId, workspaceB);
    assert.deepEqual(inA.body!.notifications.map((n) => n.task?.title).sort(), ["A1", "A2"]);
    assert.deepEqual(inB.body!.notifications.map((n) => n.task?.title), ["B1"]);
    assert.equal((await count(cookieFor("member", workspaceA))).body!.unreadCount, 2);
    assert.equal((await count(cookieFor("member", workspaceB))).body!.unreadCount, 1);

    // A notification from B cannot be modified while A is active, and vice versa.
    const bNote = inB.body!.notifications[0]!;
    assert.equal((await patchItem(cookieFor("member", workspaceA), bNote.id, { read: true })).status, 404);

    // Switching to B and marking all read leaves A untouched.
    const res = await markAllRoute.POST(
      apiRequest("POST", "/api/inbox/mark-all-read", { cookie: cookieFor("member", workspaceB) }),
    );
    assert.equal(((await res.json()) as { updated: number }).updated, 1);
    assert.equal((await count(cookieFor("member", workspaceA))).body!.unreadCount, 2);
    assert.equal((await count(cookieFor("member", workspaceB))).body!.unreadCount, 0);
  });

  it("a cookie naming a workspace where the caller is suspended fails closed with 403", async () => {
    const { eq, and } = await import("drizzle-orm");
    const where = and(eq(schema.workspaceMembers.workspaceId, workspaceB), eq(schema.workspaceMembers.userId, id.member));
    await db().update(schema.workspaceMembers).set({ status: "suspended" }).where(where);
    try {
      assert.equal((await list(cookieFor("member", workspaceB))).res.status, 403);
      assert.equal((await count(cookieFor("member", workspaceB))).res.status, 403);
      assert.equal((await list(cookieFor("member", workspaceA))).res.status, 200, "workspace A unaffected");
    } finally {
      await db().update(schema.workspaceMembers).set({ status: "active" }).where(where);
    }
  });
});

describe("Release 2C.6 inbox API — generation through real routes", () => {
  it("task PATCH assignment and due-date changes notify; a viewer's rejected PATCH creates nothing", async () => {
    await wipeNotifications();
    const taskId = await createTask(cookieFor("owner"), projectA, { title: "Route task" });
    assert.equal((await patchTask(cookieFor("owner"), taskId, { assigneeId: id.member })).status, 200);
    assert.equal((await patchTask(cookieFor("owner"), taskId, { dueDate: "2026-10-15" })).status, 200);
    assert.equal((await patchTask(cookieFor("owner"), taskId, { dueDate: "2026-10-15" })).status, 200, "no-op");
    assert.equal((await patchTask(cookieFor("viewer"), taskId, { dueDate: "2026-12-25" })).status, 403);
    const cats = (await list(cookieFor("member"))).body!.notifications.map((n) => n.category);
    assert.deepEqual(cats, ["due_date", "assignment"]);
  });

  it("bulk editing notifies only for successful, materially changed tasks", async () => {
    await wipeNotifications();
    const already = await createTask(cookieFor("owner"), projectA, { title: "Bulk already", assigneeId: id.member });
    await wipeNotifications();
    const fresh1 = await createTask(cookieFor("owner"), projectA, { title: "Bulk fresh 1" });
    const fresh2 = await createTask(cookieFor("owner"), projectA, { title: "Bulk fresh 2" });
    const foreign = await createTask(cookieFor("outsider"), projectB, { title: "Bulk foreign" });

    const res = await bulkRoute.POST(
      apiRequest("POST", "/api/tasks/bulk", {
        cookie: cookieFor("owner"),
        body: { taskIds: [already, fresh1, fresh2, foreign, "tsk_missing"], changes: { assigneeId: id.member } },
      }),
    );
    assert.equal(res.status, 200);
    const result = (await res.json()) as { updated: number; unchanged: number; failed: number };
    assert.deepEqual([result.updated, result.unchanged, result.failed], [2, 1, 2]);

    const notes = (await list(cookieFor("member"))).body!.notifications;
    assert.deepEqual(notes.map((n) => n.task?.title).sort(), ["Bulk fresh 1", "Bulk fresh 2"]);
    assert.ok(notes.every((n) => n.category === "assignment" && n.actor?.id === id.owner));

    // Retrying the same bulk request is a no-op and duplicates nothing.
    await bulkRoute.POST(
      apiRequest("POST", "/api/tasks/bulk", {
        cookie: cookieFor("owner"),
        body: { taskIds: [fresh1, fresh2], changes: { assigneeId: id.member } },
      }),
    );
    assert.equal((await list(cookieFor("member"))).body!.notifications.length, 2);
  });

  it("comments: mention via route notifies the mentioned member; an outsider mention is rejected and creates nothing", async () => {
    await wipeNotifications();
    const taskId = await createTask(cookieFor("owner"), projectA, { title: "Comment route", assigneeId: id.admin });
    await wipeNotifications();
    const body = `Secret plan xyz-123 for @[Member](${id.member})`;
    const ok = await commentsRoute.POST(
      apiRequest("POST", `/api/tasks/${taskId}/comments`, { cookie: cookieFor("owner"), body: { body } }),
      { params: Promise.resolve({ id: taskId }) },
    );
    assert.equal(ok.status, 201);
    const bad = await commentsRoute.POST(
      apiRequest("POST", `/api/tasks/${taskId}/comments`, {
        cookie: cookieFor("owner"),
        body: { body: `hi @${id.outsider}` },
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
    assert.equal(bad.status, 422);

    const member = await inboxRoute.GET(apiRequest("GET", "/api/inbox", { cookie: cookieFor("member") }));
    const raw = await member.text();
    assert.ok(!raw.includes("xyz-123"), "no comment body in notification responses");
    const parsed = JSON.parse(raw) as ListBody;
    assert.deepEqual(parsed.notifications.map((n) => n.category), ["mention"]);
    const admin = (await list(cookieFor("admin"))).body!.notifications;
    assert.deepEqual(admin.map((n) => n.category), ["comment"], "assignee gets one comment notification");
    assert.equal((await list(cookieFor("outsider"))).body!.notifications.length, 0);
  });
});

describe("Release 2C.6 inbox API — preferences", () => {
  it("strict validation, partial updates, per-user isolation, enforced at creation", async () => {
    await wipeNotifications();
    const get = async (role: Role) =>
      ((await (await prefsRoute.GET(apiRequest("GET", "/api/inbox/preferences", { cookie: cookieFor(role) }))).json()) as {
        preferences: Record<string, boolean>;
      }).preferences;
    const patch = (role: Role, body: unknown) =>
      prefsRoute.PATCH(apiRequest("PATCH", "/api/inbox/preferences", { cookie: cookieFor(role), body }));

    assert.deepEqual(await get("member"), { assignment: true, mention: true, comment: true, due_date: true });
    for (const bad of [{}, { email: false }, { assignment: "off" }, { assignment: false, userId: id.admin }]) {
      assert.equal((await patch("member", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await patch("member", { assignment: false })).status, 200);
    const res = await patch("member", { comment: false });
    assert.deepEqual(((await res.json()) as { preferences: Record<string, boolean> }).preferences, {
      assignment: false,
      mention: true,
      comment: false,
      due_date: true,
    });
    assert.deepEqual(await get("admin"), { assignment: true, mention: true, comment: true, due_date: true });

    await createTask(cookieFor("owner"), projectA, { title: "Suppressed", assigneeId: id.member });
    await createTask(cookieFor("owner"), projectA, { title: "Delivered", assigneeId: id.admin });
    assert.equal((await list(cookieFor("member"))).body!.notifications.length, 0);
    assert.equal((await list(cookieFor("admin"))).body!.notifications.length, 1);

    // Workspace B preferences are independent.
    const inB = await prefsRoute.GET(apiRequest("GET", "/api/inbox/preferences", { cookie: cookieFor("member", workspaceB) }));
    assert.equal(((await inB.json()) as { preferences: { assignment: boolean } }).preferences.assignment, true);
    await patch("member", { assignment: true, comment: true });
  });

  it("a mentioned assignee gets exactly one notification, chosen by their own preferences, end to end", async () => {
    // Preferences are changed through PATCH /api/inbox/preferences, the comment
    // is posted through POST /api/tasks/:id/comments, and the result is read
    // through GET /api/inbox — no repository calls anywhere in this test.
    const patchPrefs = (role: Role, body: unknown) =>
      prefsRoute.PATCH(apiRequest("PATCH", "/api/inbox/preferences", { cookie: cookieFor(role), body }));

    const cases = [
      { mention: true, comment: true, expected: ["mention"] },
      { mention: true, comment: false, expected: ["mention"] },
      { mention: false, comment: true, expected: ["comment"] },
      { mention: false, comment: false, expected: [] as string[] },
    ];

    for (const { mention, comment, expected } of cases) {
      const label = `mention=${mention} comment=${comment}`;
      await wipeNotifications();
      const taskId = await createTask(cookieFor("owner"), projectA, {
        title: `Precedence ${label}`,
        assigneeId: id.member,
      });
      await wipeNotifications(); // drop the assignment notification and the reset preferences

      const prefsRes = await patchPrefs("member", { mention, comment });
      assert.equal(prefsRes.status, 200, label);
      const saved = ((await prefsRes.json()) as { preferences: Record<string, boolean> }).preferences;
      assert.equal(saved.mention, mention, label);
      assert.equal(saved.comment, comment, label);

      const commentRes = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskId}/comments`, {
          cookie: cookieFor("owner"),
          body: { body: `@[Member](${id.member}) over to you` },
        }),
        { params: Promise.resolve({ id: taskId }) },
      );
      assert.equal(commentRes.status, 201, label);

      const inbox = (await list(cookieFor("member"))).body!;
      assert.deepEqual(inbox.notifications.map((n) => n.category), expected, label);
      assert.equal(inbox.notifications.length, expected.length, `${label}: never duplicated`);
      assert.equal(inbox.unreadCount, expected.length, label);
      assert.equal((await list(cookieFor("owner"))).body!.notifications.length, 0, `${label}: author not notified`);
    }

    await patchPrefs("member", { mention: true, comment: true });
  });
});
