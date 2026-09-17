import "server-only";

import { getPgDb, withPgClient } from "@/db/pg-client";
import { ownershipClaims, type OwnershipClaimStatus } from "@/db/schema.pg";
import { LOCAL_WORKSPACE_ID } from "@/db/repositories/project-repository";
import { PostgresProjectRepository } from "@/db/repositories/postgres-project-repository";
import { ensurePersonalWorkspace, getMembership } from "@/core/workspaces/service";
import { safeEqual } from "@/lib/safe-equal";
import { eq } from "drizzle-orm";

/** The claim row is always this one id — there is only ever one legacy install to claim. */
const CLAIM_ID = "singleton";

export type OwnershipClaimReason =
  | "not_available"
  | "invalid_password"
  | "already_claimed"
  | "claim_in_progress"
  | "claimant_mismatch"
  | "workspace_not_owned"
  | "workspace_mismatch";

export interface OwnershipClaimHooks {
  beforeTargetCreation?: (project: any) => Promise<void> | void;
  afterTargetCreationBeforeCheckpoint?: (project: any) => Promise<void> | void;
  duringCheckpointPersistence?: (project: any) => Promise<void> | void;
  afterCheckpointing?: (project: any) => Promise<void> | void;
  duringFinalCompletionUpdate?: () => Promise<void> | void;
}

export class OwnershipClaimError extends Error {
  readonly reason: OwnershipClaimReason;

  constructor(reason: OwnershipClaimReason) {
    super(
      reason === "not_available"
        ? "This deployment has no DASHBOARD_PASSWORD configured, so there is no legacy install to claim."
        : reason === "invalid_password"
          ? "That is not this deployment's dashboard password."
          : reason === "claim_in_progress"
            ? "An ownership claim is currently in progress."
            : reason === "already_claimed"
              ? "This deployment has already been claimed."
              : reason === "claimant_mismatch"
                ? "Only the original claimant can resume an incomplete claim."
                : reason === "workspace_not_owned"
                  ? "The claimant must belong to and own the target workspace."
                  : "The stored workspace does not match the target workspace.",
    );
    this.name = "OwnershipClaimError";
    this.reason = reason;
  }
}

export interface OwnershipClaimResult {
  workspaceId: string;
  projectsImported: number;
}

export interface OwnershipClaimProgress {
  status: OwnershipClaimStatus;
  projectsImported: number;
  lastError: string | null;
}

/**
 * True once this deployment's legacy SQLite data has already been claimed —
 * lets a caller show "already done" without attempting (and failing) the
 * claim itself, e.g. to hide the claim UI once it no longer applies.
 *
 * Returns true only when status is "completed".
 */
export async function isAlreadyClaimed(): Promise<boolean> {
  const db = getPgDb();
  const [row] = await db
    .select({ id: ownershipClaims.id, status: ownershipClaims.status })
    .from(ownershipClaims)
    .where(eq(ownershipClaims.id, CLAIM_ID))
    .limit(1);
  return row?.status === "completed";
}

/**
 * Imports this deployment's legacy SQLite `projects` + `tags` into
 * `userId`'s personal workspace, provided `suppliedPassword` matches the
 * deployment's own `DASHBOARD_PASSWORD`.
 *
 * Resumable and idempotent:
 * - Uses a PostgreSQL advisory lock to serialize concurrent attempts across replicas.
 * - Tracks per-item progress in `importedProjectIds` jsonb column.
 * - Follows explicit state lifecycle: pending -> running -> partially_completed -> completed (or failed).
 * - A failure halfway through records items already imported, updating `status = 'partially_completed'`
 *   and `lastError`.
 * - Subsequent retries skip already-imported projects, preventing duplicate records.
 */
