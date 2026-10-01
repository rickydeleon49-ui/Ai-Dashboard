/**
 * Shared Release 2D.3 template fixture. The same document is applied in the
 * SQLite (tests/unit/templates.test.ts) and PostgreSQL
 * (tests/unit-pg/templates-repository.test.ts, tests/unit-pg-auth/templates-api.test.ts)
 * suites and must produce the same project.
 */
import assert from "node:assert/strict";

export const FIXTURE_START = "2028-02-27";

/** A complete template touching every feature: milestones, subtasks, dependencies, checklists, documents. */
export const FULL_TEMPLATE = {
  name: "Launch template",
  description: "Everything a launch needs",
  project: { name: "Product launch", description: "Created from a template", type: "software", status: "planning" },
  milestones: [
    { key: "beta", title: "Beta", description: "First external users", targetOffset: 14 },
    { key: "ga", title: "General availability", description: null, targetOffset: 30 },
  ],
  tasks: [
    { key: "spec", title: "Write the spec", description: "One page", priority: "high", dueOffset: 2, milestoneKey: "beta", parentKey: null },
    { key: "spec-review", title: "Review the spec", description: null, priority: "medium", dueOffset: 3, milestoneKey: "beta", parentKey: "spec" },
    { key: "build", title: "Build it", description: null, priority: "urgent", dueOffset: 12, milestoneKey: "beta", parentKey: null },
    { key: "announce", title: "Announce", description: null, priority: "low", dueOffset: 30, milestoneKey: "ga", parentKey: null },
    { key: "retro", title: "Retrospective", description: null, priority: "medium", dueOffset: null, milestoneKey: null, parentKey: null },
  ],
  dependencies: [
    { taskKey: "build", dependsOnKey: "spec" },
    { taskKey: "announce", dependsOnKey: "build" },
  ],
  checklist: [
    { taskKey: "spec", text: "Problem statement" },
    { taskKey: "spec", text: "Success metrics" },
    { taskKey: "announce", text: "Blog post" },
  ],
  documents: [
    { title: "Launch runbook", content: "# Runbook\nSteps.", category: "Operations", pinned: true },
    { title: "FAQ", content: "Questions.", category: null, pinned: false },
  ],
} as const;

/** What applying FULL_TEMPLATE at FIXTURE_START must create (database-independent). */
export interface CreatedProjectShape {
  project: { name: string; description: string | null; type: string; status: string; source: string };
  milestones: { title: string; status: string; dueDate: string | null }[];
  tasks: { title: string; status: string; priority: string; dueDate: string | null; milestone: string | null; parent: string | null; assigneeId: string | null }[];
  dependencies: string[];
  checklist: string[];
  documents: { title: string; category: string | null; pinned: boolean }[];
  blocked: string[];
}

export function assertCreatedProject(actual: CreatedProjectShape) {
  assert.deepEqual(actual.project, {
    name: "Product launch",
    description: "Created from a template",
    type: "software",
    status: "planning",
    source: "manual",
  });
  // 2028 is a leap year: 2028-02-27 + 2 days = 2028-02-29.
  assert.deepEqual(
    [...actual.milestones].sort((a, b) => a.title.localeCompare(b.title)),
    [
      { title: "Beta", status: "open", dueDate: "2028-03-12" },
      { title: "General availability", status: "open", dueDate: "2028-03-28" },
    ],
  );
  assert.deepEqual(
    [...actual.tasks].sort((a, b) => a.title.localeCompare(b.title)),
    [
      { title: "Announce", status: "todo", priority: "low", dueDate: "2028-03-28", milestone: "General availability", parent: null, assigneeId: null },
      { title: "Build it", status: "todo", priority: "urgent", dueDate: "2028-03-10", milestone: "Beta", parent: null, assigneeId: null },
      { title: "Retrospective", status: "todo", priority: "medium", dueDate: null, milestone: null, parent: null, assigneeId: null },
      { title: "Review the spec", status: "todo", priority: "medium", dueDate: "2028-03-01", milestone: "Beta", parent: "Write the spec", assigneeId: null },
      { title: "Write the spec", status: "todo", priority: "high", dueDate: "2028-02-29", milestone: "Beta", parent: null, assigneeId: null },
    ],
  );
  assert.deepEqual([...actual.dependencies].sort(), ["Announce>Build it", "Build it>Write the spec"]);
  assert.deepEqual(actual.checklist, ["Write the spec#0:Problem statement:open", "Write the spec#1:Success metrics:open", "Announce#0:Blog post:open"].sort());
  assert.deepEqual(
    [...actual.documents].sort((a, b) => a.title.localeCompare(b.title)),
    [
      { title: "FAQ", category: null, pinned: false },
      { title: "Launch runbook", category: "Operations", pinned: true },
    ],
  );
  // Dependencies make the dependents blocked, exactly as the task repositories compute it.
  assert.deepEqual([...actual.blocked].sort(), ["Announce", "Build it"]);
}

/** A valid-looking request key. */
export function requestKey(label: string): string {
  return `key-${label}-${"x".repeat(16)}`.slice(0, 100);
}
