"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, BellOff, Check, CheckCheck, Mail, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  CollaborationNotification,
  NotificationFilter,
  NotificationView,
} from "@/core/notifications/types";
import {
  StaleWorkspaceError,
  announceInboxChange,
  fetchInboxPage,
  markAllNotificationsRead,
  updateNotificationState,
} from "./inbox-api";

function formatDate(value: string | null): string {
  if (!value) return "no date";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The one-line sentence for a notification. Plain text only — rendered as a React text node. */
export function describeNotification(n: CollaborationNotification): string {
  const who = n.actor?.name?.trim() || "Someone";
  switch (n.category) {
    case "assignment":
      return "change" in n.details && n.details.change === "unassigned"
        ? `${who} unassigned you from a task`
        : `${who} assigned you a task`;
    case "mention":
      return `${who} mentioned you in a comment`;
    case "comment":
      return `${who} commented on a task assigned to you`;
    case "due_date": {
      const details = "dueDate" in n.details ? n.details : { dueDate: null, previousDueDate: null };
      if (!details.dueDate) return `${who} cleared the due date on your task`;
      if (!details.previousDueDate) return `${who} set the due date on your task to ${formatDate(details.dueDate)}`;
      return `${who} moved your task's due date from ${formatDate(details.previousDueDate)} to ${formatDate(details.dueDate)}`;
    }
    default:
      return "New notification";
  }
}

type LoadState = "loading" | "ready" | "error";

/**
 * The notification list used by both the header panel (`compact`) and the
 * /inbox page. Mounted for exactly one workspace: its parent keys it by
 * workspace id, and every response for another workspace is discarded.
 */
export function NotificationList({
  workspaceId,
  view,
  filter,
  pageSize,
  compact = false,
  onUnreadCountChange,
}: {
  workspaceId: string;
  view: NotificationView;
  filter: NotificationFilter;
  pageSize: number;
  compact?: boolean;
  onUnreadCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<CollaborationNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; status: Exclude<LoadState, "loading"> } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const mounted = useRef(true);
  // The list is "loading" until a response arrives for exactly this request.
  const requestKey = `${view}|${filter}|${pageSize}|${reloadToken}`;
  const state: LoadState = loaded?.key === requestKey ? loaded.status : "loading";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reportCount = useCallback(
    (count: number) => {
      setUnreadCount(count);
      onUnreadCountChange?.(count);
      announceInboxChange({ workspaceId, unreadCount: count });
    },
    [onUnreadCountChange, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchInboxPage(workspaceId, { view, filter, limit: pageSize }, controller.signal)
      .then((page) => {
        setItems(page.notifications);
        setNextCursor(page.nextCursor);
        setActionError(null);
        setLoaded({ key: requestKey, status: "ready" });
        setUnreadCount(page.unreadCount);
        onUnreadCountChange?.(page.unreadCount);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || error instanceof StaleWorkspaceError) return;
        setLoaded({ key: requestKey, status: "error" });
      });
    return () => controller.abort();
    // onUnreadCountChange is intentionally excluded: a new callback identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, view, filter, pageSize, requestKey]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const page = await fetchInboxPage(workspaceId, { view, filter, limit: pageSize, cursor: nextCursor });
      if (!mounted.current) return;
      setItems((current) => {
        const seen = new Set(current.map((n) => n.id));
        return [...current, ...page.notifications.filter((n) => !seen.has(n.id))];
      });
      setNextCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
      onUnreadCountChange?.(page.unreadCount);
    } catch (error) {
      if (!mounted.current || error instanceof StaleWorkspaceError) return;
      setActionError("Couldn't load more notifications. Try again.");
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }

  async function change(n: CollaborationNotification, patch: { read?: boolean; archived?: boolean }) {
    setBusyId(n.id);
    setActionError(null);
    try {
      const result = await updateNotificationState(workspaceId, n.id, patch);
      if (!mounted.current) return;
      const leavesView =
        (patch.archived === true && view === "inbox") ||
        (patch.archived === false && view === "archived") ||
        (patch.read === true && filter === "unread");
      setItems((current) =>
        leavesView
          ? current.filter((item) => item.id !== n.id)
          : current.map((item) => (item.id === n.id ? result.notification : item)),
      );
      reportCount(result.unreadCount);
    } catch (error) {
      if (!mounted.current || error instanceof StaleWorkspaceError) return;
      setActionError("That change didn't save. Try again.");
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  async function markAll() {
    setMarkingAll(true);
    setActionError(null);
    try {
      const result = await markAllNotificationsRead(workspaceId);
      if (!mounted.current) return;
      setItems((current) =>
        filter === "unread"
          ? []
          : current.map((item) => (item.read ? item : { ...item, read: true, readAt: new Date().toISOString() })),
      );
      reportCount(result.unreadCount);
    } catch (error) {
      if (!mounted.current || error instanceof StaleWorkspaceError) return;
      setActionError("Couldn't mark everything read. Try again.");
    } finally {
      if (mounted.current) setMarkingAll(false);
    }
  }

  const hasUnread = items.some((n) => !n.read) || (unreadCount ?? 0) > 0;

  return (
    <div className="space-y-3" aria-busy={state === "loading" || loadingMore}>
      {view === "inbox" ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={markAll}
            disabled={markingAll || state !== "ready" || !hasUnread}
          >
            <CheckCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            {markingAll ? "Marking…" : "Mark all read"}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-400">
          {actionError}
        </p>
      ) : null}

      {state === "loading" ? (
        <p className="px-1 py-6 text-center text-[13px] text-muted" role="status">
          Loading notifications…
        </p>
      ) : state === "error" ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-line px-4 py-6 text-center">
          <p className="text-[13px] text-fg">Couldn&apos;t load notifications.</p>
          <Button type="button" size="sm" onClick={() => setReloadToken((t) => t + 1)}>
            <RotateCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center">
          <BellOff className="h-4.5 w-4.5 text-muted" strokeWidth={1.75} aria-hidden="true" />
          <p className="text-[13px] font-medium text-fg">
            {view === "archived"
              ? "No archived notifications"
              : filter === "unread"
                ? "No unread notifications"
                : "You're all caught up"}
          </p>
          <p className="text-[12px] text-muted">
            {view === "archived"
              ? "Notifications you archive in this workspace appear here."
              : "Assignments, mentions, comments and due-date changes in this workspace appear here."}
          </p>
        </div>
      ) : (
        <ul aria-label={view === "archived" ? "Archived notifications" : "Notifications"} className="space-y-2">
          {items.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              busy={busyId === n.id}
              compact={compact}
              onChange={(patch) => change(n, patch)}
            />
          ))}
        </ul>
      )}

      {state === "ready" && items.length > 0 ? (
        nextCursor ? (
          <div className="flex justify-center">
            <Button type="button" size="sm" variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : compact ? null : (
          <p className="text-center text-[12px] text-faint">End of notifications</p>
        )
      ) : null}
    </div>
  );
}

