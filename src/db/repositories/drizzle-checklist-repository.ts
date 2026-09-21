import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { taskActivityEvents, taskChecklistItems, tasks } from "../schema";
import type { TaskChecklistItemRow } from "../schema";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import type { ChecklistRepository } from "./checklist-repository";
import {
  MAX_CHECKLIST_ITEMS_PER_TASK,
  MAX_CHECKLIST_TEXT_LENGTH,
  MIN_CHECKLIST_TEXT_LENGTH,
} from "./checklist-repository";
import type {
  ChecklistItemActorOptions,
  CreateChecklistItemInput,
  Task,
  TaskChecklistItem,
  TaskPriority,
  TaskStatus,
  UpdateChecklistItemInput,
} from "@/core/tasks/types";
import {
  ChecklistItemNotFoundError,
  ChecklistLimitExceededError,
  InvalidChecklistItemError,
} from "@/core/tasks/errors";
import { createId } from "@/lib/ids";
import { DrizzleTaskRepository } from "./drizzle-task-repository";
import type { TaskRepository } from "./task-repository";

function nowIso(): string {
  return new Date().toISOString();
}

function toDomain(row: TaskChecklistItemRow): TaskChecklistItem {
  return {
    id: row.id,
    taskId: row.taskId,
    workspaceId: row.workspaceId,
    position: row.position,
    text: row.text,
    done: Boolean(row.done),
    doneBy: null,
    doneAt: row.doneAt ?? null,
    createdBy: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleChecklistRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresChecklistRepository instead.",
    );
  }
}

function validateText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHECKLIST_TEXT_LENGTH || trimmed.length > MAX_CHECKLIST_TEXT_LENGTH) {
    throw new InvalidChecklistItemError(
      `Checklist item text must be between ${MIN_CHECKLIST_TEXT_LENGTH} and ${MAX_CHECKLIST_TEXT_LENGTH} characters.`,
    );
  }
  return trimmed;
}

export class DrizzleChecklistRepository implements ChecklistRepository {
  private taskRepo: TaskRepository;
  public __testFaultHook?: (stage: "delete" | "reindex" | "activity") => void;

  constructor(taskRepo?: TaskRepository) {
    this.taskRepo = taskRepo ?? new DrizzleTaskRepository();
  }

  async list(workspaceId: string, taskId: string): Promise<TaskChecklistItem[]> {
    assertLocalWorkspace(workspaceId);
    const rows = db
      .select()
      .from(taskChecklistItems)
      .where(eq(taskChecklistItems.taskId, taskId))
      .orderBy(asc(taskChecklistItems.position))
      .all();
    return rows.map(toDomain);
  }

  async findById(
    workspaceId: string,
    taskId: string,
    itemId: string,
  ): Promise<TaskChecklistItem | null> {
    assertLocalWorkspace(workspaceId);
    const row = db
      .select()
      .from(taskChecklistItems)
      .where(
        and(
          eq(taskChecklistItems.taskId, taskId),
          eq(taskChecklistItems.id, itemId),
        ),
      )
      .get();
    return row ? toDomain(row) : null;
  }

