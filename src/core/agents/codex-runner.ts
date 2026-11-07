/**
 * Codex RoleRunner for the AW.2 planner and reviewer (design §16.2 rows 2, 4).
 *
 * A thin transport over runCodex: the prompt goes on stdin, Codex runs
 * read-only in the run worktree, and the schema-validated `-o` file comes back
 * as the role's raw output (the orchestrator validates it again). Files for
 * each call live in `<grantDir>/codex/<role>-r<round>` so they never collide.
 * Codex is never an implementer.
 */
import path from "node:path";
import { runCodex, type CodexRunOutcome } from "./adapters/codex";
import { resolveExecutable, type ResolveResult } from "./resolve-executable";
import type {
  PlannerRunResult,
  ReviewerRunResult,
  RoleCallInput,
  RoleRunner,
} from "./role-runners";

export interface CodexExecutable {
  file: string;
  prefixArgs?: string[];
}

export interface CodexRoleRunnerDeps {
  /** Fixed executable (tests). Default: resolved with resolveExecutable("codex") per call. */
  executable?: CodexExecutable;
  resolve?: () => ResolveResult;
  env?: NodeJS.ProcessEnv;
  graceMs?: number;
}

/** The folder for one Codex call, inside the run's storage dir. */
export function codexRunDirFor(grantDir: string, role: "planner" | "reviewer", round: number): string {
  return path.join(grantDir, "codex", `${role}-r${round}`);
}

function failureOf(outcome: CodexRunOutcome): string | null {
  const r = outcome.result;
  if (r.ok) return null;
  return `codex ${r.kind}: ${r.message}`;
}

export function createCodexRoleRunner(deps: CodexRoleRunnerDeps = {}): RoleRunner {
  const call = async (input: RoleCallInput, signal: AbortSignal): Promise<{ value: unknown } | { failure: string }> => {
    let exe: CodexExecutable;
    if (deps.executable) {
      exe = deps.executable;
    } else {
      const res = (deps.resolve ?? (() => resolveExecutable("codex")))();
      if (!res.ok) return { failure: `codex not installed (tried ${res.tried.join(", ") || "no locations"})` };
      exe = { file: res.file, prefixArgs: res.prefixArgs };
    }
    let outcome: CodexRunOutcome;
    try {
      outcome = await runCodex({
        role: input.role,
        prompt: input.prompt,
        file: exe.file,
        prefixArgs: exe.prefixArgs,
        runDir: codexRunDirFor(input.grantDir, input.role, input.round),
        worktree: input.workspacePath,
        model: input.model,
        effort: input.effort,
        env: deps.env,
        signal,
        graceMs: deps.graceMs,
      });
    } catch (err) {
      return { failure: `codex invalid-request: ${err instanceof Error ? err.message : String(err)}` };
    }
    const failure = failureOf(outcome);
    if (failure !== null) return { failure };
    return { value: outcome.result.ok ? outcome.result.value : null };
  };
  return {
    async runPlanner(input, signal): Promise<PlannerRunResult> {
      const r = await call({ ...input, role: "planner" }, signal);
      return "failure" in r ? { ok: false, failure: r.failure } : { ok: true, plan: r.value };
    },
    async runReviewer(input, signal): Promise<ReviewerRunResult> {
      const r = await call({ ...input, role: "reviewer" }, signal);
      return "failure" in r ? { ok: false, failure: r.failure } : { ok: true, review: r.value };
    },
  };
}
