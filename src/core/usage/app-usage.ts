export interface AppChatMessage {
  provider: string;            // conversation provider: "local" (Ollama) | "hermes" | other
  role: string;                // only "assistant" rows count
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;           // ISO timestamp, UTC
}

export interface AppAdvisorEvent {
  ts: string;
  ok: boolean;
}   // one LM Studio advisor call

export interface AppUsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  tokensUnknown: number;
}

export interface AppUsageSummary {
  chat: Record<string, { today: AppUsageBucket; last7Days: AppUsageBucket; byModel: Record<string, AppUsageBucket> }>;  // keyed by provider
  advisor: { today: { calls: number; failed: number }; last7Days: { calls: number; failed: number } };
}

function emptyBucket(): AppUsageBucket {
  return { calls: 0, promptTokens: 0, completionTokens: 0, tokensUnknown: 0 };
}

export function localDay(iso: string, timeZone: string = "America/Los_Angeles"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
}

export function summarizeAppUsage(
  messages: AppChatMessage[],
  advisor: AppAdvisorEvent[],
  now: Date,
  timeZone: string = "America/Los_Angeles",
): AppUsageSummary {
  const summary: AppUsageSummary = {
    chat: {},
    advisor: {
      today: { calls: 0, failed: 0 },
      last7Days: { calls: 0, failed: 0 },
    },
  };

  const tz = timeZone || "America/Los_Angeles";
  const todayDay = localDay(now.toISOString(), tz);
  if (!todayDay) {
    return summary;
  }

  const [yStr, mStr, dStr] = todayDay.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);

  const last7DaysSet = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(year, month - 1, day - i));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    last7DaysSet.add(`${y}-${m}-${dd}`);
  }

  const nowMs = now.getTime();

  for (const m of messages) {
    if (m.role !== "assistant") {
      continue;
    }
    const msgDate = new Date(m.createdAt);
    if (Number.isNaN(msgDate.getTime()) || msgDate.getTime() > nowMs) {
      continue;
    }
    const msgDay = localDay(m.createdAt, tz);
    if (!msgDay || !last7DaysSet.has(msgDay)) {
      continue;
    }

    if (!summary.chat[m.provider]) {
      summary.chat[m.provider] = {
        today: emptyBucket(),
        last7Days: emptyBucket(),
        byModel: {},
      };
    }

    const providerSummary = summary.chat[m.provider]!;
    const isToday = msgDay === todayDay;
    const hasUnknownTokens = m.promptTokens === null || m.completionTokens === null;
    const promptTokens = m.promptTokens ?? 0;
    const completionTokens = m.completionTokens ?? 0;
    const tokensUnknownInc = hasUnknownTokens ? 1 : 0;

    providerSummary.last7Days.calls += 1;
    providerSummary.last7Days.promptTokens += promptTokens;
    providerSummary.last7Days.completionTokens += completionTokens;
    providerSummary.last7Days.tokensUnknown += tokensUnknownInc;

    if (isToday) {
      providerSummary.today.calls += 1;
      providerSummary.today.promptTokens += promptTokens;
      providerSummary.today.completionTokens += completionTokens;
      providerSummary.today.tokensUnknown += tokensUnknownInc;
    }

    const modelKey = m.model ?? "unknown";
    if (!providerSummary.byModel[modelKey]) {
      providerSummary.byModel[modelKey] = emptyBucket();
    }
    const modelBucket = providerSummary.byModel[modelKey]!;
    modelBucket.calls += 1;
    modelBucket.promptTokens += promptTokens;
    modelBucket.completionTokens += completionTokens;
    modelBucket.tokensUnknown += tokensUnknownInc;
  }

  for (const ev of advisor) {
    const evDate = new Date(ev.ts);
    if (Number.isNaN(evDate.getTime()) || evDate.getTime() > nowMs) {
      continue;
    }
    const evDay = localDay(ev.ts, tz);
    if (!evDay || !last7DaysSet.has(evDay)) {
      continue;
    }

    summary.advisor.last7Days.calls += 1;
    if (!ev.ok) {
      summary.advisor.last7Days.failed += 1;
    }

    if (evDay === todayDay) {
      summary.advisor.today.calls += 1;
      if (!ev.ok) {
        summary.advisor.today.failed += 1;
      }
    }
  }

  return summary;
}
