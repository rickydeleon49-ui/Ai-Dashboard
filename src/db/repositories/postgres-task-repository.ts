import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { getPgDb } from "../pg-client";
import {
  taskActivityEvents,
  taskChecklistItems,
  taskDependencies,
  tasks,
  workspaceMembers,
} from "../schema.pg";
import type {
  Task,
  TaskCreateInput,
  TaskMutationOptions,
  TaskPriority,
  TaskQuery,
  TaskStatus,
  TaskUpdateInput,
  TaskUpdateOutcome,
} from "@/core/tasks/types";
import {
  DependencyCycleError,
  InvalidAssigneeError,
  InvalidParentTaskError,
  TaskBlockedError,
  TaskLockTimeoutError,
} from "@/core/tasks/errors";
import { createId } from "@/lib/ids";
import type { TaskRepository } from "./task-repository";

type TaskRow = typeof tasks.$inferSelect;

export type PgTransaction = Parameters<
  Parameters<ReturnType<typeof getPgDb>["transaction"]>[0]
>[0];

export type PgExecutor = ReturnType<typeof getPgDb> | PgTransaction;

export interface PostgresTaskMutationOptions extends TaskMutationOptions {
  tx?: PgTransaction;
}

function toDomain(
  row: TaskRow,
  blocked: boolean,
  checklistCounts?: { done: number; total: number },
): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    parentTaskId: row.parentTaskId,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigneeId: row.assigneeId,
    assignedBy: row.assignedBy ?? null,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    dueDate: row.dueDate?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    blocked,
    checklistTotal: checklistCounts?.total ?? 0,
    checklistDone: checklistCounts?.done ?? 0,
  };
}

/**
 * Which of `taskIds` are currently blocked — have at least one unfinished
 * dependency anywhere in the reachable dependency graph along `task_dependency`.
 *
 * Traverses reachable dependencies recursively with a CTE scoped to `workspaceId`.
 */
