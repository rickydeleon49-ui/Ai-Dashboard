/**
 * Release 2D.3 templates — pure domain rules: relative dates, strict schemas,
 * structural validation (references, one-level subtasks, dependency cycles),
 * workload limits and the preview. See docs/design/2D.3-reusable-templates.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { templateApplySchema, templateContentSchema, templateCreateSchema } from "../../src/core/templates/schema";
import { findCycleMembers, previewTemplate, relativeDate, validateTemplate } from "../../src/core/templates/validate";
import {
  MAX_CHECKLIST_ITEMS_PER_TASK,
  MAX_TEMPLATE_DEPENDENCIES,
  MAX_TEMPLATE_TASKS,
  MAX_TOTAL_DOCUMENT_CONTENT,
} from "../../src/core/templates/limits";
import type { TemplateContent } from "../../src/core/templates/types";

function content(partial: Partial<TemplateContent> = {}): TemplateContent {
  return templateContentSchema.parse({ name: "T", project: { name: "P" }, ...partial }) as TemplateContent;
}
const task = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key.toUpperCase(), ...extra });

describe("relative dates", () => {
  it("adds whole days across leap days, month and year boundaries", () => {
    assert.equal(relativeDate("2024-02-28", 1), "2024-02-29");
    assert.equal(relativeDate("2024-02-28", 2), "2024-03-01");
    assert.equal(relativeDate("2023-02-28", 1), "2023-03-01");
    assert.equal(relativeDate("2000-02-28", 1), "2000-02-29", "2000 is a leap year");
    assert.equal(relativeDate("2100-02-28", 1), "2100-03-01", "2100 is not");
    assert.equal(relativeDate("2026-01-31", 1), "2026-02-01");
    assert.equal(relativeDate("2026-12-31", 1), "2027-01-01");
    assert.equal(relativeDate("2026-06-15", 0), "2026-06-15");
    assert.equal(relativeDate("2026-01-01", 3650), "2035-12-30");
  });

  it("never loses or repeats a day across daylight-saving transitions", () => {
    // US: 2026-03-08 and 2026-11-01. EU: 2026-03-29 and 2026-10-25. NZ: 2026-04-05, 2026-09-27.
    for (const [start, expected] of [
      ["2026-03-07", ["2026-03-07", "2026-03-08", "2026-03-09"]],
      ["2026-10-31", ["2026-10-31", "2026-11-01", "2026-11-02"]],
      ["2026-03-28", ["2026-03-28", "2026-03-29", "2026-03-30"]],
      ["2026-09-26", ["2026-09-26", "2026-09-27", "2026-09-28"]],
    ] as const) {
      assert.deepEqual([0, 1, 2].map((d) => relativeDate(start, d)), expected);
    }
  });

  it("rejects dates outside the supported calendar", () => {
    assert.equal(relativeDate("9999-12-31", 0), "9999-12-31");
    assert.equal(relativeDate("9999-12-31", 1), null);
    assert.equal(relativeDate("9999-06-01", 3650), null);
    assert.equal(relativeDate("1900-01-01", 0), "1900-01-01");
  });
});

describe("strict schemas", () => {
  it("rejects unknown fields at every level, including workspace overrides", () => {
    const bad = [
      { name: "T", project: { name: "P" }, workspaceId: "ws_other" },
      { name: "T", project: { name: "P", workspaceId: "ws_other" } },
      { name: "T", project: { name: "P", repositoryUrl: "https://github.com/x/y" } },
      { name: "T", project: { name: "P", localPath: "C:/secret" } },
      { name: "T", project: { name: "P" }, tasks: [{ key: "a", title: "A", assigneeId: "usr_1" }] },
      { name: "T", project: { name: "P" }, tasks: [{ key: "a", title: "A", id: "tsk_live" }] },
      { name: "T", project: { name: "P" }, tasks: [{ key: "a", title: "A", status: "done" }] },
      { name: "T", project: { name: "P" }, checklist: [{ taskKey: "a", text: "x", done: true }] },
      { name: "T", project: { name: "P" }, documents: [{ title: "D", projectId: "prj_live" }] },
    ];
    for (const body of bad) assert.equal(templateContentSchema.safeParse(body).success, false, JSON.stringify(body));
  });

  it("validates keys, offsets, priorities and statuses", () => {
    const bad = [
      { tasks: [task("A")] },
      { tasks: [task("has space")] },
      { tasks: [task("x".repeat(41))] },
      { tasks: [task("a", { dueOffset: -1 })] },
      { tasks: [task("a", { dueOffset: 3651 })] },
      { tasks: [task("a", { dueOffset: 1.5 })] },
      { tasks: [task("a", { dueOffset: "7" })] },
      { tasks: [task("a", { priority: "critical" })] },
      { milestones: [{ key: "m", title: "M", targetOffset: -14 }] },
      { project: { name: "P", status: "completed" } },
      { project: { name: "P", type: "spaceship" } },
      { documents: [{ title: "D", content: "x".repeat(50_001) }] },
      { checklist: [{ taskKey: "a", text: "x".repeat(501) }] },
    ];
    for (const extra of bad) {
      assert.equal(templateContentSchema.safeParse({ name: "T", project: { name: "P" }, ...extra }).success, false, JSON.stringify(extra));
    }
    assert.equal(templateContentSchema.safeParse({ name: "T", project: { name: "P" }, tasks: new Array(MAX_TEMPLATE_TASKS + 1).fill(0).map((_, i) => task(`t${i}`)) }).success, false);
  });

  it("creates an empty template from a name alone", () => {
    const parsed = templateCreateSchema.parse({ name: "  Launch  " });
    assert.equal(parsed.name, "Launch");
    assert.equal(parsed.project.name, "Launch");
    assert.deepEqual([parsed.milestones, parsed.tasks, parsed.dependencies, parsed.checklist, parsed.documents], [[], [], [], [], []]);
  });

  it("validates apply requests strictly", () => {
    assert.ok(templateApplySchema.safeParse({ idempotencyKey: "a".repeat(16), startDate: "2026-10-01" }).success);
    for (const body of [
      { idempotencyKey: "short", startDate: "2026-10-01" },
      { idempotencyKey: "a".repeat(16), startDate: "2026-02-30" },
      { idempotencyKey: "a".repeat(16), startDate: "10/01/2026" },
      { idempotencyKey: "a".repeat(16), startDate: "2026-10-01", workspaceId: "ws" },
      { idempotencyKey: "has spaces in it!!", startDate: "2026-10-01" },
    ]) {
      assert.equal(templateApplySchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });
});

describe("structural validation", () => {
  it("accepts a coherent template", () => {
    const c = content({
      milestones: [{ key: "m1", title: "M1", description: null, targetOffset: 14 }],
      tasks: [
        task("a", { milestoneKey: "m1", dueOffset: 7 }),
        task("b", { parentKey: "a" }),
        task("c"),
      ] as never,
      dependencies: [{ taskKey: "c", dependsOnKey: "a" }],
      checklist: [{ taskKey: "a", text: "One" }],
    });
    assert.deepEqual(validateTemplate(c), []);
  });

  it("rejects missing references, duplicates and self-dependencies", () => {
    const issues = validateTemplate(
      content({
        tasks: [task("a", { milestoneKey: "nope" }), task("a"), task("b", { parentKey: "ghost" })] as never,
        dependencies: [
          { taskKey: "b", dependsOnKey: "b" },
          { taskKey: "b", dependsOnKey: "zzz" },
          { taskKey: "b", dependsOnKey: "a" },
          { taskKey: "b", dependsOnKey: "a" },
        ],
        checklist: [{ taskKey: "missing", text: "x" }],
      }),
    ).map((i) => i.message);
    for (const expected of [
      'Unknown milestone "nope".',
      'Duplicate task key "a".',
      'Unknown parent task "ghost".',
      "A task cannot depend on itself.",
      'Unknown task "zzz".',
      "Duplicate dependency.",
      'Unknown task "missing".',
    ]) {
      assert.ok(issues.includes(expected), `${expected} in ${JSON.stringify(issues)}`);
    }
  });

  it("enforces one-level subtasks", () => {
    const issues = validateTemplate(
      content({ tasks: [task("a"), task("b", { parentKey: "a" }), task("c", { parentKey: "b" }), task("d", { parentKey: "d" })] as never }),
    ).map((i) => `${i.path}: ${i.message}`);
    assert.ok(issues.some((m) => m.startsWith("tasks[2].parentKey") && m.includes("one level deep")));
    assert.ok(issues.some((m) => m.startsWith("tasks[1].parentKey") && m.includes("cannot itself be a subtask")));
    assert.ok(issues.some((m) => m.startsWith("tasks[3].parentKey") && m.includes("its own parent")));
  });

  it("detects cycles iteratively, even across the maximum number of tasks", () => {
    assert.deepEqual(
      findCycleMembers({
        tasks: [task("a"), task("b"), task("c"), task("d")] as never,
        dependencies: [
          { taskKey: "a", dependsOnKey: "b" },
          { taskKey: "b", dependsOnKey: "c" },
          { taskKey: "c", dependsOnKey: "a" },
          { taskKey: "d", dependsOnKey: "a" },
        ],
      }),
      ["a", "b", "c", "d"],
    );
    // A 300-long chain closed into a loop: no recursion, so no stack overflow.
    const keys = Array.from({ length: MAX_TEMPLATE_TASKS }, (_, i) => `t${i}`);
    const chain = keys.slice(1).map((k, i) => ({ taskKey: k, dependsOnKey: keys[i]! }));
    assert.deepEqual(findCycleMembers({ tasks: keys.map((k) => task(k)) as never, dependencies: chain }), []);
    const loop = [...chain, { taskKey: keys[0]!, dependsOnKey: keys[keys.length - 1]! }];
    assert.equal(findCycleMembers({ tasks: keys.map((k) => task(k)) as never, dependencies: loop }).length, MAX_TEMPLATE_TASKS);
    assert.ok(chain.length <= MAX_TEMPLATE_DEPENDENCIES);
    assert.ok(validateTemplate(content({ tasks: keys.map((k) => task(k)) as never, dependencies: loop })).some((i) => i.message.startsWith("Dependencies form a cycle")));
  });

  it("enforces per-task checklist and total document limits", () => {
    const tooMany = content({
      tasks: [task("a")] as never,
      checklist: Array.from({ length: MAX_CHECKLIST_ITEMS_PER_TASK + 1 }, (_, i) => ({ taskKey: "a", text: `Item ${i}` })),
    });
    assert.ok(validateTemplate(tooMany).some((i) => i.message.includes(`at most ${MAX_CHECKLIST_ITEMS_PER_TASK}`)));
    const docs = Array.from({ length: 11 }, (_, i) => ({ title: `D${i}`, content: "x".repeat(50_000), category: null, pinned: false }));
    assert.ok(11 * 50_000 > MAX_TOTAL_DOCUMENT_CONTENT);
    assert.ok(validateTemplate(content({ documents: docs })).some((i) => i.path === "documents"));
  });
});

describe("preview", () => {
  const c = content({
    project: { name: "Launch plan", description: null, type: "software", status: "planning" },
    milestones: [
      { key: "beta", title: "Beta", description: null, targetOffset: 14 },
      { key: "ga", title: "GA", description: null, targetOffset: null },
    ],
    tasks: [
      task("spec", { dueOffset: 0, milestoneKey: "beta", priority: "high" }),
      task("spec-review", { parentKey: "spec", dueOffset: 2 }),
      task("build", { dueOffset: 10 }),
    ] as never,
    dependencies: [{ taskKey: "build", dependsOnKey: "spec" }],
    checklist: [
      { taskKey: "spec", text: "Draft" },
      { taskKey: "spec", text: "Review" },
    ],
    documents: [{ title: "Runbook", content: "hello", category: "Ops", pinned: true }],
  });

  it("computes every date, the hierarchy, dependencies and counts on the server", () => {
    const p = previewTemplate("tpl_1", c, "2026-02-27");
    assert.equal(p.projectName, "Launch plan");
    assert.deepEqual(p.milestones.map((m) => [m.key, m.targetDate]), [["beta", "2026-03-13"], ["ga", null]]);
    assert.deepEqual(p.tasks.map((t) => [t.key, t.dueDate, t.parentKey, t.dependsOn, t.checklistCount]), [
      ["spec", "2026-02-27", null, [], 2],
      ["spec-review", "2026-03-01", "spec", [], 0],
      ["build", "2026-03-09", null, ["spec"], 0],
    ]);
    assert.deepEqual(p.documents, [{ title: "Runbook", category: "Ops", pinned: true, characters: 5 }]);
    assert.deepEqual(p.counts, { milestones: 2, tasks: 3, subtasks: 1, dependencies: 1, checklist: 2, documents: 1, records: 12 });
    assert.deepEqual(p.errors, []);
    assert.ok(p.warnings.some((w) => w.includes("unassigned")));
  });

  it("honours a project name override and reports dates past the calendar as errors", () => {
    assert.equal(previewTemplate("tpl_1", c, "2026-02-27", "Custom").projectName, "Custom");
    const p = previewTemplate("tpl_1", c, "9999-12-25");
    assert.ok(p.errors.some((e) => e.path === "milestones[0].targetOffset"));
    assert.ok(p.errors.some((e) => e.path === "tasks[2].dueOffset"));
    assert.equal(p.tasks[0]!.dueDate, "9999-12-25");
  });
});
