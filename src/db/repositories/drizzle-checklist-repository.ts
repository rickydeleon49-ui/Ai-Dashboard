import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { taskChecklistItems, tasks } from "../schema";
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
        .select({ id: tasks.id })
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

    return updated ? toDomain(updated) : null;
  }

  async reopen(
    workspaceId: string,
    taskId: string,
    itemId: string,
  ): Promise<TaskChecklistItem | null> {
    assertLocalWorkspace(workspaceId);
    const timestamp = nowIso();

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

    return updated ? toDomain(updated) : null;
  }

  async delete(
    workspaceId: string,
    taskId: string,
    itemId: string,
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

      return true;
    });
  }

  async convertToTask(
    workspaceId: string,
    taskId: string,
    itemId: string,
    options?: ChecklistItemActorOptions,
  ): Promise<Task> {
    assertLocalWorkspace(workspaceId);

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

    // Convert through normal task invariants and create
    let createdTask: Task;
    try {
      createdTask = await this.taskRepo.create(
        workspaceId,
        {
          projectId: parentTask.projectId,
          title: item.text,
        },
        options,
      );
    } catch (err) {
      throw err;
    }

    try {
      db.transaction(() => {
        // Delete checklist item
        db.delete(taskChecklistItems)
          .where(
            and(
              eq(taskChecklistItems.taskId, taskId),
              eq(taskChecklistItems.id, itemId),
            ),
          )
          .run();

        // Re-index remaining positions
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
      });
    } catch (err) {
      await this.taskRepo.delete(workspaceId, createdTask.id);
      throw err;
    }

    return createdTask;
  }
}
