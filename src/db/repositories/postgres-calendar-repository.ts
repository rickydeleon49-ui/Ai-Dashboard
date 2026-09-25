import "server-only";

/**
 * PostgreSQL CalendarRepository (Release 2D.1), accounts mode. Every query is
 * scoped by `workspace_id`, and the project join is constrained to the same
 * workspace, so no row or project name from another workspace can appear.
 * Range reads use the existing (workspace_id, due_date) indexes.
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { milestones, projects, tasks, users, workspaceMembers } from "../schema.pg";
import { calendarDayOf, type DateOnly } from "@/core/calendar/dates";
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
import { compareCalendarItems } from "@/core/calendar/order";
import type { CalendarRepository } from "./calendar-repository";

/**
 * `column`'s calendar day (its UTC date — stored timestamps are UTC) lies in
 * [from, to]. The bounds are PostgreSQL `date`s, not JavaScript Dates: the
 * exclusive upper bound for 9999-12-31 is 10000-01-01, which a JavaScript ISO
 * string cannot express but PostgreSQL's date type can. Cross-type
 * timestamp/date comparison stays index-usable.
 */
export function inDayRange(column: typeof tasks.dueDate | typeof milestones.dueDate, from: DateOnly, to: DateOnly): SQL[] {
  return [sql`${column} >= ${from}::date`, sql`${column} < (${to}::date + 1)`];
}

