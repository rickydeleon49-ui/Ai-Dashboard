/**
 * Deleted-comment redaction through the real activity endpoints, with real
 * signed-in sessions.
 *
 * Flow: a member writes a comment mentioning two teammates, edits it, and an
 * admin deletes it. Afterwards the task and project activity endpoints must
 * return the same safe representation to a viewer, a member, an admin, and
 * the owner: no actor and no mentions on that comment's lifecycle events.
 * Elevated roles get no raw data here; the edit-history route is the separate
 * audit path.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import {
  assertSafeDeletedCommentEvent,
  lifecycleEventsFor,
} from "../helpers/activity-redaction-expectations";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let projectsRoute: typeof import("../../src/app/api/projects/route");
let projectTasksRoute: typeof import("../../src/app/api/projects/[id]/tasks/route");
let commentsRoute: typeof import("../../src/app/api/tasks/[id]/comments/route");
let commentItemRoute: typeof import("../../src/app/api/tasks/[id]/comments/[commentId]/route");
let taskActivityRoute: typeof import("../../src/app/api/tasks/[id]/activity/route");
let projectActivityRoute: typeof import("../../src/app/api/projects/[id]/activity/route");

const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let workspaceA: string;
let workspaceB: string;
let projectId: string;
let taskId: string;
let deletedCommentId: string;
let liveCommentId: string;

interface ActivityEvent {
  id: string;
  type: string;
  actorId: string | null;
  details: Record<string, unknown>;
}

before(async () => {
  await migrate();
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  commentsRoute = await import("../../src/app/api/tasks/[id]/comments/route");
  commentItemRoute = await import("../../src/app/api/tasks/[id]/comments/[commentId]/route");
  taskActivityRoute = await import("../../src/app/api/tasks/[id]/activity/route");
  projectActivityRoute = await import("../../src/app/api/projects/[id]/activity/route");
  const { getPgDb } = await import("../../src/db/pg-client");
  const { users, workspaceMembers } = await import("../../src/db/schema.pg");
  const workspacesService = await import("../../src/core/workspaces/service");

  for (const role of ["owner", "admin", "member", "mention", "viewer", "outsider"]) {
    cookies[role] = await signIn(`redact_${role}@example.com`);
  }
  const allUsers = await getPgDb().select().from(users);
  for (const role of Object.keys(cookies)) {
    ids[role] = allUsers.find((u) => u.email === `redact_${role}@example.com`)!.id;
  }

  workspaceA = (await workspacesService.createTeamWorkspace(ids.owner!, "Redaction A")).id;
  await getPgDb().insert(workspaceMembers).values([
    { workspaceId: workspaceA, userId: ids.admin!, role: "admin", status: "active" },
    { workspaceId: workspaceA, userId: ids.member!, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: ids.mention!, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: ids.viewer!, role: "viewer", status: "active" },
  ]);
  workspaceB = (await workspacesService.createTeamWorkspace(ids.outsider!, "Redaction B")).id;
  for (const role of ["owner", "admin", "member", "mention", "viewer"]) {
    cookies[role] = `${cookies[role]}; cc-current-workspace=${workspaceA}`;
  }
  cookies.outsider = `${cookies.outsider}; cc-current-workspace=${workspaceB}`;

  const project = await projectsRoute.POST(
    apiRequest("POST", "/api/projects", { cookie: cookies.owner!, body: { name: "Redaction Project" } }),
  );
  projectId = ((await project.json()) as { project: { id: string } }).project.id;
  const task = await projectTasksRoute.POST(
    apiRequest("POST", `/api/projects/${projectId}/tasks`, { cookie: cookies.owner!, body: { title: "Redaction Task" } }),
    { params: Promise.resolve({ id: projectId }) },
  );
  taskId = ((await task.json()) as { task: { id: string } }).task.id;

  deletedCommentId = await postComment(cookies.member!, "private note", [ids.mention!, ids.viewer!]);
  const edit = await commentItemRoute.PATCH(
    apiRequest("PATCH", `/api/tasks/${taskId}/comments/${deletedCommentId}`, {
      cookie: cookies.member!,
      body: { body: "private note, edited" },
    }),
    { params: Promise.resolve({ id: taskId, commentId: deletedCommentId }) },
  );
  assert.equal(edit.status, 200);
  const del = await commentItemRoute.DELETE(
    apiRequest("DELETE", `/api/tasks/${taskId}/comments/${deletedCommentId}`, { cookie: cookies.admin! }),
    { params: Promise.resolve({ id: taskId, commentId: deletedCommentId }) },
  );
  assert.equal(del.status, 200);

  liveCommentId = await postComment(cookies.member!, "public note", [ids.mention!, ids.mention!]);
});

after(() => cleanup());

async function postComment(cookie: string, body: string, mentions: string[]): Promise<string> {
  const res = await commentsRoute.POST(
    apiRequest("POST", `/api/tasks/${taskId}/comments`, { cookie, body: { body, mentions } }),
    { params: Promise.resolve({ id: taskId }) },
  );
  assert.equal(res.status, 201);
  return ((await res.json()) as { comment: { id: string } }).comment.id;
}

async function taskActivity(cookie: string): Promise<{ status: number; events: ActivityEvent[] }> {
  const res = await taskActivityRoute.GET(apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie }), {
    params: Promise.resolve({ id: taskId }),
  });
  const json = (await res.json()) as { events?: ActivityEvent[] };
  return { status: res.status, events: json.events ?? [] };
}

async function projectActivity(cookie: string): Promise<{ status: number; events: ActivityEvent[] }> {
  const res = await projectActivityRoute.GET(
    apiRequest("GET", `/api/projects/${projectId}/activity`, { cookie }),
    { params: Promise.resolve({ id: projectId }) },
  );
  const json = (await res.json()) as { events?: ActivityEvent[] };
  return { status: res.status, events: json.events ?? [] };
}

const forbidden = () => [ids.member!, ids.admin!, ids.mention!, ids.viewer!];

describe("Deleted-comment redaction through the activity endpoints", () => {
  it("a viewer can't infer the author, deleter, or mentions of a deleted comment (task activity)", async () => {
    const { status, events } = await taskActivity(cookies.viewer!);
    assert.equal(status, 200);
    const lifecycle = lifecycleEventsFor(events, deletedCommentId);
    assert.deepEqual([...lifecycle.keys()].sort(), ["comment.created", "comment.deleted", "comment.edited"]);
    for (const event of lifecycle.values()) assertSafeDeletedCommentEvent(event, deletedCommentId, forbidden());
  });

  it("project activity applies the same redaction for a viewer", async () => {
    const { status, events } = await projectActivity(cookies.viewer!);
    assert.equal(status, 200);
    const lifecycle = lifecycleEventsFor(events, deletedCommentId);
    assert.equal(lifecycle.size, 3);
    for (const event of lifecycle.values()) assertSafeDeletedCommentEvent(event, deletedCommentId, forbidden());
  });

  it("member, admin, and owner receive the identical safe representation", async () => {
    for (const read of [taskActivity, projectActivity]) {
      const baseline = [...lifecycleEventsFor((await read(cookies.viewer!)).events, deletedCommentId).values()];
      for (const role of ["member", "admin", "owner"]) {
        const { status, events } = await read(cookies[role]!);
        assert.equal(status, 200, `${role} can read activity`);
        const mine = [...lifecycleEventsFor(events, deletedCommentId).values()];
        assert.deepEqual(mine, baseline, `${role} sees exactly what a viewer sees`);
        for (const event of mine) assertSafeDeletedCommentEvent(event, deletedCommentId, forbidden());
      }
    }
  });

  it("a live comment keeps its actor and deduplicated mentions", async () => {
    for (const read of [taskActivity, projectActivity]) {
      const created = lifecycleEventsFor((await read(cookies.viewer!)).events, liveCommentId).get("comment.created");
      assert.ok(created);
      assert.equal(created.actorId, ids.member);
      assert.deepEqual(created.details, { commentId: liveCommentId, mentions: [ids.mention] });
    }
  });

  it("another workspace can't read this workspace's activity", async () => {
    const task = await taskActivity(cookies.outsider!);
    assert.equal(task.status, 404);
    assert.deepEqual(task.events, []);
    const project = await projectActivity(cookies.outsider!);
    assert.equal(project.status, 404);
    assert.deepEqual(project.events, []);
  });
});

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
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(response: Response): void {
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        const value = pair.slice(eq + 1);
        if (value === "") jar.delete(pair.slice(0, eq));
        else jar.set(pair.slice(0, eq), value);
      }
    },
  };
}

async function signIn(email: string): Promise<string> {
  const jar = cookieJar();
  const csrf = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
  jar.absorb(csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const [signinResponse, logs] = await withCapturedLogs(() =>
    handlers.POST(
      new NextRequest("http://localhost/api/auth/signin/nodemailer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
        body: new URLSearchParams({ email, csrfToken, callbackUrl: "http://localhost/" }).toString(),
      }),
    ),
  );
  jar.absorb(signinResponse);
  const magicLink = logs.find((l) => l.includes(`magic link for ${email}`))?.match(/(http:\S+)/)?.[1];
  if (!magicLink) throw new Error(`no magic link logged for ${email}`);
  const callback = await handlers.GET(new NextRequest(magicLink, { headers: { cookie: jar.header() } }));
  jar.absorb(callback);
  assert.equal(callback.status, 302);
  return jar.header();
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
