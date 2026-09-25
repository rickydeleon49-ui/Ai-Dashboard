/**
 * Shared Release 2D.2 timeline fixture, seeded through the real repositories
 * (so dependencies and statuses obey production rules) and asserted
 * identically for SQLite (tests/unit/timeline.test.ts) and PostgreSQL
 * (tests/unit-pg/timeline-repository.test.ts).
 *
 * Quarter window anchored 2026-11-18 = 2026-09-28 … 2027-01-03.
 *
 *   Kickoff (milestone, 10-01, completed)
 *   Design  (11-02, done)
 *   Old approach (11-05, cancelled)
 *   Build   (11-10, in progress, milestone Launch) → Design (done), API
 *   API     (11-12)                               → Vendor contract (OTHER project, undated)
 *   Launch  (milestone, 11-20)
 *   Test    (11-25, milestone Launch)             → Build
 *   Ship    (11-30)                               → Later (2027-02-01, outside the window)
 *   Docs    (undated, milestone Launch = partially dated) → Old approach (cancelled)
 *   Idea    (undated)
 *   Someday (milestone, no target date)
 */
import assert from "node:assert/strict";
import type { MilestoneRepository } from "../../src/db/repositories/milestone-repository";
import type { ProjectRepository } from "../../src/db/repositories/project-repository";
import type { TaskRepository } from "../../src/db/repositories/task-repository";
import type { TimelineItem, TimelineResponse, TimelineTaskItem } from "../../src/core/timeline/types";

export const FIXTURE_ANCHOR = "2026-11-18";
export const FIXTURE_PROJECT = "Timeline parity";

export interface TimelineRepos {
  projectRepository: ProjectRepository;
  taskRepository: TaskRepository;
  milestoneRepository: MilestoneRepository;
}

export async function seedTimelineFixture(repos: TimelineRepos, workspaceId: string, projectName = FIXTURE_PROJECT) {
  const { projectRepository: projects, taskRepository: tasks, milestoneRepository: milestones } = repos;
  const project = await projects.create(workspaceId, { name: projectName });
  const other = await projects.create(workspaceId, { name: `${projectName} — other project` });
  const p = project.id;

  const launch = await milestones.create(workspaceId, { projectId: p, title: "Launch", dueDate: "2026-11-20" });
  await milestones.create(workspaceId, { projectId: p, title: "Kickoff", dueDate: "2026-10-01", status: "completed" });
  await milestones.create(workspaceId, { projectId: p, title: "Someday" });

  const t = async (title: string, extra: Record<string, unknown> = {}) =>
    (await tasks.create(workspaceId, { projectId: p, title, ...extra })).id;
  const design = await t("Design", { dueDate: "2026-11-02", status: "done" });
  const oldApproach = await t("Old approach", { dueDate: "2026-11-05", status: "cancelled" });
  const build = await t("Build", { dueDate: "2026-11-10", status: "in_progress", milestoneId: launch.id });
  const api = await t("API", { dueDate: "2026-11-12" });
  const test = await t("Test", { dueDate: "2026-11-25", milestoneId: launch.id });
  const ship = await t("Ship", { dueDate: "2026-11-30" });
  const later = await t("Later", { dueDate: "2027-02-01" });
  const docs = await t("Docs", { milestoneId: launch.id });
  await t("Idea");
  const vendor = (await tasks.create(workspaceId, { projectId: other.id, title: "Vendor contract" })).id;

  await tasks.addDependency(workspaceId, build, design);
  await tasks.addDependency(workspaceId, build, api);
  await tasks.addDependency(workspaceId, api, vendor);
  await tasks.addDependency(workspaceId, test, build);
  await tasks.addDependency(workspaceId, ship, later);
  await tasks.addDependency(workspaceId, docs, oldApproach);

  return { projectId: p, otherProjectId: other.id };
}

function byTitle(list: TimelineItem[], title: string): TimelineItem {
  const found = list.find((i) => i.title === title);
  assert.ok(found, `item "${title}"`);
  return found;
}

function taskByTitle(list: TimelineItem[], title: string): TimelineTaskItem {
  const item = byTitle(list, title);
  assert.equal(item.kind, "task", `${title} is a task`);
  return item as TimelineTaskItem;
}

