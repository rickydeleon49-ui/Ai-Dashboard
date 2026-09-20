import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { db } from "../client";
import { taskChecklistItems, taskDependencies, tasks } from "../schema";
import type { TaskRow } from "../schema";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import type { TaskRepository } from "./task-repository";
import type {
  Task,
  TaskCreateInput,
  TaskMutationOptions,
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
} from "@/core/tasks/errors";
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
    assigneeId: null,
    assignedBy: null,
    assignedAt: null,
    dueDate: row.dueDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    blocked,
    checklistTotal: checklistCounts?.total ?? 0,
    checklistDone: checklistCounts?.done ?? 0,
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
 * Which of `taskIds` are currently blocked — have at least one unfinished
 * dependency anywhere in the reachable dependency graph along `task_dependencies`.
 *
 * Traverses reachable dependencies recursively with a CTE. A task is blocked
 * if and only if any reachable task in its dependency graph has a status other
 * than 'done' or 'cancelled'.
 */
function loadBlockedSet(taskIds: string[]): Set<string> {
  if (taskIds.length === 0) return new Set();
  const taskIdsList = sql.join(
    taskIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = db.all<{ task_id: string }>(sql`
    WITH RECURSIVE reachable(root_id, current_id) AS (
      SELECT task_id AS root_id, depends_on_task_id AS current_id
      FROM task_dependencies
      WHERE task_id IN (${taskIdsList})
      UNION
      SELECT r.root_id, td.depends_on_task_id AS current_id
      FROM task_dependencies td
      JOIN reachable r ON td.task_id = r.current_id
    )
    SELECT DISTINCT r.root_id AS task_id
    FROM reachable r
    JOIN tasks t ON t.id = r.current_id
    WHERE t.status NOT IN ('done', 'cancelled')
  `);
  return new Set(rows.map((r) => r.task_id));
}

function assertValidParentTask(
  taskId: string | null,
  parentTaskId: string | null | undefined,
  projectId: string,
): void {
  if (parentTaskId === undefined || parentTaskId === null) return;
  if (taskId !== null && parentTaskId === taskId) {
    throw new InvalidParentTaskError("A task cannot be its own parent.");
  }
  const parent = db.select().from(tasks).where(eq(tasks.id, parentTaskId)).get();
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
    const child = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.parentTaskId, taskId))
      .limit(1)
      .get();
    if (child) {
      throw new InvalidParentTaskError("A task with subtasks cannot become a subtask.");
    }
  }
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
  // assigneeId, assignedTo, assignedBy are desktop-meaningless (see toDomain's own note) — filtering
  // by any can never match a real row here, so this is "no results" rather
  // than a silently-ignored filter.
  if (query.assigneeId || query.assignedTo || query.assignedBy) conditions.push(sql`0`);
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
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)`.mapWith(Number),
      })
      .from(tasks)
      .leftJoin(taskChecklistItems, eq(taskChecklistItems.taskId, tasks.id))
      .where(and(...conditions))
      .groupBy(tasks.id)
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = statement.all();
    const blocked = loadBlockedSet(rows.map((r) => r.task.id));
    return rows.map((row) =>
      toDomain(row.task, blocked.has(row.task.id), {
        total: row.checklistTotal ?? 0,
        done: row.checklistDone ?? 0,
      }),
    );
  }

  async listForWorkspace(workspaceId: string, query: TaskQuery = {}): Promise<Task[]> {
    assertLocalWorkspace(workspaceId);
    const conditions = queryConditions(query);

    let statement = db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)`.mapWith(Number),
      })
      .from(tasks)
      .leftJoin(taskChecklistItems, eq(taskChecklistItems.taskId, tasks.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(tasks.id)
      .orderBy(...orderByFor(query.sort))
      .$dynamic();
    if (query.limit) statement = statement.limit(query.limit);

    const rows = statement.all();
    const blocked = loadBlockedSet(rows.map((r) => r.task.id));
    return rows.map((row) =>
      toDomain(row.task, blocked.has(row.task.id), {
        total: row.checklistTotal ?? 0,
        done: row.checklistDone ?? 0,
      }),
    );
  }

  async findById(workspaceId: string, id: string): Promise<Task | null> {
    assertLocalWorkspace(workspaceId);
    const row = db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)`.mapWith(Number),
      })
      .from(tasks)
      .leftJoin(taskChecklistItems, eq(taskChecklistItems.taskId, tasks.id))
      .where(eq(tasks.id, id))
      .groupBy(tasks.id)
      .get();
    if (!row) return null;
    return toDomain(row.task, loadBlockedSet([id]).has(id), {
      total: row.checklistTotal ?? 0,
      done: row.checklistDone ?? 0,
    });
  }

  async create(
    workspaceId: string,
    input: TaskCreateInput,
    _options?: TaskMutationOptions,
  ): Promise<Task> {
    assertLocalWorkspace(workspaceId);
    assertValidParentTask(null, input.parentTaskId, input.projectId);

    const id = createId("tsk");
    const timestamp = nowIso();

    db.transaction(() => {
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
          assigneeId: null,
          dueDate: input.dueDate ?? null,
          createdAt: input.createdAt ?? timestamp,
          updatedAt: input.updatedAt ?? timestamp,
          completedAt: input.completedAt ?? null,
        })
        .run();
    });

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created task");
    return created;
  }

  async update(
    workspaceId: string,
    id: string,
    input: TaskUpdateInput,
    _options?: TaskMutationOptions,
  ): Promise<Task | null> {
    assertLocalWorkspace(workspaceId);

    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) return null;

    if (input.parentTaskId !== undefined) {
      assertValidParentTask(id, input.parentTaskId, existing.projectId);
    }

    const patch: Partial<TaskRow> = { updatedAt: nowIso() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.milestoneId !== undefined) patch.milestoneId = input.milestoneId;
    if (input.parentTaskId !== undefined) patch.parentTaskId = input.parentTaskId;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;

    if (input.status !== undefined) {
      const movingToDone = input.status === "done";
      if (movingToDone && loadBlockedSet([id]).has(id)) throw new TaskBlockedError();

      patch.status = input.status;
      const nowDone = input.status === "done" || input.status === "cancelled";
      const wasDone = existing.status === "done" || existing.status === "cancelled";
      if (nowDone && !wasDone) patch.completedAt = input.completedAt ?? nowIso();
      else if (!nowDone && wasDone) patch.completedAt = null;
    }
    if (input.completedAt !== undefined) patch.completedAt = input.completedAt;

    db.transaction(() => {
      db.update(tasks).set(patch).where(eq(tasks.id, id)).run();
    });
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
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)`.mapWith(Number),
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .leftJoin(taskChecklistItems, eq(taskChecklistItems.taskId, tasks.id))
      .where(eq(taskDependencies.taskId, taskId))
      .groupBy(tasks.id)
      .all();
    const blocked = loadBlockedSet(rows.map((r) => r.task.id));
    return rows.map((r) =>
      toDomain(r.task, blocked.has(r.task.id), {
        total: r.checklistTotal ?? 0,
        done: r.checklistDone ?? 0,
      }),
    );
  }

  async listDependents(workspaceId: string, taskId: string): Promise<Task[]> {
    assertLocalWorkspace(workspaceId);
    const rows = db
      .select({
        task: tasks,
        checklistTotal: sql<number>`count(${taskChecklistItems.id})`.mapWith(Number),
        checklistDone: sql<number>`count(case when ${taskChecklistItems.done} then 1 end)`.mapWith(Number),
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .leftJoin(taskChecklistItems, eq(taskChecklistItems.taskId, tasks.id))
      .where(eq(taskDependencies.dependsOnTaskId, taskId))
      .groupBy(tasks.id)
      .all();
    const blocked = loadBlockedSet(rows.map((r) => r.task.id));
    return rows.map((r) =>
      toDomain(r.task, blocked.has(r.task.id), {
        total: r.checklistTotal ?? 0,
        done: r.checklistDone ?? 0,
      }),
    );
  }

  async addDependency(workspaceId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    assertLocalWorkspace(workspaceId);
    if (taskId === dependsOnTaskId) throw new DependencyCycleError();

    db.transaction((tx) => {
      const existing = tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.id, [taskId, dependsOnTaskId]))
        .all();
      if (existing.length < 2) {
        throw new Error(`Tasks "${taskId}" and "${dependsOnTaskId}" must both exist.`);
      }

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
