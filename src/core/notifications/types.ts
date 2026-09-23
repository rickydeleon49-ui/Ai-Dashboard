/**
 * Collaboration notifications (Release 2C.6) — framework-free domain types.
 * Hosted accounts mode only; see docs/design/2C.6-collaboration-notifications.md.
 */

export const NOTIFICATION_CATEGORIES = ["assignment", "mention", "comment", "due_date"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Every category is on unless the recipient turns it off (design note §3). */
export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<Record<NotificationCategory, boolean>> =
  Object.freeze({
    assignment: true,
    mention: true,
    comment: true,
    due_date: true,
  });

export type NotificationPreferences = Record<NotificationCategory, boolean>;
export type NotificationPreferencesUpdate = Partial<NotificationPreferences>;

export const NOTIFICATION_VIEWS = ["inbox", "archived"] as const;
export type NotificationView = (typeof NOTIFICATION_VIEWS)[number];

export const NOTIFICATION_FILTERS = ["all", "unread"] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;
export const MAX_NOTIFICATION_PAGE_SIZE = 50;

/** Allowlisted, non-content details stored with a notification (design note §5). */
export type NotificationDetails =
  | { change: "assigned" | "unassigned" }
  | { dueDate: string | null; previousDueDate: string | null }
  | Record<string, never>;

export interface NotificationListQuery {
  view: NotificationView;
  filter: NotificationFilter;
  limit: number;
  cursor?: string;
}

/** What the API returns for one notification (design note §8.1). */
export interface CollaborationNotification {
  id: string;
  category: NotificationCategory;
  read: boolean;
  readAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  actor: { id: string; name: string | null } | null;
  task: { id: string; title: string; projectId: string } | null;
  project: { id: string; name: string } | null;
  comment: { id: string; deleted: boolean } | null;
  details: NotificationDetails;
}

export interface PaginatedNotifications {
  notifications: CollaborationNotification[];
  nextCursor: string | null;
}

export interface NotificationStateChange {
  read?: boolean;
  archived?: boolean;
}

/**
 * One notification to generate, fanned out to `recipientIds`. Built only by
 * the PostgreSQL repositories from server-side state; recipients are re-checked
 * against active membership and preferences when inserted.
 */
export interface NotificationDraft {
  workspaceId: string;
  category: NotificationCategory;
  sourceEventId: string;
  actorId: string | null;
  recipientIds: readonly string[];
  taskId: string;
  projectId: string;
  commentId?: string | null;
  details: NotificationDetails;
}
