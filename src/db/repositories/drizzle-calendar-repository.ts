/**
 * SQLite CalendarRepository (Release 2D.1), desktop only. Single-tenant: it
 * asserts `LOCAL_WORKSPACE_ID`, like every Drizzle repository here.
 *
 * Due dates are stored as text — normally "YYYY-MM-DD", occasionally a full
 * ISO timestamp from older API clients. The calendar day is the value's UTC
 * date (design note §2). The range query uses an index-friendly lexical
 * prefilter widened by a day on each side (absorbing any ±14h offset), then
 * the exact rule via SQLite's `date()`, which converts offsets to UTC.
 */
import { and, asc, eq, gte, inArray, isNull, lt, or, gt, sql, type SQL } from "drizzle-orm";
import { db } from "../client";
import { milestones, projects, tasks } from "../schema";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import { addDays, calendarDayOf, isDateOnly, type DateOnly } from "@/core/calendar/dates";
import {
  decodeUnscheduledCursor,
  encodeFilterSearchCursor,
  encodeUnscheduledCursor,
  likePattern,
  type FilterSearchCursor,
} from "@/core/calendar/query";
import {
  MAX_FILTER_MEMBERS,
  MAX_FILTER_PROJECTS,
  MILESTONE_STATUSES_FOR,
  TASK_STATUSES_FOR,
  type CalendarFilterOptions,
  type CalendarFilters,
  type CalendarItem,
  type CalendarRangeResult,
  type FilterSearchPage,
  type UnscheduledPage,
} from "@/core/calendar/types";
import type { CalendarRepository } from "./calendar-repository";
import { compareCalendarItems } from "@/core/calendar/order";

function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleCalendarRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresCalendarRepository instead.",
    );
  }
}

function assertNoAssignee(filters: Omit<CalendarFilters, "kind">): void {
  // Desktop has no users; the route rejects assignee filters before this.
  if (filters.assignee) throw new Error("Assignee filters are not supported on desktop.");
}

