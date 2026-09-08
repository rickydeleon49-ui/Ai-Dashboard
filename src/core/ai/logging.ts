/**
 * Structured logging for the local AI system.
 *
 * One line of JSON per event, on stdout — which the desktop shell already
 * captures and prefixes (`[next] …`), so there is no second log file to find
 * and no new dependency.
 *
 * What is deliberately *not* logged: prompt and response text, project file
 * contents, and the contents of any setting. Sizes, counts, model names and
 * error codes are enough to explain a failure, and a log that quotes prompts is
 * a log that eventually quotes something private.
 */
import type { AiErrorCode, AiProviderId, AiState } from "./types";

export type AiLogEvent =
  | "health"
  | "startup"
  | "model.selected"
  | "model.preload"
  | "generation.start"
  | "generation.end"
  | "generation.error"
  | "hermes.probe"
  | "project.context";

export interface AiLogFields {
  provider?: AiProviderId;
  state?: AiState;
  model?: string;
  code?: AiErrorCode;
  durationMs?: number;
  /** Message and character counts — never the text itself. */
  messages?: number;
  characters?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  projectId?: string;
  hasRepository?: boolean;
  /** Counts of files attached to a turn — never their names or contents. */
  attachments?: number;
  rejectedAttachments?: number;
  ok?: boolean;
  /** A short technical note. Callers must not put user content here. */
  detail?: string;
}

/** Truncated so a long upstream error cannot flood the log. */
function trim(detail: string): string {
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}

export function aiLog(event: AiLogEvent, fields: AiLogFields = {}): void {
  const payload: Record<string, unknown> = {
    at: new Date().toISOString(),
    scope: "ai",
    event,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    payload[key] = key === "detail" && typeof value === "string" ? trim(value) : value;
  }

  const line = JSON.stringify(payload);
  if (event.endsWith("error")) console.error(line);
  else console.log(line);
}
