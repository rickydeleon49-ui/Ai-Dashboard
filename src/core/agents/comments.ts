/**
 * Data access and validation for agent run inline comments (AW.2, §16.2 row 6).
 *
 * Inline comments on a run's diff are supplied to the agent as correction input.
 * All operations take an AgentDatabase instance (desktop SQLite only).
 * Secret redaction is applied to comment bodies before persistence.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  agentRuns,
  agentRunComments,
  type AgentRunCommentRow,
} from "@/db/schema";
import { createId } from "@/lib/ids";
import type { AgentDatabase } from "./events";
import { redactText } from "./redact";

/**
 * File path schema for comments:
 * - trimmed, 1..1000 characters
 * - relative path only (rejects absolute paths, drive letters, leading slash/backslash, and '..' segments)
 * - normalises backslashes to forward slashes
 */
export const commentFilePathSchema = z
  .string()
  .trim()
  .min(1, "File path cannot be empty")
  .max(1000, "File path must be at most 1000 characters")
  .refine((val) => !/^[/\\]/.test(val), {
    message: "File path must be relative and cannot start with a slash or backslash",
  })
  .refine((val) => !/^[a-zA-Z]:/.test(val), {
    message: "File path must not contain a drive letter",
  })
  .refine(
    (val) => !val.split(/[/\\]/).some((seg) => seg === ".."),
    {
      message: "File path must not contain '..' segments",
    },
  )
  .transform((val) => val.replace(/\\/g, "/"));

/**
 * Input schema for adding a comment to an agent run:
 * - round: integer 0..3
 * - file: optional relative file path (1..1000 chars, null = comment on the whole run)
 * - line: optional integer >= 1, only allowed when file is set
 * - body: trimmed 1..4000 characters
 */
export const commentInputSchema = z
  .object({
    round: z
      .number()
      .int("Round must be an integer")
      .min(0, "Round must be between 0 and 3")
      .max(3, "Round must be between 0 and 3"),
    file: commentFilePathSchema.nullable().optional(),
    line: z
      .number()
      .int("Line must be an integer")
      .min(1, "Line must be at least 1")
      .nullable()
      .optional(),
    body: z
      .string()
      .trim()
      .min(1, "Body is required")
      .max(4000, "Body must be at most 4000 characters"),
  })
  .strict()
  .refine(
    (data) => {
      if (data.line !== undefined && data.line !== null) {
        return Boolean(data.file);
      }
      return true;
    },
    {
      message: "Line number can only be specified when file is set",
      path: ["line"],
    },
  );

export const addCommentInputSchema = commentInputSchema;

export type CommentInput = z.input<typeof commentInputSchema>;
export type CommentData = z.output<typeof commentInputSchema>;

/**
 * Adds an inline comment to an agent run.
 *
 * Validates input, redacts secrets from the comment body via redactText,
 * and inserts the comment record.
 * Throws an Error if the run does not exist.
 */
export async function addComment(
  db: AgentDatabase,
  runId: string,
  input: CommentInput,
): Promise<AgentRunCommentRow> {
  const parsed = commentInputSchema.parse(input);

  const run = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .get();

  if (!run) {
    throw new Error(`Agent run "${runId}" not found`);
  }

  const commentId = createId("comment");
  const redactedBody = redactText(parsed.body);

  const row = db
    .insert(agentRunComments)
    .values({
      id: commentId,
      runId,
      round: parsed.round,
      file: parsed.file ?? null,
      line: parsed.line ?? null,
      body: redactedBody,
    })
    .returning()
    .get();

  return row;
}

/**
 * Lists comments for an agent run, optionally filtered by correction round.
 *
 * Ordered by round ascending, then created_at ascending, then id ascending.
 */
export async function listComments(
  db: AgentDatabase,
  runId: string,
  round?: number,
): Promise<AgentRunCommentRow[]> {
  const conditions = [eq(agentRunComments.runId, runId)];
  if (round !== undefined && round !== null) {
    conditions.push(eq(agentRunComments.round, round));
  }

  return db
    .select()
    .from(agentRunComments)
    .where(and(...conditions))
    .orderBy(
      asc(agentRunComments.round),
      asc(agentRunComments.createdAt),
      asc(agentRunComments.id),
    )
    .all();
}

/**
 * Deletes a comment only when it belongs to the specified run.
 * Returns true if the comment was deleted, false otherwise.
 */
export async function deleteComment(
  db: AgentDatabase,
  runId: string,
  commentId: string,
): Promise<boolean> {
  const deleted = db
    .delete(agentRunComments)
    .where(
      and(
        eq(agentRunComments.id, commentId),
        eq(agentRunComments.runId, runId),
      ),
    )
    .returning({ id: agentRunComments.id })
    .all();

  return deleted.length > 0;
}
