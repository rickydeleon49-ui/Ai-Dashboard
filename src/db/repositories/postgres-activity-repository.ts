/**
 * PostgreSQL implementation of ActivityRepository (Release 2C.4).
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { TaskActivityEvent } from "@/core/tasks/types";
import {
  collectCommentLifecycleIds,
  hasCommentLifecycleEvents,
  redactDeletedCommentEvents,
} from "@/core/tasks/activity-redaction";
import { getPgDb } from "../pg-client";
import { taskActivityEvents, taskComments, tasks } from "../schema.pg";
import type { ActivityRepository, ActivityListScope } from "./activity-repository";

export class PostgresActivityRepository implements ActivityRepository {
  async listByTask(workspaceId: string, taskId: string, limit = 100): Promise<TaskActivityEvent[]> {
    const db = getPgDb();
    const rows = await db
      .select()
      .from(taskActivityEvents)
      .where(
        and(
          eq(taskActivityEvents.workspaceId, workspaceId),
          eq(taskActivityEvents.taskId, taskId),
        ),
      )
      .orderBy(desc(taskActivityEvents.createdAt))
      .limit(limit);

    return this.sanitize({ workspaceId, taskId }, rows.map((r) => this.mapRow(r)));
  }

  async listByProject(workspaceId: string, projectId: string, limit = 100): Promise<TaskActivityEvent[]> {
    const db = getPgDb();
    const rows = await db
      .select()
      .from(taskActivityEvents)
      .where(
        and(
          eq(taskActivityEvents.workspaceId, workspaceId),
          eq(taskActivityEvents.projectId, projectId),
        ),
      )
      .orderBy(desc(taskActivityEvents.createdAt))
      .limit(limit);

    return this.sanitize({ workspaceId, projectId }, rows.map((r) => this.mapRow(r)));
  }

  /**
   * Which of `commentIds` are live (not soft-deleted) within the listing's own
   * workspace and task/project scope. One query per page, bounded by the
   * page's distinct comment IDs.
   */
  async findLiveCommentIds(scope: ActivityListScope, commentIds: string[]): Promise<Set<string>> {
    if (commentIds.length === 0) return new Set();
    const db = getPgDb();
    const commentConditions = and(
      eq(taskComments.workspaceId, scope.workspaceId),
      inArray(taskComments.id, commentIds),
      isNull(taskComments.deletedAt),
    );

    const rows =
      "taskId" in scope
        ? await db
            .select({ id: taskComments.id })
            .from(taskComments)
            .where(and(commentConditions, eq(taskComments.taskId, scope.taskId)))
        : await db
            .select({ id: taskComments.id })
            .from(taskComments)
            .innerJoin(
              tasks,
              and(
                eq(tasks.id, taskComments.taskId),
                eq(tasks.workspaceId, scope.workspaceId),
                eq(tasks.projectId, scope.projectId),
              ),
            )
            .where(commentConditions);

    return new Set(rows.map((r) => r.id));
  }

  async record(
    event: Omit<TaskActivityEvent, "id" | "createdAt">,
  ): Promise<TaskActivityEvent> {
    const db = getPgDb();
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(taskActivityEvents)
      .values({
        id,
        workspaceId: event.workspaceId,
        projectId: event.projectId,
        taskId: event.taskId,
        actorId: event.actorId ?? null,
        type: event.type,
        details: event.details ?? {},
      })
      .returning();

    if (!row) throw new Error("Failed to insert activity event");
    return this.mapRow(row);
  }

  private async sanitize(
    scope: ActivityListScope,
    events: TaskActivityEvent[],
  ): Promise<TaskActivityEvent[]> {
    if (!hasCommentLifecycleEvents(events)) return events;
    const live = await this.findLiveCommentIds(scope, collectCommentLifecycleIds(events));
    return redactDeletedCommentEvents(events, live);
  }

  private mapRow(row: typeof taskActivityEvents.$inferSelect): TaskActivityEvent {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      taskId: row.taskId,
      actorId: row.actorId,
      type: row.type,
      details: (row.details as Record<string, unknown>) ?? {},
      createdAt: row.createdAt.toISOString(),
    };
  }
}
