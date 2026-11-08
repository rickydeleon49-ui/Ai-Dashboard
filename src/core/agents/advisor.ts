/**
 * Opt-in wiring of the LM Studio advisor (AW3-06b).
 *
 * The owner turns it on with DASHBOARD_ADVISOR=1 (endpoint from DASHBOARD_ADVISOR_URL,
 * default http://127.0.0.1:1234). The model is the first one LM Studio lists at run time.
 */
import { runAdvisor, type AdvisorFacts, type AdvisorResult } from "./adapters/lmstudio";

export const DEFAULT_ADVISOR_URL = "http://127.0.0.1:1234";

export function advisorFromEnv(
  env: Record<string, string | undefined> = process.env,
  run: typeof runAdvisor = runAdvisor,
): ((facts: AdvisorFacts, signal: AbortSignal) => Promise<AdvisorResult>) | undefined {
  if (env.DASHBOARD_ADVISOR !== "1") return undefined;
  const endpoint = env.DASHBOARD_ADVISOR_URL?.trim() || DEFAULT_ADVISOR_URL;
  return (facts) => run(facts, { endpoint, timeoutMs: 25_000 });
}
