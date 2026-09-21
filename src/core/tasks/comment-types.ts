/**
 * Domain types for Task Comments & Activity History (Release 2C.4).
 */

export interface TaskComment {
  id: string;
  taskId: string;
  workspaceId: string;
  authorId: string | null;
  body: string;
  isDeleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
  editCount: number;
}

export interface TaskCommentEdit {
  id: string;
  commentId: string;
  editedBy: string | null;
  previousBody: string;
  createdAt: string;
}

export interface TaskActivityEvent {
  id: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  actorId: string | null;
  type: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CreateCommentInput {
  body: string;
  mentions?: string[];
}

export interface UpdateCommentInput {
  body: string;
  mentions?: string[];
}

export interface CommentActorOptions {
  actorUserId?: string;
}

export interface ActivityActorOptions {
  actorUserId?: string;
}

export interface CommentPaginationQuery {
  limit?: number;
  cursor?: string;
}

export interface PaginatedComments {
  comments: TaskComment[];
  nextCursor: string | null;
}

export * from "./comment-cursor";
