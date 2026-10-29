/**
 * Types and runtime constant arrays for the Agent Workflow Control Center.
 *
 * Source of truth: docs/design/AW-agent-workflow-control-center.md (§4, §7, §8)
 * and docs/ROADMAP.md (§10A).
 */

/**
 * Status sequence for an agent run per §4.
 *
 * queued -> preparing -> planning -> implementing -> checking -> reviewing
 * -> (correcting -> checking -> reviewing) x <= 3 -> awaiting_approval
 * -> succeeded | failed | stopped | interrupted
 */
export const RUN_STATUSES = [
  "queued",
  "preparing",
  "planning",
  "implementing",
  "checking",
  "reviewing",
  "correcting",
  "awaiting_approval",
  "succeeded",
  "failed",
  "stopped",
  "interrupted",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Terminal states where a run has concluded and no further automated work executes.
 */
export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "stopped",
  "interrupted",
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminalStatus(status: unknown): status is TerminalStatus {
  return (
    typeof status === "string" &&
    (TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Orchestration stages executed by the runner per §7.
 */
export const RUN_STAGES = [
  "inspect",
  "plan",
  "implement",
  "checks",
  "diff",
  "review",
  "correct",
  "final",
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

/**
 * Originating agent identity for run events per §4.
 */
export const EVENT_AGENTS = [
  "planner",
  "implementer",
  "reviewer",
  "checks",
  "advisor",
  "system",
] as const;

export type EventAgent = (typeof EVENT_AGENTS)[number];

/**
 * Closed set of event kinds emitted to the live stream per §7 and §8.
 */
export const EVENT_KINDS = [
  /** Lifecycle transition marking the beginning of an orchestration stage. */
  "stage_started",
  /** Lifecycle transition marking the completion of an orchestration stage. */
  "stage_finished",
  /** Streamed stdout or stderr text chunk from an agent or command process. */
  "output",
  /** Tool invocation requested by an agent. */
  "tool_call",
  /** Outcome or return value produced by an executed tool. */
  "tool_result",
  /** Exit code, duration, and bounded output from a policy check command. */
  "check_result",
  /** Summary of working tree changes (files touched, insertions, deletions). */
  "diff_summary",
  /** Structured review evaluation containing verdict and findings. */
  "review",
  /** High-level run status change transition (e.g. implementing to checking). */
  "status_changed",
  /** Recoverable or fatal failure condition during execution. */
  "error",
  /** Non-fatal diagnostic notice or policy exception (e.g. denied tool warning). */
  "warning",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * User and orchestrator intent kinds recorded in agent_run_intent per §4.
 */
export const INTENT_KINDS = [
  "start",
  "stop",
  "approve",
  "deny",
  "resume",
] as const;

export type IntentKind = (typeof INTENT_KINDS)[number];

/**
 * Working copy isolation strategy per §4 and §5.
 */
export const WORKSPACE_KINDS = [
  "git_worktree",
  "snapshot_copy",
] as const;

export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/**
 * Roles that can be assigned to agent providers per §4 and §15.
 */
export const AGENT_ROLES = [
  "planner",
  "implementer",
  "reviewer",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Standard reasoning effort tiers supported by agent providers (ROADMAP §10A).
 */
export const EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];
