/**
 * Release 2D.2 timeline — desktop (SQLite), through the real route.
 *
 * 1. Parity: the shared fixture (tests/helpers/timeline-fixtures.ts) yields
 *    exactly what the PostgreSQL suite asserts; `blocked` equals the task
 *    repository's own value for every task.
 * 2. Windows: week / month / quarter, and the supported calendar's ends.
 * 3. Strict validation, generic 404 for unknown ids, no-store, read-only, no
 *    assignee or private fields on desktop.
 * 4. A large project: independent caps with truthful truncation flags.
 * 5. A pathological graph (a 20,000-dependency hub, a cycle, an unreachable
 *    100,000-edge graph): database rows and statements stay under constants,
 *    blocked stays exact, truncated explanations are marked incomplete, and
 *    the analysis cap refuses instead of guessing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import { FIXTURE_ANCHOR, assertNoForbiddenKeys, assertTimelineParity, seedTimelineFixture } from "../helpers/timeline-fixtures";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import type { TimelineResponse } from "../../src/core/timeline/types";

type Repos = typeof import("../../src/db/repositories");
type Route = typeof import("../../src/app/api/projects/[id]/timeline/route");
let repos: Repos;
let route: Route;
let projectId: string;

before(async () => {
  await migrate();
  repos = await import("../../src/db/repositories");
  route = await import("../../src/app/api/projects/[id]/timeline/route");
  ({ projectId } = await seedTimelineFixture(repos, LOCAL_WORKSPACE_ID));
});

after(() => cleanup());

async function timeline(id: string, query: string) {
  const res = await route.GET(new NextRequest(`http://localhost/api/projects/${id}/timeline?${query}`), {
    params: Promise.resolve({ id }),
  });
  const text = await res.text();
  return { res, text, body: (text ? JSON.parse(text) : null) as TimelineResponse & { error?: string } };
}

describe("desktop timeline: fixture parity", () => {
  it("returns the shared fixture exactly (ordering, blocking paths, conflicts, undated work)", async () => {
    const { res, body, text } = await timeline(projectId, `zoom=quarter&anchor=${FIXTURE_ANCHOR}&tz=UTC`);
    assert.equal(res.status, 200, text);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assertTimelineParity(body);
    assert.equal(body.workspaceId, LOCAL_WORKSPACE_ID);
    assert.deepEqual(body.assignees, [], "desktop has no users");
    assert.ok([...body.items, ...body.undated].every((i) => i.kind !== "task" || i.assigneeId === null));
    assertNoForbiddenKeys(body);
  });

  it("blocked is the task repository's own value for every task (one definition)", async () => {
    const { body } = await timeline(projectId, `zoom=quarter&anchor=${FIXTURE_ANCHOR}`);
    const fromRepo = new Map((await repos.taskRepository.list(LOCAL_WORKSPACE_ID, projectId)).map((t) => [t.id, t.blocked]));
    const tasks = [...body.items, ...body.undated].filter((i) => i.kind === "task");
    assert.equal(tasks.length, 8, "6 dated in the window + 2 undated");
    for (const t of tasks) {
      if (t.kind !== "task") continue;
      assert.equal(t.blocked, fromRepo.get(t.id), t.title);
      // With the edge set complete, "has a blocking root" ⇔ blocked.
      assert.equal(t.blocking.roots.length > 0, t.blocked, `${t.title} roots`);
    }
  });

  it("week and month windows show only their days; blockers outside stay named", async () => {
    const week = (await timeline(projectId, "zoom=week&anchor=2026-11-10")).body;
    assert.deepEqual([week.from, week.to], ["2026-11-09", "2026-11-15"]);
    assert.deepEqual(week.items.map((i) => i.title), ["Build", "API"]);
    const build = week.items[0]!;
    if (build.kind !== "task") throw new Error();
    assert.deepEqual(build.blocking.immediateBlockers.map((id) => week.nodes[id]?.title), ["API"]);
    assert.ok(Object.values(week.nodes).some((n) => n.title === "Vendor contract"), "the transitive root is still named");

    const month = (await timeline(projectId, "zoom=month&anchor=2026-10-15")).body;
    // October 2026 runs Thursday 1st to Saturday 31st, so its grid ends Sunday 1 November.
    assert.deepEqual([month.from, month.to], ["2026-09-28", "2026-11-01"]);
    assert.deepEqual(month.items.map((i) => i.title), ["Kickoff"]);
    assert.equal(month.undated.length, 3, "undated work is listed in every window");
  });

  it("serves the first and last supported windows", async () => {
    const first = await timeline(projectId, "zoom=quarter&anchor=1900-01-01");
    assert.equal(first.res.status, 200);
    assert.deepEqual([first.body.from, first.body.items.length], ["1900-01-01", 0]);
    const last = await timeline(projectId, "zoom=week&anchor=9999-12-31");
    assert.equal(last.res.status, 200);
    assert.equal(last.body.to, "9999-12-31");
  });

  it("computes today in the requested zone", async () => {
    const { body } = await timeline(projectId, `zoom=week&anchor=${FIXTURE_ANCHOR}&tz=Pacific/Kiritimati`);
    assert.equal(body.timeZone, "Pacific/Kiritimati");
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("desktop timeline: validation and not-found", () => {
  it("rejects malformed, repeated and unknown parameters with 400 and no-store", async () => {
    for (const q of [
      "",
      "zoom=year&anchor=2026-11-18",
      "zoom=month&anchor=2026-13-01",
      "zoom=month&anchor=1899-12-31",
      "zoom=month&anchor=2026-11-18&tz=Mars/Base",
      "zoom=month&zoom=week&anchor=2026-11-18",
      "zoom=month&anchor=2026-11-18&from=2026-01-01&to=2027-12-31",
      "zoom=month&anchor=2026-11-18&workspaceId=other",
    ]) {
      const { res } = await timeline(projectId, q);
      assert.equal(res.status, 400, q);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  it("answers nonexistent and malformed project ids with the same generic 404", async () => {
    const bodies = new Set<string>();
    for (const id of ["prj_does_not_exist", "..%2F..", "bad id"]) {
      const { res, text } = await timeline(encodeURIComponent(id), "zoom=month&anchor=2026-11-18");
      assert.equal(res.status, 404, id);
      bodies.add(text);
    }
    assert.deepEqual([...bodies], ['{"error":"Project not found"}']);
  });

  it("is a read-only endpoint", () => {
    const exported = Object.keys(route);
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) assert.ok(!exported.includes(verb), verb);
  });
});

describe("desktop timeline: large project limits", () => {
  let bigProject: string;
  let smallProject: string;

  before(async () => {
    const { db } = await import("../../src/db/client");
    const schema = await import("../../src/db/schema");
    smallProject = (await repos.projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Small" })).id;
    // One off-window blocker, so the small project exercises every query the big one does.
    const only = await repos.taskRepository.create(LOCAL_WORKSPACE_ID, { projectId: smallProject, title: "Only", dueDate: "2027-03-10" });
    const offWindow = await repos.taskRepository.create(LOCAL_WORKSPACE_ID, { projectId: smallProject, title: "Off window", dueDate: "2027-06-01" });
    await repos.taskRepository.addDependency(LOCAL_WORKSPACE_ID, only.id, offWindow.id);

    bigProject = (await repos.projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Big" })).id;
    // 450 dated tasks in March 2027, 220 undated, 120 milestones, and a
    // dependency chain of 1,100 edges — every cap exceeded.
    const now = new Date().toISOString();
    const dated = Array.from({ length: 450 }, (_, i) => ({
      id: `big_t_${String(i).padStart(4, "0")}`,
      projectId: bigProject,
      title: `Big task ${String(i).padStart(4, "0")}`,
      status: "todo",
      priority: "medium",
      dueDate: `2027-03-${String((i % 28) + 1).padStart(2, "0")}`,
      createdAt: now,
      updatedAt: now,
    }));
    const undated = Array.from({ length: 220 }, (_, i) => ({
      id: `big_u_${String(i).padStart(4, "0")}`,
      projectId: bigProject,
      title: `Big undated ${String(i).padStart(4, "0")}`,
      status: "todo",
      priority: "medium",
      createdAt: now,
      updatedAt: now,
    }));
    const allTasks = [...dated, ...undated];
    for (let i = 0; i < allTasks.length; i += 100) db.insert(schema.tasks).values(allTasks.slice(i, i + 100)).run();
    const ms = Array.from({ length: 120 }, (_, i) => ({
      id: `big_m_${String(i).padStart(4, "0")}`,
      projectId: bigProject,
      title: `Big milestone ${String(i).padStart(4, "0")}`,
      status: "open",
      dueDate: `2027-03-${String((i % 28) + 1).padStart(2, "0")}`,
      createdAt: now,
      updatedAt: now,
    }));
    for (let i = 0; i < ms.length; i += 60) db.insert(schema.milestones).values(ms.slice(i, i + 60)).run();
    const edges = [];
    for (let i = 1; i < allTasks.length; i++) edges.push({ taskId: allTasks[i]!.id, dependsOnTaskId: allTasks[i - 1]!.id, createdAt: now });
    for (let i = 0; i < 500; i++) edges.push({ taskId: allTasks[i + 2]!.id, dependsOnTaskId: allTasks[i]!.id, createdAt: now });
    for (let i = 0; i < edges.length; i += 200) db.insert(schema.taskDependencies).values(edges.slice(i, i + 200)).onConflictDoNothing().run();
  });

  it("caps each list independently and says so truthfully", async () => {
    const { res, body } = await timeline(bigProject, "zoom=month&anchor=2027-03-15");
    assert.equal(res.status, 200);
    const tasks = body.items.filter((i) => i.kind === "task");
    const milestones = body.items.filter((i) => i.kind === "milestone");
    assert.equal(tasks.length, body.limits.tasks);
    assert.equal(milestones.length, body.limits.milestones);
    assert.equal(body.undated.filter((i) => i.kind === "task").length, body.limits.undatedTasks);
    assert.ok(body.edges.length <= body.limits.edges);
    assert.deepEqual(body.truncated, { tasks: true, milestones: true, undatedTasks: true, undatedMilestones: false, edges: true });
    // blocked still comes from the repository query, so it stays truthful even with a capped graph.
    assert.ok(tasks.every((t) => t.kind === "task" && t.blocked === (t.title !== "Big task 0000")));
  });

  it("keeps blocked exact for every returned task even though the explanation graph is truncated", async () => {
    const { body } = await timeline(bigProject, "zoom=month&anchor=2027-03-15");
    const canonical = new Map((await repos.taskRepository.list(LOCAL_WORKSPACE_ID, bigProject)).map((t) => [t.id, t.blocked]));
    const tasks = [...body.items, ...body.undated].filter((i) => i.kind === "task");
    for (const t of tasks) if (t.kind === "task") assert.equal(t.blocked, canonical.get(t.id), t.title);
    assert.ok(tasks.some((t) => t.kind === "task" && t.blocked && !t.blocking.complete), "some explanations are marked incomplete");
  });
});

/** Counts statements and the rows SQLite actually returns, by statement kind. */
async function instrumentSqlite() {
  const Database = (await import("better-sqlite3")).default;
  const original = Database.prototype.prepare;
  const stats = { statements: 0, rows: 0, explanationStatements: 0, explanationRows: 0, closureStatements: 0 };
  Database.prototype.prepare = function (this: unknown, ...args: Parameters<typeof original>) {
    const text = String(args[0]);
    const explanation = /ORDER BY depends_on_task_id LIMIT/.test(text);
    if (explanation) stats.explanationStatements++;
    if (/WITH RECURSIVE reach/.test(text)) stats.closureStatements++;
    stats.statements++;
    const stmt = original.apply(this as never, args) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const method of ["all", "get"] as const) {
      const fn = stmt[method]!.bind(stmt);
      stmt[method] = (...a: unknown[]) => {
        const result = fn(...a);
        const n = Array.isArray(result) ? result.length : result === undefined ? 0 : 1;
        stats.rows += n;
        if (explanation) stats.explanationRows += n;
        return result;
      };
    }
    return stmt as never;
  } as typeof original;
  return { stats, restore: () => (Database.prototype.prepare = original) };
}