function taskFilterConditions(filters: Omit<CalendarFilters, "kind">): SQL[] {
  const conditions: SQL[] = [];
  if (filters.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
  const statuses = TASK_STATUSES_FOR[filters.status];
  if (statuses) conditions.push(inArray(tasks.status, [...statuses]));
  return conditions;
}

/**
 * Lexical upper bound for the prefilter. Near the end of the calendar,
 * `to + 2 days` is year 10000, and "10000-…" sorts BEFORE "9999-…" as text, which
 * would silently drop 9999-12-31. Past MAX_DATE the bound is "9999-99", which
 * sorts after every stored "9999-MM-DD…" value.
 */
function lexicalUpperBound(to: DateOnly): string {
  const bound = addDays(to, 2);
  return isDateOnly(bound) ? bound : "9999-99";
}

export function dayRange(column: typeof tasks.dueDate | typeof milestones.dueDate, from: DateOnly, to: DateOnly): SQL[] {
  return [
    // "1899-12-31" is a safe lexical lower bound too; it just isn't a supported day.
    gte(column, addDays(from, -1)),
    lt(column, lexicalUpperBound(to)),
    sql`date(${column}) between ${from} and ${to}`,
  ];
}

export class DrizzleCalendarRepository implements CalendarRepository {
  async listRange(
    workspaceId: string,
    range: { from: DateOnly; to: DateOnly },
    filters: CalendarFilters,
    limit: number,
  ): Promise<CalendarRangeResult> {
    assertLocalWorkspace(workspaceId);
    assertNoAssignee(filters);
    const items: CalendarItem[] = [];

    if (filters.kind !== "milestones") {
      const rows = db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          projectId: tasks.projectId,
          projectName: projects.name,
          status: tasks.status,
        })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(...dayRange(tasks.dueDate, range.from, range.to), ...taskFilterConditions(filters)))
        .orderBy(asc(tasks.dueDate), asc(tasks.title), asc(tasks.id))
        .limit(limit + 1)
        .all();
      for (const row of rows) {
        const date = calendarDayOf(row.dueDate);
        if (date) items.push({ kind: "task", ...row, date, assigneeId: null });
      }
    }

    if (filters.kind !== "tasks") {
      const conditions: SQL[] = [...dayRange(milestones.dueDate, range.from, range.to)];
      if (filters.projectId) conditions.push(eq(milestones.projectId, filters.projectId));
      const statuses = MILESTONE_STATUSES_FOR[filters.status];
      if (statuses) conditions.push(inArray(milestones.status, [...statuses]));
      const rows = db
        .select({
          id: milestones.id,
          title: milestones.title,
          dueDate: milestones.dueDate,
          projectId: milestones.projectId,
          projectName: projects.name,
          status: milestones.status,
        })
        .from(milestones)
        .innerJoin(projects, eq(projects.id, milestones.projectId))
        .where(and(...conditions))
        .orderBy(asc(milestones.dueDate), asc(milestones.title), asc(milestones.id))
        .limit(limit + 1)
        .all();
      for (const row of rows) {
        const date = calendarDayOf(row.dueDate);
        if (date) items.push({ kind: "milestone", ...row, date, assigneeId: null });
      }
    }

    items.sort(compareCalendarItems);
    return { items: items.slice(0, limit), truncated: items.length > limit };
  }

  async listUnscheduled(
    workspaceId: string,
    filters: Omit<CalendarFilters, "kind">,
    page: { limit: number; cursor?: string },
  ): Promise<UnscheduledPage> {
    assertLocalWorkspace(workspaceId);
    assertNoAssignee(filters);
    const conditions: SQL[] = [
      or(isNull(tasks.dueDate), eq(tasks.dueDate, ""))!,
      ...taskFilterConditions(filters),
    ];
    if (page.cursor) {
      const cursor = decodeUnscheduledCursor(page.cursor);
      conditions.push(
        or(gt(tasks.createdAt, cursor.createdAt), and(eq(tasks.createdAt, cursor.createdAt), gt(tasks.id, cursor.id)))!,
      );
    }
    const rows = db
      .select({
        id: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        projectName: projects.name,
        status: tasks.status,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(...conditions))
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .limit(page.limit + 1)
      .all();
    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(({ createdAt: _createdAt, ...row }) => ({ kind: "task" as const, ...row, assigneeId: null })),
      nextCursor: hasMore && last ? encodeUnscheduledCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async projectExists(workspaceId: string, projectId: string): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    const row = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1).get();
    return Boolean(row);
  }

  async memberExists(workspaceId: string): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    return false;
  }

  async searchFilterOptions(
    workspaceId: string,
    type: "projects" | "members",
    search: { q: string; limit: number; cursor?: FilterSearchCursor },
  ): Promise<FilterSearchPage> {
    assertLocalWorkspace(workspaceId);
    // Desktop has no users; the route refuses member searches before this.
    if (type !== "projects") throw new Error("Member search is not supported on desktop.");
    const sortKey = sql<string>`lower(${projects.name})`;
    const conditions: SQL[] = [];
    if (search.q) conditions.push(sql`${sortKey} like ${likePattern(search.q)} escape '\\'`);
    if (search.cursor) {
      conditions.push(
        or(
          sql`${sortKey} > ${search.cursor.k}`,
          and(sql`${sortKey} = ${search.cursor.k}`, gt(projects.id, search.cursor.id)),
        )!,
      );
    }
    const rows = db
      .select({ id: projects.id, name: projects.name, sortKey })
      .from(projects)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(sortKey, asc(projects.id))
      .limit(search.limit + 1)
      .all();
    const hasMore = rows.length > search.limit;
    const page = hasMore ? rows.slice(0, search.limit) : rows;
    const last = page[page.length - 1];
    return {
      results: page.map((r) => ({ id: r.id, name: r.name })),
      nextCursor: hasMore && last ? encodeFilterSearchCursor({ k: last.sortKey, id: last.id }) : null,
    };
  }

  async listFilterOptions(workspaceId: string): Promise<CalendarFilterOptions> {
    assertLocalWorkspace(workspaceId);
    const projectRows = db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .orderBy(asc(projects.name), asc(projects.id))
      .limit(MAX_FILTER_PROJECTS + 1)
      .all();
    return {
      projects: projectRows.slice(0, MAX_FILTER_PROJECTS),
      projectsTruncated: projectRows.length > MAX_FILTER_PROJECTS,
      projectLimit: MAX_FILTER_PROJECTS,
      // Desktop has no users.
      members: [],
      membersTruncated: false,
      memberLimit: MAX_FILTER_MEMBERS,
    };
  }
}
