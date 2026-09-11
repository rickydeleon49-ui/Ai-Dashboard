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
import { taskDependencies, tasks } from "../schema.pg";
import type {
  Task,
  TaskCreateInput,
  TaskPriority,
  TaskQuery,
  TaskStatus,
  TaskUpdateInput,
} from "@/core/tasks/types";
import { DependencyCycleError } from "@/core/tasks/errors";
import { createId } from "@/lib/ids";
import type { TaskRepository } from "./task-repository";

type TaskRow = typeof tasks.$inferSelect;

const DONE_STATUSES: string[] = ["done", "cancelled"];

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
 * Which of `taskIds` are currently blocked — have at least one dependency
 * whose own status isn't done/cancelled. See `DrizzleTaskRepository`'s own
 * copy of this note for why checking only *direct* blockers correctly
 * captures transitive blocking too, with no recursive query needed here.
 */
async function loadBlockedSet(workspaceId: string, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const db = getPgDb();
  const rows = await db
    .select({ taskId: taskDependencies.taskId })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(
      and(
        eq(taskDependencies.workspaceId, workspaceId),
        inArray(taskDependencies.taskId, taskIds),
        notInArray(tasks.status, DONE_STATUSES),
      ),
    );
  return new Set(rows.map((r) => r.taskId));
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

    await db.insert(tasks).values({
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

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created task");
    return created;
  }

  async update(workspaceId: string, id: string, input: TaskUpdateInput): Promise<Task | null> {
    const db = getPgDb();
    const [existing] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
      .limit(1);
    if (!existing) return null;

    const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.milestoneId !== undefined) patch.milestoneId = input.milestoneId;
    if (input.parentTaskId !== undefined) patch.parentTaskId = input.parentTaskId;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate ? new Date(input.dueDate) : null;

    if (input.status !== undefined) {
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

    await db
      .update(tasks)
      .set(patch)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)));
    return this.findById(workspaceId, id);
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
      // Lock the two task rows this edge actually touches before checking
      // for a cycle, so a concurrent add() racing on the same pair (e.g.
      // one request adding A->B while another adds B->A at the same
      // moment) serializes instead of both passing the check. This does
      // not lock the whole graph — two edges that share no task with this
      // one can still combine into a cycle undetected under concurrency,
      // an accepted limit rather than locking the entire task table.
      //
      // The lock query is also the authorization check: it's scoped to
      // `workspaceId`, so a caller passing a task id from another
      // workspace simply fails to find it here — never silently locks (or
      // later links) a row it has no business touching, even though the
      // API layer above is expected to have already resolved both ids
      // through this same workspace before ever calling this.
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

      // Would `dependsOnTaskId` already (transitively) depend on `taskId`?
      // If so, taskId -> dependsOnTaskId would close a cycle — see
      // DrizzleTaskRepository's identical comment for the full reasoning.
      // Scoped to workspaceId too: task ids are globally unique (createId())
      // so this could never cross into another workspace's graph by
      // coincidence, but scoping it anyway keeps the query honestly
      // reflecting what it's allowed to see, and stops it walking a much
      // larger graph than it needs to.
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
