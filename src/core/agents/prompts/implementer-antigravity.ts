/**
 * Antigravity has no sandbox of its own, so the dashboard's only enforcement is
 * the tool monitor (kills on the first off-list call). The prompt says the same
 * thing up front so a well-behaved run never trips it (design §16.3 row 4).
 */
export const ANTIGRAVITY_RULES = [
  "Rules for this run (the dashboard enforces them and stops the run on a violation):",
  "- Use file tools only: read, list, search, write and edit files.",
  "- Do not use a shell or terminal, a browser, MCP tools, web access or sub-agents.",
  "- Stay inside the current working folder; do not read or write any path outside it.",
  "- Do not run tests, linters or builds: the dashboard runs the checks itself after you finish.",
].join("\n");

/** The Antigravity implementer prompt: the rules first, then the task or correction text unchanged. */
export function buildAntigravityImplementerPrompt(prompt: string): string {
  return `${ANTIGRAVITY_RULES}\n\n${prompt}`;
}

/** Sent on `--conversation <id>` when a turn ended without a result event. */
export function buildAntigravityContinuationPrompt(): string {
  return [
    "Your previous turn ended before it finished. Continue the same task from where you stopped.",
    "",
    ANTIGRAVITY_RULES,
  ].join("\n");
}
