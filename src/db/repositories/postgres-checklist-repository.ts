import "server-only";

import { and, asc, count, eq, sql } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { taskActivityEvents, taskChecklistItems, tasks } from "../schema.pg";
import type { TaskChecklistItemRow } from "../schema.pg";
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
import type { ChecklistRepository } from "./checklist-repository";
import {
  MAX_CHECKLIST_ITEMS_PER_TASK,
  MAX_CHECKLIST_TEXT_LENGTH,
  MIN_CHECKLIST_TEXT_LENGTH,
} from "./checklist-repository";
import { PostgresTaskRepository } from "./postgres-task-repository";
import type { TaskRepository } from "./task-repository";

function toDomain(row: TaskChecklistItemRow): TaskChecklistItem {
  return {
    id: row.id,
    taskId: row.taskId,
    workspaceId: row.workspaceId,
    position: row.position,
    text: row.text,
    done: Boolean(row.done),
    doneBy: row.doneBy ?? null,
    doneAt: row.doneAt?.toISOString() ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

export class PostgresChecklistRepository implements ChecklistRepository {
  private taskRepo: PostgresTaskRepository;

  constructor(taskRepo?: PostgresTaskRepository) {
    this.taskRepo = taskRepo ?? new PostgresTaskRepository();
  }

  async list(workspaceId: string, taskId: string): Promise<TaskChecklistItem[]> {
    const db = getPgDb();
    const rows = await db
      .select()
      .from(taskChecklistItems)
      .where(
        and(
          eq(taskChecklistItems.workspaceId, workspaceId),
          eq(taskChecklistItems.taskId, taskId),
        ),
      )
      .orderBy(asc(taskChecklistItems.position));
    return rows.map(toDomain);
  }

  async findById(
    workspaceId: string,
    taskId: string,
    itemId: string,
  ): Promise<TaskChecklistItem | null> {
    const db = getPgDb();
    const [row] = await db
      .select()
      .from(taskChecklistItems)
      .where(
        and(
          eq(taskChecklistItems.workspaceId, workspaceId),
          eq(taskChecklistItems.taskId, taskId),
          eq(taskChecklistItems.id, itemId),
        ),
      )
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async create(
    workspaceId: string,
    taskId: string,
    input: CreateChecklistItemInput,
    options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem> {
    const text = validateText(input.text);
    const db = getPgDb();

    return db.transaction(async (tx) => {
      // Row lock parent task to serialize concurrent appends/reorders
      const [parentTask] = await tx
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
        .for("update");

      if (!parentTask) {
        throw new ChecklistItemNotFoundError(`Task "${taskId}" not found in workspace.`);
      }

      const [countResult] = await tx
        .select({ value: count() })
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
          ),
        );

      const currentCount = Number(countResult?.value ?? 0);
      if (currentCount >= MAX_CHECKLIST_ITEMS_PER_TASK) {
        throw new ChecklistLimitExceededError(
          `Task checklist cannot exceed ${MAX_CHECKLIST_ITEMS_PER_TASK} items.`,
        );
      }

      const id = createId("chk");
      const now = new Date();

      await tx.insert(taskChecklistItems).values({
        id,
        workspaceId,
        taskId,
        position: currentCount,
        text,
        done: false,
        doneBy: null,
        doneAt: null,
        createdBy: options?.actorUserId ?? null,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(taskActivityEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        projectId: parentTask.projectId,
        taskId,
        actorId: options?.actorUserId ?? null,
        type: "checklist.item_added",
        details: { itemId: id, text },
      });

      const [created] = await tx
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, id),
          ),
        )
        .limit(1);

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
    const db = getPgDb();
    const values: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (input.text !== undefined) {
      values.text = validateText(input.text);
    }

    const [updated] = await db
      .update(taskChecklistItems)
      .set(values)
      .where(
        and(
          eq(taskChecklistItems.workspaceId, workspaceId),
          eq(taskChecklistItems.taskId, taskId),
          eq(taskChecklistItems.id, itemId),
        ),
      )
      .returning();

    return updated ? toDomain(updated) : null;
  }

  async reorder(
    workspaceId: string,
    taskId: string,
    itemIds: string[],
  ): Promise<TaskChecklistItem[]> {
    const db = getPgDb();

    return db.transaction(async (tx) => {
      // Row lock parent task to serialize concurrent reorders
      const [parentTask] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
        .for("update");

      if (!parentTask) {
        throw new ChecklistItemNotFoundError(`Task "${taskId}" not found in workspace.`);
      }

      const currentRows = await tx
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
          ),
        )
        .for("update");

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

      const now = new Date();
      for (let i = 0; i < itemIds.length; i++) {
        await tx
          .update(taskChecklistItems)
          .set({ position: i, updatedAt: now })
          .where(
            and(
              eq(taskChecklistItems.workspaceId, workspaceId),
              eq(taskChecklistItems.taskId, taskId),
              eq(taskChecklistItems.id, itemIds[i]!),
            ),
          );
      }

      const rows = await tx
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
          ),
        )
        .orderBy(asc(taskChecklistItems.position));

      return rows.map(toDomain);
    });
  }

  async complete(
    workspaceId: string,
    taskId: string,
    itemId: string,
    options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem | null> {
    const db = getPgDb();
    const now = new Date();

    return db.transaction(async (tx) => {
      const [parentTask] = await tx
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));

      const [updated] = await tx
        .update(taskChecklistItems)
        .set({
          done: true,
          doneBy: options?.actorUserId ?? null,
          doneAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .returning();

      if (updated && parentTask) {
        await tx.insert(taskActivityEvents).values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: parentTask.projectId,
          taskId,
          actorId: options?.actorUserId ?? null,
          type: "checklist.item_completed",
          details: { itemId, text: updated.text },
        });
      }

      return updated ? toDomain(updated) : null;
    });
  }

  async reopen(
    workspaceId: string,
    taskId: string,
    itemId: string,
  ): Promise<TaskChecklistItem | null> {
    const db = getPgDb();
    const now = new Date();

    return db.transaction(async (tx) => {
      const [parentTask] = await tx
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));

      const [updated] = await tx
        .update(taskChecklistItems)
        .set({
          done: false,
          doneBy: null,
          doneAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .returning();

      if (updated && parentTask) {
        await tx.insert(taskActivityEvents).values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: parentTask.projectId,
          taskId,
          actorId: null,
          type: "checklist.item_reopened",
          details: { itemId, text: updated.text },
        });
      }

      return updated ? toDomain(updated) : null;
    });
  }

  async delete(
    workspaceId: string,
    taskId: string,
    itemId: string,
  ): Promise<boolean> {
    const db = getPgDb();

    return db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .for("update");

      if (!item) return false;

      const [parentTask] = await tx
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));

      await tx
        .delete(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        );

      // Re-index remaining positions
      await tx
        .update(taskChecklistItems)
        .set({
          position: sql`${taskChecklistItems.position} - 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            sql`${taskChecklistItems.position} > ${item.position}`,
          ),
        );

      if (parentTask) {
        await tx.insert(taskActivityEvents).values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: parentTask.projectId,
          taskId,
          actorId: null,
          type: "checklist.item_deleted",
          details: { itemId, text: item.text },
        });
      }

      return true;
    });
  }

  async convertToTask(
    workspaceId: string,
    taskId: string,
    itemId: string,
    options?: ChecklistItemActorOptions,
  ): Promise<Task> {
    const db = getPgDb();

    return db.transaction(async (tx) => {
      const [parentTask] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
        .for("update");

      if (!parentTask) {
        throw new ChecklistItemNotFoundError(`Parent task "${taskId}" not found.`);
      }

      const [item] = await tx
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        )
        .for("update");

      if (!item) {
        throw new ChecklistItemNotFoundError(`Checklist item "${itemId}" not found.`);
      }

      // Convert through normal task invariants and create
      const createdTask = await this.taskRepo.create(
        workspaceId,
        {
          projectId: parentTask.projectId,
          title: item.text,
        },
        {
          actorUserId: options?.actorUserId,
          tx,
        },
      );

      // Delete checklist item
      await tx
        .delete(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            eq(taskChecklistItems.id, itemId),
          ),
        );

      // Re-index remaining positions
      await tx
        .update(taskChecklistItems)
        .set({
          position: sql`${taskChecklistItems.position} - 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(taskChecklistItems.workspaceId, workspaceId),
            eq(taskChecklistItems.taskId, taskId),
            sql`${taskChecklistItems.position} > ${item.position}`,
          ),
        );

      await tx.insert(taskActivityEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        projectId: parentTask.projectId,
        taskId,
        actorId: options?.actorUserId ?? null,
        type: "checklist.item_converted",
        details: { itemId, createdTaskId: createdTask.id },
      });

      return createdTask;
    });
  }
}