async function loadBlockedSet(
  workspaceId: string,
  taskIds: string[],
  txOrDb?: PgExecutor,
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const db = txOrDb ?? getPgDb();
  const taskIdsList = sql.join(
    taskIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    WITH RECURSIVE reachable(root_id, current_id) AS (
      SELECT task_id AS root_id, depends_on_task_id AS current_id
      FROM task_dependency
      WHERE workspace_id = ${workspaceId} AND task_id IN (${taskIdsList})
      UNION
      SELECT r.root_id, td.depends_on_task_id AS current_id
      FROM task_dependency td
      JOIN reachable r ON td.task_id = r.current_id
      WHERE td.workspace_id = ${workspaceId}
    )
    SELECT DISTINCT r.root_id AS task_id
    FROM reachable r
    JOIN task t ON t.id = r.current_id AND t.workspace_id = ${workspaceId}
    WHERE t.status NOT IN ('done', 'cancelled')
  `);
  return new Set((result.rows as Array<{ task_id: string }>).map((r) => r.task_id));
}

export const DEFAULT_TASK_LOCK_TIMEOUT_MS = 10_000;
export const MIN_TASK_LOCK_TIMEOUT_MS = 1;
export const MAX_TASK_LOCK_TIMEOUT_MS = 60_000;

/**
 * Parses and validates TASK_LOCK_TIMEOUT_MS.
 *
 * Enforces a finite positive integer within a conservative range [1, 60000] ms.
 * Absent, malformed, non-numeric, decimal, zero, negative, or excessively large inputs
 * safely fall back to DEFAULT_TASK_LOCK_TIMEOUT_MS (10000ms), ensuring no malformed
 * SQL is ever executed.
 */
export function parseTaskLockTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_TASK_LOCK_TIMEOUT_MS;
  }
  const str = String(raw).trim();
  // Strictly positive integer digits: rejects decimals, negatives, nonnumeric strings, hex, exponential notation
  if (!/^\d+$/.test(str)) {
    return DEFAULT_TASK_LOCK_TIMEOUT_MS;
  }
  const parsed = Number(str);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_TASK_LOCK_TIMEOUT_MS ||
    parsed > MAX_TASK_LOCK_TIMEOUT_MS
  ) {
    return DEFAULT_TASK_LOCK_TIMEOUT_MS;
  }
  return parsed;
}

export async function acquireWorkspaceLock(
  tx: PgExecutor,
  workspaceId: string,
  timeoutMs?: number,
): Promise<void> {
  const timeoutMsToUse =
    timeoutMs !== undefined
      ? parseTaskLockTimeoutMs(timeoutMs)
      : parseTaskLockTimeoutMs(process.env.TASK_LOCK_TIMEOUT_MS);

  try {
    // Bound advisory lock wait to prevent indefinite queue stalls
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${timeoutMsToUse}ms'`));
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('task_dependencies'), hashtext(${workspaceId}))`,
    );
    // Reset timeout immediately after acquisition so subsequent statements in the transaction are unaffected
    await tx.execute(sql.raw("SET LOCAL lock_timeout = DEFAULT"));
  } catch (error: any) {
    const cause = error?.cause ?? error;
    if (
      cause?.code === "55P03" ||
      error?.code === "55P03" ||
      /lock timeout/i.test(cause?.message || "") ||
      /lock timeout/i.test(error?.message || "")
    ) {
      throw new TaskLockTimeoutError(
        `Task mutation timed out waiting for workspace lock on "${workspaceId}"; please retry.`,
      );
    }
    throw error;
  }
}

async function assertValidParentTask(
  tx: PgExecutor,
  workspaceId: string,
  taskId: string | null,
  parentTaskId: string | null | undefined,
  projectId: string,
): Promise<void> {
  if (parentTaskId === undefined || parentTaskId === null) return;
  if (taskId !== null && parentTaskId === taskId) {
    throw new InvalidParentTaskError("A task cannot be its own parent.");
  }
  const [parent] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, parentTaskId)))
    .limit(1);
  if (!parent) {
    throw new InvalidParentTaskError("Parent task not found.");
  }
  if (parent.projectId !== projectId) {
    throw new InvalidParentTaskError("Parent task must belong to the same project.");
  }
  if (parent.parentTaskId !== null) {
    throw new InvalidParentTaskError(
      "A parent task must be a top-level task; subtasks cannot be nested.",
    );
  }
  if (taskId !== null) {
    const [child] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.parentTaskId, taskId)))
      .limit(1);
    if (child) {
      throw new InvalidParentTaskError("A task with subtasks cannot become a subtask.");
    }
  }
}

async function assertValidAssignee(
  tx: PgExecutor,
  workspaceId: string,
  assigneeId: string | null | undefined,
): Promise<void> {
  if (assigneeId === undefined || assigneeId === null) return;
  const [member] = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, assigneeId),
        eq(workspaceMembers.status, "active"),
      ),
    )
    .limit(1);
  if (!member) {
    throw new InvalidAssigneeError(
      `User "${assigneeId}" is not an active member of workspace "${workspaceId}".`,
    );
  }
}

/** Shared by `list` and `listForWorkspace` — everything except the project-id filter. */
function queryConditions(workspaceId: string, query: TaskQuery): SQL[] {
  const conditions: SQL[] = [eq(tasks.workspaceId, workspaceId)];
  if (query.status && query.status !== "all") conditions.push(eq(tasks.status, query.status));
  if (query.priority && query.priority !== "all") {
    conditions.push(eq(tasks.priority, query.priority));
  }
  if (query.milestoneId) conditions.push(eq(tasks.milestoneId, query.milestoneId));
  if (query.unassigned) {
    conditions.push(isNull(tasks.assigneeId));
  } else if (query.assignedTo) {
    conditions.push(eq(tasks.assigneeId, query.assignedTo));
  } else if (query.assigneeId) {
    conditions.push(eq(tasks.assigneeId, query.assigneeId));
  }
  if (query.assignedBy) {
    conditions.push(eq(tasks.assignedBy, query.assignedBy));
  }
  if (query.parentTaskId !== undefined) {
    conditions.push(
      query.parentTaskId === null
        ? isNull(tasks.parentTaskId)
        : eq(tasks.parentTaskId, query.parentTaskId),
    );
  }
  return conditions;
}

function orderByFor(sort: TaskQuery["sort"]) {
  switch (sort) {
    case "dueDate":
      return [sql`${tasks.dueDate} is null`, asc(tasks.dueDate)];
    case "priority":
      return [
        sql`case ${tasks.priority}
          when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
      ];
    case "created":
      return [desc(tasks.createdAt)];
    default:
      return [desc(tasks.updatedAt)];
  }
}

