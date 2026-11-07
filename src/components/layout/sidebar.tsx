"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  APP_ICON,
  APP_NAME,
  NAVIGATION,
  isNavItemVisible,
} from "@/config/navigation";
import type { ProjectStats } from "@/core/projects/types";
import { cn } from "@/lib/utils";

/**
 * Primary navigation, rendered from `NAVIGATION`.
 *
 * Counts are passed down from the server layout so the sidebar stays a pure
 * presentational component with no data fetching of its own.
 * In accounts mode, hide counts or controls for domains that have not yet been ported.
 * Agent features are desktop-only and visible only when agentRunsEnabled is true.
 */
export function SidebarNav({
  stats,
  accountsMode = false,
  agentRunsEnabled = false,
  onNavigate,
}: {
  stats: ProjectStats;
  accountsMode?: boolean;
  agentRunsEnabled?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
      {NAVIGATION.map((group) => {
        const items = group.items.filter((item) =>
          isNavItemVisible(item, { accountsMode, agentRunsEnabled }),
        );
        if (items.length === 0) return null;

        return (
          <div key={group.label}>
            <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {items.map((item) => {
                // "/" must match exactly; every other route matches its subtree.
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname === item.href || pathname.startsWith(`${item.href}/`);
                const count = item.countKey ? stats[item.countKey] : undefined;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
                      active
                        ? "bg-[var(--bg-hover)] font-medium text-fg"
                        : "text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                    )}
                  >
                    <item.icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        active ? "text-[var(--accent-text)]" : "text-faint group-hover:text-muted",
                      )}
                      strokeWidth={1.75}
                    />
                    <span className="truncate">{item.label}</span>

                    <span className="ml-auto flex items-center gap-1.5">
                      {item.phase > 1 ? (
                        <span
                          className="rounded bg-[var(--bg-subtle)] px-1 py-px text-[9px] font-medium uppercase tracking-wide text-faint"
                          title={`Arrives in Phase ${item.phase}`}
                        >
                          P{item.phase}
                        </span>
                      ) : null}
                      {count !== undefined && count > 0 ? (
                        <span className="text-[11px] tabular-nums text-faint">
                          {count}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              );
            })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <Link
      href="/"
      className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] shadow-sm">
        <APP_ICON className="h-4 w-4 text-white" strokeWidth={2} />
      </span>
      <span className="text-[13px] font-semibold tracking-tight text-fg">
        {APP_NAME}
      </span>
    </Link>
  );
}
