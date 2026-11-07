/**
 * Data access for agent runs and intents (Release AW.1, §4, §15 step 12).
 *
 * All operations take an AgentDatabase instance (the application SQLite database,
 * a test database, or a transaction within one).
 */
import { and, desc, eq } from "drizzle-orm";
import {
  agentRuns,
  agentRunIntents,
  type AgentRunRow,
  type AgentRunIntentRow,
} from "@/db/schema";
import { createId } from "@/lib/ids";
import type { AgentDatabase } from "./events";
import {
  INTENT_KINDS,
  type IntentKind,
  type RunStatus,
  type RunStage,
  type WorkspaceKind,
} from "./types";
import type { RunRequest } from "./schema";

export interface AgentRunRecord<TRequest = RunRequest, TOutcome = unknown> {
  id: string;
  projectId: string;
  status: RunStatus;
  stage: RunStage | null;
  request: TRequest;
  workspaceKind: WorkspaceKind | null;
  workspacePath: string | null;
  baseRef: string | null;
  branch: string | null;
  correctionRound: number;
  outcome: TOutcome | null;
  runnerEpoch: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface StoredAgentIntent<T = unknown> {
  id: string;
  runId: string;
  kind: IntentKind;
  payload: T;
  createdAt: string;
  claimedAt: string | null;
}

export interface CreateRunOptions {
  projectLocalPath: string;
}

export interface ListRunsOptions {
  projectId?: string;
  limit?: number;
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseRunRow(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as RunStatus,
    stage: (row.stage as RunStage) ?? null,
    request: safeParseJson<RunRequest>(row.request, {} as RunRequest),
    workspaceKind: (row.workspaceKind as WorkspaceKind) ?? null,
    workspacePath: row.workspacePath ?? null,
    baseRef: row.baseRef ?? null,
    branch: row.branch ?? null,
    correctionRound: row.correctionRound ?? 0,
    outcome: row.outcome ? safeParseJson(row.outcome, null) : null,
    runnerEpoch: row.runnerEpoch ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt ?? null,
  };
}

function parseIntentRow<T = unknown>(row: AgentRunIntentRow): StoredAgentIntent<T> {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as IntentKind,
    payload: safeParseJson<T>(row.payload, {} as T),
    createdAt: row.createdAt,
    claimedAt: row.claimedAt ?? null,
  };
}

/**
 * Creates an agent run and its initial start intent in ONE transaction.
 */
export async function createRun(
  db: AgentDatabase,
  request: RunRequest,
  { projectLocalPath }: CreateRunOptions,
): Promise<AgentRunRecord> {
  const runId = createId("run");
  const intentId = createId("intent");
  const requestJson = JSON.stringify(request);
  const intentPayloadJson = JSON.stringify({ projectLocalPath });

  const runRow = db.transaction((tx) => {
    const insertedRun = tx
      .insert(agentRuns)
      .values({
        id: runId,
        projectId: request.projectId,
        status: "queued",
        request: requestJson,
      })
      .returning()
      .get();

    const selectedRun =
      insertedRun ??
      tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .get();

    if (!selectedRun) {
      throw new Error(`Failed to insert agent run "${runId}"`);
    }

    tx.insert(agentRunIntents)
      .values({
        id: intentId,
        runId,
        kind: "start",
        payload: intentPayloadJson,
      })
      .run();

    return selectedRun;
  });

  return parseRunRow(runRow);
}

/**
 * Fetches an agent run by ID, parsing its request and outcome JSON fields.
 * Returns null if the run does not exist.
 */
export async function getRun(
  db: AgentDatabase,
  id: string,
): Promise<AgentRunRecord | null> {
  const row = db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .get();

  if (!row) return null;
  return parseRunRow(row);
}

/**
 * Lists runs ordered newest first, with limit clamped between 1 and 200.
 * Optionally filtered by projectId.
 */
export async function listRuns(
  db: AgentDatabase,
  options: ListRunsOptions = {},
): Promise<AgentRunRecord[]> {
  const limit = options.limit ?? 50;
  const clampedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

  const conditions = [];
  if (options.projectId) {
    conditions.push(eq(agentRuns.projectId, options.projectId));
  }

  const rows = db
    .select()
    .from(agentRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(clampedLimit)
    .all();

  return rows.map(parseRunRow);
}

/**
 * Creates an intent for an agent run (e.g. stop, approve, deny, resume).
 * Validates that kind is in INTENT_KINDS.
 */
export async function createIntent<T = unknown>(
  db: AgentDatabase,
  runId: string,
  kind: string,
  payload: unknown = {},
): Promise<StoredAgentIntent<T>> {
  if (!INTENT_KINDS.includes(kind as IntentKind)) {
    throw new Error(
      `Invalid intent kind: "${kind}". Must be one of: ${INTENT_KINDS.join(", ")}`,
    );
  }

  const id = createId("intent");
  const encodedPayload =
    typeof payload === "string" ? payload : JSON.stringify(payload ?? {});

  const inserted = db
    .insert(agentRunIntents)
    .values({
      id,
      runId,
      kind,
      payload: encodedPayload,
    })
    .returning()
    .get();

  const row =
    inserted ??
    db
      .select()
      .from(agentRunIntents)
      .where(eq(agentRunIntents.id, id))
      .get();

  if (!row) {
    throw new Error(`Failed to create intent "${id}" for run "${runId}"`);
  }

  return parseIntentRow<T>(row);
}
