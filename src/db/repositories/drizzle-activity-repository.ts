/**
 * SQLite implementation of ActivityRepository (Release 2C.4).
 */
import { and, desc, eq } from "drizzle-orm";
import type { TaskActivityEvent } from "@/core/tasks/types";
import { db } from "../client";
import { taskActivityEvents } from "../schema";
import type { ActivityRepository } from "./activity-repository";

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

    return rows.map((r) => this.mapRow(r));
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

    return rows.map((r) => this.mapRow(r));
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
