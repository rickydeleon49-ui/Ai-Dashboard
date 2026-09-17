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
import { taskDependencies, tasks, workspaceMembers } from "../schema.pg";
import type {
  Task,
  TaskCreateInput,
  TaskPriority,
  TaskQuery,
  TaskStatus,
  TaskUpdateInput,
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

function toDomain(row: TaskRow, blocked: boolean): Task {
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
    dueDate: row.dueDate?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    blocked,
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
  txOrDb?: any,
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
  tx: any,
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
  tx: any,
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
  tx: any,
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
  if (query.assigneeId) conditions.push(eq(tasks.assigneeId, query.assigneeId));
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
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = await statement;
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.id),
    );
    return rows.map((row) => toDomain(row, blocked.has(row.id)));
  }

  async listForWorkspace(workspaceId: string, query: TaskQuery = {}): Promise<Task[]> {
    const db = getPgDb();
    const conditions = queryConditions(workspaceId, query);

    let statement = db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = await statement;
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.id),
    );
    return rows.map((row) => toDomain(row, blocked.has(row.id)));
  }

  async findById(workspaceId: string, id: string): Promise<Task | null> {
    const db = getPgDb();
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
      .limit(1);
    if (!row) return null;
    const blocked = await loadBlockedSet(workspaceId, [id]);
    return toDomain(row, blocked.has(id));
  }

  async create(workspaceId: string, input: TaskCreateInput): Promise<Task> {
    const db = getPgDb();
    const id = createId("tsk");
    const now = new Date();

    return db.transaction(async (tx) => {
      if (input.parentTaskId !== undefined && input.parentTaskId !== null) {
        await acquireWorkspaceLock(tx, workspaceId, this.lockTimeoutMs);
      }
      await assertValidParentTask(tx, workspaceId, null, input.parentTaskId, input.projectId);
      await assertValidAssignee(tx, workspaceId, input.assigneeId);

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
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        createdAt: input.createdAt ? new Date(input.createdAt) : now,
        updatedAt: input.updatedAt ? new Date(input.updatedAt) : now,
        completedAt: input.completedAt ? new Date(input.completedAt) : null,
      });

      const [created] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
        .limit(1);
      if (!created) throw new Error("Failed to read back created task");
      const blocked = await loadBlockedSet(workspaceId, [id], tx);
      return toDomain(created, blocked.has(id));
    });
  }

  async update(workspaceId: string, id: string, input: TaskUpdateInput): Promise<Task | null> {
    const db = getPgDb();

    return db.transaction(async (tx) => {
      if (input.status !== undefined || input.parentTaskId !== undefined) {
        await acquireWorkspaceLock(tx, workspaceId, this.lockTimeoutMs);
      }

      const [existing] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
        .limit(1);
      if (!existing) return null;

      if (input.parentTaskId !== undefined) {
        await assertValidParentTask(tx, workspaceId, id, input.parentTaskId, existing.projectId);
      }
      if (input.assigneeId !== undefined) {
        await assertValidAssignee(tx, workspaceId, input.assigneeId);
      }

      const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.milestoneId !== undefined) patch.milestoneId = input.milestoneId;
      if (input.parentTaskId !== undefined) patch.parentTaskId = input.parentTaskId;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId;
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate ? new Date(input.dueDate) : null;

      if (input.status !== undefined) {
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

      const [updated] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
        .limit(1);
      if (!updated) return null;
      const blocked = await loadBlockedSet(workspaceId, [id], tx);
      return toDomain(updated, blocked.has(id));
    });
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
      .select({ task: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(
        and(eq(taskDependencies.workspaceId, workspaceId), eq(taskDependencies.taskId, taskId)),
      );
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.task.id),
    );
    return rows.map((r) => toDomain(r.task, blocked.has(r.task.id)));
  }

  async listDependents(workspaceId: string, taskId: string): Promise<Task[]> {
    const db = getPgDb();
    const rows = await db
      .select({ task: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(
        and(
          eq(taskDependencies.workspaceId, workspaceId),
          eq(taskDependencies.dependsOnTaskId, taskId),
        ),
      );
    const blocked = await loadBlockedSet(
      workspaceId,
      rows.map((r) => r.task.id),
    );
    return rows.map((r) => toDomain(r.task, blocked.has(r.task.id)));
  }

  async addDependency(workspaceId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
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

      await tx
        .insert(taskDependencies)
        .values({ taskId, dependsOnTaskId, workspaceId })
        .onConflictDoNothing();
    });
  }

  async removeDependency(
    workspaceId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<void> {
    const db = getPgDb();
    await db
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.workspaceId, workspaceId),
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      );
  }
}
