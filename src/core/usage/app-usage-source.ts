import "server-only";

import { and, desc, eq, gte } from "drizzle-orm";
import { db as appDb } from "@/db/client";
import { agentRunEvents, aiConversations, aiMessages } from "@/db/schema";
import {
  summarizeAppUsage,
  type AppAdvisorEvent,
  type AppChatMessage,
  type AppUsageSummary,
} from "./app-usage";

/** Rows older than this can never fall in the 7-day window (plus a day of slack for time zones). */
const WINDOW_DAYS = 8;
const ROW_LIMIT = 50_000;

type UsageDb = typeof appDb;

function advisorOk(payload: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payload);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
}

/**
 * The app's own AI usage (Ollama / Hermes chat replies and LM Studio advisor
 * calls) from the application database. Bounded: the last 8 days, 50k rows per
 * query. Desktop (SQLite) only, like the agent tables.
 */
export function loadAppUsage(now: Date, database: UsageDb = appDb): AppUsageSummary {
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const messageRows = database
    .select({
      provider: aiConversations.provider,
      role: aiMessages.role,
      model: aiMessages.model,
      promptTokens: aiMessages.promptTokens,
      completionTokens: aiMessages.completionTokens,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .innerJoin(aiConversations, eq(aiMessages.conversationId, aiConversations.id))
    .where(and(eq(aiMessages.role, "assistant"), gte(aiMessages.createdAt, since)))
    .orderBy(desc(aiMessages.createdAt))
    .limit(ROW_LIMIT)
    .all();

  const messages: AppChatMessage[] = messageRows.map((r) => ({
    provider: r.provider,
    role: r.role,
    model: r.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    createdAt: r.createdAt,
  }));

  const eventRows = database
    .select({ ts: agentRunEvents.ts, payload: agentRunEvents.payload })
    .from(agentRunEvents)
    .where(
      and(
        eq(agentRunEvents.kind, "advisor"),
        eq(agentRunEvents.agent, "advisor"),
        eq(agentRunEvents.stage, "final"),
        gte(agentRunEvents.ts, since),
      ),
    )
    .orderBy(desc(agentRunEvents.ts))
    .limit(ROW_LIMIT)
    .all();

  const advisor: AppAdvisorEvent[] = eventRows.map((r) => ({
    ts: r.ts,
    ok: advisorOk(r.payload),
  }));

  return summarizeAppUsage(messages, advisor, now);
}
