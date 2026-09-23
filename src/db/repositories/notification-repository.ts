import type {
  CollaborationNotification,
  NotificationListQuery,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  NotificationStateChange,
  PaginatedNotifications,
} from "@/core/notifications/types";

/**
 * Collaboration notifications (Release 2C.6). PostgreSQL / accounts mode only.
 *
 * Every method takes BOTH `workspaceId` and `recipientId` as mandatory
 * arguments and filters on both in SQL. There is deliberately no method that
 * addresses a notification by id alone: a foreign or unknown id matches zero
 * rows and is indistinguishable from a missing one.
 */
export interface NotificationRepository {
  list(workspaceId: string, recipientId: string, query: NotificationListQuery): Promise<PaginatedNotifications>;
  findById(workspaceId: string, recipientId: string, id: string): Promise<CollaborationNotification | null>;
  unreadCount(workspaceId: string, recipientId: string): Promise<number>;
  /** Applies read/archive state to one notification; null when it isn't the caller's. */
  updateState(
    workspaceId: string,
    recipientId: string,
    id: string,
    change: NotificationStateChange,
  ): Promise<CollaborationNotification | null>;
  /** Marks every unread notification of this recipient in this workspace read. Returns rows changed. */
  markAllRead(workspaceId: string, recipientId: string): Promise<number>;
  getPreferences(workspaceId: string, userId: string): Promise<NotificationPreferences>;
  /** Writes only the categories present in `update`; returns the full effective preferences. */
  updatePreferences(
    workspaceId: string,
    userId: string,
    update: NotificationPreferencesUpdate,
  ): Promise<NotificationPreferences>;
}
