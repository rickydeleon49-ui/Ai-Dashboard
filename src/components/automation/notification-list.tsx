"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Check, Info, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NotificationRow } from "@/db/schema";
import { cn, formatRelative } from "@/lib/utils";

const LEVELS = {
  info: { icon: Info, className: "text-sky-300" },
  success: { icon: Check, className: "text-emerald-400" },
  warning: { icon: AlertTriangle, className: "text-amber-400" },
} as const;

export function NotificationList({
  notifications,
}: {
  notifications: NotificationRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(method: "POST" | "DELETE") {
    setBusy(true);
    try {
      await fetch("/api/notifications", { method });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-faint">
          {notifications.length} total
          {unread > 0 ? ` · ${unread} unread` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {unread > 0 ? (
            <Button type="button" size="sm" onClick={() => act("POST")} disabled={busy}>
              <Check className="h-3 w-3" strokeWidth={2} />
              Mark all read
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => act("DELETE")}
            disabled={busy}
          >
            <Trash2 className="h-3 w-3" strokeWidth={1.75} />
            Clear
          </Button>
        </div>
      </div>

      <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-line bg-surface">
        {notifications.map((notification) => {
          const level = LEVELS[notification.level as keyof typeof LEVELS] ?? LEVELS.info;
          const Icon = level.icon;

          const inner = (
            <>
              <Icon
                className={cn("mt-0.5 h-4 w-4 shrink-0", level.className)}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-fg">
                    {notification.title}
                  </span>
                  {!notification.readAt ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]"
                      aria-label="Unread"
                    />
                  ) : null}
                </span>
                {notification.body ? (
                  <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">
                    {notification.body}
                  </span>
                ) : null}
                <span className="mt-1 block text-[11px] text-faint">
                  {formatRelative(notification.createdAt)}
                </span>
              </span>
              {notification.href ? (
                <ArrowRight
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint"
                  strokeWidth={1.75}
                />
              ) : null}
            </>
          );

          return (
            <li key={notification.id}>
              {notification.href ? (
                <Link
                  href={notification.href}
                  className="flex items-start gap-2.5 px-3.5 py-3 transition-colors hover:bg-[var(--bg-subtle)]"
                >
                  {inner}
                </Link>
              ) : (
                <div className="flex items-start gap-2.5 px-3.5 py-3">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
