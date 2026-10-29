/**
 * Unit tests for agent tables and event log persistence (Release AW.1, AW1-03).
 *
 * Exercises appendEvent, readSince, and lastSeq against a throwaway SQLite
 * database (desktop mode) with strict validation, gapless sequence guarantees,
 * secret redaction, payload truncation, and foreign-key cascade deletion.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { projects, agentRuns, agentRunEvents } from "../../src/db/schema";
import {
  appendEvent,
  lastSeq,
  readSince,
  MAX_EVENT_PAYLOAD_BYTES,
} from "../../src/core/agents/events";
import { REDACTED } from "../../src/core/agents/redact";

let db: typeof import("../../src/db/client").db;

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));

  // Ensure tables exist in case test is executed prior to db:generate
  const tables = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run'`,
  );
  if (tables.length === 0) {
    db.run(sql`
      CREATE TABLE IF NOT EXISTS agent_project_policy (
        project_id text PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        check_commands text NOT NULL DEFAULT '[]',
        excluded_paths text NOT NULL DEFAULT '[]',
        test_restrictions text NOT NULL DEFAULT '[]',
        defaults text NOT NULL DEFAULT '{}',
        roadmap_source text,
        created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.run(sql`
      CREATE TABLE IF NOT EXISTS agent_run (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'queued',
        stage text,
        request text NOT NULL DEFAULT '{}',
        workspace_kind text,
        workspace_path text NOT NULL,
        base_ref text NOT NULL,
        branch text,
        correction_round integer NOT NULL DEFAULT 0,
        outcome text,
        runner_epoch text,
        created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ended_at text
      )
    `);
    db.run(sql`
      CREATE TABLE IF NOT EXISTS agent_run_event (
        run_id text NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
        seq integer NOT NULL,
        ts text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        stage text,
        agent text NOT NULL,
        kind text NOT NULL,
        payload text NOT NULL DEFAULT '{}',
        PRIMARY KEY (run_id, seq)
      )
    `);
    db.run(sql`
      CREATE TABLE IF NOT EXISTS agent_run_intent (
        id text PRIMARY KEY NOT NULL,
        run_id text NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
        kind text NOT NULL,
        payload text NOT NULL DEFAULT '{}',
        created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        claimed_at text
      )
    `);
    db.run(sql`
      CREATE TABLE IF NOT EXISTS agent_workspace_lock (
        lock_key text PRIMARY KEY NOT NULL,
        run_id text NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
        created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
  }
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

describe("agent tables and event log (AW1-03)", () => {
  it("first seq is 1", async () => {
    const projectId = "prj-first-seq";
    const runId = "run-first-seq";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    const event = await appendEvent(db, {
      runId,
      agent: "system",
      kind: "stage_started",
      payload: { stage: "inspect" },
    });

    assert.equal(event.seq, 1);
    assert.equal(event.runId, runId);
    assert.equal(event.agent, "system");
    assert.equal(event.kind, "stage_started");
    assert.deepEqual(event.payload, { stage: "inspect" });
    assert.equal(typeof event.ts, "string");
    assert.equal(await lastSeq(db, runId), 1);
  });

  it("50 appends are gapless 1..50", async () => {
    const projectId = "prj-50-gapless";
    const runId = "run-50-gapless";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    for (let i = 1; i <= 50; i++) {
      const event = await appendEvent(db, {
        runId,
        agent: "implementer",
        kind: "output",
        payload: { index: i, text: `Chunk ${i}` },
      });
      assert.equal(event.seq, i);
    }

    assert.equal(await lastSeq(db, runId), 50);

    const events = await readSince(db, runId, 0, 100);
    assert.equal(events.length, 50);
    for (let i = 0; i < 50; i++) {
      assert.equal(events[i]!.seq, i + 1);
      assert.deepEqual(events[i]!.payload, { index: i + 1, text: `Chunk ${i + 1}` });
    }
  });

  it("two runs have independent sequences", async () => {
    const projectId = "prj-indep";
    const run1 = "run-indep-1";
    const run2 = "run-indep-2";
    await createTestProject(projectId);
    await createTestRun(run1, projectId);
    await createTestRun(run2, projectId);

    const e1_1 = await appendEvent(db, {
      runId: run1,
      agent: "planner",
      kind: "stage_started",
      payload: "p1",
    });
    assert.equal(e1_1.seq, 1);

    const e2_1 = await appendEvent(db, {
      runId: run2,
      agent: "reviewer",
      kind: "stage_started",
      payload: "p2",
    });
    assert.equal(e2_1.seq, 1);

    const e1_2 = await appendEvent(db, {
      runId: run1,
      agent: "planner",
      kind: "output",
      payload: "p3",
    });
    assert.equal(e1_2.seq, 2);

    const e2_2 = await appendEvent(db, {
      runId: run2,
      agent: "reviewer",
      kind: "output",
      payload: "p4",
    });
    assert.equal(e2_2.seq, 2);

    assert.equal(await lastSeq(db, run1), 2);
    assert.equal(await lastSeq(db, run2), 2);

    const run1Events = await readSince(db, run1, 0, 10);
    const run2Events = await readSince(db, run2, 0, 10);
    assert.deepEqual(run1Events.map((e) => e.seq), [1, 2]);
    assert.deepEqual(run2Events.map((e) => e.seq), [1, 2]);
  });

  it("readSince returns only seq > n, in order, respecting limit and clamping", async () => {
    const projectId = "prj-read-since";
    const runId = "run-read-since";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    for (let i = 1; i <= 20; i++) {
      await appendEvent(db, {
        runId,
        agent: "implementer",
        kind: "output",
        payload: { n: i },
      });
    }

    // seq > 10, limit 5 -> [11, 12, 13, 14, 15]
    const slice = await readSince(db, runId, 10, 5);
    assert.equal(slice.length, 5);
    assert.deepEqual(slice.map((e) => e.seq), [11, 12, 13, 14, 15]);

    // seq > 18, limit 10 -> [19, 20]
    const tail = await readSince(db, runId, 18, 10);
    assert.equal(tail.length, 2);
    assert.deepEqual(tail.map((e) => e.seq), [19, 20]);

    // Clamping: limit < 1 clamps to 1
    const clampedMin = await readSince(db, runId, 0, 0);
    assert.equal(clampedMin.length, 1);
    assert.equal(clampedMin[0]!.seq, 1);

    const clampedNegative = await readSince(db, runId, 0, -10);
    assert.equal(clampedNegative.length, 1);
    assert.equal(clampedNegative[0]!.seq, 1);

    // Clamping: limit > 1000 clamps to 1000 (tested by verifying all 20 are returned)
    const clampedMax = await readSince(db, runId, 0, 5000);
    assert.equal(clampedMax.length, 20);
  });

  it("a payload containing a GitHub token is stored redacted", async () => {
    const projectId = "prj-redact";
    const runId = "run-redact";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    const rawToken = "ghp_12345678901234567890abcdefghijkl";
    const event = await appendEvent(db, {
      runId,
      agent: "implementer",
      kind: "output",
      payload: {
        message: `Cloning using token ${rawToken}`,
        env: { GITHUB_TOKEN: rawToken },
      },
    });

    const parsed = event.payload as { message: string; env: { GITHUB_TOKEN: string } };
    assert.ok(!JSON.stringify(parsed).includes(rawToken), "Returned payload must not leak secret token");
    assert.ok(parsed.message.includes(REDACTED), "Token in string must be replaced by REDACTED");
    assert.equal(parsed.env.GITHUB_TOKEN, REDACTED, "Secret key value must be REDACTED");

    // Verify what was stored in the database row directly
    const rawRows = db
      .select()
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, runId))
      .all();
    assert.equal(rawRows.length, 1);
    assert.ok(!rawRows[0]!.payload.includes(rawToken), "Stored payload must not contain secret token");
    assert.ok(rawRows[0]!.payload.includes(REDACTED));
  });

  it("a payload over 16 KB is stored as the truncated form and is itself under the limit", async () => {
    const projectId = "prj-truncated";
    const runId = "run-truncated";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    const bigText = "X".repeat(25 * 1024); // 25 KB
    const event = await appendEvent(db, {
      runId,
      agent: "checks",
      kind: "check_result",
      payload: {
        check: "test:unit",
        output: bigText,
      },
    });

    const payload = event.payload as {
      truncated: boolean;
      bytes: number;
      preview: string;
    };
    assert.equal(payload.truncated, true);
    assert.ok(payload.bytes > MAX_EVENT_PAYLOAD_BYTES);
    assert.ok(payload.preview.length <= 2000);

    // Verify stored payload in the database
    const rawRow = db
      .select()
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, runId))
      .get();
    assert.ok(rawRow);
    const rawBytes = Buffer.byteLength(rawRow.payload, "utf8");
    assert.ok(
      rawBytes < MAX_EVENT_PAYLOAD_BYTES,
      `Stored truncated JSON (${rawBytes} bytes) must be well under ${MAX_EVENT_PAYLOAD_BYTES}`,
    );

    const readBack = await readSince(db, runId, 0, 10);
    assert.equal(readBack.length, 1);
    assert.deepEqual(readBack[0]!.payload, payload);
  });

  it("unknown agent/kind throws and inserts nothing", async () => {
    const projectId = "prj-validation";
    const runId = "run-validation";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    assert.equal(await lastSeq(db, runId), 0);

    // Unknown agent
    await assert.rejects(
      async () => {
        await appendEvent(db, {
          runId,
          agent: "hacker" as any,
          kind: "output",
          payload: "test",
        });
      },
      { message: /Invalid event agent/ },
    );

    // Unknown kind
    await assert.rejects(
      async () => {
        await appendEvent(db, {
          runId,
          agent: "implementer",
          kind: "hack_everything" as any,
          payload: "test",
        });
      },
      { message: /Invalid event kind/ },
    );

    // Verify nothing was inserted
    assert.equal(await lastSeq(db, runId), 0);
    const rows = await readSince(db, runId, 0, 10);
    assert.equal(rows.length, 0);
  });

  it("deleting a run cascades its events", async () => {
    const projectId = "prj-cascade";
    const runId = "run-cascade";
    await createTestProject(projectId);
    await createTestRun(runId, projectId);

    await appendEvent(db, { runId, agent: "system", kind: "stage_started", payload: 1 });
    await appendEvent(db, { runId, agent: "system", kind: "stage_finished", payload: 2 });
    assert.equal(await lastSeq(db, runId), 2);

    // Delete the run
    await db.delete(agentRuns).where(eq(agentRuns.id, runId));

    // Events must be deleted via cascade
    const eventsAfter = db
      .select()
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, runId))
      .all();
    assert.equal(eventsAfter.length, 0);
    assert.equal(await lastSeq(db, runId), 0);
  });
});
