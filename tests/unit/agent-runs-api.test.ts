/**
 * Unit tests for agent runs API routes and live event stream (Release AW.1, AW1-11).
 *
 * Covers:
 * 1. Desktop availability gate (returns 404 with empty body when disabled).
 * 2. POST /api/agent-runs validation (Zod validation, project existence, local path requirement).
 * 3. Run and start intent atomic creation.
 * 4. GET /api/agent-runs and GET /api/agent-runs/:id.
 * 5. POST /api/agent-runs/:id/stop (202 for active, 409 for terminal, no process spawning).
 * 6. GET /api/agent-runs/:id/events (SSE replay, bad header handling, live events, terminal end, abort).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { projects, agentRuns, agentRunIntents, agentRunEvents } from "../../src/db/schema";
import { appendEvent } from "../../src/core/agents/events";

let db: typeof import("../../src/db/client").db;
let agentRunsRoute: typeof import("../../src/app/api/agent-runs/route");
let agentRunByIdRoute: typeof import("../../src/app/api/agent-runs/[id]/route");
let agentRunStopRoute: typeof import("../../src/app/api/agent-runs/[id]/stop/route");
let agentRunEventsRoute: typeof import("../../src/app/api/agent-runs/[id]/events/route");

const originalEnv = {
  DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
  DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
  AUTH_MODE: process.env.AUTH_MODE,
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  DATABASE_URL: process.env.DATABASE_URL,
  AGENT_RUN_EVENTS_POLL_MS: process.env.AGENT_RUN_EVENTS_POLL_MS,
  AGENT_RUN_EVENTS_KEEP_ALIVE_MS: process.env.AGENT_RUN_EVENTS_KEEP_ALIVE_MS,
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

async function collectStreamEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { stopOnEnd?: boolean; timeoutMs?: number } = {},
): Promise<{ raw: string; events: Array<{ id?: string; event?: string; data?: string }> }> {
  const decoder = new TextDecoder();
  let raw = "";
  const timeoutMs = options.timeoutMs ?? 2500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(50, deadline - Date.now());
    const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
      setTimeout(() => resolve({ value: undefined, done: true }), remaining),
    );
    const result = await Promise.race([reader.read(), timeoutPromise]);
    if (result.done) break;
    if (result.value) {
      raw += decoder.decode(result.value, { stream: true });
      if (options.stopOnEnd && raw.includes("event: end")) {
        break;
      }
    }
  }

  const frames = raw.split("\n\n").filter((f) => f.trim().length > 0);
  const parsedEvents = frames.map((frame) => {
    const lines = frame.split("\n");
    const ev: { id?: string; event?: string; data?: string } = {};
    for (const line of lines) {
      if (line.startsWith("id: ")) ev.id = line.slice(4).trim();
      else if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
      else if (line.startsWith("data: ")) ev.data = line.slice(6).trim();
    }
    return ev;
  });

  return { raw, events: parsedEvents };
}

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));

  // Ensure tables exist in case test is executed in an isolated test environment
  const tables = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run'`,
  );
  if (tables.length === 0) {
    db.run(sql`
      CREATE TABLE IF NOT EXISTS agent_run (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'queued',
        stage text,
        request text NOT NULL DEFAULT '{}',
        workspace_kind text,
        workspace_path text,
        base_ref text,
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
  }

  agentRunsRoute = await import("../../src/app/api/agent-runs/route");
  agentRunByIdRoute = await import("../../src/app/api/agent-runs/[id]/route");
  agentRunStopRoute = await import("../../src/app/api/agent-runs/[id]/stop/route");
  agentRunEventsRoute = await import("../../src/app/api/agent-runs/[id]/events/route");
});

after(() => {
  // Restore process.env cleanly
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  cleanup();
});

describe("agent-runs API routes (Release AW.1, AW1-11)", () => {
  describe("desktop environment gate", () => {
    it("returns 404 with empty body for every route when desktop env is off, inserting nothing", async () => {
      delete process.env.DASHBOARD_LOCAL;
      delete process.env.DESKTOP_INTERNAL_SECRET;

      const runsBefore = db.select().from(agentRuns).all();
      const intentsBefore = db.select().from(agentRunIntents).all();

      const getListRes = await agentRunsRoute.GET(
        new NextRequest("http://localhost/api/agent-runs"),
      );
      assert.equal(getListRes.status, 404);
      assert.equal(await getListRes.text(), "");

      const postRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId: "p1",
          task: "Task",
          roles: { implementer: { provider: "claude" } },
        }),
      );
      assert.equal(postRes.status, 404);
      assert.equal(await postRes.text(), "");

      const getOneRes = await agentRunByIdRoute.GET(
        new NextRequest("http://localhost/api/agent-runs/run_fake"),
        { params: Promise.resolve({ id: "run_fake" }) },
      );
      assert.equal(getOneRes.status, 404);
      assert.equal(await getOneRes.text(), "");

      const stopRes = await agentRunStopRoute.POST(
        jsonRequest("http://localhost/api/agent-runs/run_fake/stop", "POST"),
        { params: Promise.resolve({ id: "run_fake" }) },
      );
      assert.equal(stopRes.status, 404);
      assert.equal(await stopRes.text(), "");

      const eventsRes = await agentRunEventsRoute.GET(
        new NextRequest("http://localhost/api/agent-runs/run_fake/events"),
        { params: Promise.resolve({ id: "run_fake" }) },
      );
      assert.equal(eventsRes.status, 404);
      assert.equal(await eventsRes.text(), "");

      const runsAfter = db.select().from(agentRuns).all();
      const intentsAfter = db.select().from(agentRunIntents).all();
      assert.equal(runsAfter.length, runsBefore.length);
      assert.equal(intentsAfter.length, intentsBefore.length);
    });
  });

  describe("active desktop mode routes", () => {
    before(() => {
      process.env.DASHBOARD_LOCAL = "1";
      process.env.DESKTOP_INTERNAL_SECRET = "secret-for-test";
      delete process.env.AUTH_MODE;
      delete process.env.DASHBOARD_PASSWORD;
      delete process.env.DATABASE_URL;
      process.env.AGENT_RUN_EVENTS_POLL_MS = "50";
    });

    it("POST /api/agent-runs validates request body", async () => {
      // Invalid JSON syntax
      const malformedReq = new NextRequest("http://localhost/api/agent-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{malformed-json",
      });
      const malformedRes = await agentRunsRoute.POST(malformedReq);
      assert.equal(malformedRes.status, 400);
      const malformedData = await malformedRes.json();
      assert.match(malformedData.error, /invalid json body/i);

      // Missing task
      const missingTaskRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId: "p1",
          roles: { implementer: { provider: "claude" } },
        }),
      );
      assert.equal(missingTaskRes.status, 400);

      // Missing roles implementer
      const missingRoleRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId: "p1",
          task: "Fix something",
          roles: {},
        }),
      );
      assert.equal(missingRoleRes.status, 400);

      // Invalid check name with slashes or spaces
      const invalidCheckRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId: "p1",
          task: "Fix something",
          roles: { implementer: { provider: "claude" } },
          checks: ["bad/check name"],
        }),
      );
      assert.equal(invalidCheckRes.status, 400);
    });

    it("POST /api/agent-runs: unknown project -> 404, project without local path -> 409", async () => {
      // Project does not exist
      const notFoundRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId: "prj_does_not_exist",
          task: "A valid task",
          roles: { implementer: { provider: "claude" } },
        }),
      );
      assert.equal(notFoundRes.status, 404);
      const notFoundData = await notFoundRes.json();
      assert.match(notFoundData.error, /project not found/i);

      // Project exists but has no local path
      await db.insert(projects).values({
        id: "prj_without_local_path",
        name: "Remote Only Project",
        localPath: null,
      });

      const noLocalPathRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId: "prj_without_local_path",
          task: "A valid task",
          roles: { implementer: { provider: "claude" } },
        }),
      );
      assert.equal(noLocalPathRes.status, 409);
      const noLocalPathData = await noLocalPathRes.json();
      assert.match(noLocalPathData.error, /project has no local folder/i);
    });

    it("POST /api/agent-runs creates run and start intent atomically in same transaction", async () => {
      const projectId = "prj_valid_local";
      const localPath = "H:/LocalRepos/demo";
      await db.insert(projects).values({
        id: projectId,
        name: "Local Repo Project",
        localPath,
      });

      const res = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId,
          task: "Build the auth system",
          roles: {
            implementer: { provider: "claude-code", model: "sonnet" },
          },
          checks: ["lint", "typecheck"],
        }),
      );

      assert.equal(res.status, 201);
      const { run } = await res.json();

      assert.ok(run.id);
      assert.equal(run.projectId, projectId);
      assert.equal(run.status, "queued");
      assert.equal(run.request.task, "Build the auth system");
      assert.deepEqual(run.request.checks, ["lint", "typecheck"]);

      // Verify DB row in agent_run
      const dbRun = db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get();
      assert.ok(dbRun);
      assert.equal(dbRun.status, "queued");

      // Verify DB row in agent_run_intent
      const intents = db
        .select()
        .from(agentRunIntents)
        .where(eq(agentRunIntents.runId, run.id))
        .all();
      assert.equal(intents.length, 1);
      assert.equal(intents[0]!.kind, "start");
      assert.deepEqual(JSON.parse(intents[0]!.payload), { projectLocalPath: localPath });
    });

    it("GET /api/agent-runs/:id and GET /api/agent-runs with filtering and limit clamping", async () => {
      // Non-existent run
      const notFoundRes = await agentRunByIdRoute.GET(
        new NextRequest("http://localhost/api/agent-runs/non_existent_id"),
        { params: Promise.resolve({ id: "non_existent_id" }) },
      );
      assert.equal(notFoundRes.status, 404);

      // Create a second project with runs
      const otherProjectId = "prj_other_filter";
      await db.insert(projects).values({
        id: otherProjectId,
        name: "Other Project",
        localPath: "H:/Other/Path",
      });

      const createRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId: otherProjectId,
          task: "Second task",
          roles: { implementer: { provider: "fake" } },
        }),
      );
      const { run: createdRun } = await createRes.json();

      // Read single run
      const singleRes = await agentRunByIdRoute.GET(
        new NextRequest(`http://localhost/api/agent-runs/${createdRun.id}`),
        { params: Promise.resolve({ id: createdRun.id }) },
      );
      assert.equal(singleRes.status, 200);
      const singleData = await singleRes.json();
      assert.equal(singleData.run.id, createdRun.id);
      assert.equal(singleData.run.request.task, "Second task");
      assert.equal(singleData.run.outcome, null);

      // Filter by projectId
      const filteredRes = await agentRunsRoute.GET(
        new NextRequest(`http://localhost/api/agent-runs?projectId=${otherProjectId}`),
      );
      assert.equal(filteredRes.status, 200);
      const filteredData = await filteredRes.json();
      assert.ok(filteredData.runs.length >= 1);
      assert.ok(filteredData.runs.every((r: { projectId: string }) => r.projectId === otherProjectId));

      // Limit clamp check (limit=1, limit=0 clamps to 1)
      const limit1Res = await agentRunsRoute.GET(
        new NextRequest("http://localhost/api/agent-runs?limit=1"),
      );
      const limit1Data = await limit1Res.json();
      assert.equal(limit1Data.runs.length, 1);

      const limit0Res = await agentRunsRoute.GET(
        new NextRequest("http://localhost/api/agent-runs?limit=0"),
      );
      const limit0Data = await limit0Res.json();
      assert.equal(limit0Data.runs.length, 1);
    });

    it("POST /api/agent-runs/:id/stop creates stop intent, rejects terminal runs, and never imports process.ts", async () => {
      const projectId = "prj_stop_test";
      await db.insert(projects).values({
        id: projectId,
        name: "Stop Test Project",
        localPath: "H:/Stop/Path",
      });

      const createRes = await agentRunsRoute.POST(
        jsonRequest("http://localhost/api/agent-runs", "POST", {
          projectId,
          task: "Task to stop",
          roles: { implementer: { provider: "fake" } },
        }),
      );
      const { run } = await createRes.json();

      // Stop non-existent run -> 404
      const stop404Res = await agentRunStopRoute.POST(
        jsonRequest("http://localhost/api/agent-runs/not_there/stop", "POST"),
        { params: Promise.resolve({ id: "not_there" }) },
      );
      assert.equal(stop404Res.status, 404);

      // Stop active run -> 202
      const stopRes = await agentRunStopRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${run.id}/stop`, "POST"),
        { params: Promise.resolve({ id: run.id }) },
      );
      assert.equal(stopRes.status, 202);
      assert.deepEqual(await stopRes.json(), { ok: true });

      // Verify stop intent was recorded in database
      const stopIntents = db
        .select()
        .from(agentRunIntents)
        .where(
          and(
            eq(agentRunIntents.runId, run.id),
            eq(agentRunIntents.kind, "stop"),
          ),
        )
        .all();
      assert.equal(stopIntents.length, 1);

      // Stop already terminal run -> 409
      db.update(agentRuns)
        .set({ status: "stopped" })
        .where(eq(agentRuns.id, run.id))
        .run();

      const stopTerminalRes = await agentRunStopRoute.POST(
        jsonRequest(`http://localhost/api/agent-runs/${run.id}/stop`, "POST"),
        { params: Promise.resolve({ id: run.id }) },
      );
      assert.equal(stopTerminalRes.status, 409);

      // Verify that process.ts was never imported
      const processModules = Object.keys(require.cache).filter(
        (key) => key.includes("core/agents/process") || key.includes("core\\agents\\process"),
      );
      assert.equal(processModules.length, 0);
    });

    describe("GET /api/agent-runs/:id/events (SSE stream)", () => {
      it("returns 404 if the run does not exist", async () => {
        const res = await agentRunEventsRoute.GET(
          new NextRequest("http://localhost/api/agent-runs/no_run/events"),
          { params: Promise.resolve({ id: "no_run" }) },
        );
        assert.equal(res.status, 404);
      });

      it("replays events after Last-Event-ID header and sends end when terminal", async () => {
        const projectId = "prj_sse_replay";
        await db.insert(projects).values({
          id: projectId,
          name: "SSE Project",
          localPath: "H:/SSE/Path",
        });

        const createRes = await agentRunsRoute.POST(
          jsonRequest("http://localhost/api/agent-runs", "POST", {
            projectId,
            task: "Replay task",
            roles: { implementer: { provider: "fake" } },
          }),
        );
        const { run } = await createRes.json();

        // Append 3 events
        await appendEvent(db, {
          runId: run.id,
          agent: "system",
          kind: "stage_started",
          payload: { stage: "inspect" },
        });
        await appendEvent(db, {
          runId: run.id,
          agent: "planner",
          kind: "output",
          payload: { text: "Thinking..." },
        });
        await appendEvent(db, {
          runId: run.id,
          agent: "planner",
          kind: "stage_finished",
          payload: { stage: "plan" },
        });

        // Set run terminal
        db.update(agentRuns)
          .set({ status: "succeeded" })
          .where(eq(agentRuns.id, run.id))
          .run();

        // Request with Last-Event-ID: 1 -> should replay seq 2 and 3, then end
        const req = new NextRequest(`http://localhost/api/agent-runs/${run.id}/events`, {
          headers: { "Last-Event-ID": "1" },
        });
        const res = await agentRunEventsRoute.GET(req, {
          params: Promise.resolve({ id: run.id }),
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get("Content-Type"), "text/event-stream");
        assert.equal(res.headers.get("Cache-Control"), "no-cache");
        assert.equal(res.headers.get("X-Accel-Buffering"), "no");

        const reader = res.body!.getReader();
        const { raw, events } = await collectStreamEvents(reader, { stopOnEnd: true });

        // Event 1 must not be present; event 2 and 3 must be present
        assert.ok(!events.some((e) => e.id === "1"), "Event 1 should be skipped");
        assert.ok(events.some((e) => e.id === "2"), "Event 2 should be received");
        assert.ok(events.some((e) => e.id === "3"), "Event 3 should be received");
        assert.ok(raw.includes("event: end"), "End event must be received for terminal run");
      });

      it("ignores a bad Last-Event-ID header and replays from seq 0", async () => {
        const projectId = "prj_sse_bad_hdr";
        await db.insert(projects).values({
          id: projectId,
          name: "SSE Bad Header Project",
          localPath: "H:/SSE/BadHdr",
        });

        const createRes = await agentRunsRoute.POST(
          jsonRequest("http://localhost/api/agent-runs", "POST", {
            projectId,
            task: "Bad header task",
            roles: { implementer: { provider: "fake" } },
          }),
        );
        const { run } = await createRes.json();

        await appendEvent(db, {
          runId: run.id,
          agent: "system",
          kind: "stage_started",
          payload: { stage: "inspect" },
        });

        db.update(agentRuns)
          .set({ status: "succeeded" })
          .where(eq(agentRuns.id, run.id))
          .run();

        const req = new NextRequest(`http://localhost/api/agent-runs/${run.id}/events`, {
          headers: { "Last-Event-ID": "not-a-valid-number" },
        });
        const res = await agentRunEventsRoute.GET(req, {
          params: Promise.resolve({ id: run.id }),
        });

        const reader = res.body!.getReader();
        const { events } = await collectStreamEvents(reader, { stopOnEnd: true });

        assert.ok(events.some((e) => e.id === "1"), "Event 1 should be replayed when header is bad");
      });

      it("supports ?after= parameter", async () => {
        const projectId = "prj_sse_after";
        await db.insert(projects).values({
          id: projectId,
          name: "SSE After Project",
          localPath: "H:/SSE/After",
        });

        const createRes = await agentRunsRoute.POST(
          jsonRequest("http://localhost/api/agent-runs", "POST", {
            projectId,
            task: "After param task",
            roles: { implementer: { provider: "fake" } },
          }),
        );
        const { run } = await createRes.json();

        await appendEvent(db, {
          runId: run.id,
          agent: "system",
          kind: "stage_started",
          payload: { stage: "inspect" },
        });
        await appendEvent(db, {
          runId: run.id,
          agent: "planner",
          kind: "output",
          payload: { text: "Seq 2" },
        });

        db.update(agentRuns)
          .set({ status: "succeeded" })
          .where(eq(agentRuns.id, run.id))
          .run();

        const req = new NextRequest(`http://localhost/api/agent-runs/${run.id}/events?after=1`);
        const res = await agentRunEventsRoute.GET(req, {
          params: Promise.resolve({ id: run.id }),
        });

        const reader = res.body!.getReader();
        const { events } = await collectStreamEvents(reader, { stopOnEnd: true });

        assert.ok(!events.some((e) => e.id === "1"), "Event 1 should be skipped");
        assert.ok(events.some((e) => e.id === "2"), "Event 2 should be received");
      });

      it("delivers events appended after the stream opened and ends once terminal", async () => {
        const projectId = "prj_sse_live";
        await db.insert(projects).values({
          id: projectId,
          name: "SSE Live Project",
          localPath: "H:/SSE/Live",
        });

        const createRes = await agentRunsRoute.POST(
          jsonRequest("http://localhost/api/agent-runs", "POST", {
            projectId,
            task: "Live task",
            roles: { implementer: { provider: "fake" } },
          }),
        );
        const { run } = await createRes.json();

        // Mark run as active (implementing)
        db.update(agentRuns)
          .set({ status: "implementing" })
          .where(eq(agentRuns.id, run.id))
          .run();

        // Append initial event 1
        await appendEvent(db, {
          runId: run.id,
          agent: "system",
          kind: "stage_started",
          payload: { stage: "implement" },
        });

        const req = new NextRequest(`http://localhost/api/agent-runs/${run.id}/events?after=0`);
        const res = await agentRunEventsRoute.GET(req, {
          params: Promise.resolve({ id: run.id }),
        });

        const reader = res.body!.getReader();

        // Append an event while stream is open, then conclude the run
        setTimeout(async () => {
          await appendEvent(db, {
            runId: run.id,
            agent: "implementer",
            kind: "output",
            payload: { text: "Appended live" },
          });
          db.update(agentRuns)
            .set({ status: "succeeded" })
            .where(eq(agentRuns.id, run.id))
            .run();
        }, 100);

        const { raw, events } = await collectStreamEvents(reader, { stopOnEnd: true });

        assert.ok(events.some((e) => e.id === "1"), "Event 1 should be received");
        assert.ok(events.some((e) => e.id === "2"), "Live Event 2 should be received");
        assert.ok(raw.includes("event: end"), "End event should be received once terminal");
      });

      it("stops polling and closes when abort signal fires", async () => {
        const projectId = "prj_sse_abort";
        await db.insert(projects).values({
          id: projectId,
          name: "SSE Abort Project",
          localPath: "H:/SSE/Abort",
        });

        const createRes = await agentRunsRoute.POST(
          jsonRequest("http://localhost/api/agent-runs", "POST", {
            projectId,
            task: "Abort task",
            roles: { implementer: { provider: "fake" } },
          }),
        );
        const { run } = await createRes.json();

        db.update(agentRuns)
          .set({ status: "implementing" })
          .where(eq(agentRuns.id, run.id))
          .run();

        const ac = new AbortController();
        const req = new NextRequest(`http://localhost/api/agent-runs/${run.id}/events`, {
          signal: ac.signal,
        });

        const res = await agentRunEventsRoute.GET(req, {
          params: Promise.resolve({ id: run.id }),
        });

        const reader = res.body!.getReader();

        // Abort after 80ms
        setTimeout(() => {
          ac.abort();
        }, 80);

        const startTime = Date.now();
        const result = await reader.read();
        const elapsed = Date.now() - startTime;

        // When aborted, the stream closes promptly
        assert.ok(elapsed < 2000, `Stream should close promptly on abort (took ${elapsed}ms)`);
        assert.ok(result.done === true || ac.signal.aborted);
      });
    });
  });
});
