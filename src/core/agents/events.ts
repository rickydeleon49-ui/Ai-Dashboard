/**
 * Event log persistence and replay for Agent Workflow Control Center (§7, §8).
 *
 * Events are gapless per run (assigned via a transaction computing max(seq) + 1),
 * bounded in size (truncated with preview if exceeding MAX_EVENT_PAYLOAD_BYTES),
 * and secrets are redacted prior to persistence via redactValue().
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "@/db/schema";
import { agentRunEvents } from "@/db/schema";
import { EVENT_AGENTS, EVENT_KINDS, type EventAgent, type EventKind } from "./types";
import { redactValue } from "./redact";

/**
 * The synchronous (better-sqlite3) Drizzle database: the app's `db`, a test
 * database, or a transaction inside one. Agent tables are SQLite only (§4).
 */
export type AgentDatabase = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

/** Maximum allowable event payload size in UTF-8 bytes (16 KB) per §8. */
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

/**
 * Larger limit for diff_patch events, which carry patch text (workspace.ts caps it
 * at 512 KB; JSON escaping adds some overhead). Over this, the event degrades to
 * the usual truncated preview and the UI shows the file list only.
 */
export const MAX_DIFF_PATCH_PAYLOAD_BYTES = 1024 * 1024;

/** Maximum preview character length for truncated payloads. */
export const MAX_PREVIEW_CHARS = 2000;

export interface StoredAgentEvent<T = unknown> {
  runId: string;
  seq: number;
  ts: string;
  stage: string | null;
  agent: string;
  kind: string;
  payload: T;
}

export interface TruncatedPayload {
  truncated: true;
  bytes: number;
  preview: string;
}

export interface AppendEventInput {
  runId: string;
  stage?: string | null;
  agent: string;
  kind: string;
  payload: unknown;
}

function safeParseJson<T = unknown>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

/**
 * Appends an event to an agent run's event log in a single transaction.
 *
 * Sequence numbers are gapless and per-run (1, 2, 3...).
 * Agent and kind are strictly validated against types.ts.
 * Payloads are redacted for secrets and bounded to MAX_EVENT_PAYLOAD_BYTES.
 */
export async function appendEvent(
  db: AgentDatabase,
  input: AppendEventInput,
): Promise<StoredAgentEvent> {
  if (!EVENT_AGENTS.includes(input.agent as EventAgent)) {
    throw new Error(`Invalid event agent: "${input.agent}". Must be one of: ${EVENT_AGENTS.join(", ")}`);
  }
  if (!EVENT_KINDS.includes(input.kind as EventKind)) {
    throw new Error(`Invalid event kind: "${input.kind}". Must be one of: ${EVENT_KINDS.join(", ")}`);
  }

  const redacted = redactValue(input.payload);
  const encoded = JSON.stringify(redacted !== undefined ? redacted : null);
  const originalBytes = Buffer.byteLength(encoded, "utf8");

  let storedJson: string;
  const maxBytes = input.kind === "diff_patch" ? MAX_DIFF_PATCH_PAYLOAD_BYTES : MAX_EVENT_PAYLOAD_BYTES;
  if (originalBytes > maxBytes) {
    const previewText = typeof redacted === "string" ? redacted : encoded;
    const preview = previewText.slice(0, MAX_PREVIEW_CHARS);
    const replacement: TruncatedPayload = {
      truncated: true,
      bytes: originalBytes,
      preview,
    };
    storedJson = JSON.stringify(replacement);
  } else {
    storedJson = encoded;
  }

  const execute = (tx: AgentDatabase) => {
    const result = tx
      .select({ maxSeq: sql<number | null>`max(${agentRunEvents.seq})` })
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, input.runId))
      .get();

    const currentMax = result?.maxSeq ? Number(result.maxSeq) : 0;
    const nextSeq = currentMax + 1;

    const inserted = tx
      .insert(agentRunEvents)
      .values({
        runId: input.runId,
        seq: nextSeq,
        stage: input.stage ?? null,
        agent: input.agent,
        kind: input.kind,
        payload: storedJson,
      })
      .returning()
      .get();

    const row = inserted ?? tx
      .select()
      .from(agentRunEvents)
      .where(and(eq(agentRunEvents.runId, input.runId), eq(agentRunEvents.seq, nextSeq)))
      .get();

    if (!row) {
      throw new Error(`Failed to append event for run "${input.runId}" at seq ${nextSeq}`);
    }

    return row;
  };

  // better-sqlite3 transactions are synchronous, so max(seq)+1 and the insert
  // cannot interleave with another append in this process; the (run_id, seq)
  // primary key rejects a duplicate from anywhere else.
  const row = db.transaction((tx) => execute(tx));

  return {
    runId: row.runId,
    seq: row.seq,
    ts: row.ts,
    stage: row.stage ?? null,
    agent: row.agent,
    kind: row.kind,
    payload: safeParseJson(row.payload),
  };
}

/**
 * Reads events for a given run with sequence numbers greater than afterSeq,
 * ordered by sequence ascending, up to limit (clamped to 1..1000).
 */
export async function readSince(
  db: AgentDatabase,
  runId: string,
  afterSeq: number,
  limit = 500,
): Promise<StoredAgentEvent[]> {
  const clampedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  // afterSeq comes from a client's Last-Event-ID: anything unusable means "from the start".
  if (!Number.isFinite(afterSeq) || afterSeq < 0) afterSeq = 0;
  const rows = db
    .select()
    .from(agentRunEvents)
    .where(
      and(
        eq(agentRunEvents.runId, runId),
        gt(agentRunEvents.seq, afterSeq),
      ),
    )
    .orderBy(asc(agentRunEvents.seq))
    .limit(clampedLimit)
    .all();

  return rows.map((row) => ({
    runId: row.runId,
    seq: row.seq,
    ts: row.ts,
    stage: row.stage ?? null,
    agent: row.agent,
    kind: row.kind,
    payload: safeParseJson(row.payload),
  }));
}

/**
 * Returns the highest sequence number for a run, or 0 if no events exist.
 */
export async function lastSeq(
  db: AgentDatabase,
  runId: string,
): Promise<number> {
  const result = db
    .select({ maxSeq: sql<number | null>`max(${agentRunEvents.seq})` })
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, runId))
    .get();

  return result?.maxSeq ? Number(result.maxSeq) : 0;
}
