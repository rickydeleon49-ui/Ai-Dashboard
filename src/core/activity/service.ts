import "server-only";

import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { activityEvents, projects } from "@/db/schema";

export interface ActivityItem {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  projectId: string | null;
  projectName: string | null;
  metadata: Record<string, unknown>;
}

/** Most recent events across the whole dashboard, newest first. */
export async function listRecentActivity(limit = 12): Promise<ActivityItem[]> {
  const rows = db
    .select({
      id: activityEvents.id,
      type: activityEvents.type,
      message: activityEvents.message,
      createdAt: activityEvents.createdAt,
      projectId: activityEvents.projectId,
      metadata: activityEvents.metadata,
      projectName: projects.name,
    })
    .from(activityEvents)
    .leftJoin(projects, eq(projects.id, activityEvents.projectId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    createdAt: row.createdAt,
    projectId: row.projectId,
    projectName: row.projectName ?? null,
    metadata: safeParse(row.metadata),
  }));
}

/** Events scoped to one project, for the detail page timeline. */
export async function listProjectActivity(
  projectId: string,
  limit = 20,
): Promise<ActivityItem[]> {
  const rows = db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.projectId, projectId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    createdAt: row.createdAt,
    projectId: row.projectId,
    projectName: null,
    metadata: safeParse(row.metadata),
  }));
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
