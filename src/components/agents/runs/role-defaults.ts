/**
 * Pure helpers for the run form's role defaults (AW2-04b, design §16.2 row 5).
 *
 * Planner and reviewer default to Codex GPT-6.1 Sol (medium) only when the
 * Codex probe says it is installed and signed in; otherwise nothing changes.
 * Codex is read-only in AW.2, so it is never offered as implementer.
 */
import {
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_MODEL,
  CODEX_EFFORT_LEVELS,
} from "@/core/agents/codex-constants";
import { EFFORT_LEVELS } from "@/core/agents/types";

export const CODEX_PROVIDER_ID = "codex";
export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

export interface ProviderState {
  id: string;
  installed?: boolean;
  authenticated?: boolean | "unknown";
  canImplement?: boolean;
}

export interface RoleDefault {
  provider: string;
  model: string;
  effort: string;
}

const NONE: RoleDefault = { provider: "", model: "", effort: "" };

export function isCodexReady(providers: readonly ProviderState[]): boolean {
  const codex = providers.find((p) => p.id === CODEX_PROVIDER_ID);
  return codex?.installed === true && codex.authenticated === true;
}

export function defaultReviewRoles(providers: readonly ProviderState[]): {
  planner: RoleDefault;
  reviewer: RoleDefault;
} {
  if (!isCodexReady(providers)) return { planner: { ...NONE }, reviewer: { ...NONE } };
  const codex = {
    provider: CODEX_PROVIDER_ID,
    model: CODEX_DEFAULT_MODEL,
    effort: CODEX_DEFAULT_EFFORT as string,
  };
  return { planner: { ...codex }, reviewer: { ...codex } };
}

/** Effort choices for a role's provider (Codex has its own list). */
export function effortLevelsFor(providerId: string): readonly string[] {
  return providerId === CODEX_PROVIDER_ID ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS;
}

/** Providers the implementer select may offer (Codex is excluded). */
export function implementerProviders<T extends ProviderState>(providers: readonly T[]): T[] {
  return providers.filter((p) => p.id !== CODEX_PROVIDER_ID && p.canImplement !== false);
}

/** Providers the planner and reviewer selects may offer (Antigravity is implementer-only; the server schema rejects it). */
export function reviewRoleProviders<T extends ProviderState>(providers: readonly T[]): T[] {
  return providers.filter((p) => p.id !== ANTIGRAVITY_PROVIDER_ID);
}
