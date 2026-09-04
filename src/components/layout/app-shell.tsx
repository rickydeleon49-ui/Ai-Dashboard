"use client";

import { useState } from "react";
import Link from "next/link";
import { Bell, Menu, Plus, X } from "lucide-react";
import { SidebarBrand, SidebarNav } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";
import { CommandPalette, type PaletteProject } from "./command-palette";
import { buttonClasses } from "@/components/ui/button";
import type { ProjectStats } from "@/core/projects/types";

/**
 * Application chrome: fixed sidebar on desktop, slide-over drawer on mobile,
 * and a sticky top bar carrying search and the primary create action.
 */
export function AppShell({
  stats,
  paletteProjects,
  unreadNotifications,
  children,
}: {
  stats: ProjectStats;
  paletteProjects: PaletteProject[];
  unreadNotifications: number;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-width)] flex-col border-r border-line bg-[var(--bg-elevated)] lg:flex">
        <SidebarBrand />
        <SidebarNav stats={stats} />
        <div className="border-t border-line px-3 py-3">
          <ThemeToggle />
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="presentation"
          onClick={() => setDrawerOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60 animate-fade-in" />
          <aside
            className="absolute inset-y-0 left-0 flex w-[var(--sidebar-width)] flex-col border-r border-line bg-[var(--bg-elevated)] animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line pr-2">
              <SidebarBrand />
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-[var(--bg-subtle)]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
            <SidebarNav stats={stats} onNavigate={() => setDrawerOpen(false)} />
            <div className="border-t border-line px-3 py-3">
              <ThemeToggle />
            </div>
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-[var(--sidebar-width)]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-[var(--bg-subtle)] lg:hidden"
          >
            <Menu className="h-4 w-4" strokeWidth={1.75} />
          </button>

          <div className="flex min-w-0 flex-1 justify-start">
            <CommandPalette projects={paletteProjects} />
          </div>

          <Link
            href="/notifications"
            aria-label={
              unreadNotifications > 0
                ? `Notifications, ${unreadNotifications} unread`
                : "Notifications"
            }
            title="Notifications"
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--bg-subtle)] hover:text-fg"
          >
            <Bell className="h-4 w-4" strokeWidth={1.75} />
            {unreadNotifications > 0 ? (
              <span className="absolute right-1 top-1 flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            ) : null}
          </Link>

          <Link href="/projects/new" className={buttonClasses("primary", "md")}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
            <span className="hidden sm:inline">New Project</span>
          </Link>
        </header>

        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
