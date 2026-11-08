/**
 * Unit tests for agent_run_comment table and data helpers (AW2-06).
 *
 * Tests:
 * - add/list order
 * - round filter
 * - whole-run comment (no file)
 * - line without file rejected
 * - '..'/absolute/drive-letter paths rejected
 * - backslashes normalised
 * - body redaction (token pattern from redact.ts)
 * - body length bounds
 * - unknown run throws
 * - delete scoped to run
 * - cascade delete when the run row is deleted
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { projects, agentRuns, agentRunComments } from "../../src/db/schema";
import {
  addComment,
  listComments,
  deleteComment,
} from "../../src/core/agents/comments";
import { REDACTED } from "../../src/core/agents/redact";

let db: typeof import("../../src/db/client").db;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
});

after(() => cleanup());

async function createTestProject(id: string, name = "Test Project"): Promise<void> {
  await db.insert(projects).values({ id, name });
}

async function createTestRun(id: string, projectId: string): Promise<void> {
  await db.insert(agentRuns).values({
    id,
    projectId,
    workspacePath: `/worktrees/${id}`,
    baseRef: "main",
  });
}

describe("agent_run_comment table and data helpers (AW2-06)", () => {
  it("addComment inserts comments and listComments returns them ordered by round, created_at, id", async () => {
    const projectId = "prj-order";
    const runId = "run-order";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    const c1 = await addComment(db, runId, {
      round: 1,
      file: "src/a.ts",
      line: 10,
      body: "Round 1 comment A",
    });
    const c2 = await addComment(db, runId, {
      round: 0,
      file: "src/b.ts",
      line: 5,
      body: "Round 0 comment B",
    });
    const c3 = await addComment(db, runId, {
      round: 1,
      file: "src/c.ts",
      line: 20,
      body: "Round 1 comment C",
    });
    const c4 = await addComment(db, runId, {
      round: 0,
      file: "src/d.ts",
      line: 1,
      body: "Round 0 comment D",
    });

    const allComments = await listComments(db, runId);
    assert.equal(allComments.length, 4);

    // Round 0 comments must come before Round 1 comments
    assert.deepEqual(
      allComments.map((c) => c.id),
      [c2.id, c4.id, c1.id, c3.id],
    );
    assert.equal(allComments[0]!.round, 0);
    assert.equal(allComments[1]!.round, 0);
    assert.equal(allComments[2]!.round, 1);
    assert.equal(allComments[3]!.round, 1);
  });

  it("listComments filters by correction round", async () => {
    const projectId = "prj-filter";
    const runId = "run-filter";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    const c0 = await addComment(db, runId, {
      round: 0,
      file: "src/round0.ts",
      body: "Comment in round 0",
    });
    const c1 = await addComment(db, runId, {
      round: 1,
      file: "src/round1.ts",
      body: "Comment in round 1",
    });

    const round0Comments = await listComments(db, runId, 0);
    assert.equal(round0Comments.length, 1);
    assert.equal(round0Comments[0]!.id, c0.id);
    assert.equal(round0Comments[0]!.round, 0);

    const round1Comments = await listComments(db, runId, 1);
    assert.equal(round1Comments.length, 1);
    assert.equal(round1Comments[0]!.id, c1.id);
    assert.equal(round1Comments[0]!.round, 1);

    const round2Comments = await listComments(db, runId, 2);
    assert.equal(round2Comments.length, 0);
  });

  it("supports whole-run comments without file or line", async () => {
    const projectId = "prj-whole-run";
    const runId = "run-whole-run";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    // Omitted file and line
    const c1 = await addComment(db, runId, {
      round: 0,
      body: "Overall run feedback without file",
    });
    assert.equal(c1.file, null);
    assert.equal(c1.line, null);
    assert.equal(c1.body, "Overall run feedback without file");

    // Explicitly null file and line
    const c2 = await addComment(db, runId, {
      round: 1,
      file: null,
      line: null,
      body: "Explicit null file and line",
    });
    assert.equal(c2.file, null);
    assert.equal(c2.line, null);
    assert.equal(c2.body, "Explicit null file and line");

    const list = await listComments(db, runId);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.file, null);
    assert.equal(list[1]!.file, null);
  });

  it("rejects line when file is not set", async () => {
    const projectId = "prj-line-no-file";
    const runId = "run-line-no-file";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    // Line with omitted file
    await assert.rejects(
      async () => {
        await addComment(db, runId, {
          round: 0,
          line: 42,
          body: "Line without file",
        });
      },
    );

    // Line with null file
    await assert.rejects(
      async () => {
        await addComment(db, runId, {
          round: 0,
          file: null,
          line: 10,
          body: "Line with null file",
        });
      },
    );

    // Line < 1 is rejected even if file is present
    await assert.rejects(
      async () => {
        await addComment(db, runId, {
          round: 0,
          file: "src/index.ts",
          line: 0,
          body: "Zero line",
        });
      },
    );
    await assert.rejects(
      async () => {
        await addComment(db, runId, {
          round: 0,
          file: "src/index.ts",
          line: -1,
          body: "Negative line",
        });
      },
    );
  });

  it("rejects '..', absolute, and drive-letter paths", async () => {
    const projectId = "prj-bad-paths";
    const runId = "run-bad-paths";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    const invalidPaths = [
      // '..' segments
      "..",
      "../secret.txt",
      "src/../secret.txt",
      "src\\..\\secret.txt",
      "dir/../../secret.txt",
      "foo/..",
      // absolute paths
      "/etc/passwd",
      "/src/index.ts",
      "\\Windows\\System32\\cmd.exe",
      "\\src\\index.ts",
      // drive letters
      "C:\\Users\\file.ts",
      "C:/Users/file.ts",
      "c:file.ts",
      "D:\\repo\\file.ts",
      "z:/repo/file.ts",
    ];

    for (const badPath of invalidPaths) {
      await assert.rejects(
        async () => {
          await addComment(db, runId, {
            round: 0,
            file: badPath,
            body: `Testing bad path: ${badPath}`,
          });
        },
        `Expected path "${badPath}" to be rejected`,
      );
    }
  });

  it("normalises backslashes in file paths to forward slashes", async () => {
    const projectId = "prj-backslashes";
    const runId = "run-backslashes";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    const comment1 = await addComment(db, runId, {
      round: 0,
      file: "src\\core\\agents\\comments.ts",
      line: 15,
      body: "Backslash path comment",
    });

    assert.equal(comment1.file, "src/core/agents/comments.ts");

    const comment2 = await addComment(db, runId, {
      round: 1,
      file: "tests\\unit\\sub\\test.ts",
      body: "Nested backslash path",
    });

    assert.equal(comment2.file, "tests/unit/sub/test.ts");

    const rows = await listComments(db, runId);
    assert.equal(rows[0]!.file, "src/core/agents/comments.ts");
    assert.equal(rows[1]!.file, "tests/unit/sub/test.ts");
  });

  it("redacts secrets from the comment body before storing", async () => {
    const projectId = "prj-redact";
    const runId = "run-redact";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    // GitHub token pattern from redact.ts and agent-redact.test.ts
    const githubSecret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const comment = await addComment(db, runId, {
      round: 0,
      file: "src/secret.ts",
      line: 12,
      body: `Found exposed token: ${githubSecret} in the commit diff`,
    });

    assert.ok(!comment.body.includes(githubSecret));
    assert.ok(comment.body.includes(REDACTED));
    assert.equal(
      comment.body,
      `Found exposed token: ${REDACTED} in the commit diff`,
    );

    // Verify directly from the database query as well
    const stored = await listComments(db, runId);
    assert.equal(stored.length, 1);
    assert.ok(!stored[0]!.body.includes(githubSecret));
    assert.ok(stored[0]!.body.includes(REDACTED));

    // Also test Anthropic key pattern
    const anthropicSecret =
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789_-abcdefghijklmnopqrstuvwxyz0123456789";
    const comment2 = await addComment(db, runId, {
      round: 0,
      body: `Secret is ${anthropicSecret}`,
    });
    assert.ok(!comment2.body.includes(anthropicSecret));
    assert.equal(comment2.body, `Secret is ${REDACTED}`);
  });

  it("enforces body length bounds and trimming", async () => {
    const projectId = "prj-body-bounds";
    const runId = "run-body-bounds";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    // Empty string rejected
    await assert.rejects(async () => {
      await addComment(db, runId, {
        round: 0,
        body: "",
      });
    });

    // Whitespace only rejected
    await assert.rejects(async () => {
      await addComment(db, runId, {
        round: 0,
        body: "   \t\n  ",
      });
    });

    // Exactly 4000 chars accepted
    const exactly4000 = "x".repeat(4000);
    const comment4000 = await addComment(db, runId, {
      round: 0,
      body: exactly4000,
    });
    assert.equal(comment4000.body.length, 4000);

    // 4001 chars rejected
    const over4000 = "x".repeat(4001);
    await assert.rejects(async () => {
      await addComment(db, runId, {
        round: 0,
        body: over4000,
      });
    });

    // Trimming leading/trailing whitespace
    const commentTrimmed = await addComment(db, runId, {
      round: 0,
      body: "  trimmed message  ",
    });
    assert.equal(commentTrimmed.body, "trimmed message");
  });

  it("enforces round bounds (0..3)", async () => {
    const projectId = "prj-round-bounds";
    const runId = "run-round-bounds";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    // Rounds 0..3 are valid
    for (let r = 0; r <= 3; r++) {
      const c = await addComment(db, runId, { round: r, body: `Round ${r}` });
      assert.equal(c.round, r);
    }

    // Round -1 is invalid
    await assert.rejects(async () => {
      await addComment(db, runId, { round: -1, body: "Negative round" });
    });

    // Round 4 is invalid
    await assert.rejects(async () => {
      await addComment(db, runId, { round: 4, body: "Round 4" });
    });

    // Non-integer round is invalid
    await assert.rejects(async () => {
      await addComment(db, runId, { round: 1.5, body: "Float round" });
    });
  });

  it("throws when adding a comment to a non-existent run", async () => {
    const unknownRunId = "run-nonexistent-12345";
    await assert.rejects(
      async () => {
        await addComment(db, unknownRunId, {
          round: 0,
          body: "Comment on missing run",
        });
      },
      {
        message: `Agent run "${unknownRunId}" not found`,
      },
    );
  });

  it("deletes a comment only when scoped to that run", async () => {
    const projectId = "prj-delete-scope";
    const run1 = "run-delete-1";
    const run2 = "run-delete-2";
    await createTestProject(projectId);
    await createTestRun(run1, projectId);
    await createTestRun(run2, projectId);

    const comment1 = await addComment(db, run1, {
      round: 0,
      body: "Comment on run 1",
    });

    // Deleting comment1 under run2 returns false and leaves comment untouched
    const deletedUnderRun2 = await deleteComment(db, run2, comment1.id);
    assert.equal(deletedUnderRun2, false);

    const run1CommentsBefore = await listComments(db, run1);
    assert.equal(run1CommentsBefore.length, 1);

    // Deleting non-existent comment returns false
    const deletedNonExistent = await deleteComment(db, run1, "comment-fake-id");
    assert.equal(deletedNonExistent, false);

    // Deleting comment1 under run1 succeeds
    const deletedUnderRun1 = await deleteComment(db, run1, comment1.id);
    assert.equal(deletedUnderRun1, true);

    const run1CommentsAfter = await listComments(db, run1);
    assert.equal(run1CommentsAfter.length, 0);

    // Deleting already deleted comment returns false
    const deleteAgain = await deleteComment(db, run1, comment1.id);
    assert.equal(deleteAgain, false);
  });

  it("cascades deletion of comments when run is deleted", async () => {
    const projectId = "prj-cascade";
    const runId = "run-cascade-comments";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    await addComment(db, runId, { round: 0, body: "Comment 1" });
    await addComment(db, runId, {
      round: 1,
      file: "src/test.ts",
      line: 5,
      body: "Comment 2",
    });

    const beforeDelete = await listComments(db, runId);
    assert.equal(beforeDelete.length, 2);

    // Delete the agent run
    await db.delete(agentRuns).where(eq(agentRuns.id, runId));

    // Comments must be cascade-deleted
    const afterDelete = await listComments(db, runId);
    assert.equal(afterDelete.length, 0);

    const rawRows = db
      .select()
      .from(agentRunComments)
      .where(eq(agentRunComments.runId, runId))
      .all();
    assert.equal(rawRows.length, 0);
  });
});
