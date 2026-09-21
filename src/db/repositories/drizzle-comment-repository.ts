/**
 * SQLite implementation of CommentRepository (Release 2C.4).
 * Single-tenant desktop supported with soft-deletion, activity logging,
 * capped cursor pagination, and bounded edit counting.
 */
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type {
  CommentActorOptions,
  CommentPaginationQuery,
  CreateCommentInput,
  PaginatedComments,
  TaskComment,
  TaskCommentEdit,
  UpdateCommentInput,
} from "@/core/tasks/types";
import {
  CommentNotFoundError,
  InvalidCommentError,
  InvalidMentionError,
  InvalidPaginationError,
} from "@/core/tasks/errors";
import { decodeCommentCursor, encodeCommentCursor } from "@/core/tasks/comment-cursor";
import { extractAndValidateMentions } from "@/core/tasks/mention-utils";
import { db } from "../client";
import {
  taskActivityEvents,
  taskCommentEdits,
  taskComments,
  tasks,
} from "../schema";
import {
  type CommentRepository,
  DEFAULT_COMMENT_PAGE_SIZE,
  MAX_COMMENT_BODY_LENGTH,
  MAX_COMMENT_PAGE_SIZE,
  MIN_COMMENT_BODY_LENGTH,
} from "./comment-repository";

export class DrizzleCommentRepository implements CommentRepository {
  async list(
    workspaceId: string,
    taskId: string,
    query?: CommentPaginationQuery,
  ): Promise<PaginatedComments> {
    if (query?.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_COMMENT_PAGE_SIZE) {
        throw new InvalidPaginationError(`Limit must be an integer between 1 and ${MAX_COMMENT_PAGE_SIZE}.`);
      }
    }
    const limit = query?.limit ?? DEFAULT_COMMENT_PAGE_SIZE;

    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (query?.cursor !== undefined) {
      const decoded = decodeCommentCursor(query.cursor);
      cursorCreatedAt = decoded.createdAt;
      cursorId = decoded.id;
    }

    const whereConditions = [
      eq(taskComments.workspaceId, workspaceId),
      eq(taskComments.taskId, taskId),
    ];

    if (cursorCreatedAt && cursorId) {
      whereConditions.push(
        or(
          gt(taskComments.createdAt, cursorCreatedAt),
          and(eq(taskComments.createdAt, cursorCreatedAt), gt(taskComments.id, cursorId)),
        )!,
      );
    }

    const rows = db
      .select()
      .from(taskComments)
      .where(and(...whereConditions))
      .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      if (last) {
        const lastIso = typeof last.createdAt === "string" ? new Date(last.createdAt).toISOString() : (last.createdAt as any).toISOString();
        nextCursor = encodeCommentCursor({
          createdAt: lastIso,
          id: last.id,
        });
      }
    }

    // Get bounded edit counts using aggregate query on page rows only
    const commentIds = pageRows.map((r) => r.id);
    const editCounts = new Map<string, number>();
    if (commentIds.length > 0) {
      const counts = db
        .select({
          commentId: taskCommentEdits.commentId,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(taskCommentEdits)
        .where(inArray(taskCommentEdits.commentId, commentIds))
        .groupBy(taskCommentEdits.commentId)
        .all();
      for (const c of counts) {
        editCounts.set(c.commentId, c.count);
      }
    }

    return {
      comments: pageRows.map((r) => this.mapRow(r, editCounts.get(r.id) ?? 0)),
      nextCursor,
    };
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

    const countRow = db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(taskCommentEdits)
      .where(eq(taskCommentEdits.commentId, commentId))
      .get();

    return this.mapRow(row, countRow?.count ?? 0);
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

    const countRow = db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(taskCommentEdits)
      .where(eq(taskCommentEdits.commentId, commentId))
      .get();

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
      editCount: countRow?.count ?? 0,
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
    const allMentions = extractAndValidateMentions(body, explicitMentions);
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
      deletedBy: isDeleted ? null : row.deletedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      editCount,
    };
  }
}
