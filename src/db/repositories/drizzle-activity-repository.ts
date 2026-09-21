/**
 * SQLite implementation of ActivityRepository (Release 2C.4).
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { TaskActivityEvent } from "@/core/tasks/types";
import {
  collectCommentLifecycleIds,
  hasCommentLifecycleEvents,
  redactDeletedCommentEvents,
} from "@/core/tasks/activity-redaction";
import { db } from "../client";
import { taskActivityEvents, taskComments, tasks } from "../schema";
import type { ActivityRepository, ActivityListScope } from "./activity-repository";

export class DrizzleActivityRepository implements ActivityRepository {
  async listByTask(workspaceId: string, taskId: string, limit = 100): Promise<TaskActivityEvent[]> {
    const rows = db
      .select()
      .from(taskActivityEvents)
      .where(
        and(
          eq(taskActivityEvents.workspaceId, workspaceId),
          eq(taskActivityEvents.taskId, taskId),
        ),
      )
      .orderBy(desc(taskActivityEvents.createdAt))
      .limit(limit)
      .all();

    return this.sanitize({ workspaceId, taskId }, rows.map((r) => this.mapRow(r)));
  }

  async listByProject(workspaceId: string, projectId: string, limit = 100): Promise<TaskActivityEvent[]> {
    const rows = db
      .select()
      .from(taskActivityEvents)
      .where(
        and(
          eq(taskActivityEvents.workspaceId, workspaceId),
          eq(taskActivityEvents.projectId, projectId),
        ),
      )
      .orderBy(desc(taskActivityEvents.createdAt))
      .limit(limit)
      .all();

    return this.sanitize({ workspaceId, projectId }, rows.map((r) => this.mapRow(r)));
  }

  /**
   * Which of `commentIds` are live (not soft-deleted) within the listing's own
   * workspace and task/project scope. One query per page, bounded by the
   * page's distinct comment IDs.
   */
  async findLiveCommentIds(scope: ActivityListScope, commentIds: string[]): Promise<Set<string>> {
    if (commentIds.length === 0) return new Set();
    const commentConditions = and(
      eq(taskComments.workspaceId, scope.workspaceId),
      inArray(taskComments.id, commentIds),
      isNull(taskComments.deletedAt),
    );

    const rows =
      "taskId" in scope
        ? db
            .select({ id: taskComments.id })
            .from(taskComments)
            .where(and(commentConditions, eq(taskComments.taskId, scope.taskId)))
            .all()
        : db
            .select({ id: taskComments.id })
            .from(taskComments)
            .innerJoin(
              tasks,
              and(eq(tasks.id, taskComments.taskId), eq(tasks.projectId, scope.projectId)),
            )
            .where(commentConditions)
            .all();

    return new Set(rows.map((r) => r.id));
  }

  async record(
    event: Omit<TaskActivityEvent, "id" | "createdAt">,
  ): Promise<TaskActivityEvent> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const detailsStr = typeof event.details === "string" ? event.details : JSON.stringify(event.details ?? {});

    db.insert(taskActivityEvents)
      .values({
        id,
        workspaceId: event.workspaceId,
        projectId: event.projectId,
        taskId: event.taskId,
        actorId: event.actorId ?? null,
        type: event.type,
        details: detailsStr,
        createdAt: now,
      })
      .run();

    return {
      id,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      taskId: event.taskId,
      actorId: event.actorId ?? null,
      type: event.type,
      details: event.details ?? {},
      createdAt: now,
    };
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
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(row.details);
    } catch {
      details = {};
    }

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      taskId: row.taskId,
      actorId: row.actorId,
      type: row.type,
      details,
      createdAt: row.createdAt,
    };
  }
}
