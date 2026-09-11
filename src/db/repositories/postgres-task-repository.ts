import "server-only";

import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { tasks } from "../schema.pg";
import type {
  Task,
  TaskCreateInput,
  TaskPriority,
  TaskQuery,
  TaskStatus,
  TaskUpdateInput,
} from "@/core/tasks/types";
import { createId } from "@/lib/ids";
import type { TaskRepository } from "./task-repository";

type TaskRow = typeof tasks.$inferSelect;

function toDomain(row: TaskRow): Task {
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
  };
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
    return rows.map(toDomain);
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
    return rows.map(toDomain);
  }

  async findById(workspaceId: string, id: string): Promise<Task | null> {
    const db = getPgDb();
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, id)))
      .limit(1);
    return row ? toDomain(row) : null;
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
}
