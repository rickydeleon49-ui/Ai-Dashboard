/**
 * PostgreSQL implementation of CommentRepository (Release 2C.4).
 * Enforces workspace scoping, transactional activity event logging,
 * soft deletion, member-mention validation, capped cursor pagination,
 * and bounded edit counting.
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
} from "@/core/tasks/errors";
import { extractAndValidateMentions } from "@/core/tasks/mention-utils";
import { getPgDb } from "../pg-client";
import {
  taskActivityEvents,
  taskCommentEdits,
  taskComments,
  tasks,
  workspaceMembers,
} from "../schema.pg";
import {
  type CommentRepository,
  DEFAULT_COMMENT_PAGE_SIZE,
  MAX_COMMENT_BODY_LENGTH,
  MAX_COMMENT_PAGE_SIZE,
  MIN_COMMENT_BODY_LENGTH,
} from "./comment-repository";

export class PostgresCommentRepository implements CommentRepository {
  async list(
    workspaceId: string,
    taskId: string,
    query?: CommentPaginationQuery,
  ): Promise<PaginatedComments> {
    const db = getPgDb();
    const limit = Math.min(
      Math.max(query?.limit ?? DEFAULT_COMMENT_PAGE_SIZE, 1),
      MAX_COMMENT_PAGE_SIZE,
    );

    let cursorDate: Date | null = null;
    let cursorId: string | null = null;
    if (query?.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf-8"));
        if (decoded && typeof decoded.createdAt === "string" && typeof decoded.id === "string") {
          cursorDate = new Date(decoded.createdAt);
          cursorId = decoded.id;
        }
      } catch {
        // Ignore malformed cursor, start from beginning
      }
    }

    const whereConditions = [
      eq(taskComments.workspaceId, workspaceId),
      eq(taskComments.taskId, taskId),
    ];

    if (cursorDate && cursorId) {
      whereConditions.push(
        or(
          gt(taskComments.createdAt, cursorDate),
          and(eq(taskComments.createdAt, cursorDate), gt(taskComments.id, cursorId)),
        )!,
      );
    }

    const rows = await db
      .select()
      .from(taskComments)
      .where(and(...whereConditions))
      .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      if (last) {
        nextCursor = Buffer.from(
          JSON.stringify({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          }),
        ).toString("base64url");
      }
    }

    // Get bounded edit counts using aggregate query on page rows only
    const commentIds = pageRows.map((r) => r.id);
    const editCounts = new Map<string, number>();
    if (commentIds.length > 0) {
      const counts = await db
        .select({
          commentId: taskCommentEdits.commentId,
          count: sql<number>`count(*)::int`.mapWith(Number),
        })
        .from(taskCommentEdits)
        .where(inArray(taskCommentEdits.commentId, commentIds))
        .groupBy(taskCommentEdits.commentId);
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
    const db = getPgDb();
    const [row] = await db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.id, commentId),
          eq(taskComments.workspaceId, workspaceId),
          eq(taskComments.taskId, taskId),
        ),
      );

    if (!row) return null;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
      .from(taskCommentEdits)
      .where(eq(taskCommentEdits.commentId, commentId));

    return this.mapRow(row, countRow?.count ?? 0);
  }

  async create(
    workspaceId: string,
    taskId: string,
    input: CreateCommentInput,
    options?: CommentActorOptions,
  ): Promise<TaskComment> {
    this.validateBody(input.body);

    const db = getPgDb();

    // Verify task exists in workspace
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));

    if (!task) {
      throw new Error("Task not found in this workspace.");
    }

    // Validate mentions against format, bounds, and workspace members before starting transaction
    const mentions = await this.validateMentions(workspaceId, input.body, input.mentions);

    return db.transaction(async (tx) => {
      const id = crypto.randomUUID();
      const authorId = options?.actorUserId ?? null;

      const [row] = await tx
        .insert(taskComments)
        .values({
          id,
          workspaceId,
          taskId,
          authorId,
          body: input.body,
        })
        .returning();

      // Log immutable activity event in same transaction
      await tx.insert(taskActivityEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        projectId: task.projectId,
        taskId,
        actorId: authorId,
        type: "comment.created",
        details: { commentId: id, ...(mentions.length > 0 ? { mentions } : {}) },
      });

      if (!row) throw new Error("Failed to create comment");
      return this.mapRow(row, 0);
    });
  }

  async update(
    workspaceId: string,
    taskId: string,
    commentId: string,
    input: UpdateCommentInput,
    options?: CommentActorOptions,
  ): Promise<TaskComment | null> {
    this.validateBody(input.body);

    const db = getPgDb();

    // Verify task exists
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
    if (!task) return null;

    await this.validateMentions(workspaceId, input.body, input.mentions);

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(taskComments)
        .where(
          and(
            eq(taskComments.id, commentId),
            eq(taskComments.workspaceId, workspaceId),
            eq(taskComments.taskId, taskId),
          ),
        )
        .for("update");

      if (!existing) return null;
      if (existing.deletedAt !== null) {
        throw new InvalidCommentError("Cannot edit a deleted comment.");
      }

      // Record edit snapshot
      await tx.insert(taskCommentEdits).values({
        id: crypto.randomUUID(),
        commentId,
        editedBy: options?.actorUserId ?? null,
        previousBody: existing.body,
      });

      // Update comment
      const [updated] = await tx
        .update(taskComments)
        .set({
          body: input.body,
          updatedAt: new Date(),
        })
        .where(eq(taskComments.id, commentId))
        .returning();

      // Log activity event
      await tx.insert(taskActivityEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        projectId: task.projectId,
        taskId,
        actorId: options?.actorUserId ?? null,
        type: "comment.edited",
        details: { commentId },
      });

      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
        .from(taskCommentEdits)
        .where(eq(taskCommentEdits.commentId, commentId));

      if (!updated) return null;
      return this.mapRow(updated, countRow?.count ?? 0);
    });
  }

  async delete(
    workspaceId: string,
    taskId: string,
    commentId: string,
    options?: CommentActorOptions,
  ): Promise<boolean> {
    const db = getPgDb();

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
    if (!task) return false;

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(taskComments)
        .where(
          and(
            eq(taskComments.id, commentId),
            eq(taskComments.workspaceId, workspaceId),
            eq(taskComments.taskId, taskId),
          ),
        )
        .for("update");

      if (!existing) return false;
      if (existing.deletedAt !== null) return true; // Already deleted

      await tx
        .update(taskComments)
        .set({
          deletedAt: new Date(),
          deletedBy: options?.actorUserId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(taskComments.id, commentId));

      // Log activity event
      await tx.insert(taskActivityEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        projectId: task.projectId,
        taskId,
        actorId: options?.actorUserId ?? null,
        type: "comment.deleted",
        details: { commentId },
      });

      return true;
    });
  }

  async getEditHistory(
    workspaceId: string,
    taskId: string,
    commentId: string,
  ): Promise<TaskCommentEdit[]> {
    const db = getPgDb();

    // Verify comment belongs to workspace and task
    const [comment] = await db
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.id, commentId),
          eq(taskComments.workspaceId, workspaceId),
          eq(taskComments.taskId, taskId),
        ),
      );

    if (!comment) {
      throw new CommentNotFoundError();
    }

    const edits = await db
      .select()
      .from(taskCommentEdits)
      .where(eq(taskCommentEdits.commentId, commentId))
      .orderBy(desc(taskCommentEdits.createdAt));

    return edits.map((e) => ({
      id: e.id,
      commentId: e.commentId,
      editedBy: e.editedBy,
      previousBody: e.previousBody,
      createdAt: e.createdAt.toISOString(),
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

  private async validateMentions(
    workspaceId: string,
    body: string,
    explicitMentions?: string[],
  ): Promise<string[]> {
    // Validates formats, deduplicates, and validates mention count limit (<= 50) BEFORE database queries
    const allMentionIds = extractAndValidateMentions(body, explicitMentions);

    if (allMentionIds.length === 0) return [];

    const db = getPgDb();
    const members = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.userId, allMentionIds),
        ),
      );

    const validMemberMap = new Map(members.map((m) => [m.userId, m.status]));

    for (const userId of allMentionIds) {
      const status = validMemberMap.get(userId);
      if (!status || (status !== "active" && status !== "invited")) {
        throw new InvalidMentionError(
          "Mentioned user is not an active member of this workspace",
          userId,
        );
      }
    }

    return allMentionIds;
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
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      deletedBy: isDeleted ? null : row.deletedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      editCount,
    };
  }
}
