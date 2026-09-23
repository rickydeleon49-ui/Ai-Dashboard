"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Bell, X } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NotificationList } from "./notification-list";
import {
  INBOX_CHANGED_EVENT,
  StaleWorkspaceError,
  fetchUnreadCount,
  type InboxChangedDetail,
} from "./inbox-api";

function unreadLabel(count: number | null): string {
  if (count === null) return "Notifications";
  if (count === 0) return "Notifications, no unread";
  return `Notifications, ${count} unread`;
}

/**
 * Accounts-mode header bell for the Release 2C.6 collaboration inbox.
 *
 * The layout renders it with `key={workspaceId}`, so switching workspaces
 * remounts it with empty state; responses for any other workspace are
 * discarded by inbox-api. The count refreshes on mount, when the window
 * regains focus, when the panel opens, and after any inbox action.
 */
export function InboxButton({ workspaceId }: { workspaceId: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  const refresh = useCallback(
    (signal?: AbortSignal) => {
      fetchUnreadCount(workspaceId, signal)
        .then((result) => setCount(result.unreadCount))
        .catch((error: unknown) => {
          if (signal?.aborted || error instanceof StaleWorkspaceError) return;
          // Keep the last known count; the panel itself surfaces load errors.
        });
    },
    [workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    const onFocus = () => refresh();
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<InboxChangedDetail>).detail;
      if (detail?.workspaceId === workspaceId) setCount(detail.unreadCount);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
    };
  }, [refresh, workspaceId]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label={unreadLabel(count)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Notifications"
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-muted transition-colors hover:bg-[var(--bg-subtle)] hover:text-fg"
      >
        <Bell className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        {count !== null && count > 0 ? (
          <span
            aria-hidden="true"
            data-testid="inbox-unread-badge"
            className="min-w-4 rounded-full bg-[var(--accent)] px-1 text-center text-[10px] font-semibold leading-4 text-white"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          className={cn(
            "absolute right-0 top-10 z-40 w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-line",
            "bg-[var(--bg-elevated)] p-3 shadow-xl animate-fade-in",
          )}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              Notifications
            </h2>
            <div className="flex items-center gap-1">
              <Link
                href="/inbox"
                data-autofocus
                onClick={() => close(false)}
                className={buttonClasses("ghost", "sm")}
              >
                Open inbox
              </Link>
              <button
                type="button"
                aria-label="Close notifications"
                onClick={() => close(true)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-[var(--bg-subtle)]"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="max-h-[min(28rem,70vh)] overflow-y-auto pr-1">
            <NotificationList
              workspaceId={workspaceId}
              view="inbox"
              filter="all"
              pageSize={10}
              compact
              onUnreadCountChange={setCount}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