/**
 * Postgres-backed, genuinely workspace-scoped implementation of
 * {@link TaskRepository} — hosted multi-user mode. Mirrors
 * `DrizzleTaskRepository`'s (SQLite) behavior closely so the two are
 * interchangeable from a caller's perspective, with a real `assigneeId`
 * (SQLite has no user concept, so its version always surfaces `null`).
 */
export class PostgresTaskRepository implements TaskRepository {
  private readonly lockTimeoutMs?: number;

  constructor(options?: { lockTimeoutMs?: number }) {
    this.lockTimeoutMs =
      options?.lockTimeoutMs !== undefined
        ? parseTaskLockTimeoutMs(options.lockTimeoutMs)
        : undefined;
  }

  async list(workspaceId: string, projectId: string, query: TaskQuery = {}): Promise<Task[]> {
    const db = getPgDb();
    const conditions = [eq(tasks.projectId, projectId), ...queryConditions(workspaceId, query)];

    let statement = db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})::int`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)::int`.mapWith(Number),
      })
      .from(tasks)
      .leftJoin(
        taskChecklistItems,
        and(
          eq(taskChecklistItems.taskId, tasks.id),
          eq(taskChecklistItems.workspaceId, workspaceId),
        ),
      )
      .where(and(...conditions))
      .groupBy(tasks.id)
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = await statement;
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.task.id),
    );
    return rows.map((row) =>
      toDomain(row.task, blocked.has(row.task.id), {
        total: row.checklistTotal ?? 0,
        done: row.checklistDone ?? 0,
      }),
    );
  }

  async listForWorkspace(workspaceId: string, query: TaskQuery = {}): Promise<Task[]> {
    const db = getPgDb();
    const conditions = queryConditions(workspaceId, query);

    let statement = db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})::int`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)::int`.mapWith(Number),
      })
      .from(tasks)
      .leftJoin(
        taskChecklistItems,
        and(
          eq(taskChecklistItems.taskId, tasks.id),
          eq(taskChecklistItems.workspaceId, workspaceId),
        ),
      )
      .where(and(...conditions))
      .groupBy(tasks.id)
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = await statement;
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.task.id),
    );
    return rows.map((row) =>
      toDomain(row.task, blocked.has(row.task.id), {
        total: row.checklistTotal ?? 0,
        done: row.checklistDone ?? 0,
      }),
    );
  }

  async findById(workspaceId: string, id: string): Promise<Task | null> {
    const db = getPgDb();
    const [row] = await db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})::int`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)::int`.mapWith(Number),
      })
      .from(tasks)
      .leftJoin(
        taskChecklistItems,
        and(
          eq(taskChecklistItems.taskId, tasks.id),
          eq(taskChecklistItems.workspaceId, workspaceId),
        ),
      )
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
      .groupBy(tasks.id)
      .limit(1);
    if (!row) return null;
    const blocked = await loadBlockedSet(workspaceId, [id]);
    return toDomain(row.task, blocked.has(id), {
      total: row.checklistTotal ?? 0,
      done: row.checklistDone ?? 0,
    });
  }

  async create(
    workspaceId: string,
    input: TaskCreateInput,
    options?: PostgresTaskMutationOptions,
  ): Promise<Task> {
    const execute = async (tx: PgTransaction) => {
      if (input.parentTaskId !== undefined && input.parentTaskId !== null) {
        await acquireWorkspaceLock(tx, workspaceId, this.lockTimeoutMs);
      }
      await assertValidParentTask(tx, workspaceId, null, input.parentTaskId, input.projectId);

      const hasAssignee = Boolean(input.assigneeId);
      if (hasAssignee) {
        await assertValidAssignee(tx, workspaceId, input.assigneeId);
        if (!options?.actorUserId) {
          throw new Error("actorUserId is required when setting a task assignee");
        }
      }

      const id = createId("tsk");
      const now = new Date();

      await tx.insert(tasks).values({
        id,
        workspaceId,
        projectId: input.projectId,
        milestoneId: input.milestoneId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? "todo",
        priority: input.priority ?? "medium",
        assigneeId: input.assigneeId ?? null,
        assignedBy: hasAssignee ? options!.actorUserId : null,
        assignedAt: hasAssignee ? now : null,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        createdAt: input.createdAt ? new Date(input.createdAt) : now,
        updatedAt: input.updatedAt ? new Date(input.updatedAt) : now,
        completedAt: input.completedAt ? new Date(input.completedAt) : null,
      });

      await tx.insert(taskActivityEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        projectId: input.projectId,
        taskId: id,
        actorId: options?.actorUserId ?? null,
        type: "task.created",
        details: { title: input.title },
      });

      const [created] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
        .limit(1);
      if (!created) throw new Error("Failed to read back created task");
      const blocked = await loadBlockedSet(workspaceId, [id], tx);
      return toDomain(created, blocked.has(id), { total: 0, done: 0 });
    };

    if (options?.tx) {
      return execute(options.tx);
    }
    const db = getPgDb();
    return db.transaction(execute);
  }

  async updateAuthoritative(
    workspaceId: string,
    id: string,
    input: TaskUpdateInput,
    options?: TaskMutationOptions,
  ): Promise<TaskUpdateOutcome | null> {
    const db = getPgDb();
    return db.transaction(async (tx) => {
      if (input.status !== undefined || input.parentTaskId !== undefined) {
        await acquireWorkspaceLock(tx, workspaceId, this.lockTimeoutMs);
      }

      const [existing] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
        .for("update")
        .limit(1);
      if (!existing) return null;

      let hasChanges = false;
      if (input.title !== undefined && input.title !== existing.title) hasChanges = true;
      if (
        input.description !== undefined &&
        (input.description ?? null) !== (existing.description ?? null)
      ) {
        hasChanges = true;
      }
      if (input.priority !== undefined && input.priority !== existing.priority) hasChanges = true;
      if (
        input.milestoneId !== undefined &&
        (input.milestoneId ?? null) !== (existing.milestoneId ?? null)
      ) {
        hasChanges = true;
      }
      if (
        input.parentTaskId !== undefined &&
        (input.parentTaskId ?? null) !== (existing.parentTaskId ?? null)
      ) {
        hasChanges = true;
      }
      if (
        input.assigneeId !== undefined &&
        (input.assigneeId ?? null) !== (existing.assigneeId ?? null)
      ) {
        hasChanges = true;
      }
      if (
        input.assignedBy !== undefined &&
        (input.assignedBy ?? null) !== (existing.assignedBy ?? null)
      ) {
        hasChanges = true;
      }
      if (input.assignedAt !== undefined) {
        const newAssignedAt = input.assignedAt ? new Date(input.assignedAt).toISOString() : null;
        const oldAssignedAt = existing.assignedAt ? existing.assignedAt.toISOString() : null;
        if (newAssignedAt !== oldAssignedAt) hasChanges = true;
      }
      if (input.dueDate !== undefined) {
        const newDue = input.dueDate ? new Date(input.dueDate).toISOString() : null;
        const oldDue = existing.dueDate ? existing.dueDate.toISOString() : null;
        if (newDue !== oldDue) hasChanges = true;
      }
      if (input.status !== undefined && input.status !== existing.status) hasChanges = true;
      if (input.completedAt !== undefined) {
        const newCompleted = input.completedAt ? new Date(input.completedAt).toISOString() : null;
        const oldCompleted = existing.completedAt ? existing.completedAt.toISOString() : null;
        if (newCompleted !== oldCompleted) hasChanges = true;
      }

      // Setting status to done on a blocked task is always rejected
      if (input.status === "done") {
        const blocked = await loadBlockedSet(workspaceId, [id], tx);
        if (blocked.has(id)) {
          throw new TaskBlockedError();
        }
      }

      // Concurrency safe no-op determination under row lock
      if (!hasChanges) {
        const [current] = await tx
          .select({
            task: tasks,
            checklistTotal: sql<number>`count(${taskChecklistItems.id})::int`.mapWith(Number),
            checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)::int`.mapWith(Number),
          })
          .from(tasks)
          .leftJoin(
            taskChecklistItems,
            and(
              eq(taskChecklistItems.taskId, tasks.id),
              eq(taskChecklistItems.workspaceId, workspaceId),
            ),
          )
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
          .groupBy(tasks.id)
          .limit(1);
        if (!current) return null;
        const blocked = await loadBlockedSet(workspaceId, [id], tx);
        return {
          task: toDomain(current.task, blocked.has(id), {
            total: current.checklistTotal ?? 0,
            done: current.checklistDone ?? 0,
          }),
          unchanged: true,
        };
      }

      if (input.parentTaskId !== undefined && input.parentTaskId !== existing.parentTaskId) {
        await assertValidParentTask(tx, workspaceId, id, input.parentTaskId, existing.projectId);
      }

      const patch: Partial<typeof tasks.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
        if (input.assigneeId === null) {
          if (existing.assigneeId !== null) {
            patch.assigneeId = null;
            patch.assignedBy = null;
            patch.assignedAt = null;
          }
        } else {
          await assertValidAssignee(tx, workspaceId, input.assigneeId);
          if (!options?.actorUserId) {
            throw new Error("actorUserId is required when changing a task assignee");
          }
          patch.assigneeId = input.assigneeId;
          patch.assignedBy = options.actorUserId;
          patch.assignedAt = new Date();
        }
      } else if (input.assignedBy !== undefined || input.assignedAt !== undefined) {
        if (input.assignedBy !== undefined) patch.assignedBy = input.assignedBy;
        if (input.assignedAt !== undefined) {
          patch.assignedAt = input.assignedAt ? new Date(input.assignedAt) : null;
        }
      }

      if (input.title !== undefined && input.title !== existing.title) patch.title = input.title;
      if (
        input.description !== undefined &&
        (input.description ?? null) !== (existing.description ?? null)
      ) {
        patch.description = input.description;
      }
      if (input.priority !== undefined && input.priority !== existing.priority) patch.priority = input.priority;
      if (
        input.milestoneId !== undefined &&
        (input.milestoneId ?? null) !== (existing.milestoneId ?? null)
      ) {
        patch.milestoneId = input.milestoneId;
      }
      if (
        input.parentTaskId !== undefined &&
        (input.parentTaskId ?? null) !== (existing.parentTaskId ?? null)
      ) {
        patch.parentTaskId = input.parentTaskId;
      }
      if (input.dueDate !== undefined) {
        const newDue = input.dueDate ? new Date(input.dueDate).toISOString() : null;
        const oldDue = existing.dueDate ? existing.dueDate.toISOString() : null;
        if (newDue !== oldDue) {
          patch.dueDate = input.dueDate ? new Date(input.dueDate) : null;
        }
      }

      if (input.status !== undefined && input.status !== existing.status) {
        const movingToDone = input.status === "done";
        if (movingToDone) {
          const blocked = await loadBlockedSet(workspaceId, [id], tx);
          if (blocked.has(id)) throw new TaskBlockedError();
        }

        patch.status = input.status;
        const nowDone = input.status === "done" || input.status === "cancelled";
        const wasDone = existing.status === "done" || existing.status === "cancelled";
        if (nowDone && !wasDone) {
          patch.completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
        } else if (!nowDone && wasDone) {
          patch.completedAt = null;
        }
      }
      if (input.completedAt !== undefined) {
        patch.completedAt = input.completedAt ? new Date(input.completedAt) : null;
      }

      await tx
        .update(tasks)
        .set(patch)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)));

      if (input.status !== undefined && input.status !== existing.status) {
        await tx.insert(taskActivityEvents).values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: existing.projectId,
          taskId: id,
          actorId: options?.actorUserId ?? null,
          type: "task.status_changed",
          details: { from: existing.status, to: input.status },
        });
      }
      if (input.priority !== undefined && input.priority !== existing.priority) {
        await tx.insert(taskActivityEvents).values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: existing.projectId,
          taskId: id,
          actorId: options?.actorUserId ?? null,
          type: "task.priority_changed",
          details: { from: existing.priority, to: input.priority },
        });
      }
      if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
        await tx.insert(taskActivityEvents).values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: existing.projectId,
          taskId: id,
          actorId: options?.actorUserId ?? null,
          type: input.assigneeId ? "task.assigned" : "task.unassigned",
          details: {
            assigneeId: input.assigneeId,
            previousAssigneeId: existing.assigneeId,
          },
        });
      }
      if (input.dueDate !== undefined) {
        const newDue = input.dueDate ? new Date(input.dueDate).toISOString().slice(0, 10) : null;
        const oldDue = existing.dueDate ? existing.dueDate.toISOString().slice(0, 10) : null;
        if (newDue !== oldDue) {
          await tx.insert(taskActivityEvents).values({
            id: crypto.randomUUID(),
            workspaceId,
            projectId: existing.projectId,
            taskId: id,
            actorId: options?.actorUserId ?? null,
            type: "task.dates_changed",
            details: { dueDate: input.dueDate ?? null },
          });
        }
      }
      if (
        input.milestoneId !== undefined &&
        (input.milestoneId ?? null) !== (existing.milestoneId ?? null)
      ) {
        await tx.insert(taskActivityEvents).values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: existing.projectId,
          taskId: id,
          actorId: options?.actorUserId ?? null,
          type: "task.milestone_changed",
          details: {
            fromMilestoneId: existing.milestoneId,
            toMilestoneId: input.milestoneId,
          },
        });
      }

      const [updated] = await tx
        .select({
          task: tasks,
          checklistTotal: sql<number>`count(${taskChecklistItems.id})::int`.mapWith(Number),
          checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)::int`.mapWith(Number),
        })
        .from(tasks)
        .leftJoin(
          taskChecklistItems,
          and(
            eq(taskChecklistItems.taskId, tasks.id),
            eq(taskChecklistItems.workspaceId, workspaceId),
          ),
        )
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
        .groupBy(tasks.id)
        .limit(1);
      if (!updated) return null;
      const blocked = await loadBlockedSet(workspaceId, [id], tx);
      return {
        task: toDomain(updated.task, blocked.has(id), {
          total: updated.checklistTotal ?? 0,
          done: updated.checklistDone ?? 0,
        }),
        unchanged: false,
      };
    });
  }

  async update(
    workspaceId: string,
    id: string,
    input: TaskUpdateInput,
    options?: TaskMutationOptions,
  ): Promise<Task | null> {
    const outcome = await this.updateAuthoritative(workspaceId, id, input, options);
    return outcome ? outcome.task : null;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const db = getPgDb();
    const [existing] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
      .limit(1);
    if (!existing) return false;
    await db.delete(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)));
    return true;
  }

  async listBlockers(workspaceId: string, taskId: string): Promise<Task[]> {
    const db = getPgDb();
    const rows = await db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})::int`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)::int`.mapWith(Number),
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .leftJoin(
        taskChecklistItems,
        and(
          eq(taskChecklistItems.taskId, tasks.id),
          eq(taskChecklistItems.workspaceId, workspaceId),
        ),
      )
      .where(
        and(eq(taskDependencies.workspaceId, workspaceId), eq(taskDependencies.taskId, taskId)),
      )
      .groupBy(tasks.id);
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.task.id),
    );
    return rows.map((r) =>
      toDomain(r.task, blocked.has(r.task.id), {
        total: r.checklistTotal ?? 0,
        done: r.checklistDone ?? 0,
      }),
    );
  }

  async listDependents(workspaceId: string, taskId: string): Promise<Task[]> {
    const db = getPgDb();
    const rows = await db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})::int`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)::int`.mapWith(Number),
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .leftJoin(
        taskChecklistItems,
        and(
          eq(taskChecklistItems.taskId, tasks.id),
          eq(taskChecklistItems.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(taskDependencies.workspaceId, workspaceId),
          eq(taskDependencies.dependsOnTaskId, taskId),
        ),
      )
      .groupBy(tasks.id);
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.task.id),
    );
    return rows.map((r) =>
      toDomain(r.task, blocked.has(r.task.id), {
        total: r.checklistTotal ?? 0,
        done: r.checklistDone ?? 0,
      }),
    );
  }

  async addDependency(
    workspaceId: string,
    taskId: string,
    dependsOnTaskId: string,
    options?: TaskMutationOptions,
  ): Promise<void> {
    if (taskId === dependsOnTaskId) throw new DependencyCycleError();
    const db = getPgDb();

    await db.transaction(async (tx) => {
      // Workspace-scoped PostgreSQL advisory transaction lock serializes
      // dependency graph mutations per workspace across multi-process and multi-replica workers.
      await acquireWorkspaceLock(tx, workspaceId, this.lockTimeoutMs);

      const locked = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, [taskId, dependsOnTaskId])))
        .for("update");
      if (locked.length < 2) {
        throw new Error(
          `Cannot add a dependency: task "${taskId}" and/or "${dependsOnTaskId}" ` +
            `do not both exist in workspace "${workspaceId}".`,
        );
      }

      // Check if dependsOnTaskId already transitively depends on taskId
      const cycle = await tx.execute(sql`
        WITH RECURSIVE reachable(id) AS (
          SELECT depends_on_task_id AS id FROM task_dependency
          WHERE task_id = ${dependsOnTaskId} AND workspace_id = ${workspaceId}
          UNION
          SELECT td.depends_on_task_id AS id FROM task_dependency td
          JOIN reachable r ON td.task_id = r.id
          WHERE td.workspace_id = ${workspaceId}
        )
        SELECT 1 AS found FROM reachable WHERE id = ${taskId} LIMIT 1
      `);
      if (cycle.rows.length > 0) throw new DependencyCycleError();

      const inserted = await tx
        .insert(taskDependencies)
        .values({ taskId, dependsOnTaskId, workspaceId })
        .onConflictDoNothing()
        .returning();

      // Only record activity event if a new row was actually inserted
      if (inserted.length > 0) {
        const [taskRow] = await tx
          .select({ projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));
        if (taskRow) {
          await tx.insert(taskActivityEvents).values({
            id: crypto.randomUUID(),
            workspaceId,
            projectId: taskRow.projectId,
            taskId,
            actorId: options?.actorUserId ?? null,
            type: "task.dependency_added",
            details: { dependsOnTaskId },
          });
        }
      }
    });
  }

  async removeDependency(
    workspaceId: string,
    taskId: string,
    dependsOnTaskId: string,
    options?: TaskMutationOptions,
  ): Promise<void> {
    const db = getPgDb();
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.workspaceId, workspaceId),
            eq(taskDependencies.taskId, taskId),
            eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
          ),
        )
        .returning();

      // Only record activity event if an existing row was actually deleted
      if (deleted.length > 0) {
        const [taskRow] = await tx
          .select({ projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));

        if (taskRow) {
          await tx.insert(taskActivityEvents).values({
            id: crypto.randomUUID(),
            workspaceId,
            projectId: taskRow.projectId,
            taskId,
            actorId: options?.actorUserId ?? null,
            type: "task.dependency_removed",
            details: { dependsOnTaskId },
          });
        }
      }
    });
  }
}
