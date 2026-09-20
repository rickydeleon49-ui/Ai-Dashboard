/**
 * SQLite implementation of CommentRepository (Release 2C.4).
 * Single-tenant desktop supported with soft-deletion and activity logging.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  CommentActorOptions,
  CreateCommentInput,
  TaskComment,
  TaskCommentEdit,
  UpdateCommentInput,
} from "@/core/tasks/types";
import {
  CommentNotFoundError,
  InvalidCommentError,
  InvalidMentionError,
} from "@/core/tasks/errors";
import { extractMentions } from "@/core/tasks/mention-utils";
import { db } from "../client";
import {
  taskActivityEvents,
  taskCommentEdits,
  taskComments,
  tasks,
} from "../schema";
import {
  type CommentRepository,
  MAX_COMMENT_BODY_LENGTH,
  MIN_COMMENT_BODY_LENGTH,
} from "./comment-repository";

export class DrizzleCommentRepository implements CommentRepository {
  async list(workspaceId: string, taskId: string): Promise<TaskComment[]> {
    const rows = db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.workspaceId, workspaceId),
          eq(taskComments.taskId, taskId),
        ),
      )
      .orderBy(asc(taskComments.createdAt))
      .all();

    const commentIds = rows.map((r) => r.id);
    const editCounts = new Map<string, number>();
    if (commentIds.length > 0) {
      const edits = db
        .select({ commentId: taskCommentEdits.commentId })
        .from(taskCommentEdits)
        .where(inArray(taskCommentEdits.commentId, commentIds))
        .all();
      for (const e of edits) {
        editCounts.set(e.commentId, (editCounts.get(e.commentId) ?? 0) + 1);
      }
    }

    return rows.map((r) => this.mapRow(r, editCounts.get(r.id) ?? 0));
  }

  async findById(workspaceId: string, taskId: string, commentId: string): Promise<TaskComment | null> {
    const [row] = db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.id, commentId),
          eq(taskComments.workspaceId, workspaceId),
          eq(taskComments.taskId, taskId),
        ),
      )
      .all();

    if (!row) return null;

    const edits = db
      .select({ id: taskCommentEdits.id })
      .from(taskCommentEdits)
      .where(eq(taskCommentEdits.commentId, commentId))
      .all();

    return this.mapRow(row, edits.length);
  }

  async create(
    workspaceId: string,
    taskId: string,
    input: CreateCommentInput,
    options?: CommentActorOptions,
  ): Promise<TaskComment> {
    this.validateBody(input.body);
    this.validateMentions(input.body, input.mentions);

    const [task] = db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .all();

    if (!task) {
      throw new Error("Task not found.");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const authorId = options?.actorUserId ?? null;

    db.transaction(() => {
      db.insert(taskComments)
        .values({
          id,
          workspaceId,
          taskId,
          authorId,
          body: input.body,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      db.insert(taskActivityEvents)
        .values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: task.projectId,
          taskId,
          actorId: authorId,
          type: "comment.created",
          details: JSON.stringify({ commentId: id }),
          createdAt: now,
        })
        .run();
    });

    return {
      id,
      taskId,
      workspaceId,
      authorId,
      body: input.body,
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
      createdAt: now,
      updatedAt: now,
      editCount: 0,
    };
  }

  async update(
    workspaceId: string,
    taskId: string,
    commentId: string,
    input: UpdateCommentInput,
    options?: CommentActorOptions,
  ): Promise<TaskComment | null> {
    this.validateBody(input.body);
    this.validateMentions(input.body, input.mentions);

    const [task] = db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .all();
    if (!task) return null;

    const [existing] = db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.id, commentId),
          eq(taskComments.workspaceId, workspaceId),
          eq(taskComments.taskId, taskId),
        ),
      )
      .all();

    if (!existing) return null;
    if (existing.deletedAt !== null) {
      throw new InvalidCommentError("Cannot edit a deleted comment.");
    }

    const now = new Date().toISOString();

    db.transaction(() => {
      db.insert(taskCommentEdits)
        .values({
          id: crypto.randomUUID(),
          commentId,
          editedBy: options?.actorUserId ?? null,
          previousBody: existing.body,
          createdAt: now,
        })
        .run();

      db.update(taskComments)
        .set({
          body: input.body,
          updatedAt: now,
        })
        .where(eq(taskComments.id, commentId))
        .run();

      db.insert(taskActivityEvents)
        .values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: task.projectId,
          taskId,
          actorId: options?.actorUserId ?? null,
          type: "comment.edited",
          details: JSON.stringify({ commentId }),
          createdAt: now,
        })
        .run();
    });

    const edits = db
      .select({ id: taskCommentEdits.id })
      .from(taskCommentEdits)
      .where(eq(taskCommentEdits.commentId, commentId))
      .all();

    return {
      id: commentId,
      taskId,
      workspaceId,
      authorId: existing.authorId,
      body: input.body,
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
      createdAt: existing.createdAt,
      updatedAt: now,
      editCount: edits.length,
    };
  }

  async delete(
    workspaceId: string,
    taskId: string,
    commentId: string,
    options?: CommentActorOptions,
  ): Promise<boolean> {
    const [task] = db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .all();
    if (!task) return false;

    const [existing] = db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.id, commentId),
          eq(taskComments.workspaceId, workspaceId),
          eq(taskComments.taskId, taskId),
        ),
      )
      .all();

    if (!existing) return false;
    if (existing.deletedAt !== null) return true;

    const now = new Date().toISOString();

    db.transaction(() => {
      db.update(taskComments)
        .set({
          deletedAt: now,
          deletedBy: options?.actorUserId ?? null,
          updatedAt: now,
        })
        .where(eq(taskComments.id, commentId))
        .run();

      db.insert(taskActivityEvents)
        .values({
          id: crypto.randomUUID(),
          workspaceId,
          projectId: task.projectId,
          taskId,
          actorId: options?.actorUserId ?? null,
          type: "comment.deleted",
          details: JSON.stringify({ commentId }),
          createdAt: now,
        })
        .run();
    });

    return true;
  }

  async getEditHistory(
    workspaceId: string,
    taskId: string,
    commentId: string,
  ): Promise<TaskCommentEdit[]> {
    const [comment] = db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.id, commentId),
          eq(taskComments.workspaceId, workspaceId),
          eq(taskComments.taskId, taskId),
        ),
      )
      .all();

    if (!comment) {
      throw new CommentNotFoundError();
    }

    const edits = db
      .select({
        id: taskCommentEdits.id,
        commentId: taskCommentEdits.commentId,
        editedBy: taskCommentEdits.editedBy,
        previousBody: taskCommentEdits.previousBody,
        createdAt: taskCommentEdits.createdAt,
      })
      .from(taskCommentEdits)
      .where(eq(taskCommentEdits.commentId, commentId))
      .orderBy(desc(taskCommentEdits.createdAt))
      .all();

    return edits.map((e) => ({
      id: e.id,
      commentId: e.commentId,
      editedBy: e.editedBy,
      previousBody: e.previousBody,
      createdAt: e.createdAt,
    }));
  }

  private validateBody(body: string): void {
    const trimmed = body.trim();
    if (trimmed.length < MIN_COMMENT_BODY_LENGTH || trimmed.length > MAX_COMMENT_BODY_LENGTH) {
      throw new InvalidCommentError(
        `Comment body must be between ${MIN_COMMENT_BODY_LENGTH} and ${MAX_COMMENT_BODY_LENGTH} characters.`,
      );
    }
  }

  private validateMentions(body: string, explicitMentions?: string[]): void {
    const extracted = extractMentions(body);
    const allMentions = [...extracted, ...(explicitMentions ?? [])];
    if (allMentions.length > 0) {
      throw new InvalidMentionError("Mentions are not supported in desktop mode.");
    }
  }

  private mapRow(row: typeof taskComments.$inferSelect, editCount = 0): TaskComment {
    const isDeleted = row.deletedAt !== null;
    return {
      id: row.id,
      taskId: row.taskId,
      workspaceId: row.workspaceId,
      authorId: isDeleted ? null : row.authorId,
      body: isDeleted ? "[This comment was deleted]" : row.body,
      isDeleted,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      editCount,
    };
  }
}