function taskFilterConditions(filters: Omit<CalendarFilters, "kind">): SQL[] {
  const conditions: SQL[] = [];
  if (filters.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
  if (filters.assignee?.kind === "unassigned") conditions.push(isNull(tasks.assigneeId));
  if (filters.assignee?.kind === "user") conditions.push(eq(tasks.assigneeId, filters.assignee.userId));
  const statuses = TASK_STATUSES_FOR[filters.status];
  if (statuses) conditions.push(inArray(tasks.status, [...statuses]));
  return conditions;
}

export class PostgresCalendarRepository implements CalendarRepository {
  async listRange(
    workspaceId: string,
    range: { from: DateOnly; to: DateOnly },
    filters: CalendarFilters,
    limit: number,
  ): Promise<CalendarRangeResult> {
    const db = getPgDb();
    const items: CalendarItem[] = [];

    if (filters.kind !== "milestones") {
      const rows = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          projectId: tasks.projectId,
          projectName: projects.name,
          status: tasks.status,
          assigneeId: tasks.assigneeId,
        })
        .from(tasks)
        .innerJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.workspaceId, tasks.workspaceId)))
        .where(
          and(
            eq(tasks.workspaceId, workspaceId),
            ...inDayRange(tasks.dueDate, range.from, range.to),
            ...taskFilterConditions(filters),
          ),
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.title), asc(tasks.id))
        .limit(limit + 1);
      for (const row of rows) {
        const date = calendarDayOf(row.dueDate);
        if (!date) continue;
        items.push({ kind: "task", ...row, date, assigneeId: row.assigneeId ?? null });
      }
    }

    // Milestones have no assignee, so an assignee filter excludes them.
    if (filters.kind !== "tasks" && !filters.assignee) {
      const conditions: SQL[] = [
        eq(milestones.workspaceId, workspaceId),
        ...inDayRange(milestones.dueDate, range.from, range.to),
      ];
      if (filters.projectId) conditions.push(eq(milestones.projectId, filters.projectId));
      const statuses = MILESTONE_STATUSES_FOR[filters.status];
      if (statuses) conditions.push(inArray(milestones.status, [...statuses]));
      const rows = await db
        .select({
          id: milestones.id,
          title: milestones.title,
          dueDate: milestones.dueDate,
          projectId: milestones.projectId,
          projectName: projects.name,
          status: milestones.status,
        })
        .from(milestones)
        .innerJoin(
          projects,
          and(eq(projects.id, milestones.projectId), eq(projects.workspaceId, milestones.workspaceId)),
        )
        .where(and(...conditions))
        .orderBy(asc(milestones.dueDate), asc(milestones.title), asc(milestones.id))
        .limit(limit + 1);
      for (const row of rows) {
        const date = calendarDayOf(row.dueDate);
        if (!date) continue;
        items.push({ kind: "milestone", ...row, date, assigneeId: null });
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
    // Keyset over millisecond-truncated created_at: rows written by SQL now()
    // carry microseconds, which a JavaScript Date (and so the cursor) cannot
    // represent. Ordering and comparing on the same truncated value keeps
    // paging exact — nothing repeated, nothing skipped.
    const createdMs = sql<Date>`date_trunc('milliseconds', ${tasks.createdAt})`;
    const conditions: SQL[] = [eq(tasks.workspaceId, workspaceId), isNull(tasks.dueDate), ...taskFilterConditions(filters)];
    if (page.cursor) {
      const cursor = decodeUnscheduledCursor(page.cursor);
      const at = new Date(cursor.createdAt).toISOString();
      conditions.push(sql`(${createdMs}, ${tasks.id}) > (${at}::timestamp, ${cursor.id})`);
    }
    const rows = await getPgDb()
      .select({
        id: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        projectName: projects.name,
        status: tasks.status,
        assigneeId: tasks.assigneeId,
        // A raw expression bypasses the column's own mapper; the driver hands back
        // the UTC wall-clock text of a `timestamp`, so read it as UTC explicitly.
        createdAt: createdMs.mapWith((v: string | Date) =>
          v instanceof Date ? v : new Date(`${String(v).replace(" ", "T")}Z`),
        ),
      })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.workspaceId, tasks.workspaceId)))
      .where(and(...conditions))
      .orderBy(asc(createdMs), asc(tasks.id))
      .limit(page.limit + 1);
    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(({ createdAt: _createdAt, ...row }) => ({
        kind: "task" as const,
        ...row,
        assigneeId: row.assigneeId ?? null,
      })),
      nextCursor:
        hasMore && last ? encodeUnscheduledCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  async projectExists(workspaceId: string, projectId: string): Promise<boolean> {
    const [row] = await getPgDb()
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    return Boolean(row);
  }

  async memberExists(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await getPgDb()
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    return Boolean(row);
  }

  async searchFilterOptions(
    workspaceId: string,
    type: "projects" | "members",
    search: { q: string; limit: number; cursor?: FilterSearchCursor },
  ): Promise<FilterSearchPage> {
    const db = getPgDb();
    const pattern = likePattern(search.q);
    let rows: { id: string; name: string | null; sortKey: string }[];
    if (type === "projects") {
      const sortKey = sql<string>`lower(${projects.name})`;
      const conditions: SQL[] = [eq(projects.workspaceId, workspaceId)];
      if (search.q) conditions.push(sql`${sortKey} like ${pattern} escape '\\'`);
      if (search.cursor) conditions.push(sql`(${sortKey}, ${projects.id}) > (${search.cursor.k}, ${search.cursor.id})`);
      rows = await db
        .select({ id: projects.id, name: projects.name, sortKey })
        .from(projects)
        .where(and(...conditions))
        .orderBy(sortKey, asc(projects.id))
        .limit(search.limit + 1);
    } else {
      // Active members only, and only id + name. Matching is on the name
      // alone — never email, so a search cannot probe for an address.
      const sortKey = sql<string>`coalesce(lower(${users.name}), '')`;
      const conditions: SQL[] = [
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.status, "active"),
      ];
      if (search.q) conditions.push(sql`${sortKey} like ${pattern} escape '\\'`);
      if (search.cursor) conditions.push(sql`(${sortKey}, ${users.id}) > (${search.cursor.k}, ${search.cursor.id})`);
      rows = await db
        .select({ id: users.id, name: users.name, sortKey })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(...conditions))
        .orderBy(sortKey, asc(users.id))
        .limit(search.limit + 1);
    }
    const hasMore = rows.length > search.limit;
    const page = hasMore ? rows.slice(0, search.limit) : rows;
    const last = page[page.length - 1];
    return {
      results: page.map((r) => ({ id: r.id, name: r.name })),
      nextCursor: hasMore && last ? encodeFilterSearchCursor({ k: last.sortKey, id: last.id }) : null,
    };
  }

  async listFilterOptions(workspaceId: string): Promise<CalendarFilterOptions> {
    const db = getPgDb();
    const [projectRows, memberRows] = await Promise.all([
      db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId))
        .orderBy(asc(projects.name), asc(projects.id))
        .limit(MAX_FILTER_PROJECTS + 1),
      // Active members only, and only id + name: never email, image, role or status.
      db
        .select({ id: users.id, name: users.name })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, "active")))
        .orderBy(sql`${users.name} asc nulls last`, asc(users.id))
        .limit(MAX_FILTER_MEMBERS + 1),
    ]);
    return {
      projects: projectRows.slice(0, MAX_FILTER_PROJECTS),
      projectsTruncated: projectRows.length > MAX_FILTER_PROJECTS,
      projectLimit: MAX_FILTER_PROJECTS,
      members: memberRows.slice(0, MAX_FILTER_MEMBERS),
      membersTruncated: memberRows.length > MAX_FILTER_MEMBERS,
      memberLimit: MAX_FILTER_MEMBERS,
    };
  }
}