  async create(
    workspaceId: string,
    taskId: string,
    input: CreateChecklistItemInput,
    _options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem> {
    assertLocalWorkspace(workspaceId);
    const text = validateText(input.text);

    return db.transaction(() => {
      const parentTask = db
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();

      if (!parentTask) {
        throw new ChecklistItemNotFoundError(`Task "${taskId}" not found.`);
      }

      const countResult = db
        .select({ value: count() })
        .from(taskChecklistItems)
        .where(eq(taskChecklistItems.taskId, taskId))
        .get();

      const currentCount = Number(countResult?.value ?? 0);
      if (currentCount >= MAX_CHECKLIST_ITEMS_PER_TASK) {
        throw new ChecklistLimitExceededError(
          `Task checklist cannot exceed ${MAX_CHECKLIST_ITEMS_PER_TASK} items.`,
        );
      }

      const id = createId("chk");
      const timestamp = nowIso();

      db.insert(taskChecklistItems)
        .values({
          id,
          workspaceId: LOCAL_WORKSPACE_ID,
          taskId,
          position: currentCount,
          text,
          done: false,
          doneBy: null,
          doneAt: null,
          createdBy: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();

      db.insert(taskActivityEvents)
        .values({
          id: crypto.randomUUID(),
          workspaceId: LOCAL_WORKSPACE_ID,
          projectId: parentTask.projectId,
          taskId,
          actorId: null,
          type: "checklist.item_added",
          details: JSON.stringify({ itemId: id, text }),
          createdAt: timestamp,
        })
        .run();

      const created = db
        .select()
        .from(taskChecklistItems)
        .where(eq(taskChecklistItems.id, id))
        .get();

      if (!created) {
        throw new Error("Failed to read back created checklist item.");
      }
      return toDomain(created);
    });
  }

  async update(
    workspaceId: string,
    taskId: string,
    itemId: string,
    input: UpdateChecklistItemInput,
  ): Promise<TaskChecklistItem | null> {
    assertLocalWorkspace(workspaceId);
    const values: Record<string, any> = {
      updatedAt: nowIso(),
    };

    if (input.text !== undefined) {
      values.text = validateText(input.text);
    }

    db.update(taskChecklistItems)
      .set(values)
      .where(
        and(
          eq(taskChecklistItems.taskId, taskId),
          eq(taskChecklistItems.id, itemId),
        ),
      )
      .run();

    const updated = db
      .select()
      .from(taskChecklistItems)
      .where(
        and(
          eq(taskChecklistItems.taskId, taskId),
          eq(taskChecklistItems.id, itemId),
        ),
      )
      .get();

    return updated ? toDomain(updated) : null;
  }

  async reorder(
    workspaceId: string,
    taskId: string,
    itemIds: string[],
  ): Promise<TaskChecklistItem[]> {
    assertLocalWorkspace(workspaceId);

    return db.transaction(() => {
      const parentTask = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();

      if (!parentTask) {
        throw new ChecklistItemNotFoundError(`Task "${taskId}" not found.`);
      }

      const currentRows = db
        .select()
        .from(taskChecklistItems)
        .where(eq(taskChecklistItems.taskId, taskId))
        .all();

      if (itemIds.length !== currentRows.length) {
        throw new InvalidChecklistItemError(
          `Reorder list length (${itemIds.length}) does not match existing item count (${currentRows.length}).`,
        );
      }

      const currentIds = new Set(currentRows.map((r) => r.id));
      for (const id of itemIds) {
        if (!currentIds.has(id)) {
          throw new InvalidChecklistItemError(
            `Checklist item "${id}" does not belong to task "${taskId}".`,
          );
        }
      }

      const timestamp = nowIso();
      for (let i = 0; i < itemIds.length; i++) {
        db.update(taskChecklistItems)
          .set({ position: i, updatedAt: timestamp })
          .where(
            and(
              eq(taskChecklistItems.taskId, taskId),
              eq(taskChecklistItems.id, itemIds[i]!),
            ),
          )
          .run();
      }

      const rows = db
        .select()
        .from(taskChecklistItems)
        .where(eq(taskChecklistItems.taskId, taskId))
        .orderBy(asc(taskChecklistItems.position))
        .all();

      return rows.map(toDomain);
    });
  }

  async complete(
    workspaceId: string,
    taskId: string,
    itemId: string,
    _options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem | null> {
    assertLocalWorkspace(workspaceId);
    const timestamp = nowIso();

    return db.transaction(() => {
      const existing = db
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .get();

      if (!existing) return null;
      if (existing.done) {
        return toDomain(existing);
      }

      const parentTask = db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();

      db.update(taskChecklistItems)
        .set({
          done: true,
          doneBy: null,
          doneAt: timestamp,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .run();

      const updated = db
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .get();

      if (updated && parentTask) {
        db.insert(taskActivityEvents)
          .values({
            id: crypto.randomUUID(),
            workspaceId: LOCAL_WORKSPACE_ID,
            projectId: parentTask.projectId,
            taskId,
            actorId: null,
            type: "checklist.item_completed",
            details: JSON.stringify({ itemId, text: updated.text }),
            createdAt: timestamp,
          })
          .run();
      }

      return updated ? toDomain(updated) : null;
    });
  }

  async reopen(
    workspaceId: string,
    taskId: string,
    itemId: string,
    _options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem | null> {
    assertLocalWorkspace(workspaceId);
    const timestamp = nowIso();

    return db.transaction(() => {
      const existing = db
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .get();

      if (!existing) return null;
      if (!existing.done) {
        return toDomain(existing);
      }

      const parentTask = db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();

      db.update(taskChecklistItems)
        .set({
          done: false,
          doneBy: null,
          doneAt: null,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .run();

      const updated = db
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .get();

      if (updated && parentTask) {
        db.insert(taskActivityEvents)
          .values({
            id: crypto.randomUUID(),
            workspaceId: LOCAL_WORKSPACE_ID,
            projectId: parentTask.projectId,
            taskId,
            actorId: null,
            type: "checklist.item_reopened",
            details: JSON.stringify({ itemId, text: updated.text }),
            createdAt: timestamp,
          })
          .run();
      }

      return updated ? toDomain(updated) : null;
    });
  }

  async delete(
    workspaceId: string,
    taskId: string,
    itemId: string,
    _options?: ChecklistItemActorOptions,
  ): Promise<boolean> {
    assertLocalWorkspace(workspaceId);

    return db.transaction(() => {
      const item = db
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .get();

      if (!item) return false;

      const parentTask = db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();

      db.delete(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .run();

      db.update(taskChecklistItems)
        .set({
          position: sql`${taskChecklistItems.position} - 1`,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            sql`${taskChecklistItems.position} > ${item.position}`,
          ),
        )
        .run();

      if (parentTask) {
        db.insert(taskActivityEvents)
          .values({
            id: crypto.randomUUID(),
            workspaceId: LOCAL_WORKSPACE_ID,
            projectId: parentTask.projectId,
            taskId,
            actorId: null,
            type: "checklist.item_deleted",
            details: JSON.stringify({ itemId, text: item.text }),
            createdAt: nowIso(),
          })
          .run();
      }

      return true;
    });
  }

  async convertToTask(
    workspaceId: string,
    taskId: string,
    itemId: string,
    _options?: ChecklistItemActorOptions,
  ): Promise<Task> {
    assertLocalWorkspace(workspaceId);

    return db.transaction(() => {
      const parentTask = db
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();

      if (!parentTask) {
        throw new ChecklistItemNotFoundError(`Parent task "${taskId}" not found.`);
      }

      const item = db
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .get();

      if (!item) {
        throw new ChecklistItemNotFoundError(`Checklist item "${itemId}" not found.`);
      }

      const newTaskId = createId("tsk");
      const timestamp = nowIso();

      // 1. Create task preserving normal task invariants
      db.insert(tasks)
        .values({
          id: newTaskId,
          projectId: parentTask.projectId,
          milestoneId: null,
          parentTaskId: null,
          title: item.text,
          description: null,
          status: "todo",
          priority: "medium",
          assigneeId: null,
          dueDate: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
        })
        .run();

      db.insert(taskActivityEvents)
        .values({
          id: crypto.randomUUID(),
          workspaceId: LOCAL_WORKSPACE_ID,
          projectId: parentTask.projectId,
          taskId: newTaskId,
          actorId: null,
          type: "task.created",
          details: JSON.stringify({ title: item.text }),
          createdAt: timestamp,
        })
        .run();

      // Deterministic fault-injection hook point 1: deletion
      if (this.__testFaultHook) {
        this.__testFaultHook("delete");
      }

      // 2. Delete checklist item
      db.delete(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .run();

      // Deterministic fault-injection hook point 2: reindex
      if (this.__testFaultHook) {
        this.__testFaultHook("reindex");
      }

      // 3. Re-index remaining positions
      db.update(taskChecklistItems)
        .set({
          position: sql`${taskChecklistItems.position} - 1`,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(taskChecklistItems.taskId, taskId),
            sql`${taskChecklistItems.position} > ${item.position}`,
          ),
        )
        .run();

      // Deterministic fault-injection hook point 3: activity
      if (this.__testFaultHook) {
        this.__testFaultHook("activity");
      }

      // 4. Record converted activity event
      db.insert(taskActivityEvents)
        .values({
          id: crypto.randomUUID(),
          workspaceId: LOCAL_WORKSPACE_ID,
          projectId: parentTask.projectId,
          taskId,
          actorId: null,
          type: "checklist.item_converted",
          details: JSON.stringify({ itemId, createdTaskId: newTaskId }),
          createdAt: timestamp,
        })
        .run();

      const created = db
        .select()
        .from(tasks)
        .where(eq(tasks.id, newTaskId))
        .get();

      if (!created) {
        throw new Error("Failed to read back created task.");
      }

      return {
        id: created.id,
        projectId: created.projectId,
        milestoneId: created.milestoneId,
        parentTaskId: created.parentTaskId,
        title: created.title,
        description: created.description,
        status: created.status as TaskStatus,
        priority: created.priority as TaskPriority,
        assigneeId: null,
        assignedBy: null,
        assignedAt: null,
        dueDate: created.dueDate,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        completedAt: created.completedAt,
        blocked: false,
        checklistTotal: 0,
        checklistDone: 0,
      };
    });
  }
}