describe("desktop timeline: bounded dependency workload", () => {
  let project: string;
  const hubSeed = "path_seed_hub";
  const cycleSeed = "path_seed_cycle";
  const HUB_DEPENDENCIES = 20_000;
  const UNRELATED_EDGES = 100_000;

  before(async () => {
    const { db } = await import("../../src/db/client");
    const schema = await import("../../src/db/schema");
    const now = new Date().toISOString();
    project = (await repos.projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Pathological" })).id;
    const unrelatedProject = (await repos.projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Unrelated" })).id;
    const row = (tid: string, projectId: string, title: string, dueDate?: string, status = "todo") => ({
      id: tid,
      projectId,
      title,
      status,
      priority: "medium",
      createdAt: now,
      updatedAt: now,
      dueDate: dueDate ?? null,
    });
    const insertTasks = (rows: ReturnType<typeof row>[]) => {
      for (let i = 0; i < rows.length; i += 500) db.insert(schema.tasks).values(rows.slice(i, i + 500)).run();
    };
    const insertEdges = (edges: [string, string][]) => {
      for (let i = 0; i < edges.length; i += 500) {
        db.insert(schema.taskDependencies)
          .values(edges.slice(i, i + 500).map(([taskId, dependsOnTaskId]) => ({ taskId, dependsOnTaskId, createdAt: now })))
          .onConflictDoNothing()
          .run();
      }
    };
    const dep = (i: number) => `path_d_${String(i).padStart(6, "0")}`;
    const unrel = (i: number) => `unrel_${String(i).padStart(6, "0")}`;
    // Seeds in the window; a hub with 20,000 dependencies (all done except the
    // last); a cycle (inserted raw: the repositories reject cycles); and an
    // unconnected 100,000-edge graph in another project that nothing here reaches.
    insertTasks([
      row(hubSeed, project, "Seed on hub", "2027-05-10"),
      row(cycleSeed, project, "Seed on cycle", "2027-05-11"),
      row("path_free", project, "Free seed", "2027-05-12"),
      row("path_hub", project, "Hub", undefined, "done"),
      row("path_x", project, "Cycle X"),
      row("path_y", project, "Cycle Y", undefined, "done"),
      row("path_z", project, "Cycle Z", undefined, "done"),
      ...Array.from({ length: HUB_DEPENDENCIES }, (_, i) =>
        row(dep(i), project, `Hub dep ${i}`, undefined, i === HUB_DEPENDENCIES - 1 ? "todo" : "done"),
      ),
      ...Array.from({ length: UNRELATED_EDGES + 1 }, (_, i) => row(unrel(i), unrelatedProject, `Unrelated ${i}`)),
    ]);
    insertEdges([
      [hubSeed, "path_hub"],
      ...Array.from({ length: HUB_DEPENDENCIES }, (_, i): [string, string] => ["path_hub", dep(i)]),
      [cycleSeed, "path_x"],
      ["path_x", "path_y"],
      ["path_y", "path_z"],
      ["path_z", "path_x"],
      ...Array.from({ length: UNRELATED_EDGES }, (_, i): [string, string] => [unrel(i), unrel(i + 1)]),
    ]);
  });

  it("bounds database work: explanation rows and statements stay under constants the graph size cannot move", async () => {
    const { stats, restore } = await instrumentSqlite();
    let body: TimelineResponse;
    try {
      body = (await timeline(project, "zoom=month&anchor=2027-05-15")).body;
    } finally {
      restore();
    }
    const L = body.limits;
    assert.ok(body.edges.length <= L.edges);
    assert.equal(body.truncated.edges, true, "the explanation is reported as truncated");
    assert.ok(stats.explanationRows <= L.edges + L.exploreBatch * (L.edges + 1), `explanation rows ${stats.explanationRows}`);
    // The hub's 20,000 dependencies cost at most edgeBudget + 1 rows, not 20,000.
    assert.ok(stats.explanationRows <= L.edges + 10, `the hub was read with a LIMIT (rows ${stats.explanationRows})`);
    assert.ok(stats.explanationStatements <= 1 + Math.ceil(L.edges / L.exploreBatch) + L.maxDepth);
    assert.equal(stats.closureStatements, 1, "blocked state is one statement, not one per task");
    assert.ok(stats.rows < 5000, `total rows returned ${stats.rows} is far below the graph size`);
  });

  it("keeps blocked exact when the explanation is truncated, and marks that explanation incomplete", async () => {
    const { body } = await timeline(project, "zoom=month&anchor=2027-05-15");
    const byId = new Map(body.items.map((i) => [i.id, i]));
    const hub = byId.get(hubSeed)!;
    const cycle = byId.get(cycleSeed)!;
    const free = byId.get("path_free")!;
    if (hub.kind !== "task" || cycle.kind !== "task" || free.kind !== "task") throw new Error("tasks expected");
    // The only unfinished dependency is the hub's 20,000th: far outside the explanation budget.
    assert.equal(hub.blocked, true);
    assert.equal(hub.blocking.complete, false);
    // In id order the hub is expanded before this seed; its 20,000 dependencies
    // exhaust the budget, so the walk never reached the cycle. The seed is still
    // exactly blocked (Cycle X is unfinished; the closure terminates on the
    // cycle), and its explanation says it is incomplete rather than empty.
    assert.equal(cycle.blocked, true);
    assert.equal(cycle.blocking.complete, false);
    assert.deepEqual(cycle.blocking.roots, []);
    assert.equal(free.blocked, false);
    const canonical = new Map((await repos.taskRepository.list(LOCAL_WORKSPACE_ID, project)).map((t) => [t.id, t.blocked]));
    for (const item of body.items) if (item.kind === "task") assert.equal(item.blocked, canonical.get(item.id), item.title);
  });

  it("never traverses unreachable graphs, and refuses (rather than guesses) past the analysis cap", async () => {
    const window = (await import("../../src/core/timeline/range")).timelineRange("month", "2027-05-15");
    const { TIMELINE_LIMITS } = await import("../../src/core/timeline/types");
    const { TimelineAnalysisBudgetError } = await import("../../src/core/timeline/explore");
    const range = { from: window.from, to: window.to };
    // Reachable here: hub + 20,000 dependencies + X, Y, Z. The 100,001-task
    // unrelated graph would blow this cap if it were ever traversed.
    const reachable = HUB_DEPENDENCIES + 4;
    const ok = await repos.timelineRepository.load(LOCAL_WORKSPACE_ID, project, range, { ...TIMELINE_LIMITS, analysisTasks: reachable });
    assert.ok(ok);
    await assert.rejects(
      repos.timelineRepository.load(LOCAL_WORKSPACE_ID, project, range, { ...TIMELINE_LIMITS, analysisTasks: reachable - 1 }),
      TimelineAnalysisBudgetError,
    );
  });

  it("answers a tripped workload guard with a generic, retryable 503", async () => {
    const { TimelineAnalysisBudgetError } = await import("../../src/core/timeline/explore");
    const original = repos.timelineRepository.load;
    repos.timelineRepository.load = async () => {
      throw new TimelineAnalysisBudgetError();
    };
    try {
      const { res, text } = await timeline(project, "zoom=month&anchor=2027-05-15");
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(text, JSON.stringify({ error: "This project's dependency graph is too large to analyse right now." }));
    } finally {
      repos.timelineRepository.load = original;
    }
  });
});
