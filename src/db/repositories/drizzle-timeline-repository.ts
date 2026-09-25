/**
 * SQLite TimelineRepository (Release 2D.2), desktop only. Single-tenant: it
 * asserts `LOCAL_WORKSPACE_ID`, like every Drizzle repository here. The same
 * external contract as the PostgreSQL implementation, and the same due-day
 * rule as the Calendar (`dayRange`); an empty-string due date counts as
 * undated, as it does on the Calendar.
 *
 * Workload (docs/design/2D.2-timeline.md §7): better-sqlite3 is synchronous
 * and has no statement timeout, so the exact blocked-state closure bounds its
 * recursion instead — the recursive step is LIMITed to
 * `limits.analysisTasks + 1` rows, and more reachable tasks than that is
 * refused with `TimelineAnalysisBudgetError`. The explanation graph uses the
 * same bounded `exploreDependencies` walk as PostgreSQL.
 */
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../client";
import { milestones, projects, tasks } from "../schema";
import { calendarDayOf, type DateOnly } from "@/core/calendar/dates";
import { TimelineAnalysisBudgetError, exploreDependencies } from "@/core/timeline/explore";
import type {
  TimelineData,
  TimelineEdge,
  TimelineExternalTask,
  TimelineLimits,
  TimelineMilestoneRow,
  TimelineTaskRow,
} from "@/core/timeline/types";
import { dayRange } from "./drizzle-calendar-repository";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import type { TimelineRepository } from "./timeline-repository";

function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleTimelineRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresTimelineRepository instead.",
    );
  }
}

type TaskSelect = {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  milestoneDue: string | null;
};

function toTaskRow(row: TaskSelect, blocked: Set<string>): TimelineTaskRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    date: calendarDayOf(row.dueDate),
    milestoneId: row.milestoneId,
    milestoneTitle: row.milestoneTitle,
    milestoneDate: calendarDayOf(row.milestoneDue),
    // Desktop has no users (see `tasks.assigneeId` in db/schema.ts).
    assigneeId: null,
    blocked: blocked.has(row.id),
  };
}

function toMilestone(m: { id: string; title: string; status: string; dueDate: string | null }): TimelineMilestoneRow {
  return { id: m.id, title: m.title, status: m.status, date: calendarDayOf(m.dueDate) };
}

