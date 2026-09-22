/**
 * POST /api/tasks/bulk, built from explicit dependencies.
 *
 * `createBulkTaskUpdateHandler(deps)` returns a request handler bound to a
 * frozen copy of `deps`. There is no module-level mutable state: tests build
 * their own handler with fault-injecting dependencies, and nothing they do can
 * affect the production handler or any other request.
 *
 * Only the data lookups used to validate a request's *content* are injectable
 * (tasks, milestones, and the membership of the requested assignee).
 * Authorization is not: `requireRole()` and the inactive-workspace check
 * always use the genuine workspace membership service, so no injected
 * dependency can grant access.
 */
import { NextResponse, type NextRequest } from "next/server";
import { milestoneRepository, taskRepository } from "@/db/repositories";
import type { MilestoneRepository } from "@/db/repositories/milestone-repository";
import type { TaskRepository } from "@/db/repositories/task-repository";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { bulkTaskUpdateSchema } from "@/core/tasks/schema";
import {
  InvalidAssigneeError,
  InvalidParentTaskError,
  TaskBlockedError,
  TaskLockTimeoutError,
} from "@/core/tasks/errors";
import type {
  BulkTaskItemResult,
  BulkTaskUpdateResponse,
  TaskUpdateInput,
} from "@/core/tasks/types";
import type { WorkspaceMembership } from "@/core/workspaces/types";
import { resolveWorkspaceAndUserForRequest } from "@/core/workspaces/current-workspace";
import {
  AuthorizationError,
  authorizationErrorResponse,
  requireRole,
} from "@/core/workspaces/authorization";
import { isAccountsMode } from "@/lib/auth-mode";

export interface BulkTaskUpdateDependencies {
  readonly taskRepository: Pick<TaskRepository, "findById" | "updateAuthoritative">;
  readonly milestoneRepository: Pick<MilestoneRepository, "findById">;
  /** Looks up the requested assignee's membership. Never used for authorization. */
  readonly getMembership: (workspaceId: string, userId: string) => Promise<WorkspaceMembership | null>;
  readonly isAccountsMode: () => boolean;
}

/** The genuine services, as used by the exported route. */
export const productionBulkTaskUpdateDependencies: BulkTaskUpdateDependencies = Object.freeze({
  taskRepository,
  milestoneRepository,
  getMembership: async (workspaceId: string, userId: string) =>
    (await import("@/core/workspaces/service")).getMembership(workspaceId, userId),
  isAccountsMode,
});

function workspaceRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Sign-in required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export function createBulkTaskUpdateHandler(
  dependencies: BulkTaskUpdateDependencies,
): (request: NextRequest) => Promise<NextResponse> {
  const deps: BulkTaskUpdateDependencies = Object.freeze({ ...dependencies });

  /**
   * Applies bounded, atomic per-task updates across a list of task IDs (up to 100).
   * Implements truthful partial-failure reporting, returning stable error codes and
   * retryable flags without exposing internal database details or cross-tenant existence.
   */
  return async function POST(request: NextRequest): Promise<NextResponse> {
    ensureDatabaseReady();

    const resolved = await resolveWorkspaceAndUserForRequest(request);
    if (!resolved) return workspaceRequiredResponse();
    const { workspaceId, userId } = resolved;

    if (userId) {
      const requestedWorkspaceCookie = request.cookies.get("cc-current-workspace")?.value;
      if (requestedWorkspaceCookie) {
        // Authorization: always the genuine membership service, never an injected one.
        const { getMembership } = await import("@/core/workspaces/service");
        const requestedMembership = await getMembership(requestedWorkspaceCookie, userId);
        if (requestedMembership && requestedMembership.status !== "active") {
          return authorizationErrorResponse(
            new AuthorizationError(
              "inactive_member",
              "Your membership in this workspace is not active.",
            ),
          );
        }
      }

      try {
        await requireRole(workspaceId, userId, "member");
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
        throw error;
      }
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
    }

    const parsed = bulkTaskUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json(
        { error: first?.message ?? "Invalid bulk update", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { taskIds, changes } = parsed.data;
    const uniqueTaskIds = Array.from(new Set(taskIds));
    const accountsMode = deps.isAccountsMode();

    // Lazy/cached helper to validate milestone without letting DB errors abort or masquerade as invalid_milestone
    let cachedMilestoneId: string | null | undefined = undefined;
    let cachedMilestoneResult:
      | { ok: true; milestone: Awaited<ReturnType<MilestoneRepository["findById"]>> | null }
      | { ok: false; errorCode: "internal_error"; error: string; retryable: true }
      | null = null;

    async function getTargetMilestone(mId: string | null | undefined) {
      if (mId === undefined || mId === null) {
        return { ok: true as const, milestone: null };
      }
      if (cachedMilestoneId === mId && cachedMilestoneResult !== null) {
        return cachedMilestoneResult;
      }
      cachedMilestoneId = mId;
      try {
        const ms = await deps.milestoneRepository.findById(workspaceId, mId);
        cachedMilestoneResult = { ok: true as const, milestone: ms };
        return cachedMilestoneResult;
      } catch {
        cachedMilestoneResult = {
          ok: false as const,
          errorCode: "internal_error" as const,
          error: "An unexpected error occurred while checking milestone",
          retryable: true as const,
        };
        return cachedMilestoneResult;
      }
    }

    // Lazy/cached helper to check assignee without letting DB errors abort or masquerade as invalid_assignee
    let cachedAssigneeId: string | null | undefined = undefined;
    let cachedAssigneeResult:
      | { ok: true; isActive: boolean }
      | { ok: false; errorCode: "internal_error"; error: string; retryable: true }
      | null = null;

    async function checkAssigneeActive(aId: string | null | undefined) {
      if (aId === undefined || aId === null) {
        return { ok: true as const, isActive: true };
      }
      if (!accountsMode) {
        return { ok: true as const, isActive: false };
      }
      if (cachedAssigneeId === aId && cachedAssigneeResult !== null) {
        return cachedAssigneeResult;
      }
      cachedAssigneeId = aId;
      try {
        const membership = await deps.getMembership(workspaceId, aId);
        cachedAssigneeResult = { ok: true as const, isActive: membership?.status === "active" };
        return cachedAssigneeResult;
      } catch {
        cachedAssigneeResult = {
          ok: false as const,
          errorCode: "internal_error" as const,
          error: "An unexpected error occurred while verifying assignee membership",
          retryable: true as const,
        };
        return cachedAssigneeResult;
      }
    }

    const results: BulkTaskItemResult[] = [];

    for (let i = 0; i < uniqueTaskIds.length; i++) {
      const taskId = uniqueTaskIds[i]!;
      try {
        let existing;
        try {
          existing = await deps.taskRepository.findById(workspaceId, taskId);
        } catch {
          console.error(`[bulk-task-update] internal error looking up task at index ${i}`);
          results.push({
            taskId,
            status: "failed",
            errorCode: "internal_error",
            error: "An unexpected error occurred while loading the task",
            retryable: true,
          });
          continue;
        }

        if (!existing) {
          results.push({
            taskId,
            status: "failed",
            errorCode: "not_found",
            error: "Task not found",
            retryable: false,
          });
          continue;
        }

        // Validate milestone belongs to the task's project
        if (changes.milestoneId !== undefined && changes.milestoneId !== null) {
          const msCheck = await getTargetMilestone(changes.milestoneId);
          if (!msCheck.ok) {
            results.push({
              taskId,
              status: "failed",
              errorCode: msCheck.errorCode,
              error: msCheck.error,
              retryable: msCheck.retryable,
            });
            continue;
          }
          if (!msCheck.milestone || msCheck.milestone.projectId !== existing.projectId) {
            results.push({
              taskId,
              status: "failed",
              errorCode: "invalid_milestone",
              error: "Milestone does not belong to this task's project",
              retryable: false,
            });
            continue;
          }
        }

        // Validate assignee is active member of workspace
        if (changes.assigneeId !== undefined && changes.assigneeId !== null) {
          const assigneeCheck = await checkAssigneeActive(changes.assigneeId);
          if (!assigneeCheck.ok) {
            results.push({
              taskId,
              status: "failed",
              errorCode: assigneeCheck.errorCode,
              error: assigneeCheck.error,
              retryable: assigneeCheck.retryable,
            });
            continue;
          }
          if (!assigneeCheck.isActive) {
            results.push({
              taskId,
              status: "failed",
              errorCode: "invalid_assignee",
              error: accountsMode
                ? "Assignee is not an active member of this workspace"
                : "Assignees are only supported in accounts mode",
              retryable: false,
            });
            continue;
          }
        }

        // Validate blocked-task completion protection
        if (changes.status === "done" && existing.blocked) {
          results.push({
            taskId,
            status: "failed",
            errorCode: "blocked_task",
            error: "Cannot complete a task that has unfinished dependencies",
            retryable: false,
          });
          continue;
        }

        // Prepare update payload
        const updateInput: TaskUpdateInput = {};
        if (changes.status !== undefined) updateInput.status = changes.status;
        if (changes.priority !== undefined) updateInput.priority = changes.priority;
        if (changes.milestoneId !== undefined) updateInput.milestoneId = changes.milestoneId;
        if (changes.assigneeId !== undefined) updateInput.assigneeId = changes.assigneeId;
        if (changes.dueDate !== undefined) updateInput.dueDate = changes.dueDate;

        const outcome = await deps.taskRepository.updateAuthoritative(
          workspaceId,
          taskId,
          updateInput,
          { actorUserId: userId ?? undefined },
        );

        if (!outcome) {
          results.push({
            taskId,
            status: "failed",
            errorCode: "not_found",
            error: "Task not found",
            retryable: false,
          });
        } else if (outcome.unchanged) {
          results.push({
            taskId,
            status: "unchanged",
          });
        } else {
          results.push({
            taskId,
            status: "updated",
          });
        }
      } catch (err) {
        if (err instanceof TaskBlockedError) {
          results.push({
            taskId,
            status: "failed",
            errorCode: "blocked_task",
            error: err.message,
            retryable: false,
          });
        } else if (err instanceof TaskLockTimeoutError) {
          results.push({
            taskId,
            status: "failed",
            errorCode: "conflict",
            error: "Task lock timeout due to concurrent modification",
            retryable: true,
          });
        } else if (err instanceof InvalidAssigneeError) {
          results.push({
            taskId,
            status: "failed",
            errorCode: "invalid_assignee",
            error: err.message,
            retryable: false,
          });
        } else if (err instanceof InvalidParentTaskError) {
          results.push({
            taskId,
            status: "failed",
            errorCode: "validation_failed",
            error: err.message,
            retryable: false,
          });
        } else {
          console.error(`[bulk-task-update] unexpected error updating task at index ${i}`);
          results.push({
            taskId,
            status: "failed",
            errorCode: "internal_error",
            error: "An unexpected error occurred while updating the task",
            retryable: true,
          });
        }
      }
    }

    const updated = results.filter((r) => r.status === "updated").length;
    const unchanged = results.filter((r) => r.status === "unchanged").length;
    const succeeded = updated + unchanged;
    const failed = results.filter((r) => r.status === "failed").length;

    const responsePayload: BulkTaskUpdateResponse = {
      requested: uniqueTaskIds.length,
      succeeded,
      updated,
      unchanged,
      failed,
      results,
    };

    return NextResponse.json(responsePayload, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  };
}
