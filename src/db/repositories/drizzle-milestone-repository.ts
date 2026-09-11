import { and, desc, eq } from "drizzle-orm";
import { db } from "../client";
import { milestones } from "../schema";
import type { MilestoneRow } from "../schema";
import { LOCAL_WORKSPACE_ID } from "./project-repository";
import type { MilestoneRepository } from "./milestone-repository";
import type {
  Milestone,
  MilestoneCreateInput,
  MilestoneQuery,
  MilestoneStatus,
  MilestoneUpdateInput,
} from "@/core/tasks/types";
import { createId } from "@/lib/ids";

function nowIso(): string {
  return new Date().toISOString();
}

function toDomain(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status as MilestoneStatus,
    dueDate: row.dueDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

/** See `DrizzleProjectRepository`'s own copy of this check for the reasoning. */
function assertLocalWorkspace(workspaceId: string): void {
  if (workspaceId !== LOCAL_WORKSPACE_ID) {
    throw new Error(
      `DrizzleMilestoneRepository (SQLite) only serves "${LOCAL_WORKSPACE_ID}"; got "${workspaceId}". ` +
        "Hosted multi-user mode must use PostgresMilestoneRepository instead.",
    );
  }
}

/** SQLite-backed implementation of {@link MilestoneRepository}. */
export class DrizzleMilestoneRepository implements MilestoneRepository {
  async list(
    workspaceId: string,
    projectId: string,
    query: MilestoneQuery = {},
  ): Promise<Milestone[]> {
    assertLocalWorkspace(workspaceId);
    const conditions = [eq(milestones.projectId, projectId)];
    if (query.status && query.status !== "all") {
      conditions.push(eq(milestones.status, query.status));
    }

    const rows = db
      .select()
      .from(milestones)
      .where(and(...conditions))
      .orderBy(desc(milestones.createdAt))
      .all();
    return rows.map(toDomain);
  }

  async findById(workspaceId: string, id: string): Promise<Milestone | null> {
    assertLocalWorkspace(workspaceId);
    const row = db.select().from(milestones).where(eq(milestones.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async create(workspaceId: string, input: MilestoneCreateInput): Promise<Milestone> {
    assertLocalWorkspace(workspaceId);
    const id = createId("mst");
    const timestamp = nowIso();

    db.insert(milestones)
      .values({
        id,
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? "open",
        dueDate: input.dueDate ?? null,
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp,
        completedAt: input.completedAt ?? null,
      })
      .run();

    const created = await this.findById(workspaceId, id);
    if (!created) throw new Error("Failed to read back created milestone");
    return created;
  }

  async update(
    workspaceId: string,
    id: string,
    input: MilestoneUpdateInput,
  ): Promise<Milestone | null> {
    assertLocalWorkspace(workspaceId);
    const existing = db.select().from(milestones).where(eq(milestones.id, id)).get();
    if (!existing) return null;

    const patch: Partial<MilestoneRow> = { updatedAt: nowIso() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;

    // Completing or reopening a milestone keeps `completedAt` honest rather
    // than requiring the caller to set it explicitly every time.
    if (input.status !== undefined) {
      patch.status = input.status;
      if (input.status === "completed" && existing.status !== "completed") {
        patch.completedAt = input.completedAt ?? nowIso();
      } else if (input.status !== "completed" && existing.status === "completed") {
        patch.completedAt = null;
      }
    }
    if (input.completedAt !== undefined) patch.completedAt = input.completedAt;

    db.update(milestones).set(patch).where(eq(milestones.id, id)).run();
    return this.findById(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    assertLocalWorkspace(workspaceId);
    const existing = db.select().from(milestones).where(eq(milestones.id, id)).get();
    if (!existing) return false;
    db.delete(milestones).where(eq(milestones.id, id)).run();
    return true;
  }
}