const idList = (ids: string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/**
 * Exact blocked state for `taskIds` under the canonical definition, as a
 * linear closure (see the PostgreSQL implementation). The recursive step's
 * LIMIT caps how many reachable tasks SQLite will ever enqueue.
 */
function exactBlockedSet(taskIds: string[], cap: number): Set<string> {
  if (taskIds.length === 0) return new Set();
  const ids = idList(taskIds);
  const row = db.get<{ reach_count: number; blocked_ids: string | null }>(sql`
    WITH RECURSIVE reach(id) AS (
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id IN (${ids})
      UNION
      SELECT td.depends_on_task_id FROM task_dependencies td
      JOIN reach r ON td.task_id = r.id
      LIMIT ${cap + 1}
    ),
    region(id) AS (
      SELECT id FROM reach
      UNION
      SELECT id FROM tasks WHERE id IN (${ids})
    ),
    blocked(id) AS (
      SELECT td.task_id FROM task_dependencies td
      JOIN region g ON g.id = td.task_id
      JOIN tasks t ON t.id = td.depends_on_task_id
      WHERE t.status NOT IN ('done', 'cancelled')
      UNION
      SELECT td.task_id FROM task_dependencies td
      JOIN blocked b ON td.depends_on_task_id = b.id
      JOIN region g ON g.id = td.task_id
    )
    SELECT
      (SELECT count(*) FROM reach) AS reach_count,
      (SELECT json_group_array(id) FROM blocked WHERE id IN (${ids})) AS blocked_ids
  `);
  if (!row || row.reach_count > cap) throw new TimelineAnalysisBudgetError();
  return new Set(JSON.parse(row.blocked_ids ?? "[]") as string[]);
}

/** At most `perTaskLimit` dependency ids per task: one LIMITed primary-key range scan each. */
async function loadDependencies(ids: string[], perTaskLimit: number): Promise<TimelineEdge[]> {
  const parts = ids.map(
    (id) => sql`SELECT * FROM (SELECT task_id, depends_on_task_id FROM task_dependencies
      WHERE task_id = ${id} ORDER BY depends_on_task_id LIMIT ${perTaskLimit})`,
  );
  return db
    .all<{ task_id: string; depends_on_task_id: string }>(sql.join(parts, sql` UNION ALL `))
    .map((r) => ({ taskId: r.task_id, dependsOnTaskId: r.depends_on_task_id }));
}

export class DrizzleTimelineRepository implements TimelineRepository {
  async load(
    workspaceId: string,
    projectId: string,
    range: { from: DateOnly; to: DateOnly },
    limits: TimelineLimits,
  ): Promise<TimelineData | null> {
    assertLocalWorkspace(workspaceId);

    const project = db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!project) return null;

    const taskColumns = {
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueDate: tasks.dueDate,
      milestoneId: tasks.milestoneId,
      milestoneTitle: milestones.title,
      milestoneDue: milestones.dueDate,
    };
    const milestoneColumns = {
      id: milestones.id,
      title: milestones.title,
      status: milestones.status,
      dueDate: milestones.dueDate,
    };
    const undatedTask = or(isNull(tasks.dueDate), eq(tasks.dueDate, ""))!;
    const undatedMilestone = or(isNull(milestones.dueDate), eq(milestones.dueDate, ""))!;

    const datedTasks = db
      .select(taskColumns)
      .from(tasks)
      .leftJoin(milestones, eq(milestones.id, tasks.milestoneId))
      .where(and(eq(tasks.projectId, projectId), ...dayRange(tasks.dueDate, range.from, range.to)))
      .orderBy(sql`date(${tasks.dueDate})`, asc(tasks.title), asc(tasks.id))
      .limit(limits.tasks + 1)
      .all();
    const undatedTasks = db
      .select(taskColumns)
      .from(tasks)
      .leftJoin(milestones, eq(milestones.id, tasks.milestoneId))
      .where(and(eq(tasks.projectId, projectId), undatedTask))
      .orderBy(
        sql`${milestones.dueDate} is null or ${milestones.dueDate} = ''`,
        sql`date(${milestones.dueDate})`,
        asc(tasks.title),
        asc(tasks.id),
      )
      .limit(limits.undatedTasks + 1)
      .all();
    const datedMilestones = db
      .select(milestoneColumns)
      .from(milestones)
      .where(and(eq(milestones.projectId, projectId), ...dayRange(milestones.dueDate, range.from, range.to)))
      .orderBy(sql`date(${milestones.dueDate})`, asc(milestones.title), asc(milestones.id))
      .limit(limits.milestones + 1)
      .all();
    const undatedMilestones = db
      .select(milestoneColumns)
      .from(milestones)
      .where(and(eq(milestones.projectId, projectId), undatedMilestone))
      .orderBy(asc(milestones.title), asc(milestones.id))
      .limit(limits.undatedMilestones + 1)
      .all();

    const keptDated = datedTasks.slice(0, limits.tasks);
    const keptUndated = undatedTasks.slice(0, limits.undatedTasks);
    const returnedIds = [...keptDated, ...keptUndated].map((t) => t.id);

    const blocked = exactBlockedSet(returnedIds, limits.analysisTasks);
    const explored = await exploreDependencies(
      returnedIds,
      { edgeBudget: limits.edges, batchSize: limits.exploreBatch, maxDepth: limits.maxDepth },
      loadDependencies,
    );

    const returned = new Set(returnedIds);
    const externalIds = [...new Set(explored.edges.flatMap((e) => [e.taskId, e.dependsOnTaskId]))].filter(
      (id) => !returned.has(id),
    );
    const external: TimelineExternalTask[] =
      externalIds.length === 0
        ? []
        : db
            .select({
              id: tasks.id,
              title: tasks.title,
              status: tasks.status,
              dueDate: tasks.dueDate,
              projectId: tasks.projectId,
              projectName: projects.name,
            })
            .from(tasks)
            .innerJoin(projects, eq(projects.id, tasks.projectId))
            .where(inArray(tasks.id, externalIds))
            .all()
            .map((r) => ({
              id: r.id,
              title: r.title,
              status: r.status,
              date: calendarDayOf(r.dueDate),
              projectId: r.projectId,
              projectName: r.projectName,
            }));

    return {
      project,
      tasks: keptDated.map((r) => toTaskRow(r, blocked)),
      milestones: datedMilestones.slice(0, limits.milestones).map(toMilestone),
      undatedTasks: keptUndated.map((r) => toTaskRow(r, blocked)),
      undatedMilestones: undatedMilestones.slice(0, limits.undatedMilestones).map(toMilestone),
      edges: explored.edges,
      expanded: explored.expanded,
      external,
      truncated: {
        tasks: datedTasks.length > limits.tasks,
        milestones: datedMilestones.length > limits.milestones,
        undatedTasks: undatedTasks.length > limits.undatedTasks,
        undatedMilestones: undatedMilestones.length > limits.undatedMilestones,
        edges: explored.truncated,
      },
    };
  }
}
