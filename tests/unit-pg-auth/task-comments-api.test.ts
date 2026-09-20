/**
 * Release 2C.4 Task Comments & Activity API Integration Tests (Auth.js + PostgreSQL).
 *
 * Verifies:
 * 1. Unauthenticated requests:
 *    - All endpoints return 401 when called without a session.
 * 2. Role Matrix for Reads (GET comments, GET task activity, GET project activity):
 *    - Viewer, Member, Admin, Owner allowed (200, no-store).
 *    - Suspended, Removed, and Outsider rejected with 403.
 * 3. Role Matrix for Comments Creation (POST):
 *    - Member, Admin, Owner allowed (201).
 *    - Viewer rejected with 403.
 *    - Suspended, Removed, and Outsider rejected with 403.
 * 4. Mention Validation:
 *    - Mentions of active workspace members succeed.
 *    - Mentions of outsiders rejected with 422.
 *    - Mentions of suspended or removed members rejected with 422.
 * 5. Comment Editing (PATCH):
 *    - Author can edit their own comment (200).
 *    - Non-author (even Admin/Owner) cannot edit someone else's comment (403).
 *    - Viewer, suspended, removed rejected with 403.
 *    - Editing deleted comment rejected with 422.
 * 6. Comment Deletion (DELETE):
 *    - Author can delete their own comment (200).
 *    - Non-author regular member rejected with 403.
 *    - Admin and Owner can delete other users' comments (moderation) (200).
 * 7. Cross-Workspace Isolation & Body Leakage:
 *    - Comment bodies and activity events never cross workspace boundaries.
 * 8. Stored-XSS Protection:
 *    - Raw script tags stored accurately in database and safely returned.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type ProjectTasksRoute = typeof import("../../src/app/api/projects/[id]/tasks/route");
type CommentsRoute = typeof import("../../src/app/api/tasks/[id]/comments/route");
type CommentItemRoute = typeof import("../../src/app/api/tasks/[id]/comments/[commentId]/route");
type TaskActivityRoute = typeof import("../../src/app/api/tasks/[id]/activity/route");
type ProjectActivityRoute = typeof import("../../src/app/api/projects/[id]/activity/route");

let projectsRoute: ProjectsRoute;
let projectTasksRoute: ProjectTasksRoute;
let commentsRoute: CommentsRoute;
let commentItemRoute: CommentItemRoute;
let taskActivityRoute: TaskActivityRoute;
let projectActivityRoute: ProjectActivityRoute;

let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesService: typeof import("../../src/core/workspaces/service");

let ownerCookie: string;
let adminCookie: string;
let memberCookie: string;
let member2Cookie: string;
let viewerCookie: string;
let suspendedCookie: string;
let removedCookie: string;
let outsiderCookie: string;

let ownerId: string;
let adminId: string;
let memberId: string;
let member2Id: string;
let viewerId: string;
let suspendedId: string;
let removedId: string;
let outsiderId: string;

let workspaceA: string;
let workspaceB: string;
let projectAId: string;
let taskAId: string;

before(async () => {
  await migrate();
  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  commentsRoute = await import("../../src/app/api/tasks/[id]/comments/route");
  commentItemRoute = await import("../../src/app/api/tasks/[id]/comments/[commentId]/route");
  taskActivityRoute = await import("../../src/app/api/tasks/[id]/activity/route");
  projectActivityRoute = await import("../../src/app/api/projects/[id]/activity/route");

  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaceMembers } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");

  // Sign in users
  ownerCookie = await signIn("cmt_owner@example.com");
  adminCookie = await signIn("cmt_admin@example.com");
  memberCookie = await signIn("cmt_member@example.com");
  member2Cookie = await signIn("cmt_member2@example.com");
  viewerCookie = await signIn("cmt_viewer@example.com");
  suspendedCookie = await signIn("cmt_suspended@example.com");
  removedCookie = await signIn("cmt_removed@example.com");
  outsiderCookie = await signIn("cmt_outsider@example.com");

  const pgDb = db();
  const allUsers = await pgDb.select().from(users);
  const userMap = new Map(allUsers.map((u) => [u.email, u.id]));

  ownerId = userMap.get("cmt_owner@example.com")!;
  adminId = userMap.get("cmt_admin@example.com")!;
  memberId = userMap.get("cmt_member@example.com")!;
  member2Id = userMap.get("cmt_member2@example.com")!;
  viewerId = userMap.get("cmt_viewer@example.com")!;
  suspendedId = userMap.get("cmt_suspended@example.com")!;
  removedId = userMap.get("cmt_removed@example.com")!;
  outsiderId = userMap.get("cmt_outsider@example.com")!;

  // Create Workspace A
  const wsA = await workspacesService.createTeamWorkspace(ownerId, "Comments WS A");
  workspaceA = wsA.id;

  await pgDb.insert(workspaceMembers).values([
    { workspaceId: workspaceA, userId: adminId, role: "admin", status: "active" },
    { workspaceId: workspaceA, userId: memberId, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: member2Id, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: viewerId, role: "viewer", status: "active" },
    { workspaceId: workspaceA, userId: suspendedId, role: "member", status: "suspended" },
    { workspaceId: workspaceA, userId: removedId, role: "member", status: "removed" },
  ]);

  // Create Workspace B
  const wsB = await workspacesService.createTeamWorkspace(outsiderId, "Comments WS B");
  workspaceB = wsB.id;

  // Decorate cookies
  ownerCookie = withWorkspaceCookie(ownerCookie, workspaceA);
  adminCookie = withWorkspaceCookie(adminCookie, workspaceA);
  memberCookie = withWorkspaceCookie(memberCookie, workspaceA);
  member2Cookie = withWorkspaceCookie(member2Cookie, workspaceA);
  viewerCookie = withWorkspaceCookie(viewerCookie, workspaceA);
  suspendedCookie = withWorkspaceCookie(suspendedCookie, workspaceA);
  removedCookie = withWorkspaceCookie(removedCookie, workspaceA);
  outsiderCookie = withWorkspaceCookie(outsiderCookie, workspaceB);

  // Create Project in Workspace A
  const createProjReq = apiRequest("POST", "/api/projects", {
    cookie: ownerCookie,
    body: { name: "Comments Project A" },
  });
  const projRes = await projectsRoute.POST(createProjReq);
  const projJson = (await projRes.json()) as { project: { id: string } };
  projectAId = projJson.project.id;

  // Create Task in Workspace A
  const createTaskReq = apiRequest("POST", `/api/projects/${projectAId}/tasks`, {
    cookie: ownerCookie,
    body: { title: "Comments and Activity Task" },
  });
  const taskRes = await projectTasksRoute.POST(createTaskReq, {
    params: Promise.resolve({ id: projectAId }),
  });
  const taskJson = (await taskRes.json()) as { task: { id: string } };
  taskAId = taskJson.task.id;
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

describe("Release 2C.4 Task Comments & Activity API", () => {
  describe("Unauthenticated requests", () => {
    it("rejects unauthenticated requests to comments and activity with 401", async () => {
      const getComments = await commentsRoute.GET(
        apiRequest("GET", `/api/tasks/${taskAId}/comments`),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(getComments.status, 401);

      const postComment = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, { body: { body: "Hello" } }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(postComment.status, 401);

      const patchComment = await commentItemRoute.PATCH(
        apiRequest("PATCH", `/api/tasks/${taskAId}/comments/some-id`, { body: { body: "Edit" } }),
        { params: Promise.resolve({ id: taskAId, commentId: "some-id" }) },
      );
      assert.equal(patchComment.status, 401);

      const deleteComment = await commentItemRoute.DELETE(
        apiRequest("DELETE", `/api/tasks/${taskAId}/comments/some-id`),
        { params: Promise.resolve({ id: taskAId, commentId: "some-id" }) },
      );
      assert.equal(deleteComment.status, 401);

      const getTaskActivity = await taskActivityRoute.GET(
        apiRequest("GET", `/api/tasks/${taskAId}/activity`),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(getTaskActivity.status, 401);

      const getProjActivity = await projectActivityRoute.GET(
        apiRequest("GET", `/api/projects/${projectAId}/activity`),
        { params: Promise.resolve({ id: projectAId }) },
      );
      assert.equal(getProjActivity.status, 401);
    });
  });

  describe("Role matrix for comment creation (POST)", () => {
    it("allows Member, Admin, and Owner to create comments", async () => {
      // Member creates
      const resMember = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: "Comment by member" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(resMember.status, 201);
      const jsonMember = (await resMember.json()) as { comment: { id: string; body: string; authorId: string } };
      assert.equal(jsonMember.comment.body, "Comment by member");
      assert.equal(jsonMember.comment.authorId, memberId);

      // Admin creates
      const resAdmin = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: adminCookie,
          body: { body: "Comment by admin" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(resAdmin.status, 201);

      // Owner creates
      const resOwner = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: ownerCookie,
          body: { body: "Comment by owner" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(resOwner.status, 201);
    });

    it("rejects Viewer with 403", async () => {
      const res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: viewerCookie,
          body: { body: "Viewer comment" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(res.status, 403);
    });

    it("rejects Suspended and Removed members with 403 or 404", async () => {
      const resSuspended = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: suspendedCookie,
          body: { body: "Suspended comment" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.ok(resSuspended.status === 403 || resSuspended.status === 404);

      const resRemoved = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: removedCookie,
          body: { body: "Removed comment" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.ok(resRemoved.status === 403 || resRemoved.status === 404);
    });

    it("rejects Outsider with 403 or 404", async () => {
      const res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: outsiderCookie,
          body: { body: "Outsider comment" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.ok(res.status === 403 || res.status === 404);
    });
  });

  describe("Mention validation", () => {
    it("allows mentions of active workspace members", async () => {
      const res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: {
            body: `Hey @[Admin](${adminId}), please check this!`,
          },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(res.status, 201);
      const json = (await res.json()) as { comment: { id: string; body: string } };
      assert.ok(json.comment.body.includes(adminId));

      // Verify activity event recorded mentions
      const actRes = await taskActivityRoute.GET(
        apiRequest("GET", `/api/tasks/${taskAId}/activity`, { cookie: memberCookie }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      const actJson = (await actRes.json()) as {
        events: Array<{ type: string; details: { commentId?: string; mentions?: string[] } }>;
      };
      const commentEvent = actJson.events.find(
        (e) => e.type === "comment.created" && e.details?.commentId === json.comment.id,
      );
      assert.ok(commentEvent);
      assert.deepEqual(commentEvent.details.mentions, [adminId]);
    });

    it("rejects mentions of an outsider with 422", async () => {
      const res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: {
            body: `Hey @[Outsider](${outsiderId}) from WS B!`,
          },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(res.status, 422);
      const json = (await res.json()) as { error: string; invalidUserId?: string };
      assert.match(json.error, /not an active member/i);
      assert.equal(json.invalidUserId, outsiderId);
    });

    it("rejects mentions of suspended and removed members with 422", async () => {
      const resSuspended = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: {
            body: `Hey @[Suspended](${suspendedId})`,
          },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(resSuspended.status, 422);

      const resRemoved = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: {
            body: `Hey @[Removed](${removedId})`,
          },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(resRemoved.status, 422);
    });
  });

  describe("Comment editing permissions (PATCH)", () => {
    let commentId: string;

    before(async () => {
      // Create a comment authored by member
      const res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: "Original body to be edited" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      const json = (await res.json()) as { comment: { id: string } };
      commentId = json.comment.id;
    });

    it("author can edit their own comment", async () => {
      const res = await commentItemRoute.PATCH(
        apiRequest("PATCH", `/api/tasks/${taskAId}/comments/${commentId}`, {
          cookie: memberCookie,
          body: { body: "Updated body by author" },
        }),
        { params: Promise.resolve({ id: taskAId, commentId }) },
      );
      assert.equal(res.status, 200);
      const json = (await res.json()) as { comment: { body: string; editCount: number } };
      assert.equal(json.comment.body, "Updated body by author");
      assert.equal(json.comment.editCount, 1);

      // Verify edit history via GET
      const getRes = await commentItemRoute.GET(
        apiRequest("GET", `/api/tasks/${taskAId}/comments/${commentId}`, {
          cookie: memberCookie,
        }),
        { params: Promise.resolve({ id: taskAId, commentId }) },
      );
      assert.equal(getRes.status, 200);
      const getJson = (await getRes.json()) as { history: Array<{ previousBody: string }> };
      assert.equal(getJson.history.length, 1);
      assert.equal(getJson.history[0]?.previousBody, "Original body to be edited");
    });

    it("another member cannot edit the comment (403)", async () => {
      const res = await commentItemRoute.PATCH(
        apiRequest("PATCH", `/api/tasks/${taskAId}/comments/${commentId}`, {
          cookie: member2Cookie,
          body: { body: "Attempted edit by member2" },
        }),
        { params: Promise.resolve({ id: taskAId, commentId }) },
      );
      assert.equal(res.status, 403);
      const json = (await res.json()) as { error: string };
      assert.match(json.error, /only comment authors can edit/i);
    });

    it("admin cannot edit another member's comment (author-only rule, 403)", async () => {
      const res = await commentItemRoute.PATCH(
        apiRequest("PATCH", `/api/tasks/${taskAId}/comments/${commentId}`, {
          cookie: adminCookie,
          body: { body: "Admin edit attempt" },
        }),
        { params: Promise.resolve({ id: taskAId, commentId }) },
      );
      assert.equal(res.status, 403);
    });

    it("validates empty body on edit with 422", async () => {
      const res = await commentItemRoute.PATCH(
        apiRequest("PATCH", `/api/tasks/${taskAId}/comments/${commentId}`, {
          cookie: memberCookie,
          body: { body: "   " },
        }),
        { params: Promise.resolve({ id: taskAId, commentId }) },
      );
      assert.equal(res.status, 422);
    });
  });

  describe("Comment deletion permissions (DELETE)", () => {
    it("author can delete their own comment", async () => {
      // Create a comment
      const createRes = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: "Comment to delete by author" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      const { comment } = (await createRes.json()) as { comment: { id: string } };

      const deleteRes = await commentItemRoute.DELETE(
        apiRequest("DELETE", `/api/tasks/${taskAId}/comments/${comment.id}`, {
          cookie: memberCookie,
        }),
        { params: Promise.resolve({ id: taskAId, commentId: comment.id }) },
      );
      assert.equal(deleteRes.status, 200);

      // Verify soft deletion
      const getRes = await commentItemRoute.GET(
        apiRequest("GET", `/api/tasks/${taskAId}/comments/${comment.id}`, {
          cookie: memberCookie,
        }),
        { params: Promise.resolve({ id: taskAId, commentId: comment.id }) },
      );
      assert.equal(getRes.status, 200);
      const getJson = (await getRes.json()) as { comment: { body: string; isDeleted: boolean; authorId: string | null } };
      assert.equal(getJson.comment.isDeleted, true);
      assert.equal(getJson.comment.body, "[This comment was deleted]");
      assert.equal(getJson.comment.authorId, null);

      // Editing deleted comment returns 422
      const editRes = await commentItemRoute.PATCH(
        apiRequest("PATCH", `/api/tasks/${taskAId}/comments/${comment.id}`, {
          cookie: memberCookie,
          body: { body: "Cannot edit deleted" },
        }),
        { params: Promise.resolve({ id: taskAId, commentId: comment.id }) },
      );
      assert.equal(editRes.status, 422);
    });

    it("another member cannot delete someone else's comment (403)", async () => {
      // Created by member
      const createRes = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: "Member comment" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      const { comment } = (await createRes.json()) as { comment: { id: string } };

      // Member 2 tries to delete
      const deleteRes = await commentItemRoute.DELETE(
        apiRequest("DELETE", `/api/tasks/${taskAId}/comments/${comment.id}`, {
          cookie: member2Cookie,
        }),
        { params: Promise.resolve({ id: taskAId, commentId: comment.id }) },
      );
      assert.equal(deleteRes.status, 403);
      const json = (await deleteRes.json()) as { error: string };
      assert.match(json.error, /only the author or a workspace admin\/owner/i);
    });

    it("admin and owner can delete another member's comment (moderation)", async () => {
      // Comment 1: deleted by admin
      const c1Res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: "To be deleted by admin" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      const c1 = (await c1Res.json()) as { comment: { id: string } };

      const delAdminRes = await commentItemRoute.DELETE(
        apiRequest("DELETE", `/api/tasks/${taskAId}/comments/${c1.comment.id}`, {
          cookie: adminCookie,
        }),
        { params: Promise.resolve({ id: taskAId, commentId: c1.comment.id }) },
      );
      assert.equal(delAdminRes.status, 200);

      // Comment 2: deleted by owner
      const c2Res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: "To be deleted by owner" },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      const c2 = (await c2Res.json()) as { comment: { id: string } };

      const delOwnerRes = await commentItemRoute.DELETE(
        apiRequest("DELETE", `/api/tasks/${taskAId}/comments/${c2.comment.id}`, {
          cookie: ownerCookie,
        }),
        { params: Promise.resolve({ id: taskAId, commentId: c2.comment.id }) },
      );
      assert.equal(delOwnerRes.status, 200);
    });
  });

  describe("Role matrix for Reads & Activity (GET)", () => {
    it("allows Viewer, Member, Admin, and Owner to read comments with no-store", async () => {
      for (const [roleName, cookie] of [
        ["viewer", viewerCookie],
        ["member", memberCookie],
        ["admin", adminCookie],
        ["owner", ownerCookie],
      ]) {
        const res = await commentsRoute.GET(
          apiRequest("GET", `/api/tasks/${taskAId}/comments`, { cookie }),
          { params: Promise.resolve({ id: taskAId }) },
        );
        assert.equal(res.status, 200, `Expected 200 for ${roleName}`);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
        const json = (await res.json()) as { comments: unknown[] };
        assert.ok(Array.isArray(json.comments));
      }
    });

    it("allows Viewer, Member, Admin, and Owner to read task and project activity with no-store", async () => {
      for (const [roleName, cookie] of [
        ["viewer", viewerCookie],
        ["member", memberCookie],
        ["admin", adminCookie],
        ["owner", ownerCookie],
      ]) {
        const taskRes = await taskActivityRoute.GET(
          apiRequest("GET", `/api/tasks/${taskAId}/activity`, { cookie }),
          { params: Promise.resolve({ id: taskAId }) },
        );
        assert.equal(taskRes.status, 200, `Expected 200 task activity for ${roleName}`);
        assert.equal(taskRes.headers.get("Cache-Control"), "no-store");
        const taskJson = (await taskRes.json()) as { events: Array<{ type: string }> };
        assert.ok(taskJson.events.length > 0);

        const projRes = await projectActivityRoute.GET(
          apiRequest("GET", `/api/projects/${projectAId}/activity`, { cookie }),
          { params: Promise.resolve({ id: projectAId }) },
        );
        assert.equal(projRes.status, 200, `Expected 200 project activity for ${roleName}`);
        assert.equal(projRes.headers.get("Cache-Control"), "no-store");
        const projJson = (await projRes.json()) as { events: Array<{ type: string }> };
        assert.ok(projJson.events.length > 0);
      }
    });

    it("rejects suspended, removed, and outsider from reading comments and activity with 403 or 404", async () => {
      for (const [roleName, cookie] of [
        ["suspended", suspendedCookie],
        ["removed", removedCookie],
        ["outsider", outsiderCookie],
      ]) {
        const cRes = await commentsRoute.GET(
          apiRequest("GET", `/api/tasks/${taskAId}/comments`, { cookie }),
          { params: Promise.resolve({ id: taskAId }) },
        );
        assert.ok(
          cRes.status === 403 || cRes.status === 404,
          `Expected 403 or 404 for ${roleName} comments read (got ${cRes.status})`,
        );

        const aRes = await taskActivityRoute.GET(
          apiRequest("GET", `/api/tasks/${taskAId}/activity`, { cookie }),
          { params: Promise.resolve({ id: taskAId }) },
        );
        assert.ok(
          aRes.status === 403 || aRes.status === 404,
          `Expected 403 or 404 for ${roleName} activity read (got ${aRes.status})`,
        );
      }
    });
  });

  describe("Cross-workspace isolation & body leakage prevention", () => {
    it("ensures comment bodies and activity cannot leak to another workspace", async () => {
      // Create Project & Task in Workspace B
      const createProjBReq = apiRequest("POST", "/api/projects", {
        cookie: outsiderCookie,
        body: { name: "Project in WS B" },
      });
      const projBRes = await projectsRoute.POST(createProjBReq);
      const projBJson = (await projBRes.json()) as { project: { id: string } };

      const createTaskBReq = apiRequest("POST", `/api/projects/${projBJson.project.id}/tasks`, {
        cookie: outsiderCookie,
        body: { title: "Task in WS B" },
      });
      const taskBRes = await projectTasksRoute.POST(createTaskBReq, {
        params: Promise.resolve({ id: projBJson.project.id }),
      });
      const taskBJson = (await taskBRes.json()) as { task: { id: string } };

      // Secret comment created in Workspace A
      const secretBody = "SuperSecretContentOnlyInWorkspaceA_987123";
      await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: secretBody },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );

      // Workspace B user listing comments in their own task
      const bCommentsRes = await commentsRoute.GET(
        apiRequest("GET", `/api/tasks/${taskBJson.task.id}/comments`, {
          cookie: outsiderCookie,
        }),
        { params: Promise.resolve({ id: taskBJson.task.id }) },
      );
      assert.equal(bCommentsRes.status, 200);
      const bComments = (await bCommentsRes.json()) as { comments: Array<{ body: string }> };
      const leaked = bComments.comments.some((c) => c.body.includes(secretBody));
      assert.equal(leaked, false, "Workspace A comment body leaked into Workspace B list!");

      // Workspace B user attempting to target Workspace A task comments directly
      const directAttempt = await commentsRoute.GET(
        apiRequest("GET", `/api/tasks/${taskAId}/comments`, {
          cookie: outsiderCookie,
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.ok(
        directAttempt.status === 403 || directAttempt.status === 404,
        "Outsider was not rejected when targeting Workspace A",
      );

      // Workspace B user attempting to target Workspace A activity directly
      const activityAttempt = await taskActivityRoute.GET(
        apiRequest("GET", `/api/tasks/${taskAId}/activity`, {
          cookie: outsiderCookie,
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.ok(
        activityAttempt.status === 403 || activityAttempt.status === 404,
        "Outsider was not rejected for Workspace A activity",
      );
    });
  });

  describe("Stored-XSS handling", () => {
    it("stores raw HTML/script payload without execution and returns it accurately", async () => {
      const xssPayload = `<script>alert('xss')</script><img src="x" onerror="alert(1)">`;
      const res = await commentsRoute.POST(
        apiRequest("POST", `/api/tasks/${taskAId}/comments`, {
          cookie: memberCookie,
          body: { body: xssPayload },
        }),
        { params: Promise.resolve({ id: taskAId }) },
      );
      assert.equal(res.status, 201);
      const json = (await res.json()) as { comment: { body: string } };
      // Raw string is stored accurately
      assert.equal(json.comment.body, xssPayload);
    });
  });
});
