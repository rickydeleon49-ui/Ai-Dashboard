/**
 * Role independence helper for the agent run form (AW2-05, design §16.2 row 5).
 *
 * Compares implementer and reviewer providers to label the run's review independence:
 * - no reviewer: "none" -> "No independent review"
 * - reviewer provider equals implementer provider: "same-provider" -> "Same provider, separate session"
 * - different provider: "separate-provider" -> "Different provider"
 *
 * Compares provider IDs exactly after trim (no case folding).
 */

export type ReviewIndependenceKind =
  | "none"
  | "separate-provider"
  | "same-provider";

export interface ReviewIndependence {
  kind: ReviewIndependenceKind;
  label: string;
}

export function describeReviewIndependence(roles: {
  implementer: { provider: string };
  reviewer?: { provider?: string } | null;
}): ReviewIndependence {
  const reviewerProvider = roles?.reviewer?.provider?.trim() ?? "";
  if (!reviewerProvider) {
    return { kind: "none", label: "No independent review" };
  }

  const implementerProvider = roles?.implementer?.provider?.trim() ?? "";
  if (reviewerProvider === implementerProvider) {
    return { kind: "same-provider", label: "Same provider, separate session" };
  }

  return { kind: "separate-provider", label: "Different provider" };
}
