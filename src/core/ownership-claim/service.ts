import "server-only";

import { getPgDb } from "@/db/pg-client";
import { ownershipClaims } from "@/db/schema.pg";
import { DrizzleProjectRepository } from "@/db/repositories/drizzle-project-repository";
import { LOCAL_WORKSPACE_ID } from "@/db/repositories/project-repository";
import { PostgresProjectRepository } from "@/db/repositories/postgres-project-repository";
import { ensurePersonalWorkspace } from "@/core/workspaces/service";
import { safeEqual } from "@/lib/safe-equal";
import { eq } from "drizzle-orm";

/** The claim row is always this one id — there is only ever one legacy install to claim. */
const CLAIM_ID = "singleton";

export type OwnershipClaimReason = "not_available" | "invalid_password" | "already_claimed";

export class OwnershipClaimError extends Error {
  readonly reason: OwnershipClaimReason;

  constructor(reason: OwnershipClaimReason) {
    super(
      reason === "not_available"
        ? "This deployment has no DASHBOARD_PASSWORD configured, so there is no legacy install to claim."
        : reason === "invalid_password"
          ? "That is not this deployment's dashboard password."
          : "This deployment has already been claimed.",
    );
    this.name = "OwnershipClaimError";
    this.reason = reason;
  }
}

export interface OwnershipClaimResult {
  workspaceId: string;
  projectsImported: number;
}

/**
 * True once this deployment's legacy SQLite data has already been claimed —
 * lets a caller show "already done" without attempting (and failing) the
 * claim itself, e.g. to hide the claim UI once it no longer applies.
 */
export async function isAlreadyClaimed(): Promise<boolean> {
  const db = getPgDb();
  const [row] = await db
    .select({ id: ownershipClaims.id })
    .from(ownershipClaims)
    .where(eq(ownershipClaims.id, CLAIM_ID))
    .limit(1);
  return Boolean(row);
}

/**
 * One-shot: imports this deployment's legacy SQLite `projects` + `tags` into
 * `userId`'s personal workspace, provided `suppliedPassword` matches the
 * deployment's own `DASHBOARD_PASSWORD` — proof the caller is the
 * deployment's legitimate operator, not just any signed-in account, since a
 * fresh accounts-mode sign-up would otherwise let a stranger scoop up
 * another operator's pre-existing data. A session is checked by the route
 * handler; this only checks the password.
 *
 * Racing this concurrently is safe: the claim row is inserted with
 * `onConflictDoNothing()` *before* anything is imported, so only the first
 * request to reach that insert ever gets past it — every other caller,
 * including a legitimate retry, sees `already_claimed` and imports nothing
 * a second time. SQLite is only ever read here, never written, so the
 * legacy data survives a claim (or a hundred attempted claims) untouched.
 */
export async function claimOwnership(
  userId: string,
  suppliedPassword: string,
): Promise<OwnershipClaimResult> {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) throw new OwnershipClaimError("not_available");
  if (!safeEqual(suppliedPassword, password)) throw new OwnershipClaimError("invalid_password");

  const workspace = await ensurePersonalWorkspace(userId);

  const db = getPgDb();
  const [claimed] = await db
    .insert(ownershipClaims)
    .values({ id: CLAIM_ID, claimedBy: userId, workspaceId: workspace.id })
    .onConflictDoNothing()
    .returning();
  if (!claimed) throw new OwnershipClaimError("already_claimed");

  const legacyProjects = await new DrizzleProjectRepository().list(LOCAL_WORKSPACE_ID, {
    includeArchived: true,
  });

  const projectRepository = new PostgresProjectRepository();
  for (const project of legacyProjects) {
    await projectRepository.create(workspace.id, {
      name: project.name,
      description: project.description,
      source: project.source,
      type: project.type,
      status: project.status,
      tags: project.tags,
      repositoryUrl: project.repositoryUrl,
      projectUrl: project.projectUrl,
      localPath: project.localPath,
      notes: project.notes,
      favorite: project.favorite,
      archived: project.archived,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
      externalId: project.externalId,
      syncedAt: project.syncedAt,
      metadata: project.metadata,
    });
  }

  if (legacyProjects.length > 0) {
    await db
      .update(ownershipClaims)
      .set({ projectsImported: legacyProjects.length })
      .where(eq(ownershipClaims.id, CLAIM_ID));
  }

  return { workspaceId: workspace.id, projectsImported: legacyProjects.length };
}
