/**
 * AW4-05: runs tied to tasks.
 * Create with/without/invalid taskId, next-task endpoint, outcome posted to the
 * task's activity once per run, and the task itself never changing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentRuns, projects, taskActivityEvents, taskDependencies, tasks } from "../../src/db/schema";

let db: typeof import("../../src/db/client").db;
let runsRoute: typeof import("../../src/app/api/agent-runs/route");
let runByIdRoute: typeof import("../../src/app/api/agent-runs/[id]/route");
let nextTaskRoute: typeof import("../../src/app/api/agent-projects/[id]/next-task/route");
let link: typeof import("../../src/core/agents/task-link");

const originalEnv = {
  DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
  DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/agent-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function runBody(projectId: string, extra: Record<string, unknown> = {}) {
  return { projectId, task: "Do it", roles: { implementer: { provider: "claude" } }, ...extra };
}

function taskRow(id: string, projectId: string, extra: Partial<typeof tasks.$inferInsert> = {}) {
  return { id, projectId, title: `Title ${id}`, ...extra };
}

before(async () => {
  process.env.DASHBOARD_LOCAL = "1";
  process.env.DESKTOP_INTERNAL_SECRET = "secret-for-test";
  await migrate();
  ({ db } = await import("../../src/db/client"));
  runsRoute = await import("../../src/app/api/agent-runs/route");
  runByIdRoute = await import("../../src/app/api/agent-runs/[id]/route");
  nextTaskRoute = await import("../../src/app/api/agent-projects/[id]/next-task/route");
  link = await import("../../src/core/agents/task-link");

  db.insert(projects).values({ id: "p1", name: "P1", localPath: "H:/repos/p1" }).run();
  db.insert(projects).values({ id: "p2", name: "P2", localPath: "H:/repos/p2" }).run();
  db.insert(projects).values({ id: "p3", name: "P3 empty", localPath: "H:/repos/p3" }).run();
  db.insert(tasks).values(taskRow("t1", "p1", { priority: "high" })).run();
  db.insert(tasks).values(taskRow("t2", "p1", { priority: "low" })).run();
  db.insert(tasks).values(taskRow("other", "p2")).run();
});

after(async () => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanup();
});

describe("create run with taskId", () => {
  it("stores taskId and returns it from GET", async () => {
    const res = await runsRoute.POST(post(runBody("p1", { taskId: "t1" })));
    assert.equal(res.status, 201);
    const { run } = (await res.json()) as { run: { id: string; taskId: string | null } };
    assert.equal(run.taskId, "t1");
    const get = await runByIdRoute.GET(new NextRequest(`http://localhost/api/agent-runs/${run.id}`), {
      params: Promise.resolve({ id: run.id }),
    });
    const body = (await get.json()) as { run: { taskId: string | null } };
    assert.equal(body.run.taskId, "t1");
  });

  it("works without a taskId (null)", async () => {
    const res = await runsRoute.POST(post(runBody("p1")));
    assert.equal(res.status, 201);
    const { run } = (await res.json()) as { run: { taskId: string | null } };
    assert.equal(run.taskId, null);
  });

  it("rejects an unknown task, another project's task and an empty id with 400, creating nothing", async () => {
    const count = db.select().from(agentRuns).all().length;
    const missing = await runsRoute.POST(post(runBody("p1", { taskId: "nope" })));
    assert.equal(missing.status, 400);
    const foreign = await runsRoute.POST(post(runBody("p1", { taskId: "other" })));
    assert.equal(foreign.status, 400);
    const empty = await runsRoute.POST(post(runBody("p1", { taskId: "" })));
    assert.equal(empty.status, 400);
    assert.equal(db.select().from(agentRuns).all().length, count);
  });
});

describe("next-task endpoint", () => {
  const call = (id: string) =>
    nextTaskRoute.GET(new NextRequest(`http://localhost/api/agent-projects/${id}/next-task`), {
      params: Promise.resolve({ id }),
    });

  it("returns the eligible task, skipping one with an active run", async () => {
    const first = (await (await call("p1")).json()) as { task: { id: string; title: string } | null };
    // t1 already has a queued run from the create test, so t2 is next.
    assert.deepEqual(first.task, { id: "t2", title: "Title t2" });
  });

  it("returns null with a reason when nothing is eligible", async () => {
    const empty = (await (await call("p3")).json()) as { task: null; reason: string };
    assert.equal(empty.task, null);
    assert.match(empty.reason, /no tasks/i);

    db.insert(taskDependencies).values({ taskId: "t2", dependsOnTaskId: "t1" }).run();
    const blocked = (await (await call("p1")).json()) as { task: null; reason: string };
    assert.equal(blocked.task, null);
    assert.match(blocked.reason, /No task is ready/);
    db.delete(taskDependencies).run();
  });

  it("404s for an unknown project", async () => {
    assert.equal((await call("zzz")).status, 404);
  });
});

describe("outcome posted to task activity", () => {
  async function makeRun(taskId: string | null): Promise<string> {
    const res = await runsRoute.POST(post(runBody("p1", taskId ? { taskId } : {})));
    return ((await res.json()) as { run: { id: string } }).run.id;
  }
  const events = (taskId: string, runId: string) =>
    db
      .select()
      .from(taskActivityEvents)
      .where(eq(taskActivityEvents.taskId, taskId))
      .all()
      .filter((e) => e.type === link.AGENT_RUN_ACTIVITY_TYPE && JSON.parse(e.details).runId === runId);

  for (const status of ["succeeded", "failed", "stopped"] as const) {
    it(`appends one event for ${status} and is idempotent`, async () => {
      db.insert(tasks).values(taskRow(`task_${status}`, "p1")).run();
      const runId = await makeRun(`task_${status}`);
      const outcome = {
        status,
        facts: {
          checks: [
            { name: "lint", exitCode: 0, timedOut: false },
            { name: "test", exitCode: 1, timedOut: false },
          ],
          reviewVerdict: "approve",
        },
        missing: [],
      };
      db.update(agentRuns).set({ status, outcome: JSON.stringify(outcome) }).where(eq(agentRuns.id, runId)).run();

      assert.equal(link.postRunOutcomeToTask(db, runId), true);
      assert.equal(link.postRunOutcomeToTask(db, runId), false);
      const written = events(`task_${status}`, runId);
      assert.equal(written.length, 1);
      const details = JSON.parse(written[0]!.details);
      assert.equal(details.status, status);
      assert.equal(details.link, `/agents/runs/${runId}`);
      assert.equal(details.checksPassed, 1);
      assert.equal(details.checksFailed, 1);
      assert.equal(details.verdict, "approve");
    });
  }

  it("skips non-final runs and runs without a task, and never changes the task", async () => {
    db.insert(tasks).values(taskRow("keep", "p1", { status: "todo" })).run();
    const snapshot = db.select().from(tasks).where(eq(tasks.id, "keep")).get();

    const active = await makeRun("keep");
    assert.equal(link.postRunOutcomeToTask(db, active), false);

    const none = await makeRun(null);
    db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, none)).run();
    assert.equal(link.postRunOutcomeToTask(db, none), false);

    db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, active)).run();
    assert.equal(link.postRunOutcomeToTask(db, active), true);

    const current = db.select().from(tasks).where(eq(tasks.id, "keep")).get();
    assert.deepEqual(current, snapshot);
    assert.equal(current!.status, "todo");
  });

  it("deleting a task leaves its runs with task_id null", async () => {
    db.insert(tasks).values(taskRow("gone", "p1")).run();
    const runId = await makeRun("gone");
    db.delete(tasks).where(eq(tasks.id, "gone")).run();
    const row = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    assert.equal(row?.taskId, null);
  });
});
