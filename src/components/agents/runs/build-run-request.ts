/**
 * Pure request-builder for creating an agent run (AW2-05).
 *
 * Normalizes form inputs into a valid RunRequest payload:
 * - Omit model and effort when set to provider defaults (empty).
 * - Only emit effort if it is a member of EFFORT_LEVELS.
 * - Omit optional roles (planner, reviewer) when their provider is empty.
 * - Normalize check names from string or array.
 */
import { EFFORT_LEVELS, type EffortLevel } from "@/core/agents/types";
import type { RoleConfig, RunRequest } from "@/core/agents/schema";
import { parseCheckNames } from "./logic";

export interface RoleInput {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface BuildRunRequestInput {
  projectId: string;
  task: string;
  roles: {
    implementer: RoleInput;
    planner?: RoleInput | null;
    reviewer?: RoleInput | null;
  };
  checks?: string | readonly string[];
  antigravityAcknowledgement?: {
    plugins: string[] | readonly string[];
    mcpServers: string[] | readonly string[];
  };
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

export function buildRoleConfig(
  input?: RoleInput | null,
): RoleConfig | undefined {
  if (!input) return undefined;
  const provider = input.provider?.trim();
  if (!provider) return undefined;

  const config: RoleConfig = { provider };

  const model = input.model?.trim();
  if (model) {
    config.model = model;
  }

  const effort = input.effort?.trim();
  if (effort && isEffortLevel(effort)) {
    config.effort = effort;
  }

  return config;
}

export function normalizeChecks(checks?: string | readonly string[]): string[] {
  if (!checks) return [];
  if (typeof checks === "string") {
    return parseCheckNames(checks);
  }
  return parseCheckNames(checks.join(" "));
}

export function buildRunRequest(input: BuildRunRequestInput): RunRequest {
  const implementer = buildRoleConfig(input.roles.implementer) ?? {
    provider: input.roles.implementer?.provider?.trim() ?? "",
  };
  const planner = buildRoleConfig(input.roles.planner);
  const reviewer = buildRoleConfig(input.roles.reviewer);

  const request: RunRequest = {
    projectId: input.projectId,
    task: input.task,
    roles: {
      implementer,
      ...(planner ? { planner } : {}),
      ...(reviewer ? { reviewer } : {}),
    },
    checks: normalizeChecks(input.checks),
  };

  if (
    implementer.provider === "antigravity" &&
    input.antigravityAcknowledgement
  ) {
    request.antigravityAcknowledgement = {
      plugins: [...input.antigravityAcknowledgement.plugins],
      mcpServers: [...input.antigravityAcknowledgement.mcpServers],
    };
  }

  return request;
}
