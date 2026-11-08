/**
 * Unit tests for agent runs inline comments API routes (AW2-06b).
 *
 * Covers:
 * 1. Desktop availability gate (returns 404 with empty body when disabled).
 * 2. Unknown run (returns 404 JSON {error: "Agent run not found"}).
 * 3. POST valid -> 201 and GET lists it.
 * 4. POST bad JSON / bad path ("../x") / line without file -> 400.
 * 5. Oversized body -> 413 (Content-Length and body text length before parsing).
 * 6. GET bad round -> 400.
 * 7. GET round filter.
 * 8. DELETE -> 204 then 404.
 * 9. DELETE with another run's id -> 404 and the comment still exists.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { projects, agentRuns, agentRunComments } from "../../src/db/schema";

let db: typeof import("../../src/db/client").db;
let commentsRoute: typeof import("../../src/app/api/agent-runs/[id]/comments/route");
let commentByIdRoute: typeof import("../../src/app/api/agent-runs/[id]/comments/[commentId]/route");

const originalEnv = {
  DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
  DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
  AUTH_MODE: process.env.AUTH_MODE,
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  DATABASE_URL: process.env.DATABASE_URL,
};

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  const finalHeaders = new Headers(headers);
  if (body !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
  }
  return new NextRequest(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createTestProject(id: string, name = "Test Project"): Promise<void> {
  await db.insert(projects).values({ id, name, localPath: "H:/test/path" });
}

async function createTestRun(
  id: string,
  projectId: string,
  opts: { status?: string; reviewer?: boolean } = {},
): Promise<void> {
  await db.insert(agentRuns).values({
    id,
    projectId,
    status: (opts.status ?? "reviewing") as "reviewing",
    request: JSON.stringify({
      projectId,
      task: "t",
      checks: [],
      roles: {
        implementer: { provider: "claude-code" },
        ...(opts.reviewer === false ? {} : { reviewer: { provider: "claude-code" } }),
      },
    }),
    workspacePath: `/worktrees/${id}`,
    baseRef: "main",
  });
}

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));

  commentsRoute = await import("../../src/app/api/agent-runs/[id]/comments/route");
  commentByIdRoute = await import("../../src/app/api/agent-runs/[id]/comments/[commentId]/route");
});

after(() => {
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  cleanup();
});

describe("agent run inline comments API routes (AW2-06b)", () => {
  describe("desktop environment gate", () => {
    it("returns 404 with empty body for every route when desktop env is off, inserting nothing", async () => {
      delete process.env.DASHBOARD_LOCAL;
      delete process.env.DESKTOP_INTERNAL_SECRET;

      const commentsBefore = db.select().from(agentRunComments).all();

      const getRes = await commentsRoute.GET(
        new NextRequest("http://localhost/api/agent-runs/run_gate/comments"),
        { params: Promise.resolve({ id: "run_gate" }) },
      );
      assert.equal(getRes.status, 404);
      assert.equal(await getRes.text(), "");

      const postRes = await commentsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs/run_gate/comments", "POST", {
          round: 0,
          body: "Comment",
        }),
        { params: Promise.resolve({ id: "run_gate" }) },
      );
      assert.equal(postRes.status, 404);
      assert.equal(await postRes.text(), "");

      const deleteRes = await commentByIdRoute.DELETE(
        new NextRequest("http://localhost/api/agent-runs/run_gate/comments/c1"),
        { params: Promise.resolve({ id: "run_gate", commentId: "c1" }) },
      );
      assert.equal(deleteRes.status, 404);
      assert.equal(await deleteRes.text(), "");

      const commentsAfter = db.select().from(agentRunComments).all();
      assert.equal(commentsAfter.length, commentsBefore.length);
    });
  });

  describe("active desktop mode routes", () => {
    before(() => {
      process.env.DASHBOARD_LOCAL = "1";
      process.env.DESKTOP_INTERNAL_SECRET = "secret-for-test";
      delete process.env.AUTH_MODE;
      delete process.env.DASHBOARD_PASSWORD;
      delete process.env.DATABASE_URL;
    });

    it("returns 404 JSON when agent run is not found", async () => {
      const getRes = await commentsRoute.GET(
        new NextRequest("http://localhost/api/agent-runs/unknown_run/comments"),
        { params: Promise.resolve({ id: "unknown_run" }) },
      );
      assert.equal(getRes.status, 404);
      const getData = await getRes.json();
      assert.equal(getData.error, "Agent run not found");

      const postRes = await commentsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs/unknown_run/comments", "POST", {
          round: 0,
          body: "Comment",
        }),
        { params: Promise.resolve({ id: "unknown_run" }) },
      );
      assert.equal(postRes.status, 404);
      const postData = await postRes.json();
      assert.equal(postData.error, "Agent run not found");

      const deleteRes = await commentByIdRoute.DELETE(
        new NextRequest("http://localhost/api/agent-runs/unknown_run/comments/c1"),
        { params: Promise.resolve({ id: "unknown_run", commentId: "c1" }) },
      );
      assert.equal(deleteRes.status, 404);
      const deleteData = await deleteRes.json();
      assert.equal(deleteData.error, "Agent run not found");
    });

    it("POST on a terminal run or a run with no reviewer stage -> 409 and nothing stored (review S3)", async () => {
      await createTestProject("prj_409");
      await createTestRun("run_409_done", "prj_409", { status: "succeeded" });
      await createTestRun("run_409_aw1", "prj_409", { reviewer: false });
      for (const [runId, pattern] of [
        ["run_409_done", /has ended/],
        ["run_409_aw1", /no planner or reviewer stage/],
      ] as const) {
        const res = await commentsRoute.POST(
          jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", { round: 0, body: "hello" }),
          { params: Promise.resolve({ id: runId }) },
        );
        assert.equal(res.status, 409);
        assert.match(((await res.json()) as { error: string }).error, pattern);
        assert.equal(db.select().from(agentRunComments).where(eq(agentRunComments.runId, runId)).all().length, 0);
      }
    });

    it("POST valid -> 201 and GET lists it", async () => {
      const projectId = "prj_valid";
      const runId = "run_valid";
      await createTestProject(projectId);
      await createTestRun(runId, projectId);

      // 1. Post a file line comment
      const postRes1 = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          file: "src/main.ts",
          line: 12,
          body: "Fix this issue",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(postRes1.status, 201);
      const data1 = await postRes1.json();
      assert.ok(data1.comment);
      assert.ok(data1.comment.id);
      assert.equal(data1.comment.runId, runId);
      assert.equal(data1.comment.round, 0);
      assert.equal(data1.comment.file, "src/main.ts");
      assert.equal(data1.comment.line, 12);
      assert.equal(data1.comment.body, "Fix this issue");
      assert.ok(data1.comment.createdAt);

      // 2. Post a whole-run comment (no file, no line)
      const postRes2 = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 1,
          body: "Overall approach looks good",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(postRes2.status, 201);
      const data2 = await postRes2.json();
      assert.ok(data2.comment);
      assert.equal(data2.comment.round, 1);
      assert.equal(data2.comment.file, null);
      assert.equal(data2.comment.line, null);
      assert.equal(data2.comment.body, "Overall approach looks good");

      // 3. GET /api/agent-runs/:id/comments lists all comments
      const getRes = await commentsRoute.GET(
        new NextRequest(`http://localhost/api/agent-runs/${runId}/comments`),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.ok(Array.isArray(getData.comments));
      assert.equal(getData.comments.length, 2);
      assert.equal(getData.comments[0].id, data1.comment.id);
      assert.equal(getData.comments[1].id, data2.comment.id);
    });

    it("POST bad JSON / bad path ('../x') / line without file -> 400", async () => {
      const projectId = "prj_bad_req";
      const runId = "run_bad_req";
      await createTestProject(projectId);
      await createTestRun(runId, projectId);

      // Malformed JSON syntax
      const malformedReq = new NextRequest(
        `http://localhost/api/agent-runs/${runId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{bad-json:",
        },
      );
      const malformedRes = await commentsRoute.POST(malformedReq, {
        params: Promise.resolve({ id: runId }),
      });
      assert.equal(malformedRes.status, 400);
      const malformedData = await malformedRes.json();
      assert.match(malformedData.error, /invalid json body/i);

      // Bad path with '..'
      const dotDotRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          file: "../secret.txt",
          body: "Dot dot path",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(dotDotRes.status, 400);
      const dotDotData = await dotDotRes.json();
      assert.equal(dotDotData.error, "Validation failed");
      assert.ok(Array.isArray(dotDotData.issues));

      // Bad path with drive letter
      const driveRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          file: "C:/absolute/path",
          body: "Drive path",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(driveRes.status, 400);

      // Bad path with leading slash
      const slashRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          file: "/etc/passwd",
          body: "Slash path",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(slashRes.status, 400);

      // Line without file
      const lineWithoutFileRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          line: 42,
          body: "Line without file",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(lineWithoutFileRes.status, 400);
      const lineWithoutFileData = await lineWithoutFileRes.json();
      assert.equal(lineWithoutFileData.error, "Validation failed");

      // Missing body
      const missingBodyRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(missingBodyRes.status, 400);

      // Round out of bounds (> 3)
      const roundHighRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 4,
          body: "Round 4",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(roundHighRes.status, 400);

      // Round negative
      const roundNegRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: -1,
          body: "Round -1",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(roundNegRes.status, 400);
    });

    it("oversized body -> 413 (checked before parsing via Content-Length and body text length)", async () => {
      const projectId = "prj_oversized";
      const runId = "run_oversized";
      await createTestProject(projectId);
      await createTestRun(runId, projectId);

      // 1. Content-Length header > 16 KB (16384 bytes)
      const headerOversizedReq = new NextRequest(
        `http://localhost/api/agent-runs/${runId}/comments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "16385",
          },
          body: JSON.stringify({ round: 0, body: "small" }),
        },
      );
      const headerRes = await commentsRoute.POST(headerOversizedReq, {
        params: Promise.resolve({ id: runId }),
      });
      assert.equal(headerRes.status, 413);

      // 2. Body text length > 16 KB without header
      const largePayload = JSON.stringify({
        round: 0,
        body: "a".repeat(17000),
      });
      const bodyOversizedReq = new NextRequest(
        `http://localhost/api/agent-runs/${runId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: largePayload,
        },
      );
      const bodyRes = await commentsRoute.POST(bodyOversizedReq, {
        params: Promise.resolve({ id: runId }),
      });
      assert.equal(bodyRes.status, 413);
    });

    it("GET bad round -> 400 JSON {error}", async () => {
      const projectId = "prj_bad_round";
      const runId = "run_bad_round";
      await createTestProject(projectId);
      await createTestRun(runId, projectId);

      const invalidRounds = ["4", "-1", "abc", "", "1.5", "00", " 4 "];
      for (const val of invalidRounds) {
        const res = await commentsRoute.GET(
          new NextRequest(
            `http://localhost/api/agent-runs/${runId}/comments?round=${encodeURIComponent(val)}`,
          ),
          { params: Promise.resolve({ id: runId }) },
        );
        assert.equal(
          res.status,
          400,
          `Expected status 400 for ?round=${val}, got ${res.status}`,
        );
        const data = await res.json();
        assert.ok(data.error, `Expected error field for ?round=${val}`);
      }
    });

    it("GET round filter", async () => {
      const projectId = "prj_round_filter";
      const runId = "run_round_filter";
      await createTestProject(projectId);
      await createTestRun(runId, projectId);

      await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          body: "Round 0 comment",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 1,
          body: "Round 1 comment",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          body: "Second Round 0 comment",
        }),
        { params: Promise.resolve({ id: runId }) },
      );

      // Filter round 0
      const res0 = await commentsRoute.GET(
        new NextRequest(`http://localhost/api/agent-runs/${runId}/comments?round=0`),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(res0.status, 200);
      const data0 = await res0.json();
      assert.equal(data0.comments.length, 2);
      assert.ok(data0.comments.every((c: { round: number }) => c.round === 0));

      // Filter round 1
      const res1 = await commentsRoute.GET(
        new NextRequest(`http://localhost/api/agent-runs/${runId}/comments?round=1`),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(res1.status, 200);
      const data1 = await res1.json();
      assert.equal(data1.comments.length, 1);
      assert.equal(data1.comments[0].round, 1);

      // Filter round 2 (empty)
      const res2 = await commentsRoute.GET(
        new NextRequest(`http://localhost/api/agent-runs/${runId}/comments?round=2`),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.comments.length, 0);
    });

    it("DELETE -> 204 then 404", async () => {
      const projectId = "prj_delete";
      const runId = "run_delete";
      await createTestProject(projectId);
      await createTestRun(runId, projectId);

      const postRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          body: "Comment to delete",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      const { comment } = await postRes.json();
      const commentId = comment.id;

      // First DELETE -> 204
      const deleteRes1 = await commentByIdRoute.DELETE(
        new NextRequest(`http://localhost/api/agent-runs/${runId}/comments/${commentId}`),
        { params: Promise.resolve({ id: runId, commentId }) },
      );
      assert.equal(deleteRes1.status, 204);
      assert.equal(await deleteRes1.text(), "");

      // Verify row removed from DB
      const row = db
        .select()
        .from(agentRunComments)
        .where(eq(agentRunComments.id, commentId))
        .get();
      assert.equal(row, undefined);

      // Second DELETE -> 404
      const deleteRes2 = await commentByIdRoute.DELETE(
        new NextRequest(`http://localhost/api/agent-runs/${runId}/comments/${commentId}`),
        { params: Promise.resolve({ id: runId, commentId }) },
      );
      assert.equal(deleteRes2.status, 404);
      const deleteData2 = await deleteRes2.json();
      assert.equal(deleteData2.error, "Comment not found");
    });

    it("DELETE with another run's id -> 404 and the comment still exists", async () => {
      const projectId = "prj_scope";
      const runA = "run_scope_a";
      const runB = "run_scope_b";
      await createTestProject(projectId);
      await createTestRun(runA, projectId);
      await createTestRun(runB, projectId);

      // Add comment to Run A
      const postRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runA}/comments`, "POST", {
          round: 0,
          body: "Belongs to Run A",
        }),
        { params: Promise.resolve({ id: runA }) },
      );
      const { comment } = await postRes.json();
      const commentId = comment.id;

      // Attempt DELETE via Run B
      const deleteRes = await commentByIdRoute.DELETE(
        new NextRequest(`http://localhost/api/agent-runs/${runB}/comments/${commentId}`),
        { params: Promise.resolve({ id: runB, commentId }) },
      );
      assert.equal(deleteRes.status, 404);
      const deleteData = await deleteRes.json();
      assert.equal(deleteData.error, "Comment not found");

      // Verify comment still exists for Run A in DB and via GET
      const inDb = db
        .select()
        .from(agentRunComments)
        .where(eq(agentRunComments.id, commentId))
        .get();
      assert.ok(inDb);
      assert.equal(inDb.runId, runA);

      const getRes = await commentsRoute.GET(
        new NextRequest(`http://localhost/api/agent-runs/${runA}/comments`),
        { params: Promise.resolve({ id: runA }) },
      );
      const getData = await getRes.json();
      assert.equal(getData.comments.length, 1);
      assert.equal(getData.comments[0].id, commentId);
    });

    it("POST redacts secrets from comment body before saving", async () => {
      const projectId = "prj_secret";
      const runId = "run_secret";
      await createTestProject(projectId);
      await createTestRun(runId, projectId);

      const postRes = await commentsRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${runId}/comments`, "POST", {
          round: 0,
          body: "Here is a secret: ghp_123456789012345678901234567890123456 in code",
        }),
        { params: Promise.resolve({ id: runId }) },
      );
      assert.equal(postRes.status, 201);
      const { comment } = await postRes.json();
      assert.ok(!comment.body.includes("ghp_123456789012345678901234567890123456"));
      assert.match(comment.body, /\[REDACTED\]/);
    });
  });
});
