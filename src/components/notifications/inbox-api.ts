/**
 * Browser-side calls to /api/inbox (Release 2C.6).
 *
 * Every response names the workspace it was computed for. A component is
 * mounted for exactly one workspace, and `request()` rejects any response for a
 * different one, so a request that was in flight while the user switched
 * workspaces can never paint another workspace's notifications or count.
 */
import type {
  CollaborationNotification,
  NotificationFilter,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  NotificationView,
} from "@/core/notifications/types";

export class StaleWorkspaceError extends Error {
  constructor() {
    super("The active workspace changed.");
    this.name = "StaleWorkspaceError";
  }
}

export class InboxRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "InboxRequestError";
    this.status = status;
  }
}

/** Fired after any inbox mutation so other inbox components can refresh their count. */
export const INBOX_CHANGED_EVENT = "cc:inbox-changed";

export interface InboxChangedDetail {
  workspaceId: string;
  unreadCount: number;
}

export function announceInboxChange(detail: InboxChangedDetail): void {
  window.dispatchEvent(new CustomEvent<InboxChangedDetail>(INBOX_CHANGED_EVENT, { detail }));
}

async function request<T extends { workspaceId: string }>(
  workspaceId: string,
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error bodies fall through to the generic message.
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status}).`;
    throw new InboxRequestError(response.status, message);
  }
  const data = body as T;
  if (!data || data.workspaceId !== workspaceId) throw new StaleWorkspaceError();
  return data;
}

export interface InboxPage {
  workspaceId: string;
  notifications: CollaborationNotification[];
  nextCursor: string | null;
  unreadCount: number;
}

export function fetchInboxPage(
  workspaceId: string,
  options: { view: NotificationView; filter: NotificationFilter; limit: number; cursor?: string | null },
  signal?: AbortSignal,
): Promise<InboxPage> {
  const params = new URLSearchParams({
    view: options.view,
    filter: options.filter,
    limit: String(options.limit),
  });
  if (options.cursor) params.set("cursor", options.cursor);
  return request<InboxPage>(workspaceId, `/api/inbox?${params.toString()}`, { signal });
}

export function fetchUnreadCount(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<{ workspaceId: string; unreadCount: number }> {
  return request(workspaceId, "/api/inbox/unread-count", { signal });
}

export function updateNotificationState(
  workspaceId: string,
  id: string,
  change: { read?: boolean; archived?: boolean },
): Promise<{ workspaceId: string; notification: CollaborationNotification; unreadCount: number }> {
  return request(workspaceId, `/api/inbox/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(change),
  });
}

export function markAllNotificationsRead(
  workspaceId: string,
): Promise<{ workspaceId: string; updated: number; unreadCount: number }> {
  return request(workspaceId, "/api/inbox/mark-all-read", { method: "POST" });
}

export function fetchPreferences(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<{ workspaceId: string; preferences: NotificationPreferences }> {
  return request(workspaceId, "/api/inbox/preferences", { signal });
}

export function savePreferences(
  workspaceId: string,
  update: NotificationPreferencesUpdate,
): Promise<{ workspaceId: string; preferences: NotificationPreferences }> {
  return request(workspaceId, "/api/inbox/preferences", {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}
