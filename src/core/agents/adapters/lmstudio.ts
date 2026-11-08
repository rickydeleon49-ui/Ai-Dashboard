/**
 * LM Studio advisor client for the Agent Workflow Control Center (§16.3 row 6).
 *
 * Provides an OpenAI-compatible client for LM Studio on localhost (127.0.0.1:1234).
 * After the final verdict of an agent run, the advisor produces a concise,
 * non-binding summary of what happened.
 *
 * If LM Studio is offline, slow, or not configured, the run outcome is unchanged.
 */
import type { FetchLike } from "../../ai/ollama-client";

export type { FetchLike };

export const DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";

/** Strips trailing slashes so paths can be concatenated cleanly without double slashes. */
export function normaliseEndpoint(endpoint?: string): string {
  if (!endpoint || !endpoint.trim()) {
    return DEFAULT_LMSTUDIO_ENDPOINT;
  }
  return endpoint.trim().replace(/\/+$/, "");
}

/**
 * Lists loaded/available model identifiers from LM Studio's GET /v1/models endpoint.
 *
 * Returns data[].id exactly as given, keeping the original order.
 * Throws an Error with a short message on non-2xx, bad JSON, malformed response, or timeout.
 */
export async function listLmStudioModels(
  opts: {
    endpoint?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<string[]> {
  const endpoint = normaliseEndpoint(opts.endpoint);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchFn: FetchLike =
    opts.fetchImpl ?? ((input, init) => fetch(input, init));

  const controller = new AbortController();
  // The timer covers reading the body too, so a stalled response cannot hang the caller.
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let payload: unknown;
  try {
    let response: Response;
    try {
      response = await fetchFn(`${endpoint}/v1/models`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to reach LM Studio: ${msg}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const snippet = text ? `: ${text.slice(0, 200)}` : "";
      throw new Error(`LM Studio returned HTTP ${response.status}${snippet}`);
    }

    try {
      payload = await response.json();
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse LM Studio response: ${msg}`);
    }
  } finally {
    clearTimeout(timer);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error("Malformed response from LM Studio: missing data array");
  }

  const rawData = (payload as { data: unknown[] }).data;
  const ids: string[] = [];
  for (const item of rawData) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string"
    ) {
      ids.push((item as { id: string }).id);
    }
  }
  return ids;
}

export interface AdvisorFacts {
  task: string;
  status: string;
  reviewVerdict: string | null;
  rounds: number;
  filesChanged: string[];
  checks: { name: string; passed: boolean }[];
  findings: { severity: string; title: string }[];
}

/**
 * Builds chat messages for the advisor LLM turn.
 *
 * System message sets role and instructs a 6-bullet summary that cannot alter the outcome.
 * User message serializes facts as pretty JSON with filesChanged capped at 50 and findings capped at 30.
 */
export function buildAdvisorMessages(
  facts: AdvisorFacts,
): { role: "system" | "user"; content: string }[] {
  const allFiles = Array.isArray(facts.filesChanged) ? facts.filesChanged : [];
  const filesChanged = allFiles.slice(0, 50);
  const filesLeftOut = allFiles.length - filesChanged.length;

  const allFindings = Array.isArray(facts.findings) ? facts.findings : [];
  const findings = allFindings.slice(0, 30);
  const findingsLeftOut = allFindings.length - findings.length;

  const payload: Record<string, unknown> = {
    task: facts.task,
    status: facts.status,
    reviewVerdict: facts.reviewVerdict,
    rounds: facts.rounds,
    filesChanged,
    ...(filesLeftOut > 0
      ? { filesChangedLeftOut: `${filesLeftOut} left out` }
      : {}),
    checks: Array.isArray(facts.checks) ? facts.checks : [],
    findings,
    ...(findingsLeftOut > 0
      ? { findingsLeftOut: `${findingsLeftOut} left out` }
      : {}),
  };

  return [
    {
      role: "system",
      content:
        "You are an advisor. Summarise this agent run for its owner in at most 6 short bullet points. You cannot change the outcome.",
    },
    {
      role: "user",
      content: JSON.stringify(payload, null, 2),
    },
  ];
}

export type AdvisorResult =
  { ok: true; model: string; summary: string } | { ok: false; reason: string };

/**
 * Runs an advisor evaluation turn against LM Studio.
 *
 * Never throws — always returns an AdvisorResult.
 * If model is omitted, lists models from LM Studio and picks the first.
 * Sends chat completion request with temperature 0.2, max_tokens 400, stream false.
 * Trims summary and ensures any failure produces an ok: false result with a short reason.
 */
export async function runAdvisor(
  facts: AdvisorFacts,
  opts: {
    endpoint?: string;
    model?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<AdvisorResult> {
  try {
    const endpoint = normaliseEndpoint(opts.endpoint);
    const fetchFn: FetchLike =
      opts.fetchImpl ?? ((input, init) => fetch(input, init));

    let model = opts.model?.trim();
    if (!model) {
      let models: string[];
      try {
        models = await listLmStudioModels({
          endpoint,
          fetchImpl: fetchFn,
          timeoutMs:
            opts.timeoutMs !== undefined
              ? Math.min(opts.timeoutMs, 5000)
              : 5000,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: msg.slice(0, 200) };
      }

      if (!models || models.length === 0 || !models[0]) {
        return { ok: false, reason: "no model loaded in LM Studio" };
      }
      model = models[0];
    }

    const messages = buildAdvisorMessages(facts);
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // The timer stays armed while the body is read; cleared in the finally below.
    try {
      let response: Response;
      try {
        response = await fetchFn(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.2,
            max_tokens: 400,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return {
            ok: false,
            reason: `Request timed out after ${timeoutMs}ms`,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          reason: `Failed to reach LM Studio: ${msg}`.slice(0, 200),
        };
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const snippet = text ? `: ${text.slice(0, 200)}` : "";
        return {
          ok: false,
          reason: `LM Studio returned HTTP ${response.status}${snippet}`.slice(
            0,
            200,
          ),
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return {
            ok: false,
            reason: `Request timed out after ${timeoutMs}ms`,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          reason: `Invalid JSON response: ${msg}`.slice(0, 200),
        };
      }

      if (!payload || typeof payload !== "object") {
        return {
          ok: false,
          reason: "Malformed response: expected JSON object",
        };
      }

      const choices = (payload as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return {
          ok: false,
          reason: "Malformed response: choices array is empty",
        };
      }

      const firstChoice = choices[0];
      if (!firstChoice || typeof firstChoice !== "object") {
        return {
          ok: false,
          reason: "Malformed response: choice item is not an object",
        };
      }

      const message = (firstChoice as { message?: unknown }).message;
      if (!message || typeof message !== "object") {
        return { ok: false, reason: "Malformed response: message is missing" };
      }

      const rawContent = (message as { content?: unknown }).content;
      if (typeof rawContent !== "string") {
        return {
          ok: false,
          reason: "Malformed response: message content is not a string",
        };
      }

      const summary = rawContent.trim();
      if (!summary) {
        return { ok: false, reason: "Advisor returned empty summary" };
      }

      return {
        ok: true,
        model,
        summary,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}
