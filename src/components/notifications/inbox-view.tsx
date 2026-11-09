"use client";

import { useState } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NotificationFilter, NotificationView } from "@/core/notifications/types";
import { NotificationList } from "./notification-list";
import { NotificationPreferencesForm } from "./notification-preferences";

function Toggle({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center rounded-md border px-2.5 text-[13px] font-medium transition-colors min-h-[40px] md:min-h-0 md:h-7",
        pressed
          ? "border-[var(--border-strong)] bg-[var(--bg-subtle)] text-fg underline underline-offset-4"
          : "border-transparent text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/** The /inbox page body. Keyed by workspace id by its page, like the header button. */
export function InboxView({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<NotificationView>("inbox");
  const [filter, setFilter] = useState<NotificationFilter>("all");

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-label="Notification history" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
            <Toggle pressed={view === "inbox"} onClick={() => setView("inbox")}>
              Inbox
            </Toggle>
            <Toggle pressed={view === "archived"} onClick={() => setView("archived")}>
              Archived
            </Toggle>
          </div>
          <div role="group" aria-label="Filter" className="flex flex-wrap gap-1">
            <Toggle pressed={filter === "all"} onClick={() => setFilter("all")}>
              All
            </Toggle>
            <Toggle pressed={filter === "unread"} onClick={() => setFilter("unread")}>
              Unread
            </Toggle>
          </div>
        </div>
        <NotificationList workspaceId={workspaceId} view={view} filter={filter} pageSize={20} />
      </section>
      <aside className="min-w-0">
        <Card className="min-w-0">
          <CardBody className="min-w-0">
            <NotificationPreferencesForm workspaceId={workspaceId} />
          </CardBody>
        </Card>
      </aside>
    </div>
  );
}
