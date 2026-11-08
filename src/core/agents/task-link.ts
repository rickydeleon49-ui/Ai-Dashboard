/**
 * Runs tied to tasks (AW4-05).
 *
 * - validateRunTask: the task a run is created for must exist in the run's project.
 * - nextTaskForProject: the AW4-02 picker over a project's real tasks.
 * - postRunOutcomeToTask: appends ONE activity event to the task when the run
 *   ends. It never changes the task's status or any other task field.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, taskActivityEvents, taskDependencies, tasks } from "@/db/schema";
import type { AgentDatabase } from "./events";
import { pickNextTask } from "./next-task";
import { TERMINAL_STATUSES } from "./types";

/** Activity event type written when a linked run ends. */
export const AGENT_RUN_ACTIVITY_TYPE = "task.agent_run";

/** Mirrors LOCAL_WORKSPACE_ID in project-repository (not imported: it pulls the app db client). */
const LOCAL_WORKSPACE_ID = "local";

const OUTCOME_STATUSES = ["succeeded", "failed", "stopped"] as const;

export type TaskLinkCheck = { ok: true } | { ok: false; error: string };

/** True when `taskId` is a task of `projectId`. */
export function validateRunTask(db: AgentDatabase, projectId: string, taskId: string): TaskLinkCheck {
  const row = db
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) return { ok: false, error: "Task not found" };
  if (row.projectId !== projectId) return { ok: false, error: "Task does not belong to this project" };
  return { ok: true };
}

export type NextTaskResult =
  | { task: { id: string; title: string }; reason: null }
  | { task: null; reason: string };

/** The next eligible task of a project, or null with the reason there is none. */
export function nextTaskForProject(db: AgentDatabase, projectId: string): NextTaskResult {
  const rows = db
    .select({
      id: tasks.id,
      parentTaskId: tasks.parentTaskId,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .all();
  if (rows.length === 0) return { task: null, reason: "This project has no tasks." };

  const ids = rows.map((r) => r.id);
  const deps = db
    .select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId })
    .from(taskDependencies)
    .where(inArray(taskDependencies.taskId, ids))
    .all();
  const active = db
    .select({ taskId: agentRuns.taskId, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.projectId, projectId))
    .all();
  const activeRunTaskIds = new Set<string>();
  for (const r of active) {
    if (r.taskId && !(TERMINAL_STATUSES as readonly string[]).includes(r.status)) {
      activeRunTaskIds.add(r.taskId);
    }
  }

  const picked = pickNextTask(rows, deps, activeRunTaskIds);
  if (!picked) {
    return { task: null, reason: "No task is ready: every open task is blocked, has an unfinished subtask, or already has an active run." };
  }
  return { task: { id: picked.id, title: picked.title }, reason: null };
}

/**
 * Appends the run's outcome to its task's activity, once. Returns true when an
 * event was written. A no-op (false) for a run with no task, a missing task,
 * a run that is not succeeded/failed/stopped, or one already posted.
 * Never updates the task row.
 */
export function postRunOutcomeToTask(db: AgentDatabase, runId: string): boolean {
  return db.transaction((tx) => {
    const run = tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!run || !run.taskId) return false;
    if (!(OUTCOME_STATUSES as readonly string[]).includes(run.status)) return false;

    const task = tx
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, run.taskId))
      .get();
    if (!task) return false;

    const already = tx
      .select({ id: taskActivityEvents.id })
      .from(taskActivityEvents)
      .where(
        and(
          eq(taskActivityEvents.taskId, task.id),
          eq(taskActivityEvents.type, AGENT_RUN_ACTIVITY_TYPE),
          sql`json_extract(${taskActivityEvents.details}, '$.runId') = ${runId}`,
        ),
      )
      .get();
    if (already) return false;

    let outcome: {
      facts?: { checks?: Array<{ exitCode: number | null; timedOut: boolean }>; reviewVerdict?: string | null };
      error?: string;
    } = {};
    try {
      outcome = run.outcome ? (JSON.parse(run.outcome) as typeof outcome) : {};
    } catch {
      outcome = {};
    }
    const checks = outcome.facts?.checks ?? [];
    const passed = checks.filter((c) => c.exitCode === 0 && !c.timedOut).length;
    const details: Record<string, unknown> = {
      runId,
      status: run.status,
      link: `/agents/runs/${runId}`,
      checksPassed: passed,
      checksFailed: checks.length - passed,
      verdict: outcome.facts?.reviewVerdict ?? null,
    };
    if (outcome.error) details.error = String(outcome.error).slice(0, 500);

    tx.insert(taskActivityEvents)
      .values({
        id: crypto.randomUUID(),
        workspaceId: LOCAL_WORKSPACE_ID,
        projectId: task.projectId,
        taskId: task.id,
        actorId: null,
        type: AGENT_RUN_ACTIVITY_TYPE,
        details: JSON.stringify(details),
      })
      .run();
    return true;
  });
}
