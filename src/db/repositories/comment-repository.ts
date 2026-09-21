/**
 * The persistence contract for task comments (Release 2C.4).
 */
import type {
  CommentActorOptions,
  CommentPaginationQuery,
  CreateCommentInput,
  PaginatedComments,
  TaskComment,
  TaskCommentEdit,
  UpdateCommentInput,
} from "@/core/tasks/types";

export const MIN_COMMENT_BODY_LENGTH = 1;
export const MAX_COMMENT_BODY_LENGTH = 10000;
export const DEFAULT_COMMENT_PAGE_SIZE = 50;
export const MAX_COMMENT_PAGE_SIZE = 100;

export interface CommentRepository {
  /** Returns comments for a task with capped pagination and stable ordering. */
  list(
    workspaceId: string,
    taskId: string,
    query?: CommentPaginationQuery,
  ): Promise<PaginatedComments>;

  /** Finds a single comment by ID. */
  findById(workspaceId: string, taskId: string, commentId: string): Promise<TaskComment | null>;

  /** Creates a new comment on a task, validates mentions, and logs activity event. */
  create(
    workspaceId: string,
    taskId: string,
    input: CreateCommentInput,
    options?: CommentActorOptions,
  ): Promise<TaskComment>;

  /** Updates an existing comment, records previous body in edit history, and logs activity event. */
  update(
    workspaceId: string,
    taskId: string,
    commentId: string,
    input: UpdateCommentInput,
    options?: CommentActorOptions,
  ): Promise<TaskComment | null>;

  /** Soft-deletes a comment and logs activity event. */
  delete(
    workspaceId: string,
    taskId: string,
    commentId: string,
    options?: CommentActorOptions,
  ): Promise<boolean>;

  /** Returns edit history snapshots for a comment (privileged audit). */
  getEditHistory(workspaceId: string, taskId: string, commentId: string): Promise<TaskCommentEdit[]>;
}
