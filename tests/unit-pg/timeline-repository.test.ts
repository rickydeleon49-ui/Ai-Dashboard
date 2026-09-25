/**
 * Release 2D.2 timeline — PostgreSQL repository.
 *
 * 1. Parity with SQLite on the shared fixture (tests/helpers/timeline-fixtures.ts),
 *    and `blocked` equal to PostgresTaskRepository's own value.
 * 2. Workspace isolation: an identical fixture in another workspace never
 *    contributes a task, milestone, edge, node or project name, and a project
 *    id is only found in its own workspace.
 * 3. Assignee ids come through; nothing else about users does.
 * 4. A large project: independent caps with truthful truncation.
 * 5. A pathological graph (20,000-dependency hub, a cycle) next to a
 *    100,000-edge graph in another workspace: rows and statements stay under
 *    constants inside a READ ONLY transaction with a statement timeout; blocked
 *    stays exact; the other workspace is never traversed; the analysis cap and
 *    the real statement timeout both refuse instead of guessing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import { FIXTURE_ANCHOR, assertNoForbiddenKeys, assertTimelineParity, seedTimelineFixture } from "../helpers/timeline-fixtures";
import type { TimelineData, TimelineResponse } from "../../src/core/timeline/types";

const WA = "ws-tl-a";
const WB = "ws-tl-b";
const MEMBER = "b2000000-0000-4000-8000-000000000002";

type Repo = import("../../src/db/repositories/postgres-timeline-repository").PostgresTimelineRepository;
let repo: Repo;
let db: ReturnType<typeof import("../../src/db/pg-client").getPgDb>;
let schema: typeof import("../../src/db/schema.pg");
let core: typeof import("../../src/core/timeline/blocking");
let range: typeof import("../../src/core/timeline/range");
let types: typeof import("../../src/core/timeline/types");
let tasksRepo: import("../../src/db/repositories/postgres-task-repository").PostgresTaskRepository;
let projectA: string;
let projectB: string;

before(async () => {
  await migrate();
  db = (await import("../../src/db/pg-client")).getPgDb();
  schema = await import("../../src/db/schema.pg");
  core = await import("../../src/core/timeline/blocking");
  range = await import("../../src/core/timeline/range");
  types = await import("../../src/core/timeline/types");
  const { PostgresTimelineRepository } = await import("../../src/db/repositories/postgres-timeline-repository");
  const { PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository");
  const { PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository");
  const { PostgresMilestoneRepository } = await import("../../src/db/repositories/postgres-milestone-repository");
  repo = new PostgresTimelineRepository();
  tasksRepo = new PostgresTaskRepository();

  await db.insert(schema.users).values([{ id: MEMBER, name: "Tia Timeline", email: "tia@example.com", image: "https://img/tia" }]);
  await db.insert(schema.workspaces).values([
    { id: WA, name: "Timeline A", slug: WA, kind: "team" },
    { id: WB, name: "Timeline B", slug: WB, kind: "team" },
  ]);
  await db.insert(schema.workspaceMembers).values([{ workspaceId: WA, userId: MEMBER, role: "member", status: "active" }]);

  const repos = {
    projectRepository: new PostgresProjectRepository(),
    taskRepository: tasksRepo,
    milestoneRepository: new PostgresMilestoneRepository(),
  };
  ({ projectId: projectA } = await seedTimelineFixture(repos, WA));
  // The same names in workspace B, plus extra B-only work that must never leak.
  ({ projectId: projectB } = await seedTimelineFixture(repos, WB));
  const secret = await tasksRepo.create(WB, { projectId: projectB, title: "B secret", dueDate: "2026-11-11" });
  const secretBlocker = await tasksRepo.create(WB, { projectId: projectB, title: "B secret blocker" });
  await tasksRepo.addDependency(WB, secret.id, secretBlocker.id);

  const apiTask = (await tasksRepo.list(WA, projectA)).find((t) => t.title === "API")!;
  await tasksRepo.update(WA, apiTask.id, { assigneeId: MEMBER }, { actorUserId: MEMBER });
});

after(() => cleanup());

function respond(workspaceId: string, data: TimelineData, zoom: "week" | "month" | "quarter", anchor: string): TimelineResponse {
  const window = range.timelineRange(zoom, anchor);
  const analysis = core.analyzeTimeline(data);
  return {
    workspaceId,
    projectId: data.project.id,
    projectName: data.project.name,
    zoom,
    anchor,
    from: window.from,
    to: window.to,
    timeZone: "UTC",
    today: "2026-11-18",
    ...analysis,
    assignees: [],
    limits: types.TIMELINE_LIMITS,
    truncated: data.truncated,
    editable: false,
  };
}

async function load(workspaceId: string, projectId: string, zoom: "week" | "month" | "quarter" = "quarter", anchor = FIXTURE_ANCHOR) {
  const window = range.timelineRange(zoom, anchor);
  return repo.load(workspaceId, projectId, { from: window.from, to: window.to }, types.TIMELINE_LIMITS);
}

describe("postgres timeline: parity and one blocking definition", () => {
  it("returns the shared fixture exactly as SQLite does", async () => {
    const data = await load(WA, projectA);
    assert.ok(data);
    const body = respond(WA, data, "quarter", FIXTURE_ANCHOR);
    assertTimelineParity(body);
    assertNoForbiddenKeys(body);
  });

  it("blocked equals PostgresTaskRepository's value, and roots exist exactly when blocked", async () => {
    const data = (await load(WA, projectA))!;
    const body = respond(WA, data, "quarter", FIXTURE_ANCHOR);
    const fromRepo = new Map((await tasksRepo.list(WA, projectA)).map((t) => [t.id, t.blocked]));
    for (const item of [...body.items, ...body.undated]) {
      if (item.kind !== "task") continue;
      assert.equal(item.blocked, fromRepo.get(item.id), item.title);
      assert.equal(item.blocking.roots.length > 0, item.blocked, item.title);
    }
  });

  it("carries assignee ids and nothing else about users", async () => {
    const data = (await load(WA, projectA))!;
    const api = data.tasks.find((t) => t.title === "API")!;
    assert.equal(api.assigneeId, MEMBER);
    assert.ok(!JSON.stringify(data).includes("tia@example.com"));
    assert.ok(!JSON.stringify(data).includes("https://img/tia"));
  });
});

describe("postgres timeline: workspace isolation", () => {
  it("finds a project only in its own workspace", async () => {
    assert.equal(await load(WB, projectA), null);
    assert.equal(await load(WA, projectB), null);
    assert.equal(await load("ws-does-not-exist", projectA), null);
  });

  it("never includes another workspace's tasks, milestones, edges, nodes or names", async () => {
    const [a, b] = await Promise.all([load(WA, projectA), load(WB, projectB)]);
    const idsOf = (d: TimelineData) =>
      new Set([
        ...d.tasks.map((t) => t.id),
        ...d.undatedTasks.map((t) => t.id),
        ...d.milestones.map((m) => m.id),
        ...d.undatedMilestones.map((m) => m.id),
        ...d.external.map((x) => x.id),
        ...d.edges.flatMap((e) => [e.taskId, e.dependsOnTaskId]),
      ]);
    const aIds = idsOf(a!);
    for (const id of idsOf(b!)) assert.ok(!aIds.has(id), `workspace B id ${id} appeared in workspace A`);
    const text = JSON.stringify(a);
    assert.ok(!text.includes("B secret"));
    assert.ok(b!.tasks.some((t) => t.title === "B secret"), "B's own read does include it");
  });
});

describe("postgres timeline: large project limits", () => {
  let big: string;
  let small: string;

  before(async () => {
    const { PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository");
    const projects = new PostgresProjectRepository();
    small = (await projects.create(WA, { name: "Small" })).id;
    const only = await tasksRepo.create(WA, { projectId: small, title: "Only", dueDate: "2027-03-10" });
    const off = await tasksRepo.create(WA, { projectId: small, title: "Off window", dueDate: "2027-06-01" });
    await tasksRepo.addDependency(WA, only.id, off.id);

    big = (await projects.create(WA, { name: "Big" })).id;
    const dated = Array.from({ length: 450 }, (_, i) => ({
      id: `pg_big_t_${String(i).padStart(4, "0")}`,
      workspaceId: WA,
      projectId: big,
      title: `Big task ${String(i).padStart(4, "0")}`,
      dueDate: new Date(`2027-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
    }));
    const undated = Array.from({ length: 220 }, (_, i) => ({
      id: `pg_big_u_${String(i).padStart(4, "0")}`,
      workspaceId: WA,
      projectId: big,
      title: `Big undated ${String(i).padStart(4, "0")}`,
    }));
    const all = [...dated, ...undated];
    for (let i = 0; i < all.length; i += 200) await db.insert(schema.tasks).values(all.slice(i, i + 200));
    await db.insert(schema.milestones).values(
      Array.from({ length: 120 }, (_, i) => ({
        id: `pg_big_m_${String(i).padStart(4, "0")}`,
        workspaceId: WA,
        projectId: big,
        title: `Big milestone ${String(i).padStart(4, "0")}`,
        dueDate: new Date(`2027-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
      })),
    );
    const edges: { taskId: string; dependsOnTaskId: string; workspaceId: string }[] = [];
    for (let i = 1; i < all.length; i++) edges.push({ taskId: all[i]!.id, dependsOnTaskId: all[i - 1]!.id, workspaceId: WA });
    for (let i = 0; i < 500; i++) edges.push({ taskId: all[i + 2]!.id, dependsOnTaskId: all[i]!.id, workspaceId: WA });
    for (let i = 0; i < edges.length; i += 300) await db.insert(schema.taskDependencies).values(edges.slice(i, i + 300)).onConflictDoNothing();
  });

  it("caps each list independently and says so truthfully", async () => {
    const data = (await load(WA, big, "month", "2027-03-15"))!;
    assert.equal(data.tasks.length, types.MAX_TIMELINE_TASKS);
    assert.equal(data.milestones.length, types.MAX_TIMELINE_MILESTONES);
    assert.equal(data.undatedTasks.length, types.MAX_TIMELINE_UNDATED_TASKS);
    assert.equal(data.edges.length, types.MAX_TIMELINE_EDGES);
    assert.deepEqual(data.truncated, { tasks: true, milestones: true, undatedTasks: true, undatedMilestones: false, edges: true });
    assert.ok(data.tasks.every((t) => t.blocked === (t.title !== "Big task 0000")));
  });

  it("keeps blocked exact for every returned task even though the explanation graph is truncated", async () => {
    const data = (await load(WA, big, "month", "2027-03-15"))!;
    const body = respond(WA, data, "month", "2027-03-15");
    const canonical = new Map((await tasksRepo.list(WA, big)).map((t) => [t.id, t.blocked]));
    const items = [...body.items, ...body.undated].filter((i) => i.kind === "task");
    for (const t of items) if (t.kind === "task") assert.equal(t.blocked, canonical.get(t.id), t.title);
    assert.ok(items.some((t) => t.kind === "task" && t.blocked && !t.blocking.complete));
  });
});

/** Counts statements and the rows PostgreSQL actually returns (pool and transaction clients). */
async function instrumentPg() {
  const pg = await import("pg");
  const protos = [pg.Pool.prototype, pg.Client.prototype] as unknown as { query: (...a: unknown[]) => unknown }[];
  const originals = protos.map((p) => p.query);
  const stats = { statements: [] as string[], rows: 0, explanationStatements: 0, explanationRows: 0, closureStatements: 0 };
  protos.forEach((proto, i) => {
    const original = originals[i]!;
    proto.query = function (this: unknown, ...args: unknown[]) {
      const first = args[0] as string | { text?: string } | undefined;
      const text = typeof first === "string" ? first : (first?.text ?? "");
      // A Pool delegates to a Client; count each statement once, at the Client.
      if (proto === (pg.Client.prototype as unknown)) {
        stats.statements.push(text);
        const explanation = /ORDER BY depends_on_task_id LIMIT/.test(text);
        if (explanation) stats.explanationStatements++;
        if (/WITH RECURSIVE reach/.test(text)) stats.closureStatements++;
        const result = original.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<{ rows?: unknown[] }>).then(
            (r) => {
              const n = r?.rows?.length ?? 0;
              stats.rows += n;
              if (explanation) stats.explanationRows += n;
            },
            () => {},
          );
        }
        return result;
      }
      return original.apply(this, args);
    };
  });
  return {
    stats,
    restore: () => protos.forEach((proto, i) => (proto.query = originals[i]!)),
  };
}

