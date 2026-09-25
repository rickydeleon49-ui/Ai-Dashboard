import "server-only";

/**
 * PostgreSQL TimelineRepository (Release 2D.2), accounts mode.
 *
 * Isolation: every query, CTE seed, recursive step, task lookup and project
 * lookup is restricted to `workspace_id` (and `project_id` where it applies).
 *
 * Workload (docs/design/2D.2-timeline.md §7):
 * - The whole read runs in one READ ONLY transaction with
 *   `SET LOCAL statement_timeout`; a timeout becomes
 *   `TimelineAnalysisBudgetError` (a generic 503 at the route), never SQL
 *   details and never a guessed blocked state.
 * - Exact blocked state: one linear closure over the tasks reachable from
 *   the returned tasks — each reachable task enters the recursion once — and
 *   refused if more than `limits.analysisTasks` tasks are reachable.
 * - Explanation graph: `exploreDependencies`, whose row and statement counts
 *   are bounded by constants (per-task LIMITed primary-key range scans).
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { milestones, projects, tasks } from "../schema.pg";
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
import { inDayRange } from "./postgres-calendar-repository";
import type { TimelineRepository } from "./timeline-repository";

type Tx = Parameters<Parameters<ReturnType<typeof getPgDb>["transaction"]>[0]>[0];

type TaskSelect = {
  id: string;
  title: string;
  status: string;
  dueDate: Date | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  milestoneDue: Date | null;
  assigneeId: string | null;
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
    assigneeId: row.assigneeId ?? null,
    blocked: blocked.has(row.id),
  };
}

const idList = (ids: string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/** PostgreSQL's query_canceled (statement_timeout), however the driver wraps it. */
export function isStatementTimeout(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "57014") return true;
  }
  return false;
}

/**
 * Exact blocked state for `taskIds` under the canonical definition (a task is
 * blocked iff a task reachable along dependency edges is neither done nor
 * cancelled; traversal continues through resolved tasks). Linear, unlike a
 * per-root traversal: `reach` holds each reachable task once, and `blocked`
 * holds each blocked task in that region once.
 */
async function exactBlockedSet(tx: Tx, workspaceId: string, taskIds: string[], cap: number): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const ids = idList(taskIds);
  const result = await tx.execute(sql`
    WITH RECURSIVE reach(id) AS (
      SELECT td.depends_on_task_id FROM task_dependency td
      WHERE td.workspace_id = ${workspaceId} AND td.task_id IN (${ids})
      UNION
      SELECT td.depends_on_task_id FROM task_dependency td
      JOIN reach r ON td.task_id = r.id
      WHERE td.workspace_id = ${workspaceId}
    ),
    region(id) AS (
      SELECT id FROM reach
      UNION
      SELECT t.id FROM task t WHERE t.workspace_id = ${workspaceId} AND t.id IN (${ids})
    ),
    blocked(id) AS (
      SELECT td.task_id FROM task_dependency td
      JOIN region g ON g.id = td.task_id
      JOIN task t ON t.id = td.depends_on_task_id AND t.workspace_id = ${workspaceId}
      WHERE td.workspace_id = ${workspaceId} AND t.status NOT IN ('done', 'cancelled')
      UNION
      SELECT td.task_id FROM task_dependency td
      JOIN blocked b ON td.depends_on_task_id = b.id
      JOIN region g ON g.id = td.task_id
      WHERE td.workspace_id = ${workspaceId}
    )
    SELECT
      (SELECT count(*) FROM reach)::int AS reach_count,
      COALESCE((SELECT array_agg(id) FROM blocked WHERE id IN (${ids})), '{}') AS blocked_ids
  `);
  const row = result.rows[0] as { reach_count: number; blocked_ids: string[] };
  if (row.reach_count > cap) throw new TimelineAnalysisBudgetError();
  return new Set(row.blocked_ids);
}

/** At most `perTaskLimit` dependency ids per task: one LIMITed primary-key range scan each. */
function dependencyLoader(tx: Tx, workspaceId: string) {
  return async (ids: string[], perTaskLimit: number): Promise<TimelineEdge[]> => {
    const parts = ids.map(
      (id) => sql`(SELECT task_id, depends_on_task_id FROM task_dependency
        WHERE workspace_id = ${workspaceId} AND task_id = ${id}
        ORDER BY depends_on_task_id LIMIT ${perTaskLimit})`,
    );
    const result = await tx.execute(sql.join(parts, sql` UNION ALL `));
    return (result.rows as { task_id: string; depends_on_task_id: string }[]).map((r) => ({
      taskId: r.task_id,
      dependsOnTaskId: r.depends_on_task_id,
    }));
  };
}

