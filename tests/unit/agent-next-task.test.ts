import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleTasks,
  firstUncheckedItem,
  pickNextTask,
  type NextTaskCandidate,
  type TaskDependencyEdge,
} from "../../src/core/agents/next-task";

function makeTask(overrides: Partial<NextTaskCandidate> & { id: string }): NextTaskCandidate {
  return {
    id: overrides.id,
    parentTaskId: overrides.parentTaskId ?? null,
    title: overrides.title ?? `Task ${overrides.id}`,
    status: overrides.status ?? "todo",
    priority: overrides.priority ?? "medium",
    dueDate: overrides.dueDate !== undefined ? overrides.dueDate : null,
    createdAt: overrides.createdAt ?? "2026-11-01T00:00:00Z",
  };
}

test("status filter: only todo tasks are eligible", () => {
  const tasks: NextTaskCandidate[] = [
    makeTask({ id: "t-todo", status: "todo" }),
    makeTask({ id: "t-prog", status: "in_progress" }),
    makeTask({ id: "t-done", status: "done" }),
    makeTask({ id: "t-canc", status: "cancelled" }),
    makeTask({ id: "t-other", status: "archived" }),
  ];
  const eligible = eligibleTasks(tasks, [], new Set());
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]!.id, "t-todo");

  const picked = pickNextTask(tasks, [], new Set());
  assert.notEqual(picked, null);
  assert.equal(picked!.id, "t-todo");
});

test("active-run exclusion: tasks in activeRunTaskIds are excluded", () => {
  const tasks: NextTaskCandidate[] = [
    makeTask({ id: "t1", status: "todo", priority: "urgent" }),
    makeTask({ id: "t2", status: "todo", priority: "high" }),
  ];
  const activeRuns = new Set(["t1"]);
  const eligible = eligibleTasks(tasks, [], activeRuns);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]!.id, "t2");

  const picked = pickNextTask(tasks, [], activeRuns);
  assert.notEqual(picked, null);
  assert.equal(picked!.id, "t2");
});

test("blocked by unfinished dependency: task is blocked if dependency is not done or cancelled", () => {
  const tasks: NextTaskCandidate[] = [
    makeTask({ id: "t1", status: "todo" }),
    makeTask({ id: "t2", status: "in_progress" }),
    makeTask({ id: "t3", status: "todo" }),
    makeTask({ id: "t4", status: "todo" }),
    makeTask({ id: "t5", status: "todo" }),
  ];
  const deps: TaskDependencyEdge[] = [
    { taskId: "t1", dependsOnTaskId: "t2" },
    { taskId: "t3", dependsOnTaskId: "t4" },
  ];
  const eligible = eligibleTasks(tasks, deps, new Set());
  const eligibleIds = eligible.map((t) => t.id);
  assert.equal(eligibleIds.includes("t1"), false);
  assert.equal(eligibleIds.includes("t3"), false);
  assert.equal(eligibleIds.includes("t4"), true);
  assert.equal(eligibleIds.includes("t5"), true);
});

test("dependency on cancelled/done/missing task is not blocking", () => {
  const tasks: NextTaskCandidate[] = [
    makeTask({ id: "t-target", status: "todo" }),
    makeTask({ id: "t-done", status: "done" }),
    makeTask({ id: "t-canc", status: "cancelled" }),
  ];
  const deps: TaskDependencyEdge[] = [
    { taskId: "t-target", dependsOnTaskId: "t-done" },
    { taskId: "t-target", dependsOnTaskId: "t-canc" },
    { taskId: "t-target", dependsOnTaskId: "t-missing-id" },
  ];
  const eligible = eligibleTasks(tasks, deps, new Set());
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]!.id, "t-target");

  const picked = pickNextTask(tasks, deps, new Set());
  assert.notEqual(picked, null);
  assert.equal(picked!.id, "t-target");
});

test("parent with open subtask excluded but subtask eligible", () => {
  const parent = makeTask({ id: "parent-1", status: "todo", priority: "urgent" });
  const subtask1 = makeTask({
    id: "sub-1",
    parentTaskId: "parent-1",
    status: "todo",
    priority: "medium",
  });
  const subtask2 = makeTask({
    id: "sub-2",
    parentTaskId: "parent-1",
    status: "in_progress",
    priority: "low",
  });

  const tasks = [parent, subtask1, subtask2];
  const eligible = eligibleTasks(tasks, [], new Set());

  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]!.id, "sub-1");

  const picked = pickNextTask(tasks, [], new Set());
  assert.notEqual(picked, null);
  assert.equal(picked!.id, "sub-1");
});

test("parent eligible after all subtasks done", () => {
  const parent = makeTask({ id: "parent-1", status: "todo" });
  const subtask1 = makeTask({
    id: "sub-1",
    parentTaskId: "parent-1",
    status: "done",
  });
  const subtask2 = makeTask({
    id: "sub-2",
    parentTaskId: "parent-1",
    status: "cancelled",
  });

  const tasks = [parent, subtask1, subtask2];
  const eligible = eligibleTasks(tasks, [], new Set());

  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]!.id, "parent-1");

  const picked = pickNextTask(tasks, [], new Set());
  assert.notEqual(picked, null);
  assert.equal(picked!.id, "parent-1");
});