/** Everything a quarter response for the fixture must say, independent of database. */
export function assertTimelineParity(body: TimelineResponse) {
  assert.equal(body.projectName, FIXTURE_PROJECT);
  assert.deepEqual([body.zoom, body.anchor, body.from, body.to], ["quarter", FIXTURE_ANCHOR, "2026-09-28", "2027-01-03"]);
  assert.equal(body.editable, false);

  assert.deepEqual(
    body.items.map((i) => `${i.kind}:${i.title}:${i.date}:${i.status}`),
    [
      "milestone:Kickoff:2026-10-01:completed",
      "task:Design:2026-11-02:done",
      "task:Old approach:2026-11-05:cancelled",
      "task:Build:2026-11-10:in_progress",
      "task:API:2026-11-12:todo",
      "milestone:Launch:2026-11-20:open",
      "task:Test:2026-11-25:todo",
      "task:Ship:2026-11-30:todo",
    ],
  );
  assert.deepEqual(
    body.undated.map((i) => `${i.kind}:${i.title}:${i.kind === "task" ? i.milestoneDate : i.date}`),
    ["task:Docs:2026-11-20", "task:Idea:null", "milestone:Someday:null"],
  );

  const blocked = [...body.items, ...body.undated]
    .filter((i): i is TimelineTaskItem => i.kind === "task" && i.blocked)
    .map((i) => i.title);
  assert.deepEqual(blocked, ["Build", "API", "Test", "Ship"]);

  const titleOf = (id: string) => body.nodes[id]?.title;
  const explain = (title: string) => {
    const b = taskByTitle(body.items, title).blocking;
    return {
      immediate: b.immediateBlockers.map(titleOf),
      roots: b.roots.map(titleOf),
      path: b.path.map(([from, to]) => `${titleOf(from)}>${titleOf(to)}`),
    };
  };
  // Cross-project blocker, transitive chains, a resolved (done) branch skipped.
  assert.deepEqual(explain("API"), { immediate: ["Vendor contract"], roots: ["Vendor contract"], path: ["API>Vendor contract"] });
  assert.deepEqual(explain("Build"), {
    immediate: ["API"],
    roots: ["API", "Vendor contract"],
    path: ["Build>API", "API>Vendor contract"],
  });
  assert.deepEqual(explain("Test"), {
    immediate: ["Build"],
    roots: ["Build", "API", "Vendor contract"],
    path: ["Test>Build", "Build>API", "API>Vendor contract"],
  });
  // A blocker outside the window is named, not drawn.
  assert.deepEqual(explain("Ship"), { immediate: ["Later"], roots: ["Later"], path: ["Ship>Later"] });
  // A cancelled dependency blocks nothing.
  const docs = taskByTitle(body.undated, "Docs");
  assert.equal(docs.blocked, false);
  assert.deepEqual(docs.dependsOn.map(titleOf), ["Old approach"]);
  assert.deepEqual(docs.blocking.roots, []);

  assert.deepEqual(taskByTitle(body.items, "Build").conflicts, ["due_before_blocker"]);
  assert.deepEqual(taskByTitle(body.items, "Test").conflicts, ["due_after_milestone"]);
  assert.deepEqual(taskByTitle(body.items, "Ship").conflicts, ["due_before_blocker"]);
  assert.deepEqual(taskByTitle(body.items, "API").conflicts, [], "an undated blocker proves no conflict");

  assert.deepEqual(
    body.edges.map((e) => `${titleOf(e.taskId)}>${titleOf(e.dependsOnTaskId)}`).sort(),
    ["API>Vendor contract", "Build>API", "Build>Design", "Docs>Old approach", "Ship>Later", "Test>Build"],
  );
  const vendor = Object.values(body.nodes).find((n) => n.title === "Vendor contract")!;
  assert.equal(vendor.inProject, false);
  assert.equal(vendor.projectName, `${FIXTURE_PROJECT} — other project`);
  const later = Object.values(body.nodes).find((n) => n.title === "Later")!;
  assert.deepEqual([later.inProject, later.date], [true, "2027-02-01"]);

  assert.deepEqual(body.truncated, { tasks: false, milestones: false, undatedTasks: false, undatedMilestones: false, edges: false });
}

/** Keys that must never appear anywhere in a timeline payload. */
export const FORBIDDEN_TIMELINE_KEYS = [
  "email",
  "emailVerified",
  "image",
  "password",
  "passwordHash",
  "token",
  "secret",
  "description",
  "body",
  "comments",
  "content",
  "sessionToken",
  "accessToken",
  "refreshToken",
  "role",
];

export function assertNoForbiddenKeys(value: unknown, path = "body") {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenKeys(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      assert.ok(!FORBIDDEN_TIMELINE_KEYS.includes(key), `${path}.${key} must not be in a timeline payload`);
      assertNoForbiddenKeys(v, `${path}.${key}`);
    }
  }
}
