/**
 * The persistence contract for task activity history (Release 2C.4).
 */
import type { TaskActivityEvent } from "@/core/tasks/types";

export interface ActivityRepository {
  /** Lists chronological activity events for a task. */
  listByTask(workspaceId: string, taskId: string, limit?: number): Promise<TaskActivityEvent[]>;

  /** Lists chronological activity events for a project. */
  listByProject(workspaceId: string, projectId: string, limit?: number): Promise<TaskActivityEvent[]>;

  /** Records an immutable activity event. */
  record(
    event: Omit<TaskActivityEvent, "id" | "createdAt">,
  ): Promise<TaskActivityEvent>;
}
