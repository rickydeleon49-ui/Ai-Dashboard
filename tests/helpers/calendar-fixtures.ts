/**
 * Shared Release 2D.1 calendar fixture. The SQLite (tests/unit) and PostgreSQL
 * (tests/unit-pg) repository suites seed exactly these rows through their own
 * task/milestone repositories and must return exactly these results — that is
 * the parity guarantee.
 */
import assert from "node:assert/strict";
import type { CalendarRepository } from "../../src/db/repositories/calendar-repository";
import type { CalendarFilters } from "../../src/core/calendar/types";

export const PARITY_TASKS = [
  { title: "Sep 30 plain", dueDate: "2026-09-30" },
  { title: "Oct 1 plain", dueDate: "2026-10-01" },
  { title: "Oct 31 plain", dueDate: "2026-10-31" },
  { title: "Nov 1 plain", dueDate: "2026-11-01" },
  // Legacy full timestamps: calendar day is the UTC date.
  { title: "Legacy late", dueDate: "2026-10-31T23:30:00-05:00" }, // → 2026-11-01
  { title: "Legacy early", dueDate: "2026-10-01T01:00:00+05:00" }, // → 2026-09-30
  { title: "Leap day", dueDate: "2028-02-29" },
  { title: "Year end", dueDate: "2026-12-31" },
  { title: "Year start", dueDate: "2027-01-01" },
  { title: "Done Oct 2", dueDate: "2026-10-02", status: "done" as const },
  // The supported calendar's first and last days.
  { title: "First supported day", dueDate: "1900-01-01" },
  { title: "Last supported day", dueDate: "9999-12-31" },
  { title: "Unscheduled A" },
  { title: "Unscheduled B" },
] as const;

export const PARITY_MILESTONES = [
  { title: "Milestone Oct 15", dueDate: "2026-10-15" },
  { title: "Milestone done Oct 20", dueDate: "2026-10-20", status: "completed" as const },
  { title: "Last milestone", dueDate: "9999-12-31" },
  { title: "Milestone undated" },
] as const;

const ALL: CalendarFilters = { status: "all", kind: "all" };

/** Runs the shared parity assertions against one repository implementation. */
export async function assertCalendarParity(repo: CalendarRepository, workspaceId: string, projectId: string) {
  const titles = async (from: string, to: string, filters: CalendarFilters = ALL) =>
    (await repo.listRange(workspaceId, { from, to }, filters, 1000)).items.map((i) => `${i.date} ${i.kind} ${i.title}`);

  assert.deepEqual(await titles("2026-10-01", "2026-10-31"), [
    "2026-10-01 task Oct 1 plain",
    "2026-10-02 task Done Oct 2",
    "2026-10-15 milestone Milestone Oct 15",
    "2026-10-20 milestone Milestone done Oct 20",
    "2026-10-31 task Oct 31 plain",
  ]);
  assert.deepEqual(await titles("2026-11-01", "2026-11-01"), ["2026-11-01 task Legacy late", "2026-11-01 task Nov 1 plain"]);
  assert.deepEqual(await titles("2026-09-30", "2026-09-30"), ["2026-09-30 task Legacy early", "2026-09-30 task Sep 30 plain"]);
  assert.deepEqual(await titles("2026-12-28", "2027-01-03"), ["2026-12-31 task Year end", "2027-01-01 task Year start"]);
  assert.deepEqual(await titles("2028-02-29", "2028-02-29"), ["2028-02-29 task Leap day"]);
  // Ranges ending on 9999-12-31 and starting on 1900-01-01 (the December 9999
  // and January 1900 month grids) return their items rather than failing.
  assert.deepEqual(await titles("9999-11-29", "9999-12-31"), [
    "9999-12-31 milestone Last milestone",
    "9999-12-31 task Last supported day",
  ]);
  assert.deepEqual(await titles("9999-12-31", "9999-12-31"), [
    "9999-12-31 milestone Last milestone",
    "9999-12-31 task Last supported day",
  ]);
  assert.deepEqual(await titles("1900-01-01", "1900-02-04"), ["1900-01-01 task First supported day"]);
  assert.deepEqual(await titles("2026-10-01", "2026-10-31", { status: "open", kind: "all" }), [
    "2026-10-01 task Oct 1 plain",
    "2026-10-15 milestone Milestone Oct 15",
    "2026-10-31 task Oct 31 plain",
  ]);
  assert.deepEqual(await titles("2026-10-01", "2026-10-31", { status: "done", kind: "all" }), [
    "2026-10-02 task Done Oct 2",
    "2026-10-20 milestone Milestone done Oct 20",
  ]);
  assert.deepEqual(await titles("2026-10-01", "2026-10-31", { status: "all", kind: "milestones" }), [
    "2026-10-15 milestone Milestone Oct 15",
    "2026-10-20 milestone Milestone done Oct 20",
  ]);
  assert.equal((await titles("2026-10-01", "2026-10-31", { status: "all", kind: "tasks" })).length, 3);
  assert.deepEqual(await titles("2026-10-01", "2026-10-31", { status: "all", kind: "all", projectId: "prj_none" }), []);
  assert.equal((await titles("2026-10-01", "2026-10-31", { ...ALL, projectId })).length, 5);

  const unscheduled = await repo.listUnscheduled(workspaceId, { status: "all" }, { limit: 25 });
  assert.deepEqual(unscheduled.items.map((i) => i.title).sort(), ["Unscheduled A", "Unscheduled B"]);
  assert.equal(unscheduled.nextCursor, null);
  assert.ok(unscheduled.items.every((i) => i.projectId === projectId && i.projectName));

  const capped = await repo.listRange(workspaceId, { from: "2026-09-28", to: "2026-11-08" }, ALL, 3);
  assert.equal(capped.items.length, 3);
  assert.equal(capped.truncated, true);

  assert.equal(await repo.projectExists(workspaceId, projectId), true);
  assert.equal(await repo.projectExists(workspaceId, "prj_does_not_exist"), false);
}

/** Pages through every unscheduled task, asserting no repeats. */
export async function collectUnscheduled(repo: CalendarRepository, workspaceId: string, limit: number) {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await repo.listUnscheduled(workspaceId, { status: "all" }, { limit, ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages < 1000, "paging terminates");
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length, "no task repeated across pages");
  return { seen, pages };
}
