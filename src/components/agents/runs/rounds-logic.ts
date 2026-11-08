/**
 * Pure round logic for the run page (AW2-07b): which correction round an event
 * belongs to, and the diff / checks / review / plan views scoped to a round.
 * Legacy (AW.1) events carry no `round` and all count as round 0.
 */
import { severityClass, type SeverityClass } from "@/core/agents/severity";
import {
  deriveChecks,
  deriveDiff,
  deriveDiffPatch,
  deriveReview,
  type CheckView,
  type DiffPatchView,
  type DiffView,
  type ReviewView,
  type UiEvent,
} from "./logic";

/** Mirrors MAX_ROUNDS in the orchestrator prompts (not imported: server-only). */
export const MAX_UI_ROUND = 3;

export function roundOf(event: UiEvent): number {
  const p = event.payload;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const r = (p as Record<string, unknown>).round;
    if (typeof r === "number" && Number.isInteger(r) && r >= 0 && r <= MAX_UI_ROUND) return r;
  }
  return 0;
}

/** Sorted distinct rounds seen in the events; [0] when there are none (legacy). */
export function availableRounds(events: UiEvent[]): number[] {
  const set = new Set<number>([0]);
  for (const e of events) set.add(roundOf(e));
  return [...set].sort((a, b) => a - b);
}

export function roundLabel(round: number): string {
  return round === 0 ? "Initial" : `Round ${round}`;
}

function inRound(events: UiEvent[], round: number): UiEvent[] {
  return events.filter((e) => roundOf(e) === round);
}

export function diffForRound(events: UiEvent[], round: number): DiffView | null {
  return deriveDiff(inRound(events, round));
}

export function diffPatchForRound(events: UiEvent[], round: number): DiffPatchView | null {
  return deriveDiffPatch(inRound(events, round));
}

export function checksForRound(events: UiEvent[], round: number): CheckView[] {
  return deriveChecks(inRound(events, round));
}

export function reviewForRound(events: UiEvent[], round: number): ReviewView | null {
  return deriveReview(inRound(events, round));
}

export interface PlanView {
  task: string;
  scopePaths: string[];
  acceptance: string[];
  checks: string[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The latest planner output event `{kind:"plan", plan}`, or null. */
export function derivePlan(events: UiEvent[]): PlanView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.kind !== "output") continue;
    const p = e.payload;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const o = p as Record<string, unknown>;
    if (o.kind !== "plan" || !o.plan || typeof o.plan !== "object" || Array.isArray(o.plan)) continue;
    const plan = o.plan as Record<string, unknown>;
    return {
      task: typeof plan.task === "string" ? plan.task : "",
      scopePaths: strings(plan.scope_paths),
      acceptance: strings(plan.acceptance),
      checks: strings(plan.checks),
    };
  }
  return null;
}

export interface FindingsBySeverity {
  groups: Record<SeverityClass, ReviewView["findings"]>;
  counts: Record<SeverityClass, number>;
}

export const SEVERITY_ORDER: SeverityClass[] = ["blocking", "major", "minor"];

export function findingsBySeverity(review: ReviewView): FindingsBySeverity {
  const groups: FindingsBySeverity["groups"] = { blocking: [], major: [], minor: [] };
  for (const f of review.findings) {
    groups[severityClass(f.severity as Parameters<typeof severityClass>[0])].push(f);
  }
  return {
    groups,
    counts: { blocking: groups.blocking.length, major: groups.major.length, minor: groups.minor.length },
  };
}

/** The round to show: the user's pick if it still exists, else the latest. */
export function selectedRound(rounds: number[], picked: number | null): number {
  const latest = rounds[rounds.length - 1] ?? 0;
  return picked !== null && rounds.includes(picked) ? picked : latest;
}
