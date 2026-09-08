import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { aiConversations, aiMessages } from "@/db/schema";
import { createId } from "@/lib/ids";
import type { AiMode, AiProviderId, ChatMessage, ChatRole } from "./types";

/**
 * Conversation persistence, on the application's existing SQLite database.
 *
 * Transcripts are ordinary rows, so backing up the data folder backs up the
 * conversations too, and nothing new has to be installed or run.
 */

/**
 * One file the user sent with a message.
 *
 * A summary only. The bytes stay in the uploads directory, so a transcript
 * stays small, and a file that was deleted since does not resurrect itself in
 * the history.
 */
export interface MessageAttachment {
  id: string;
  filename: string;
  /** Size of the stored file, not of what was sent. */
  size: number;
  /** Whether the model saw only the beginning of it. */
  truncated: boolean;
}

export interface StoredMessage {
  id: string;
  role: ChatRole;
  content: string;
  model: string | null;
  /** "cancelled" | "error" — set when a reply did not finish normally. */
  stoppedReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  /** Files sent with this turn. Empty for everything else. */
  attachments: MessageAttachment[];
  createdAt: string;
}

/**
 * Reads the attachment column back.
 *
 * The column is nullable and holds JSON written by an earlier version of this
 * application, so it is parsed defensively: a row that predates the column, or
 * one edited by hand, degrades to "no attachments" rather than breaking the
 * conversation it belongs to.
 */
function parseAttachments(raw: unknown): MessageAttachment[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): MessageAttachment[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.filename !== "string") return [];
      return [
        {
          id: record.id,
          filename: record.filename,
          size: typeof record.size === "number" ? record.size : 0,
          truncated: record.truncated === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

export interface Conversation {
  id: string;
  title: string;
  provider: AiProviderId;
  mode: AiMode;
  model: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: StoredMessage[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A conversation's name, taken from its first message.
 *
 * Asking a model to name the conversation would cost a generation and a model
 * load before the user has seen a single token; the first line of what they
 * typed identifies it just as well in a list.
 */
export function titleFromMessage(content: string): string {
  const line = content.trim().split("\n").find((entry) => entry.trim()) ?? "";
  const cleaned = line.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
}

export function listConversations(limit = 50): Conversation[] {
  return db
    .select()
    .from(aiConversations)
    // Ids carry a timestamp prefix, so they break a tie between two rows
    // written in the same millisecond deterministically.
    .orderBy(desc(aiConversations.updatedAt), desc(aiConversations.id))
    .limit(limit)
    .all() as Conversation[];
}

export function findConversation(id: string): ConversationWithMessages | null {
  const row = db
    .select()
    .from(aiConversations)
    .where(eq(aiConversations.id, id))
    .get();
  if (!row) return null;

  const messages = db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, id))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    .all()
    .map((row): StoredMessage => ({
      id: row.id,
      role: row.role as ChatRole,
      content: row.content,
      model: row.model,
      stoppedReason: row.stoppedReason,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      durationMs: row.durationMs,
      attachments: parseAttachments(row.attachments),
      createdAt: row.createdAt,
    }));

  return { ...(row as Conversation), messages };
}

export function createConversation(input: {
  provider: AiProviderId;
  mode: AiMode;
  model: string | null;
  projectId: string | null;
  title?: string;
}): Conversation {
  const timestamp = nowIso();
  const conversation = {
    id: createId("conv"),
    title: input.title?.trim() || "New chat",
    provider: input.provider,
    mode: input.mode,
    model: input.model,
    projectId: input.projectId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  db.insert(aiConversations).values(conversation).run();
  return conversation;
}

export function appendMessage(
  conversationId: string,
  message: {
    role: ChatRole;
    content: string;
    model?: string | null;
    stoppedReason?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    durationMs?: number | null;
    attachments?: MessageAttachment[];
  },
): StoredMessage {
  const row: StoredMessage = {
    id: createId("msg"),
    role: message.role,
    content: message.content,
    model: message.model ?? null,
    stoppedReason: message.stoppedReason ?? null,
    promptTokens: message.promptTokens ?? null,
    completionTokens: message.completionTokens ?? null,
    durationMs: message.durationMs ?? null,
    attachments: message.attachments ?? [],
    createdAt: nowIso(),
  };

  db.insert(aiMessages)
    .values({
      ...row,
      conversationId,
      // Null rather than "[]" for the common case, so the column stays empty
      // for every message that carried nothing.
      attachments: row.attachments.length > 0 ? JSON.stringify(row.attachments) : null,
    })
    .run();
  db.update(aiConversations)
    .set({ updatedAt: row.createdAt, ...(row.model ? { model: row.model } : {}) })
    .where(eq(aiConversations.id, conversationId))
    .run();

  return row;
}

export function renameConversation(id: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  db.update(aiConversations)
    .set({ title: trimmed.slice(0, 120), updatedAt: nowIso() })
    .where(eq(aiConversations.id, id))
    .run();
}

export function setConversationProject(id: string, projectId: string | null): void {
  db.update(aiConversations)
    .set({ projectId, updatedAt: nowIso() })
    .where(eq(aiConversations.id, id))
    .run();
}

export function deleteConversation(id: string): boolean {
  const result = db.delete(aiConversations).where(eq(aiConversations.id, id)).run();
  return result.changes > 0;
}

/**
 * The transcript as the model should see it.
 *
 * Stored system messages are dropped: the project context is rebuilt from the
 * live project on every request, so a branch that changed since yesterday is
 * described correctly rather than as it was when the conversation started.
 */
export function toChatMessages(messages: StoredMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.role !== "system" && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }));
}

/** Conversations attached to a project, for the project page. */
export function listConversationsForProject(projectId: string, limit = 10): Conversation[] {
  return db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.projectId, projectId)))
    .orderBy(desc(aiConversations.updatedAt))
    .limit(limit)
    .all() as Conversation[];
}
