/**
 * PostgreSQL implementation of ActivityRepository (Release 2C.4).
 */
import { and, desc, eq } from "drizzle-orm";
import type { TaskActivityEvent } from "@/core/tasks/types";
import { getPgDb } from "../pg-client";
import { taskActivityEvents } from "../schema.pg";
import type { ActivityRepository } from "./activity-repository";

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

    return rows.map((r) => this.mapRow(r));
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

    return rows.map((r) => this.mapRow(r));
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
