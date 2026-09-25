/**
 * Release 2D.2 timeline core: windows, navigation, strict query parsing and
 * the blocking-path analysis (docs/design/2D.2-timeline.md §3, §6).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeTimeline,
  blockingFor,
  buildDependencyGraph,
  compareNodes,
  isItemResolved,
  isTaskResolved,
} from "../../src/core/timeline/blocking";
import { parseTimelineQuery, TimelineQueryError, isTimelineProjectId } from "../../src/core/timeline/query";
import { firstOfQuarter, quarterRange, shiftTimeline, timelineRange } from "../../src/core/timeline/range";
import { MAX_TIMELINE_DAYS, type TimelineData, type TimelineTaskRow } from "../../src/core/timeline/types";

describe("timeline windows", () => {
  it("week is the ISO week, month the Calendar's month grid, quarter whole weeks around the quarter", () => {
    assert.deepEqual([timelineRange("week", "2026-11-04").from, timelineRange("week", "2026-11-04").to], ["2026-11-02", "2026-11-08"]);
    const month = timelineRange("month", "2026-11-18");
    assert.deepEqual([month.from, month.to, month.days.length], ["2026-10-26", "2026-12-06", 42]);
    const q = timelineRange("quarter", "2026-11-18");
    assert.equal(firstOfQuarter("2026-11-18"), "2026-10-01");
    assert.deepEqual([q.from, q.to], ["2026-09-28", "2027-01-03"]);
    assert.equal(q.days.length % 7, 0);
    assert.ok(q.days.length <= MAX_TIMELINE_DAYS);
  });

  it("every zoom stays within the day bound for every quarter of several years", () => {
    for (let year = 2024; year <= 2030; year++) {
      for (const month of ["01", "04", "07", "10"]) {
        for (const zoom of ["week", "month", "quarter"] as const) {
          const r = timelineRange(zoom, `${year}-${month}-15`);
          assert.ok(r.days.length <= MAX_TIMELINE_DAYS, `${zoom} ${year}-${month}`);
          assert.equal(r.days[0], r.from);
          assert.equal(r.days[r.days.length - 1], r.to);
        }
      }
    }
  });

  it("days are consecutive across daylight-saving transitions in any zone (UTC arithmetic)", () => {
    // US DST ends 2026-11-01; Auckland DST starts 2026-09-27; Europe 2026-10-25.
    const q = quarterRange("2026-10-10");
    for (let i = 1; i < q.days.length; i++) {
      const prev = new Date(`${q.days[i - 1]}T00:00:00Z`).getTime();
      const cur = new Date(`${q.days[i]}T00:00:00Z`).getTime();
      assert.equal(cur - prev, 86_400_000, `${q.days[i - 1]} → ${q.days[i]}`);
    }
    assert.ok(q.days.includes("2026-11-01") && q.days.includes("2026-10-25"));
  });

  it("clamps at the supported boundaries and refuses to navigate outside them", () => {
    assert.equal(timelineRange("quarter", "1900-02-01").from, "1900-01-01");
    assert.equal(timelineRange("quarter", "9999-12-01").to, "9999-12-31");
    assert.equal(timelineRange("week", "9999-12-31").to, "9999-12-31");
    for (const zoom of ["week", "month", "quarter"] as const) {
      assert.equal(shiftTimeline(zoom, "1900-01-03", -1), null, `${zoom} before 1900`);
      assert.equal(shiftTimeline(zoom, "9999-12-30", 1), null, `${zoom} after 9999`);
    }
    assert.equal(shiftTimeline("quarter", "2026-11-18", 1), "2027-01-01");
    assert.equal(shiftTimeline("quarter", "2026-02-18", -1), "2025-10-01");
    assert.equal(shiftTimeline("month", "2026-11-18", 1), "2026-12-01");
    assert.equal(shiftTimeline("week", "2026-11-04", 1), "2026-11-09");
  });
});

describe("timeline query parsing", () => {
  const parse = (q: string) => parseTimelineQuery(new URLSearchParams(q));

  it("accepts zoom + anchor (+ tz)", () => {
    assert.deepEqual(parse("zoom=quarter&anchor=2026-11-18"), { zoom: "quarter", anchor: "2026-11-18" });
    assert.deepEqual(parse("zoom=week&anchor=9999-12-31&tz=Pacific/Auckland"), {
      zoom: "week",
      anchor: "9999-12-31",
      tz: "Pacific/Auckland",
    });
    assert.deepEqual(parse("zoom=month&anchor=1900-01-01"), { zoom: "month", anchor: "1900-01-01" });
  });

  it("rejects unknown, repeated, missing and malformed parameters", () => {
    for (const q of [
      "",
      "zoom=year&anchor=2026-01-01",
      "zoom=month",
      "anchor=2026-01-01",
      "zoom=month&anchor=2026-1-1",
      "zoom=month&anchor=2026-02-30",
      "zoom=month&anchor=1899-12-31",
      "zoom=month&anchor=10000-01-01",
      "zoom=month&anchor=11/18/2026",
      "zoom=month&anchor=2026-11-18T00:00:00Z",
      "zoom=month&anchor=2026-11-18&tz=Not/AZone",
      "zoom=month&anchor=2026-11-18&tz=",
      "zoom=month&zoom=week&anchor=2026-11-18",
      "zoom=month&anchor=2026-11-18&anchor=2026-11-19",
      "zoom=month&anchor=2026-11-18&from=2026-01-01",
      "zoom=month&anchor=2026-11-18&workspaceId=ws_other",
    ]) {
      assert.throws(() => parse(q), TimelineQueryError, q);
    }
  });

  it("only opaque ids name a project", () => {
    assert.ok(isTimelineProjectId("prj_abc-123"));
    for (const bad of ["", "../etc", "a b", "x".repeat(101), "p;drop"]) assert.equal(isTimelineProjectId(bad), false, bad);
  });
});

function task(id: string, partial: Partial<TimelineTaskRow> = {}): TimelineTaskRow {
  return {
    id,
    title: id,
    status: "todo",
    date: null,
    milestoneId: null,
    milestoneTitle: null,
    milestoneDate: null,
    assigneeId: null,
    blocked: false,
    ...partial,
  };
}

function data(tasks: TimelineTaskRow[], edges: [string, string][], extra: Partial<TimelineData> = {}): TimelineData {
  return {
    project: { id: "p1", name: "Project" },
    tasks,
    milestones: [],
    undatedTasks: [],
    undatedMilestones: [],
    edges: edges.map(([taskId, dependsOnTaskId]) => ({ taskId, dependsOnTaskId })),
    // Complete explanation graph unless a test says otherwise.
    expanded: [...new Set([...tasks.map((t) => t.id), ...edges.flat()])],
    external: [],
    truncated: { tasks: false, milestones: false, undatedTasks: false, undatedMilestones: false, edges: false },
    ...extra,
  };
}

describe("blocking paths", () => {
  it("uses the repositories' resolution rule for tasks and completed/cancelled for milestones", () => {
    assert.ok(isTaskResolved("done") && isTaskResolved("cancelled"));
    assert.ok(!isTaskResolved("todo") && !isTaskResolved("in_progress") && !isTaskResolved("completed"));
    assert.ok(isItemResolved("milestone", "completed") && !isItemResolved("milestone", "open"));
  });

  it("direct blocker: the unfinished dependency is the root and the only immediate blocker", () => {
    const a = analyzeTimeline(data([task("A", { date: "2026-11-10", blocked: true }), task("B", { date: "2026-11-05" })], [["A", "B"]]));
    const A = a.items.find((i) => i.id === "A")!;
    assert.equal(A.kind, "task");
    if (A.kind !== "task") return;
    assert.deepEqual(A.blocking, { immediateBlockers: ["B"], roots: ["B"], path: [["A", "B"]], complete: true });
    assert.deepEqual(A.dependsOn, ["B"]);
  });

  it("transitive blocker through a DONE task is still found (a completed task can't conceal it)", () => {
    const a = analyzeTimeline(
      data(
        [task("A", { blocked: true, date: "2026-11-10" }), task("B", { status: "done", date: "2026-11-05" }), task("C", { date: "2026-11-01" })],
        [
          ["A", "B"],
          ["B", "C"],
        ],
      ),
    );
    const item = a.items.find((i) => i.id === "A")!;
    if (item.kind !== "task") throw new Error("task expected");
    assert.deepEqual(item.blocking.roots, ["C"]);
    assert.deepEqual(item.blocking.path, [
      ["A", "B"],
      ["B", "C"],
    ]);
    assert.deepEqual(item.blocking.immediateBlockers, ["B"]);
  });

  it("completed and cancelled dependencies with nothing unfinished behind them block nothing", () => {
    const graph = buildDependencyGraph(
      [
        { taskId: "A", dependsOnTaskId: "B" },
        { taskId: "A", dependsOnTaskId: "C" },
      ],
      new Map(),
    );
    const status: Record<string, string> = { B: "done", C: "cancelled" };
    assert.deepEqual(blockingFor("A", graph, (id) => status[id]), { immediateBlockers: [], roots: [], path: [], complete: true });
  });

  it("multiple branches: every branch that reaches unfinished work is included, in a fixed order", () => {
    // A depends on B (due later) and C (due earlier); both lead to unfinished work.
    const nodes = new Map([
      ["B", { id: "B", title: "B", date: "2026-11-20" }],
      ["C", { id: "C", title: "C", date: "2026-11-01" }],
      ["D", { id: "D", title: "D", date: null }],
    ]);
    const edges = [
      { taskId: "A", dependsOnTaskId: "B" },
      { taskId: "A", dependsOnTaskId: "C" },
      { taskId: "B", dependsOnTaskId: "D" },
    ];
    const status: Record<string, string> = { B: "done", C: "in_progress", D: "todo" };
    const once = blockingFor("A", buildDependencyGraph(edges, nodes), (id) => status[id]);
    // C (due earliest) is visited before B; D is reached through B.
    assert.deepEqual(once, {
      immediateBlockers: ["C", "B"],
      roots: ["C", "D"],
      path: [
        ["A", "C"],
        ["A", "B"],
        ["B", "D"],
      ],
      complete: true,
    });
    // Same answer whatever order the edges arrive in.
    const again = blockingFor("A", buildDependencyGraph([...edges].reverse(), nodes), (id) => status[id]);
    assert.deepEqual(again, once);
  });

  it("diamond: a shared root is reached once, by the shortest path, and path edges are not repeated", () => {
    const edges = [
      { taskId: "A", dependsOnTaskId: "B" },
      { taskId: "A", dependsOnTaskId: "C" },
      { taskId: "B", dependsOnTaskId: "D" },
      { taskId: "C", dependsOnTaskId: "D" },
    ];
    const status: Record<string, string> = { B: "done", C: "done", D: "todo" };
    const r = blockingFor("A", buildDependencyGraph(edges, new Map()), (id) => status[id]);
    assert.deepEqual(r.roots, ["D"]);
    assert.deepEqual(r.path, [
      ["A", "B"],
      ["B", "D"],
    ]);
    assert.deepEqual(r.immediateBlockers, ["B"]);
  });

  it("terminates on a cycle (defence in depth; the repositories reject cycles)", () => {
    const edges = [
      { taskId: "A", dependsOnTaskId: "B" },
      { taskId: "B", dependsOnTaskId: "C" },
      { taskId: "C", dependsOnTaskId: "A" },
    ];
    const r = blockingFor("A", buildDependencyGraph(edges, new Map()), () => "todo");
    assert.deepEqual(r.roots, ["B", "C"]);
  });

  it("never claims a root whose status is unknown (outside a truncated edge set)", () => {
    const r = blockingFor("A", buildDependencyGraph([{ taskId: "A", dependsOnTaskId: "Z" }], new Map()), () => undefined);
    assert.deepEqual(r, { immediateBlockers: [], roots: [], path: [], complete: true });
  });

  it("unblocked tasks carry an empty explanation even when they have dependencies", () => {
    const a = analyzeTimeline(data([task("A", { date: "2026-11-10" }), task("B", { status: "done", date: "2026-11-01" })], [["A", "B"]]));
    const A = a.items.find((i) => i.id === "A")!;
    if (A.kind !== "task") throw new Error();
    assert.deepEqual(A.blocking, { immediateBlockers: [], roots: [], path: [], complete: true });
    assert.deepEqual(A.dependsOn, ["B"]);
  });

  it("visit order is due day (undated last), title, id", () => {
    const order = [
      { id: "z", title: "Z", date: null },
      { id: "b", title: "B", date: "2026-01-02" },
      { id: "a2", title: "A", date: "2026-01-02" },
      { id: "a1", title: "A", date: "2026-01-02" },
      { id: "c", title: "C", date: "2025-12-31" },
    ].sort(compareNodes);
    assert.deepEqual(order.map((n) => n.id), ["c", "a1", "a2", "b", "z"]);
  });
});

describe("date conflicts and ordering", () => {
  it("flags a task due before an unfinished blocker, and after its milestone", () => {
    const a = analyzeTimeline(
      data(
        [
          task("A", { date: "2026-11-05", blocked: true, milestoneId: "m", milestoneDate: "2026-11-01" }),
          task("B", { date: "2026-11-09" }),
          task("C", { date: "2026-11-03", status: "done", milestoneDate: "2026-11-01" }),
        ],
        [["A", "B"]],
      ),
    );
    const byId = new Map(a.items.map((i) => [i.id, i]));
    const A = byId.get("A")!;
    const C = byId.get("C")!;
    if (A.kind !== "task" || C.kind !== "task") throw new Error();
    assert.deepEqual(A.conflicts, ["due_before_blocker", "due_after_milestone"]);
    assert.deepEqual(C.conflicts, [], "resolved work has no conflicts");
  });

  it("orders dated items by day, milestones first, then title and id; undated tasks by milestone target", () => {
    const a = analyzeTimeline(
      data([task("t2", { date: "2026-11-02", title: "B" }), task("t1", { date: "2026-11-02", title: "A" }), task("t0", { date: "2026-11-01", title: "Z" })], [], {
        milestones: [{ id: "m1", title: "Zeta", status: "open", date: "2026-11-02" }],
        undatedTasks: [
          task("u1", { title: "No milestone" }),
          task("u2", { title: "Later target", milestoneDate: "2026-12-01" }),
          task("u3", { title: "Early target", milestoneDate: "2026-11-15" }),
        ],
        undatedMilestones: [{ id: "um", title: "Someday", status: "open", date: null }],
      }),
    );
    assert.deepEqual(a.items.map((i) => i.id), ["t0", "m1", "t1", "t2"]);
    assert.deepEqual(a.undated.map((i) => i.id), ["u3", "u2", "u1", "um"]);
  });

  it("records every referenced task as a node, marking other-project ones", () => {
    const a = analyzeTimeline(
      data([task("A", { blocked: true, date: "2026-11-02" })], [["A", "X"]], {
        external: [{ id: "X", title: "Elsewhere", status: "todo", date: null, projectId: "p2", projectName: "Other" }],
      }),
    );
    assert.deepEqual(a.nodes.X, { id: "X", title: "Elsewhere", status: "todo", date: null, projectId: "p2", projectName: "Other", inProject: false });
    assert.equal(a.nodes.A!.inProject, true);
  });
});