function NotificationItem({
  notification: n,
  busy,
  compact,
  onChange,
}: {
  notification: CollaborationNotification;
  busy: boolean;
  compact: boolean;
  onChange: (patch: { read?: boolean; archived?: boolean }) => void;
}) {
  const sentence = describeNotification(n);
  const subject = n.task?.title ?? "an unavailable task";
  const created = new Date(n.createdAt);

  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2.5",
        n.read ? "border-line bg-transparent" : "border-[var(--border-strong)] bg-[var(--bg-subtle)]",
      )}
      data-notification-id={n.id}
      data-read={n.read ? "true" : "false"}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            n.read ? "border border-line" : "bg-[var(--accent)]",
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className={cn("text-[13px] leading-snug", n.read ? "text-muted" : "font-semibold text-fg")}>
            {n.read ? null : (
              <span className="mr-1.5 inline-flex items-center rounded border border-[var(--border-strong)] px-1 text-[10px] font-semibold uppercase tracking-wide text-fg">
                Unread
              </span>
            )}
            {sentence}
          </p>
          <p className="text-[12px] text-muted">
            {n.task ? (
              <Link
                href={`/projects/${encodeURIComponent(n.task.projectId)}/tasks#task-${encodeURIComponent(n.task.id)}`}
                className="font-medium text-fg underline-offset-2 hover:underline focus-visible:underline"
              >
                {n.task.title}
              </Link>
            ) : (
              <span className="italic">This task is no longer available</span>
            )}
            {n.project ? <span className="text-faint"> · {n.project.name}</span> : null}
            {n.comment?.deleted ? <span className="text-faint"> · Comment deleted</span> : null}
          </p>
          <p className="text-[11px] text-faint">
            <time dateTime={n.createdAt}>{created.toLocaleString()}</time>
          </p>
        </div>
        <div className={cn("flex shrink-0 gap-1", compact ? "flex-col" : "flex-row")}>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={() => onChange({ read: !n.read })}
            aria-label={n.read ? `Mark as unread: ${sentence}, ${subject}` : `Mark as read: ${sentence}, ${subject}`}
            title={n.read ? "Mark as unread" : "Mark as read"}
          >
            {n.read ? (
              <Mail className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={() => onChange({ archived: !n.archived })}
            aria-label={n.archived ? `Restore: ${sentence}, ${subject}` : `Archive: ${sentence}, ${subject}`}
            title={n.archived ? "Restore to inbox" : "Archive"}
          >
            {n.archived ? (
              <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Archive className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </li>
  );
}