test("full ordering (priority, due date with null last, createdAt, id)", () => {
  const tasks: NextTaskCandidate[] = [
    makeTask({ id: "t09-unknown", priority: "custom", dueDate: null, createdAt: "2026-11-01T00:00:00Z" }),
    makeTask({ id: "t08-low", priority: "low", dueDate: null, createdAt: "2026-11-01T00:00:00Z" }),
    makeTask({ id: "t07-med", priority: "medium", dueDate: null, createdAt: "2026-11-01T00:00:00Z" }),
    makeTask({ id: "t06-high-nodue-cr2-b", priority: "high", dueDate: null, createdAt: "2026-10-02T00:00:00Z" }),
    makeTask({ id: "t05-high-nodue-cr2-a", priority: "high", dueDate: null, createdAt: "2026-10-02T00:00:00Z" }),
    makeTask({ id: "t04-high-nodue-cr1", priority: "high", dueDate: null, createdAt: "2026-10-01T00:00:00Z" }),
    makeTask({ id: "t03-high-due2", priority: "high", dueDate: "2026-11-05", createdAt: "2026-11-01T00:00:00Z" }),
    makeTask({ id: "t02-high-due1", priority: "high", dueDate: "2026-11-01", createdAt: "2026-11-01T00:00:00Z" }),
    makeTask({ id: "t01-urgent", priority: "urgent", dueDate: null, createdAt: "2026-11-01T00:00:00Z" }),
  ];

  const eligible = eligibleTasks(tasks, [], new Set());
  const orderedIds = eligible.map((t) => t.id);

  assert.deepEqual(orderedIds, [
    "t01-urgent",
    "t02-high-due1",
    "t03-high-due2",
    "t04-high-nodue-cr1",
    "t05-high-nodue-cr2-a",
    "t06-high-nodue-cr2-b",
    "t07-med",
    "t08-low",
    "t09-unknown",
  ]);

  const picked = pickNextTask(tasks, [], new Set());
  assert.notEqual(picked, null);
  assert.equal(picked!.id, "t01-urgent");
});

test("inputs not mutated: input arrays and objects remain untouched", () => {
  const task1 = Object.freeze(makeTask({ id: "t1", status: "todo", priority: "low" }));
  const task2 = Object.freeze(makeTask({ id: "t2", status: "todo", priority: "urgent" }));
  const tasks = Object.freeze([task1, task2]);
  const dep = Object.freeze({ taskId: "t1", dependsOnTaskId: "t2" });
  const deps = Object.freeze([dep]);
  const activeRuns: ReadonlySet<string> = Object.freeze(new Set(["t3"]));

  const eligible = eligibleTasks(tasks as NextTaskCandidate[], deps as TaskDependencyEdge[], activeRuns);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]!.id, "t1");
  assert.equal(tasks[1]!.id, "t2");
  assert.equal(deps.length, 1);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0]!.id, "t2");
});

test("empty list → null: returns empty array and null", () => {
  const eligible = eligibleTasks([], [], new Set());
  assert.deepEqual(eligible, []);

  const picked = pickNextTask([], [], new Set());
  assert.equal(picked, null);
});

test("firstUncheckedItem: found finds first unchecked item in section", () => {
  const md = `# Roadmap\n\n## Tasks\n- [ ] Ship AW4-02\n- [ ] Next item\n`;
  const item = firstUncheckedItem(md, "Tasks");
  assert.equal(item, "Ship AW4-02");
});

test("firstUncheckedItem: skips checked items (- [x] and - [X] and * [x])", () => {
  const md = `## Tasks\n- [x] Item 1\n- [X] Item 2\n* [x] Item 3\n* [ ] First unchecked\n- [ ] Second unchecked\n`;
  const item = firstUncheckedItem(md, "Tasks");
  assert.equal(item, "First unchecked");
});

test("firstUncheckedItem: section ends at same-level heading", () => {
  const md = `## Tasks\nNo items here.\n## Next Section\n- [ ] In next section\n`;
  const item = firstUncheckedItem(md, "Tasks");
  assert.equal(item, null);
});

test("firstUncheckedItem: nested deeper heading stays in section", () => {
  const md = `## Tasks\nSome intro text.\n### Subheading\n- [x] Done in subhead\n- [ ] Todo in subhead\n## Next\n`;
  const item = firstUncheckedItem(md, "Tasks");
  assert.equal(item, "Todo in subhead");
});

test("firstUncheckedItem: heading missing → null", () => {
  const md = `# Overview\n- [ ] An item\n`;
  const item = firstUncheckedItem(md, "Nonexistent Heading");
  assert.equal(item, null);
});

test("firstUncheckedItem: CRLF input handled cleanly", () => {
  const md = "## Tasks\r\n- [x] Done item\r\n- [ ] Task with CRLF\r\n## End\r\n";
  const item = firstUncheckedItem(md, "Tasks");
  assert.equal(item, "Task with CRLF");
});
