/**
 * Dismissing finished runs (Release AW.4, AW4-11, design §5 cleanup rule).
 *
 * Dismissing hides a finished run from the default run list and is the only thing
 * that makes its worktree eligible for cleanup (see retention.ts). Restoring clears
 * it again. Neither touches the run's files, branch or approvals.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agentRunApprovals, agentRunIntents, agentRuns } from "@/db/schema";
import { OPEN_STATUSES } from "./approvals";
import type { AgentDatabase } from "./events";
import { getRun, type AgentRunRecord } from "./runs";
import { TERMINAL_STATUSES } from "./types";

export type DismissErrorCode = "not_found" | "conflict";

export class DismissError extends Error {
  readonly code: DismissErrorCode;
  constructor(code: DismissErrorCode, message: string) {
    super(message);
    this.name = "DismissError";
    this.code = code;
  }
}

/** Queued work that would act on the run again. */
const BLOCKING_INTENT_KINDS = ["resume", "approval_execute"];

function dismissBlocker(db: AgentDatabase, run: AgentRunRecord): string | null {
  if (!(TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
    return `Only a finished run can be dismissed (this run is ${run.status})`;
  }
  const openApproval = db
    .select({ id: agentRunApprovals.id })
    .from(agentRunApprovals)
    .where(and(eq(agentRunApprovals.runId, run.id), inArray(agentRunApprovals.status, OPEN_STATUSES)))
    .get();
  if (openApproval) return "This run has an approval that is still open; decide it first";
  const queued = db
    .select({ id: agentRunIntents.id })
    .from(agentRunIntents)
    .where(
      and(
        eq(agentRunIntents.runId, run.id),
        isNull(agentRunIntents.claimedAt),
        inArray(agentRunIntents.kind, BLOCKING_INTENT_KINDS),
      ),
    )
    .get();
  if (queued) return "This run has queued work (a resume or an approved action); wait for it to finish";
  return null;
}

async function requireRun(db: AgentDatabase, runId: string): Promise<AgentRunRecord> {
  const run = await getRun(db, runId);
  if (!run) throw new DismissError("not_found", "Agent run not found");
  return run;
}

/** Marks a finished run dismissed (idempotent: dismissing again keeps the first date). */
export async function dismissRun(db: AgentDatabase, runId: string, now: Date = new Date()): Promise<AgentRunRecord> {
  const run = await requireRun(db, runId);
  const blocker = dismissBlocker(db, run);
  if (blocker) throw new DismissError("conflict", blocker);
  if (run.dismissedAt === null) {
    db.update(agentRuns)
      .set({ dismissedAt: now.toISOString() })
      .where(and(eq(agentRuns.id, runId), isNull(agentRuns.dismissedAt)))
      .run();
  }
  return requireRun(db, runId);
}

/** Brings a dismissed run back (idempotent). */
export async function undismissRun(db: AgentDatabase, runId: string): Promise<AgentRunRecord> {
  await requireRun(db, runId);
  db.update(agentRuns).set({ dismissedAt: null }).where(eq(agentRuns.id, runId)).run();
  return requireRun(db, runId);
}