export class PostgresTimelineRepository implements TimelineRepository {
  async load(
    workspaceId: string,
    projectId: string,
    range: { from: DateOnly; to: DateOnly },
    limits: TimelineLimits,
  ): Promise<TimelineData | null> {
    const timeoutMs = Math.trunc(limits.statementTimeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid timeline statement timeout.");
    try {
      return await getPgDb().transaction(
        async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${timeoutMs}`));
          return this.read(tx, workspaceId, projectId, range, limits);
        },
        { accessMode: "read only" },
      );
    } catch (error) {
      if (isStatementTimeout(error)) throw new TimelineAnalysisBudgetError();
      throw error;
    }
  }

  private async read(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    range: { from: DateOnly; to: DateOnly },
    limits: TimelineLimits,
  ): Promise<TimelineData | null> {
    const [project] = await tx
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    if (!project) return null;

    const taskColumns = {
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueDate: tasks.dueDate,
      milestoneId: tasks.milestoneId,
      milestoneTitle: milestones.title,
      milestoneDue: milestones.dueDate,
      assigneeId: tasks.assigneeId,
    };
    const milestoneColumns = { id: milestones.id, title: milestones.title, status: milestones.status, dueDate: milestones.dueDate };
    const inProject = and(eq(tasks.workspaceId, workspaceId), eq(tasks.projectId, projectId));
    const milestoneJoin = and(eq(milestones.id, tasks.milestoneId), eq(milestones.workspaceId, workspaceId));

    // Sequential: one connection inside the transaction.
    const datedTasks = await tx
      .select(taskColumns)
      .from(tasks)
      .leftJoin(milestones, milestoneJoin)
      .where(and(inProject, ...inDayRange(tasks.dueDate, range.from, range.to)))
      .orderBy(asc(tasks.dueDate), asc(tasks.title), asc(tasks.id))
      .limit(limits.tasks + 1);
    const undatedTasks = await tx
      .select(taskColumns)
      .from(tasks)
      .leftJoin(milestones, milestoneJoin)
      .where(and(inProject, isNull(tasks.dueDate)))
      .orderBy(sql`${milestones.dueDate} asc nulls last`, asc(tasks.title), asc(tasks.id))
      .limit(limits.undatedTasks + 1);
    const datedMilestones = await tx
      .select(milestoneColumns)
      .from(milestones)
      .where(
        and(
          eq(milestones.workspaceId, workspaceId),
          eq(milestones.projectId, projectId),
          ...inDayRange(milestones.dueDate, range.from, range.to),
        ),
      )
      .orderBy(asc(milestones.dueDate), asc(milestones.title), asc(milestones.id))
      .limit(limits.milestones + 1);
    const undatedMilestones = await tx
      .select(milestoneColumns)
      .from(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.projectId, projectId), isNull(milestones.dueDate)))
      .orderBy(asc(milestones.title), asc(milestones.id))
      .limit(limits.undatedMilestones + 1);

    const keptDated = datedTasks.slice(0, limits.tasks);
    const keptUndated = undatedTasks.slice(0, limits.undatedTasks);
    const returnedIds = [...keptDated, ...keptUndated].map((t) => t.id);

    const blocked = await exactBlockedSet(tx, workspaceId, returnedIds, limits.analysisTasks);
    const explored = await exploreDependencies(
      returnedIds,
      { edgeBudget: limits.edges, batchSize: limits.exploreBatch, maxDepth: limits.maxDepth },
      dependencyLoader(tx, workspaceId),
    );

    const returned = new Set(returnedIds);
    const externalIds = [...new Set(explored.edges.flatMap((e) => [e.taskId, e.dependsOnTaskId]))].filter(
      (id) => !returned.has(id),
    );
    const external: TimelineExternalTask[] =
      externalIds.length === 0
        ? []
        : (
            await tx
              .select({
                id: tasks.id,
                title: tasks.title,
                status: tasks.status,
                dueDate: tasks.dueDate,
                projectId: tasks.projectId,
                projectName: projects.name,
              })
              .from(tasks)
              .innerJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.workspaceId, workspaceId)))
              .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, externalIds)))
          ).map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            date: calendarDayOf(r.dueDate),
            projectId: r.projectId,
            projectName: r.projectName,
          }));

    const toMilestone = (m: { id: string; title: string; status: string; dueDate: Date | null }): TimelineMilestoneRow => ({
      id: m.id,
      title: m.title,
      status: m.status,
      date: calendarDayOf(m.dueDate),
    });

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
