import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { db } from "../client";
import { taskDependencies, tasks } from "../schema";
import type { TaskRow } from "../schema";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import type { TaskRepository } from "./task-repository";
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

const DONE_STATUSES: string[] = ["done", "cancelled"];

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Assignment has no meaning on desktop — there is no user concept there —
 * so a row's `assigneeId` is always surfaced as `null` regardless of what
 * (if anything) is actually stored in the column. See the column's own
 * comment in `db/schema.ts`.
 */
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
    assigneeId: null,
    dueDate: row.dueDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    blocked,
  };
}

/** See `DrizzleProjectRepository`'s own copy of this check for the reasoning. */
function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleTaskRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresTaskRepository instead.",
    );
  }
}

/**
 * Which of `taskIds` are currently blocked — have at least one dependency
 * (see `task_dependencies`) whose own status isn't done/cancelled. This is
 * necessarily correct for *transitive* blocking too without a recursive
 * query: if B blocks A and B is itself blocked (by C), B's own status can
 * only be todo/in_progress (not done), which alone is enough to mark A
 * blocked — there's no need to also know *why* B isn't done.
 */
function loadBlockedSet(taskIds: string[]): Set<string> {
  if (taskIds.length === 0) return new Set();
  const rows = db
    .select({ taskId: taskDependencies.taskId })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(and(inArray(taskDependencies.taskId, taskIds), notInArray(tasks.status, DONE_STATUSES)))
    .all();
  return new Set(rows.map((r) => r.taskId));
}

/** Shared by `list` and `listForWorkspace` — everything except the project-id filter. */
function queryConditions(query: TaskQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.status && query.status !== "all") conditions.push(eq(tasks.status, query.status));
  if (query.priority && query.priority !== "all") {
    conditions.push(eq(tasks.priority, query.priority));
  }
  if (query.milestoneId) conditions.push(eq(tasks.milestoneId, query.milestoneId));
  if (query.parentTaskId !== undefined) {
    conditions.push(
      query.parentTaskId === null
        ? isNull(tasks.parentTaskId)
        : eq(tasks.parentTaskId, query.parentTaskId),
    );
  }
  // assigneeId is desktop-meaningless (see toDomain's own note) — filtering
  // by one can never match a real row here, so this is "no results" rather
  // than a silently-ignored filter.
  if (query.assigneeId) conditions.push(sql`0`);
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

/** SQLite-backed implementation of {@link TaskRepository}. */
export class DrizzleTaskRepository implements TaskRepository {
  async list(workspaceId: string, projectId: string, query: TaskQuery = {}): Promise<Task[]> {
    assertLocalWorkspace(workspaceId);
    const conditions = [eq(tasks.projectId, projectId), ...queryConditions(query)];

    let statement = db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = statement.all();
    const blocked = loadBlockedSet(rows.map((r) => r.id));
    return rows.map((row) => toDomain(row, blocked.has(row.id)));
  }

  async listForWorkspace(workspaceId: string, query: TaskQuery = {}): Promise<Task[]> {
    assertLocalWorkspace(workspaceId);
    const conditions = queryConditions(query);

    let statement = db
      .select()
      .from(tasks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = statement.all();
    const blocked = loadBlockedSet(rows.map((r) => r.id));
    return rows.map((row) => toDomain(row, blocked.has(row.id)));
  }

  async findById(workspaceId: string, id: string): Promise<Task | null> {
    assertLocalWorkspace(workspaceId);
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) return null;
    return toDomain(row, loadBlockedSet([id]).has(id));
  }

  async create(workspaceId: string, input: TaskCreateInput): Promise<Task> {
    assertLocalWorkspace(workspaceId);
    const id = createId("tsk");
    const timestamp = nowIso();

    db.insert(tasks)
      .values({
        id,
        projectId: input.projectId,
        milestoneId: input.milestoneId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? "todo",
        priority: input.priority ?? "medium",
        // assigneeId is intentionally never persisted here — desktop has no
        // user concept. Silently accepting one would promise something the
        // next read could never honor.
        assigneeId: null,
        dueDate: input.dueDate ?? null,
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp,
        completedAt: input.completedAt ?? null,
      })
      .run();

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created task");
    return created;
  }

  async update(workspaceId: string, id: string, input: TaskUpdateInput): Promise<Task | null> {
    assertLocalWorkspace(workspaceId);
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) return null;

    const patch: Partial<TaskRow> = { updatedAt: nowIso() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.milestoneId !== undefined) patch.milestoneId = input.milestoneId;
    if (input.parentTaskId !== undefined) patch.parentTaskId = input.parentTaskId;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    // See create()'s own note — assigneeId is never persisted on desktop.

    if (input.status !== undefined) {
      patch.status = input.status;
      const nowDone = input.status === "done" || input.status === "cancelled";
      const wasDone = existing.status === "done" || existing.status === "cancelled";
      if (nowDone && !wasDone) patch.completedAt = input.completedAt ?? nowIso();
      else if (!nowDone && wasDone) patch.completedAt = null;
    }
    if (input.completedAt !== undefined) patch.completedAt = input.completedAt;

    db.update(tasks).set(patch).where(eq(tasks.id, id)).run();
    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) return false;
    db.delete(tasks).where(eq(tasks.id, id)).run();
    return true;
  }

  async listBlockers(workspaceId: string, taskId: string): Promise<Task[]> {
    assertLocalWorkspace(workspaceId);
    const rows = db
      .select({ task: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(eq(taskDependencies.taskId, taskId))
      .all();
    const blocked = loadBlockedSet(rows.map((r) => r.task.id));
    return rows.map((r) => toDomain(r.task, blocked.has(r.task.id)));
  }

  async listDependents(workspaceId: string, taskId: string): Promise<Task[]> {
    assertLocalWorkspace(workspaceId);
    const rows = db
      .select({ task: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(eq(taskDependencies.dependsOnTaskId, taskId))
      .all();
    const blocked = loadBlockedSet(rows.map((r) => r.task.id));
    return rows.map((r) => toDomain(r.task, blocked.has(r.task.id)));
  }

  async addDependency(workspaceId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    assertLocalWorkspace(workspaceId);
    if (taskId === dependsOnTaskId) throw new DependencyCycleError();

    db.transaction((tx) => {
      // Would `dependsOnTaskId` already (transitively) depend on `taskId`?
      // If so, taskId -> dependsOnTaskId would close a cycle. Walking from
      // dependsOnTaskId along its own "depends on" edges and checking
      // whether taskId is reachable answers exactly that. A single
      // connection (better-sqlite3, desktop) already serializes every
      // write through this transaction — no extra locking needed the way
      // PostgresTaskRepository needs it for concurrent hosted writers.
      const cycle = tx.get<{ found: number }>(sql`
        WITH RECURSIVE reachable(id) AS (
          SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ${dependsOnTaskId}
          UNION
          SELECT td.depends_on_task_id AS id FROM task_dependencies td
          JOIN reachable r ON td.task_id = r.id
        )
        SELECT 1 AS found FROM reachable WHERE id = ${taskId} LIMIT 1
      `);
      if (cycle) throw new DependencyCycleError();

      tx.insert(taskDependencies).values({ taskId, dependsOnTaskId }).onConflictDoNothing().run();
      return true;
    });
  }

  async removeDependency(
    workspaceId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<void> {
    assertLocalWorkspace(workspaceId);
    db.delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .run();
  }
}
