/**
 * The persistence contract for task checklists (Release 2C.3).
 * Follows the task repository pattern. Everything above this line depends only
 * on this interface, never on Drizzle or a specific database directly.
 */
import type {
  ChecklistItemActorOptions,
  CreateChecklistItemInput,
  Task,
  TaskChecklistItem,
  UpdateChecklistItemInput,
} from "@/core/tasks/types";

export const MAX_CHECKLIST_ITEMS_PER_TASK = 100;
export const MIN_CHECKLIST_TEXT_LENGTH = 1;
export const MAX_CHECKLIST_TEXT_LENGTH = 500;

export interface ChecklistRepository {
  /** Returns all checklist items for a task ordered by position ascending. */
  list(workspaceId: string, taskId: string): Promise<TaskChecklistItem[]>;

  /** Finds a single checklist item by id. */
  findById(workspaceId: string, taskId: string, itemId: string): Promise<TaskChecklistItem | null>;

  /** Creates and appends a new item at position count. */
  create(
    workspaceId: string,
    taskId: string,
    input: CreateChecklistItemInput,
    options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem>;

  /** Updates text of an item. */
  update(
    workspaceId: string,
    taskId: string,
    itemId: string,
    input: UpdateChecklistItemInput,
  ): Promise<TaskChecklistItem | null>;

  /** Reorders all items for a task. itemIds must contain all current item IDs. */
  reorder(
    workspaceId: string,
    taskId: string,
    itemIds: string[],
  ): Promise<TaskChecklistItem[]>;

  /** Marks an item complete (done = true, doneBy = actorUserId, doneAt = now). */
  complete(
    workspaceId: string,
    taskId: string,
    itemId: string,
    options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem | null>;

  /** Reopens a completed item (done = false, doneBy = null, doneAt = null). */
  reopen(
    workspaceId: string,
    taskId: string,
    itemId: string,
    options?: ChecklistItemActorOptions,
  ): Promise<TaskChecklistItem | null>;

  /** Deletes an item and shifts subsequent positions down. */
  delete(
    workspaceId: string,
    taskId: string,
    itemId: string,
    options?: ChecklistItemActorOptions,
  ): Promise<boolean>;

  /**
   * Converts an item to a full task in the same project, atomically removing
   * the checklist item and executing standard task invariants.
   */
  convertToTask(
    workspaceId: string,
    taskId: string,
    itemId: string,
    options?: ChecklistItemActorOptions,
  ): Promise<Task>;
}