describe("postgres timeline: bounded dependency workload", () => {
  const WC = "ws-tl-c";
  const HUB_DEPENDENCIES = 20_000;
  const FOREIGN_EDGES = 100_000;
  let project: string;

  before(async () => {
    const { PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository");
    const projects = new PostgresProjectRepository();
    project = (await projects.create(WA, { name: "Pathological" })).id;
    await db.insert(schema.workspaces).values([{ id: WC, name: "Timeline C", slug: WC, kind: "team" }]);
    const foreignProject = (await projects.create(WC, { name: "Foreign huge graph" })).id;

    const task = (tid: string, ws: string, projectId: string, title: string, dueDate?: string, status = "todo") => ({
      id: tid,
      workspaceId: ws,
      projectId,
      title,
      status,
      dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null,
    });
    const insertTasks = async (rows: ReturnType<typeof task>[]) => {
      for (let i = 0; i < rows.length; i += 2000) await db.insert(schema.tasks).values(rows.slice(i, i + 2000));
    };
    const insertEdges = async (ws: string, edges: [string, string][]) => {
      for (let i = 0; i < edges.length; i += 2000) {
        await db
          .insert(schema.taskDependencies)
          .values(edges.slice(i, i + 2000).map(([taskId, dependsOnTaskId]) => ({ taskId, dependsOnTaskId, workspaceId: ws })))
          .onConflictDoNothing();
      }
    };
    const dep = (i: number) => `pg_path_d_${String(i).padStart(6, "0")}`;
    const foreign = (i: number) => `pg_foreign_${String(i).padStart(6, "0")}`;
    await insertTasks([
      task("pg_path_seed_hub", WA, project, "Seed on hub", "2027-05-10"),
      task("pg_path_seed_cycle", WA, project, "Seed on cycle", "2027-05-11"),
      task("pg_path_free", WA, project, "Free seed", "2027-05-12"),
      task("pg_path_hub", WA, project, "Hub", undefined, "done"),
      task("pg_path_x", WA, project, "Cycle X"),
      task("pg_path_y", WA, project, "Cycle Y", undefined, "done"),
      task("pg_path_z", WA, project, "Cycle Z", undefined, "done"),
      ...Array.from({ length: HUB_DEPENDENCIES }, (_, i) =>
        task(dep(i), WA, project, `Hub dep ${i}`, undefined, i === HUB_DEPENDENCIES - 1 ? "todo" : "done"),
      ),
      ...Array.from({ length: FOREIGN_EDGES + 1 }, (_, i) => task(foreign(i), WC, foreignProject, `Foreign ${i}`)),
    ]);
    await insertEdges(WA, [
      ["pg_path_seed_hub", "pg_path_hub"],
      ...Array.from({ length: HUB_DEPENDENCIES }, (_, i): [string, string] => ["pg_path_hub", dep(i)]),
      ["pg_path_seed_cycle", "pg_path_x"],
      ["pg_path_x", "pg_path_y"],
      ["pg_path_y", "pg_path_z"],
      ["pg_path_z", "pg_path_x"],
    ]);
    await insertEdges(WC, Array.from({ length: FOREIGN_EDGES }, (_, i): [string, string] => [foreign(i), foreign(i + 1)]));
  });

  it("bounds database work: explanation rows and statements stay under constants, inside a read-only timed transaction", async () => {
    const { stats, restore } = await instrumentPg();
    let data: TimelineData | null;
    try {
      data = await load(WA, project, "month", "2027-05-15");
    } finally {
      restore();
    }
    const L = types.TIMELINE_LIMITS;
    assert.ok(data);
    assert.ok(data.edges.length <= L.edges);
    assert.equal(data.truncated.edges, true);
    assert.ok(stats.explanationRows <= L.edges + L.exploreBatch * (L.edges + 1), `explanation rows ${stats.explanationRows}`);
    assert.ok(stats.explanationRows <= L.edges + 10, `the hub was read with a LIMIT (rows ${stats.explanationRows})`);
    assert.ok(stats.explanationStatements <= Math.ceil(206 / L.exploreBatch) + Math.ceil(L.edges / L.exploreBatch) + L.maxDepth);
    assert.equal(stats.closureStatements, 1, "blocked state is one statement, not one per task");
    assert.ok(stats.rows < 5000, `total rows returned ${stats.rows} is far below the graph size`);
    assert.ok(stats.statements.some((s) => /^begin read only/i.test(s.trim())), "READ ONLY transaction");
    assert.ok(stats.statements.includes(`SET LOCAL statement_timeout = ${L.statementTimeoutMs}`), "statement timeout applied");
  });

  it("keeps blocked exact when the explanation is truncated, and marks that explanation incomplete", async () => {
    const data = (await load(WA, project, "month", "2027-05-15"))!;
    const body = respond(WA, data, "month", "2027-05-15");
    const byId = new Map([...body.items, ...body.undated].map((i) => [i.id, i]));
    const hub = byId.get("pg_path_seed_hub")!;
    const cycle = byId.get("pg_path_seed_cycle")!;
    const free = byId.get("pg_path_free")!;
    if (hub.kind !== "task" || cycle.kind !== "task" || free.kind !== "task") throw new Error("tasks expected");
    assert.deepEqual([hub.blocked, hub.blocking.complete], [true, false]);
    assert.deepEqual([cycle.blocked, cycle.blocking.complete, cycle.blocking.roots], [true, false, []]);
    assert.equal(free.blocked, false);
    const canonical = new Map((await tasksRepo.list(WA, project)).map((t) => [t.id, t.blocked]));
    for (const item of body.items) if (item.kind === "task") assert.equal(item.blocked, canonical.get(item.id), item.title);
  });

  it("never traverses another workspace's graph, and refuses (rather than guesses) past the analysis cap", async () => {
    const { TimelineAnalysisBudgetError } = await import("../../src/core/timeline/explore");
    const window = range.timelineRange("month", "2027-05-15");
    const r = { from: window.from, to: window.to };
    // Reachable in workspace A: hub + 20,000 dependencies + X, Y, Z. Workspace
    // C's 100,001-task chain would blow this cap if it were ever traversed.
    const reachable = HUB_DEPENDENCIES + 4;
    assert.ok(await repo.load(WA, project, r, { ...types.TIMELINE_LIMITS, analysisTasks: reachable }));
    await assert.rejects(
      repo.load(WA, project, r, { ...types.TIMELINE_LIMITS, analysisTasks: reachable - 1 }),
      TimelineAnalysisBudgetError,
    );
    const data = (await repo.load(WA, project, r, types.TIMELINE_LIMITS))!;
    assert.ok(!JSON.stringify(data).includes("pg_foreign_"), "nothing from workspace C is returned");
  });

  it("turns PostgreSQL's statement timeout into the generic budget error", async () => {
    const { TimelineAnalysisBudgetError } = await import("../../src/core/timeline/explore");
    const { isStatementTimeout } = await import("../../src/db/repositories/postgres-timeline-repository");
    assert.ok(isStatementTimeout({ code: "57014" }));
    assert.ok(isStatementTimeout(Object.assign(new Error("wrapped"), { cause: { code: "57014" } })));
    assert.ok(!isStatementTimeout({ code: "23505" }));
    // A 1 ms budget cannot cover a 20,000-task closure: the real timeout fires.
    const window = range.timelineRange("month", "2027-05-15");
    await assert.rejects(
      repo.load(WA, project, { from: window.from, to: window.to }, { ...types.TIMELINE_LIMITS, statementTimeoutMs: 1 }),
      TimelineAnalysisBudgetError,
    );
    // And the connection is usable afterwards (the transaction was rolled back).
    assert.ok(await load(WA, projectA));
  });
});
