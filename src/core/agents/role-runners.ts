/**
 * Role runners for the AW.2 planner and reviewer (design §16.2 rows 3, 4).
 *
 * The orchestrator builds the prompts and validates the answers; a RoleRunner
 * only transports one prompt to a provider and hands back the raw structured
 * output. The Claude and Codex runners implement it (codex-runner.ts). There
 * is no fallback between providers: a role whose provider has no runner makes
 * the run fail up front.
 */
import path from "node:path";
import { createCodexRoleRunner } from "./codex-runner";
import { claudeReadOnlyJson, type ReviewDeps } from "./review-claude";

export interface RoleCallInput {
  role: "planner" | "reviewer";
  /** Fully built prompt (untrusted text already fenced and escaped). */
  prompt: string;
  workspacePath: string;
  model?: string;
  effort?: string;
  /** Folder for per-call grant files; lives in the run store, never in the workspace. */
  grantDir: string;
  /** 0 for the initial review, 1..3 after each correction round. */
  round: number;
}

export type PlannerRunResult = { ok: true; plan: unknown } | { ok: false; failure: string };
export type ReviewerRunResult = { ok: true; review: unknown } | { ok: false; failure: string };

export interface RoleRunner {
  runPlanner(input: RoleCallInput, signal: AbortSignal): Promise<PlannerRunResult>;
  runReviewer(input: RoleCallInput, signal: AbortSignal): Promise<ReviewerRunResult>;
}

/** Provider id (RoleConfig.provider) -> runner. */
export type RoleRunnerMap = Readonly<Record<string, RoleRunner | undefined>>;

function errorOf(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "error" in raw && typeof (raw as { error: unknown }).error === "string") {
    return (raw as { error: string }).error;
  }
  return null;
}

/** Read-only `claude -p` runner (the existing Claude Code adapter's reviewer path). */
export function createClaudeRoleRunner(deps: Omit<ReviewDeps, "grantDir"> = {}): RoleRunner {
  const call = async (input: RoleCallInput, signal: AbortSignal, key: string): Promise<unknown> =>
    claudeReadOnlyJson(
      input.prompt,
      input.workspacePath,
      signal,
      { ...deps, grantDir: path.join(input.grantDir, input.role), model: input.model, effort: input.effort },
      key,
    );
  return {
    async runPlanner(input, signal) {
      const raw = await call(input, signal, "scope_paths");
      const failure = errorOf(raw);
      return failure === null ? { ok: true, plan: raw } : { ok: false, failure };
    },
    async runReviewer(input, signal) {
      const raw = await call(input, signal, "verdict");
      const failure = errorOf(raw);
      return failure === null ? { ok: true, review: raw } : { ok: false, failure };
    },
  };
}

/** Scripted output of one fake role call: raw JSON, or a failure. */
export type FakeRoleStep = { output: unknown } | { failure: string };

export interface FakeRoleScript {
  /** Planner output (used for every planner call). */
  plan?: FakeRoleStep;
  /** Reviewer outputs in call order; the last one repeats. */
  reviews?: FakeRoleStep[];
}

/** Credential-free runner for tests and demos: replays a script, records every call. */
export function createFakeRoleRunner(script: FakeRoleScript = {}): RoleRunner & { calls: RoleCallInput[] } {
  const calls: RoleCallInput[] = [];
  let reviewCalls = 0;
  const toResult = (step: FakeRoleStep | undefined, label: string) => {
    if (!step) return { ok: false as const, failure: `fake ${label} has no scripted output` };
    if ("failure" in step) return { ok: false as const, failure: step.failure };
    return { ok: true as const, output: step.output };
  };
  return {
    calls,
    async runPlanner(input) {
      calls.push(input);
      const r = toResult(script.plan, "planner");
      return r.ok ? { ok: true, plan: r.output } : r;
    },
    async runReviewer(input) {
      calls.push(input);
      const steps = script.reviews ?? [];
      const r = toResult(steps[Math.min(reviewCalls++, steps.length - 1)], "reviewer");
      return r.ok ? { ok: true, review: r.output } : r;
    },
  };
}

/** Runners the app wires by default: Claude Code and Codex (planner/reviewer only). */
export function defaultRoleRunners(deps: Omit<ReviewDeps, "grantDir"> = {}): RoleRunnerMap {
  return { "claude-code": createClaudeRoleRunner(deps), codex: createCodexRoleRunner() };
}
