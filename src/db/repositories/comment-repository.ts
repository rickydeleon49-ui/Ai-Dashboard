/**
 * The persistence contract for task comments (Release 2C.4).
 */
import type {
  CommentActorOptions,
  CreateCommentInput,
  TaskComment,
  TaskCommentEdit,
  UpdateCommentInput,
} from "@/core/tasks/types";

export const MIN_COMMENT_BODY_LENGTH = 1;
export const MAX_COMMENT_BODY_LENGTH = 10000;

export interface CommentRepository {
  /** Returns all comments for a task ordered by createdAt ascending. */
  list(workspaceId: string, taskId: string): Promise<TaskComment[]>;

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

  /** Returns edit history snapshots for a comment. */
  getEditHistory(workspaceId: string, taskId: string, commentId: string): Promise<TaskCommentEdit[]>;
}
