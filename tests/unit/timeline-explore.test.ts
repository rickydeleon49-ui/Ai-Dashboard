/**
 * Release 2D.2 bounded dependency exploration (src/core/timeline/explore.ts).
 *
 * The loader here behaves exactly like the repositories' SQL — for each id,
 * at most `perTaskLimit` dependency ids in ascending order — and counts every
 * row it "reads", so these tests measure database work, not response size.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exploreDependencies, type DependencyBatchLoader } from "../../src/core/timeline/explore";
import { analyzeTimeline, blockingFor, buildDependencyGraph } from "../../src/core/timeline/blocking";
import type { TimelineData, TimelineTaskRow } from "../../src/core/timeline/types";

function fakeDb(adjacency: Map<string, string[]>, opts: { shuffle?: boolean } = {}) {
  const stats = { statements: 0, rows: 0, maxBatch: 0, perTaskLimits: [] as number[] };
  const load: DependencyBatchLoader = async (ids, perTaskLimit) => {
    stats.statements++;
    stats.maxBatch = Math.max(stats.maxBatch, ids.length);
    stats.perTaskLimits.push(perTaskLimit);
    const rows = ids.flatMap((id) =>
      [...(adjacency.get(id) ?? [])].sort().slice(0, perTaskLimit).map((dep) => ({ taskId: id, dependsOnTaskId: dep })),
    );
    stats.rows += rows.length;
    return opts.shuffle ? rows.reverse() : rows;
  };
  return { load, stats };
}

const BUDGET = { edgeBudget: 1000, batchSize: 50, maxDepth: 32 };
const rowBound = (b: typeof BUDGET) => b.edgeBudget + b.batchSize * (b.edgeBudget + 1);
const statementBound = (b: typeof BUDGET, seeds: number) =>
  Math.ceil(seeds / b.batchSize) + Math.ceil(b.edgeBudget / b.batchSize) + b.maxDepth;
const id = (prefix: string, i: number) => `${prefix}${String(i).padStart(6, "0")}`;

describe("bounded dependency exploration", () => {
  it("a hub with 20,000 dependencies reads at most the row bound, returns ≤ 1,000 edges and reports truncation", async () => {
    const adjacency = new Map([["hub", Array.from({ length: 20_000 }, (_, i) => id("d", i))]]);
    const { load, stats } = fakeDb(adjacency);
    const r = await exploreDependencies(["hub"], BUDGET, load);
    assert.equal(r.edges.length, 1000);
    assert.equal(r.truncated, true);
    assert.deepEqual(r.expanded, [], "the hub's dependencies were not all loaded");
    assert.ok(stats.rows <= 1001, `a single-task statement reads ≤ budget + 1 rows (read ${stats.rows})`);
    assert.equal(r.rowsRead, stats.rows);
  });

  it("a wide, deep random graph of 200,000 edges stays within the row and statement bounds", async () => {
    // 600 seeds, each with 40 dependencies into a pool of 50,000 tasks that
    // themselves have 4 dependencies each: far more than the budget.
    const adjacency = new Map<string, string[]>();
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const seeds = Array.from({ length: 600 }, (_, i) => id("s", i));
    for (const s of seeds) adjacency.set(s, Array.from({ length: 40 }, () => id("p", rand(50_000))));
    for (let i = 0; i < 50_000; i++) adjacency.set(id("p", i), Array.from({ length: 4 }, () => id("p", rand(50_000))));
    const { load, stats } = fakeDb(adjacency);
    const r = await exploreDependencies(seeds, BUDGET, load);
    assert.ok(r.edges.length <= 1000);
    assert.equal(r.truncated, true);
    assert.ok(stats.rows <= rowBound(BUDGET), `rows ${stats.rows} ≤ ${rowBound(BUDGET)}`);
    assert.ok(stats.statements <= statementBound(BUDGET, seeds.length), `statements ${stats.statements}`);
    assert.ok(stats.maxBatch <= BUDGET.batchSize);
    assert.ok(stats.perTaskLimits.every((l) => l <= BUDGET.edgeBudget + 1));
  });

  it("a 5,000-long chain stops at the depth limit with at most maxDepth statements", async () => {
    const adjacency = new Map<string, string[]>();
    for (let i = 0; i < 5000; i++) adjacency.set(id("c", i), [id("c", i + 1)]);
    const { load, stats } = fakeDb(adjacency);
    const r = await exploreDependencies([id("c", 0)], BUDGET, load);
    assert.equal(r.truncated, true);
    assert.equal(r.edges.length, BUDGET.maxDepth);
    assert.equal(stats.statements, BUDGET.maxDepth);
  });

  it("cycles terminate and a small complete graph is fully expanded, not truncated", async () => {
    const adjacency = new Map([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", ["A", "D"]],
    ]);
    const { load, stats } = fakeDb(adjacency);
    const r = await exploreDependencies(["A"], BUDGET, load);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.edges.map((e) => `${e.taskId}>${e.dependsOnTaskId}`), ["A>B", "B>C", "C>A", "C>D"]);
    assert.deepEqual(r.expanded.sort(), ["A", "B", "C", "D"]);
    assert.equal(stats.statements, 4);
  });

  it("is deterministic whatever order the database returns rows in", async () => {
    const adjacency = new Map([
      ["A", ["Z", "B", "M"]],
      ["B", ["Q", "C"]],
      ["M", ["C"]],
    ]);
    const plain = await exploreDependencies(["A"], BUDGET, fakeDb(adjacency).load);
    const shuffled = await exploreDependencies(["A"], BUDGET, fakeDb(adjacency, { shuffle: true }).load);
    assert.deepEqual(shuffled.edges, plain.edges);
    assert.deepEqual(shuffled.expanded, plain.expanded);
  });

  it("exactly at the budget, unexplored frontier tasks are reported as possibly incomplete", async () => {
    const adjacency = new Map([["A", ["B", "C"]]]);
    const r = await exploreDependencies(["A"], { edgeBudget: 2, batchSize: 50, maxDepth: 32 }, fakeDb(adjacency).load);
    assert.equal(r.edges.length, 2);
    assert.deepEqual(r.expanded, ["A"]);
    assert.equal(r.truncated, true, "B and C were never looked up");
  });
});

describe("explanation completeness", () => {
  it("marks a blocking explanation incomplete when it reaches a task whose dependencies were not loaded", () => {
    const graph = buildDependencyGraph(
      [
        { taskId: "A", dependsOnTaskId: "B" },
        { taskId: "B", dependsOnTaskId: "C" },
      ],
      new Map(),
    );
    const status: Record<string, string> = { B: "done", C: "done" };
    const full = blockingFor("A", graph, (x) => status[x], () => true);
    assert.equal(full.complete, true);
    const partial = blockingFor("A", graph, (x) => status[x], (x) => x !== "C");
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.roots, [], "nothing unfinished was seen — but that is not a claim of 'unblocked'");
  });

  it("keeps the exact blocked value from the repository when the explanation is truncated", () => {
    const task = (tid: string, blocked: boolean): TimelineTaskRow => ({
      id: tid,
      title: tid,
      status: "todo",
      date: "2026-11-02",
      milestoneId: null,
      milestoneTitle: null,
      milestoneDate: null,
      assigneeId: null,
      blocked,
    });
    const data: TimelineData = {
      project: { id: "p", name: "P" },
      tasks: [task("A", true), task("X", false)],
      milestones: [],
      undatedTasks: [],
      undatedMilestones: [],
      // A's dependency B was loaded, B's own dependencies were not.
      edges: [{ taskId: "A", dependsOnTaskId: "B" }],
      expanded: ["A", "X"],
      external: [{ id: "B", title: "B", status: "done", date: null, projectId: "p", projectName: "P" }],
      truncated: { tasks: false, milestones: false, undatedTasks: false, undatedMilestones: false, edges: true },
    };
    const a = analyzeTimeline(data);
    const A = a.items.find((i) => i.id === "A")!;
    const X = a.items.find((i) => i.id === "X")!;
    if (A.kind !== "task" || X.kind !== "task") throw new Error();
    assert.equal(A.blocked, true, "still blocked, even though the loaded graph shows no unfinished task");
    assert.equal(A.blocking.complete, false);
    assert.deepEqual(A.blocking.roots, []);
    assert.equal(X.blocked, false);
    assert.equal(X.blocking.complete, true);
  });
});
