/**
 * Pure rules for when an agent run can take new owner comments (AW.2, review S3).
 * No server imports: the API route and the run page both use it.
 */
import { isTerminalStatus } from "./types";

/** Why a run cannot take new comments, or null when it can. */
export function commentRejectionReason(run: {
  status: string;
  hasReviewStage: boolean;
}): string | null {
  if (isTerminalStatus(run.status)) {
    return "This run has ended, so a new comment would never reach the agent.";
  }
  if (!run.hasReviewStage) {
    return "This run has no planner or reviewer stage, so comments are not read. Start a run with a reviewer to use them.";
  }
  return null;
}

/** True when the request has a planner or reviewer role (the AW.2 rounds flow). */
export function requestHasReviewStage(
  request: { roles?: { planner?: unknown; reviewer?: unknown } } | null | undefined,
): boolean {
  return Boolean(request?.roles?.planner || request?.roles?.reviewer);
}