export async function claimOwnership(
  userId: string,
  suppliedPassword: string,
  hooks?: OwnershipClaimHooks,
): Promise<OwnershipClaimResult> {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) throw new OwnershipClaimError("not_available");
  if (!safeEqual(suppliedPassword, password)) throw new OwnershipClaimError("invalid_password");

  const workspace = await ensurePersonalWorkspace(userId);
  const db = getPgDb();

  return await withPgClient(async (client) => {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('ownership_claim')) AS acquired",
    );
    if (!lockResult.rows[0]?.acquired) {
      throw new OwnershipClaimError("claim_in_progress");
    }

    try {
      const [existing] = await db
        .select()
        .from(ownershipClaims)
        .where(eq(ownershipClaims.id, CLAIM_ID))
        .limit(1);

      if (existing) {
        if (existing.status === "completed") {
          throw new OwnershipClaimError("already_claimed");
        }

        // 3. Bind retries to original claimant: only the original claimedBy account can resume.
        if (existing.claimedBy && existing.claimedBy !== userId) {
          throw new OwnershipClaimError("claimant_mismatch");
        }

        // Verify the claimant still belongs to and owns the target workspace.
        const membership = await getMembership(existing.workspaceId, userId);
        if (!membership || membership.role !== "owner") {
          throw new OwnershipClaimError("workspace_not_owned");
        }

        // Verify stored workspace is the intended target.
        if (existing.workspaceId !== workspace.id) {
          throw new OwnershipClaimError("workspace_mismatch");
        }
      }

      let importedProjectIds: string[] = Array.isArray(existing?.importedProjectIds)
        ? (existing.importedProjectIds as string[])
        : [];
      const targetWorkspaceId = existing?.workspaceId || workspace.id;

      if (!existing) {
        await db.insert(ownershipClaims).values({
          id: CLAIM_ID,
          claimedBy: userId,
          workspaceId: targetWorkspaceId,
          status: "running",
          projectsImported: 0,
          importedProjectIds: [],
          lastError: null,
          claimedAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        await db
          .update(ownershipClaims)
          .set({
            status: "running",
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(ownershipClaims.id, CLAIM_ID));
      }

      const { withLegacySqliteAccess } = await import("@/db/client");
      const { DrizzleProjectRepository } = await import(
        "@/db/repositories/drizzle-project-repository"
      );
      const legacyProjects = await withLegacySqliteAccess(async () => {
        return await new DrizzleProjectRepository().list(LOCAL_WORKSPACE_ID, {
          includeArchived: true,
        });
      });

      for (const project of legacyProjects) {
        if (importedProjectIds.includes(project.id)) {
          // Idempotent: already imported in a previous attempt.
          continue;
        }

        try {
          // 2. Make target project creation and progress checkpoint one PostgreSQL transaction
          await db.transaction(async (tx) => {
            await hooks?.beforeTargetCreation?.(project);

            const txProjectRepo = new PostgresProjectRepository(tx);
            await txProjectRepo.create(targetWorkspaceId, {
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
              metadata: {
                ...(typeof project.metadata === "object" && project.metadata ? project.metadata : {}),
                legacyProjectId: project.id,
              },
            });

            await hooks?.afterTargetCreationBeforeCheckpoint?.(project);

            await hooks?.duringCheckpointPersistence?.(project);

            const nextImported = [...importedProjectIds, project.id];
            await tx
              .update(ownershipClaims)
              .set({
                status: "partially_completed",
                importedProjectIds: nextImported,
                projectsImported: nextImported.length,
                updatedAt: new Date(),
              })
              .where(eq(ownershipClaims.id, CLAIM_ID));
          });

          // Committed together atomically
          importedProjectIds = [...importedProjectIds, project.id];

          await hooks?.afterCheckpointing?.(project);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await db
            .update(ownershipClaims)
            .set({
              status: importedProjectIds.length > 0 ? "partially_completed" : "failed",
              lastError: errorMessage,
              projectsImported: importedProjectIds.length,
              updatedAt: new Date(),
            })
            .where(eq(ownershipClaims.id, CLAIM_ID));
          throw err;
        }
      }

      await hooks?.duringFinalCompletionUpdate?.();

      await db
        .update(ownershipClaims)
        .set({
          status: "completed",
          projectsImported: importedProjectIds.length,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(ownershipClaims.id, CLAIM_ID));

      return { workspaceId: targetWorkspaceId, projectsImported: importedProjectIds.length };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('ownership_claim'))");
    }
  });
}
