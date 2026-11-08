/**
 * Codex constants that are safe for client components (no Node imports).
 * The adapter (adapters/codex.ts) re-exports them.
 */

/** Codex's own reasoning-effort list (verified against the service, design §3.1). */
export const CODEX_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexEffort = (typeof CODEX_EFFORT_LEVELS)[number];

export const CODEX_DEFAULT_EFFORT: CodexEffort = "medium";

/** Models offered for a Codex role (design default: GPT-6.1 Sol, medium). */
export const CODEX_MODELS = ["gpt-6.1-sol", "gpt-6-luna"];
export const CODEX_DEFAULT_MODEL = "gpt-6.1-sol";
