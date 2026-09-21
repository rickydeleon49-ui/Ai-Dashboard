/**
 * The persistence contract for task activity history (Release 2C.4).
 *
 * Stored events are immutable. The list methods return sanitized
 * representations: comment lifecycle events for a comment that isn't live in
 * the listing's scope come back with `actorId: null` and `details` reduced to
 * `{ commentId }` (see core/tasks/activity-redaction.ts). This applies to every
 * caller role; raw rows are only reachable through dedicated audit paths.
 */
import type { TaskActivityEvent } from "@/core/tasks/types";

export type ActivityListScope =
  | { workspaceId: string; taskId: string }
  | { workspaceId: string; projectId: string };

export interface ActivityRepository {
  /** Lists chronological activity events for a task, sanitized for output. */
  listByTask(workspaceId: string, taskId: string, limit?: number): Promise<TaskActivityEvent[]>;

  /** Lists chronological activity events for a project, sanitized for output. */
  listByProject(workspaceId: string, projectId: string, limit?: number): Promise<TaskActivityEvent[]>;

  /** Records an immutable activity event. */
  record(
    event: Omit<TaskActivityEvent, "id" | "createdAt">,
  ): Promise<TaskActivityEvent>;
}
