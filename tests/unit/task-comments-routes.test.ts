/**
 * Release 2C.4 Task Comments & Activity: Desktop Route Tests.
 *
 * Verifies Next.js route handlers under /api/tasks/[id]/comments, /api/tasks/[id]/activity,
 * and /api/projects/[id]/activity in desktop mode (SQLite, single local user):
 * - List (GET /api/tasks/:id/comments with pagination envelope)
 * - Add comment (POST /api/tasks/:id/comments)
 * - Validation (empty body -> 422)
 * - Mentions rejection in desktop mode (returns 422)
 * - Edit comment (PATCH /api/tasks/:id/comments/:commentId)
 * - Comment details without edit history (GET /api/tasks/:id/comments/:commentId)
 * - Dedicated privileged edit history route (GET /api/tasks/:id/comments/:commentId/history)
 * - Delete comment (DELETE /api/tasks/:id/comments/:commentId)
 * - Task activity timeline (GET /api/tasks/:id/activity)
 * - Project activity timeline (GET /api/projects/:id/activity)
 * - 404 handling on nonexistent tasks and comments
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import type { TaskComment, TaskActivityEvent } from "../../src/core/tasks/types";

let projectRepository: typeof import("../../src/db/repositories").projectRepository;
let taskRepository: typeof import("../../src/db/repositories").taskRepository;

type CommentsRoute = typeof import("../../src/app/api/tasks/[id]/comments/route");
type CommentItemRoute = typeof import("../../src/app/api/tasks/[id]/comments/[commentId]/route");
type CommentHistoryRoute = typeof import("../../src/app/api/tasks/[id]/comments/[commentId]/history/route");
type TaskActivityRoute = typeof import("../../src/app/api/tasks/[id]/activity/route");
type ProjectActivityRoute = typeof import("../../src/app/api/projects/[id]/activity/route");

let commentsRoute: CommentsRoute;
let commentItemRoute: CommentItemRoute;
let commentHistoryRoute: CommentHistoryRoute;
let taskActivityRoute: TaskActivityRoute;
let projectActivityRoute: ProjectActivityRoute;

let projectId: string;
let taskId: string;

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  await migrate();
  ({ projectRepository, taskRepository } = await import("../../src/db/repositories"));
  commentsRoute = await import("../../src/app/api/tasks/[id]/comments/route");
  commentItemRoute = await import("../../src/app/api/tasks/[id]/comments/[commentId]/route");
  commentHistoryRoute = await import("../../src/app/api/tasks/[id]/comments/[commentId]/history/route");
  taskActivityRoute = await import("../../src/app/api/tasks/[id]/activity/route");
  projectActivityRoute = await import("../../src/app/api/projects/[id]/activity/route");

  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, {
    name: "Desktop Comments Route Project",
  });
  projectId = project.id;

  const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
    projectId,
    title: "Desktop Comments Route Task",
  });
  taskId = task.id;
});

after(() => cleanup());

describe("Desktop comments and activity routes", () => {
  let createdCommentId: string;

  it("GET /api/tasks/:id/comments returns empty array initially with no-store and null cursor", async () => {
    const req = new NextRequest(`http://localhost/api/tasks/${taskId}/comments`);
    const res = await commentsRoute.GET(req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = (await res.json()) as { comments: TaskComment[]; nextCursor: string | null };
    assert.deepEqual(data.comments, []);
    assert.equal(data.nextCursor, null);
  });

  it("POST validates input body (empty text returns 422)", async () => {
    const req = jsonRequest(`http://localhost/api/tasks/${taskId}/comments`, "POST", {
      body: "   ",
    });
    const res = await commentsRoute.POST(req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res.status, 422);
  });

  it("POST rejects malformed mention user IDs with 422", async () => {
    const req = jsonRequest(`http://localhost/api/tasks/${taskId}/comments`, "POST", {
      body: "Hello @[User](123)",
    });
    const res = await commentsRoute.POST(req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res.status, 422);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /valid user id/i);
  });

  it("POST rejects mentions in desktop mode with 422", async () => {
    const req = jsonRequest(`http://localhost/api/tasks/${taskId}/comments`, "POST", {
      body: "Hello @[User](00000000-0000-0000-0000-000000000001)",
    });
    const res = await commentsRoute.POST(req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res.status, 422);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /desktop/i);
  });

  it("POST creates a comment and returns 201 with no-store", async () => {
    const req = jsonRequest(`http://localhost/api/tasks/${taskId}/comments`, "POST", {
      body: "Initial desktop comment",
    });
    const res = await commentsRoute.POST(req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = (await res.json()) as { comment: TaskComment };
    assert.equal(data.comment.body, "Initial desktop comment");
    assert.equal(data.comment.authorId, null);
    createdCommentId = data.comment.id;
  });

  it("PATCH /api/tasks/:id/comments/:commentId edits comment body", async () => {
    const req = jsonRequest(
      `http://localhost/api/tasks/${taskId}/comments/${createdCommentId}`,
      "PATCH",
      { body: "Updated desktop comment body" },
    );
    const res = await commentItemRoute.PATCH(req, {
      params: Promise.resolve({ id: taskId, commentId: createdCommentId }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { comment: TaskComment };
    assert.equal(data.comment.body, "Updated desktop comment body");
    assert.equal(data.comment.editCount, 1);
  });

  it("GET /api/tasks/:id/comments/:commentId returns comment details only without edit history", async () => {
    const req = new NextRequest(
      `http://localhost/api/tasks/${taskId}/comments/${createdCommentId}`,
    );
    const res = await commentItemRoute.GET(req, {
      params: Promise.resolve({ id: taskId, commentId: createdCommentId }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      comment: TaskComment;
      history?: unknown;
    };
    assert.equal(data.comment.id, createdCommentId);
    assert.equal("history" in data, false, "history must not be returned on comment GET route");
  });

  it("GET /api/tasks/:id/comments/:commentId/history returns audit edit history", async () => {
    const req = new NextRequest(
      `http://localhost/api/tasks/${taskId}/comments/${createdCommentId}/history`,
    );
    const res = await commentHistoryRoute.GET(req, {
      params: Promise.resolve({ id: taskId, commentId: createdCommentId }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = (await res.json()) as {
      history: Array<{ previousBody: string }>;
    };
    assert.equal(data.history.length, 1);
    assert.equal(data.history[0]?.previousBody, "Initial desktop comment");
  });

  it("supports comment pagination with limit and cursor", async () => {
    // Add second comment
    const postReq = jsonRequest(`http://localhost/api/tasks/${taskId}/comments`, "POST", {
      body: "Second desktop comment for pagination",
    });
    await commentsRoute.POST(postReq, { params: Promise.resolve({ id: taskId }) });

    // Page 1 with limit=1
    const p1Req = new NextRequest(`http://localhost/api/tasks/${taskId}/comments?limit=1`);
    const p1Res = await commentsRoute.GET(p1Req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(p1Res.status, 200);
    const p1Data = (await p1Res.json()) as { comments: TaskComment[]; nextCursor: string | null };
    assert.equal(p1Data.comments.length, 1);
    assert.ok(p1Data.nextCursor);

    // Page 2 with cursor
    const p2Req = new NextRequest(
      `http://localhost/api/tasks/${taskId}/comments?limit=1&cursor=${p1Data.nextCursor}`,
    );
    const p2Res = await commentsRoute.GET(p2Req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(p2Res.status, 200);
    const p2Data = (await p2Res.json()) as { comments: TaskComment[]; nextCursor: string | null };
    assert.equal(p2Data.comments.length, 1);
    assert.notEqual(p1Data.comments[0]?.id, p2Data.comments[0]?.id);

    // Invalid limit returns 422
    const badReq = new NextRequest(`http://localhost/api/tasks/${taskId}/comments?limit=0`);
    const badRes = await commentsRoute.GET(badReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(badRes.status, 422);
  });

  it("DELETE soft-deletes a comment preserving audit trail", async () => {
    const req = new NextRequest(
      `http://localhost/api/tasks/${taskId}/comments/${createdCommentId}`,
      { method: "DELETE" },
    );
    const res = await commentItemRoute.DELETE(req, {
      params: Promise.resolve({ id: taskId, commentId: createdCommentId }),
    });
    assert.equal(res.status, 200);

    // Fetch via GET to verify soft delete
    const getReq = new NextRequest(
      `http://localhost/api/tasks/${taskId}/comments/${createdCommentId}`,
    );
    const getRes = await commentItemRoute.GET(getReq, {
      params: Promise.resolve({ id: taskId, commentId: createdCommentId }),
    });
    assert.equal(getRes.status, 200);
    const getData = (await getRes.json()) as { comment: TaskComment; history?: unknown };
    assert.equal(getData.comment.isDeleted, true);
    assert.equal(getData.comment.body, "[This comment was deleted]");
    assert.equal(getData.comment.authorId, null);
    assert.equal(getData.comment.deletedBy, null);
    assert.equal("history" in getData, false);
  });

  it("GET /api/tasks/:id/activity returns chronological activity events", async () => {
    const req = new NextRequest(`http://localhost/api/tasks/${taskId}/activity`);
    const res = await taskActivityRoute.GET(req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = (await res.json()) as { events: TaskActivityEvent[] };
    assert.ok(data.events.length >= 3);
    const types = data.events.map((e) => e.type);
    assert.ok(types.includes("comment.created"));
    assert.ok(types.includes("comment.edited"));
    assert.ok(types.includes("comment.deleted"));
  });

  it("GET /api/projects/:id/activity returns project-wide activity timeline", async () => {
    const req = new NextRequest(`http://localhost/api/projects/${projectId}/activity`);
    const res = await projectActivityRoute.GET(req, {
      params: Promise.resolve({ id: projectId }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = (await res.json()) as { events: TaskActivityEvent[] };
    assert.ok(data.events.length > 0);
  });

  it("returns 404 for nonexistent task and comment", async () => {
    const nonExistentTaskId = "00000000-0000-0000-0000-000000000000";
    const req1 = new NextRequest(`http://localhost/api/tasks/${nonExistentTaskId}/comments`);
    const res1 = await commentsRoute.GET(req1, {
      params: Promise.resolve({ id: nonExistentTaskId }),
    });
    assert.equal(res1.status, 404);

    const req2 = new NextRequest(
      `http://localhost/api/tasks/${taskId}/comments/${nonExistentTaskId}`,
    );
    const res2 = await commentItemRoute.GET(req2, {
      params: Promise.resolve({ id: taskId, commentId: nonExistentTaskId }),
    });
    assert.equal(res2.status, 404);

    const req3 = new NextRequest(
      `http://localhost/api/tasks/${taskId}/comments/${nonExistentTaskId}/history`,
    );
    const res3 = await commentHistoryRoute.GET(req3, {
      params: Promise.resolve({ id: taskId, commentId: nonExistentTaskId }),
    });
    assert.equal(res3.status, 404);
  });
});
