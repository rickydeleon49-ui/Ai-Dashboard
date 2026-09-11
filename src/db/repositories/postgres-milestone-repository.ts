import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { getPgDb } from "../pg-client";
import { milestones } from "../schema.pg";
import type {
  Milestone,
  MilestoneCreateInput,
  MilestoneQuery,
  MilestoneStatus,
  MilestoneUpdateInput,
} from "@/core/tasks/types";
import { createId } from "@/lib/ids";
import type { MilestoneRepository } from "./milestone-repository";

type MilestoneRow = typeof milestones.$inferSelect;

function toDomain(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status as MilestoneStatus,
    dueDate: row.dueDate?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/**
 * Postgres-backed, genuinely workspace-scoped implementation of
 * {@link MilestoneRepository} — hosted multi-user mode. Mirrors
 * `DrizzleMilestoneRepository`'s (SQLite) behavior closely so the two are
 * interchangeable from a caller's perspective; every query here
 * additionally filters on `workspaceId`.
 */
export class PostgresMilestoneRepository implements MilestoneRepository {
  async list(
    workspaceId: string,
    projectId: string,
    query: MilestoneQuery = {},
  ): Promise<Milestone[]> {
    const db = getPgDb();
    const conditions = [eq(milestones.workspaceId, workspaceId), eq(milestones.projectId, projectId)];
    if (query.status && query.status !== "all") {
      conditions.push(eq(milestones.status, query.status));
    }

    const rows = await db
      .select()
      .from(milestones)
      .where(and(...conditions))
      .orderBy(desc(milestones.createdAt));
    return rows.map(toDomain);
  }

  async findById(workspaceId: string, id: string): Promise<Milestone | null> {
    const db = getPgDb();
    const [row] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  async create(workspaceId: string, input: MilestoneCreateInput): Promise<Milestone> {
    const db = getPgDb();
    const id = createId("mst");
    const now = new Date();

    await db.insert(milestones).values({
      id,
      workspaceId,
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? "open",
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdAt: input.createdAt ? new Date(input.createdAt) : now,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : now,
      completedAt: input.completedAt ? new Date(input.completedAt) : null,
    });

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created milestone");
    return created;
  }

  async update(
    workspaceId: string,
    id: string,
    input: MilestoneUpdateInput,
  ): Promise<Milestone | null> {
    const db = getPgDb();
    const [existing] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)))
      .limit(1);
    if (!existing) return null;

    const patch: Partial<typeof milestones.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate ? new Date(input.dueDate) : null;

    if (input.status !== undefined) {
      patch.status = input.status;
      if (input.status === "completed" && existing.status !== "completed") {
        patch.completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
      } else if (input.status !== "completed" && existing.status === "completed") {
        patch.completedAt = null;
      }
    }
    if (input.completedAt !== undefined) {
      patch.completedAt = input.completedAt ? new Date(input.completedAt) : null;
    }

    await db
      .update(milestones)
      .set(patch)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)));
    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const db = getPgDb();
    const [existing] = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)))
      .limit(1);
    if (!existing) return false;
    await db
      .delete(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)));
    return true;
  }
}
