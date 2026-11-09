import Link from "next/link";
import {
  Activity,
  CircleDot,
  FileUp,
  FolderGit2,
  Github,
  Layers,
  LogIn,
  Star,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { StatTiles, type Stat } from "@/components/dashboard/stat-tiles";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { ProjectRowList } from "@/components/dashboard/project-row-list";
import { ProjectGrid } from "@/components/projects/project-card";
import { projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import type { ActivityItem } from "@/core/activity/service";
import { STATUS_META } from "@/core/projects/labels";
import { PROJECT_STATUSES } from "@/core/projects/types";
import { isAccountsMode } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    // Practically unreachable: proxy.ts already requires a session in
    // accounts mode, and sign-in always creates a personal workspace.
    return (
      <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see your dashboard." />
    );
  }

  const [stats, activeProjects, recentlyOpened, favorites, allRecent, activity] = await Promise.all([
    projectRepository.stats(workspaceId),
    projectRepository.list(workspaceId, { status: "active", sort: "updated", limit: 8 }),
    projectRepository.list(workspaceId, { sort: "opened", limit: 6 }),
    projectRepository.list(workspaceId, { favorite: true, sort: "updated", limit: 6 }),
    projectRepository.list(workspaceId, { sort: "updated", limit: 8 }),
    isAccountsMode()
      ? Promise.resolve<ActivityItem[]>([])
      : import("@/core/activity/service").then((m) => m.listRecentActivity(10)),
  ]);

  const accountsMode = isAccountsMode();

  const tiles: Stat[] = [
    {
      label: "Total projects",
      value: stats.total,
      href: "/projects",
      icon: Layers,
      hint: `${stats.archived} archived`,
    },
    {
      label: "Active",
      value: stats.active,
      href: "/projects?status=active",
      icon: CircleDot,
      hint: "In progress now",
    },
    // GitHub sync and uploads are still SQLite-only, unscoped by workspace
    // (see proxy.ts's route-allowlist comment) — their pages are blocked in
    // accounts mode, so these tiles would link straight to a 404 there.
    ...(accountsMode
      ? []
      : [
          {
            label: "GitHub",
            value: stats.github,
            href: "/github",
            icon: Github,
            // Counts repositories linked as projects, not everything in the sync cache.
            hint: "Added to dashboard",
          },
          {
            label: "Uploaded",
            value: stats.uploaded,
            href: "/uploads",
            icon: FileUp,
            hint: "Imported projects",
          },
        ]),
    {
      label: "Favorites",
      value: stats.favorites,
      href: "/favorites",
      icon: Star,
      hint: "Pinned projects",
    },
  ];

  const empty = stats.total === 0 && stats.archived === 0;

  return (
    <div className="min-w-0 space-y-7">
      <PageHeader
        title="Dashboard"
        description="Everything you are building, in one place."
        actions={
          <Link href="/projects" className={cn(buttonClasses("secondary", "md"), "min-h-[40px] md:min-h-0")}>
            Open library
          </Link>
        }
      />

      <StatTiles stats={tiles} />

      {empty ? (
        <EmptyState
          icon={FolderGit2}
          title="Your command center is ready"
          description="Add your first project by hand, or sync your GitHub repositories to fill the library automatically."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/projects/new" className={cn(buttonClasses("primary", "lg"), "min-h-[40px] md:min-h-0")}>
                New project
              </Link>
              {accountsMode ? null : (
                <Link href="/github" className={cn(buttonClasses("secondary", "lg"), "min-h-[40px] md:min-h-0")}>
                  <Github className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Connect GitHub
                </Link>
              )}
            </div>
          }
        />
      ) : null}

      <section className="min-w-0 space-y-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          Quick actions
        </h2>
        <QuickActions />
      </section>

      {activeProjects.length > 0 ? (
        <section className="min-w-0 space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight text-fg">
              Currently working on
            </h2>
            <Link
              href="/projects?status=active"
              className="inline-flex items-center text-[12px] text-muted transition-colors hover:text-fg min-h-[40px] md:min-h-0"
            >
              View all
            </Link>
          </div>
          <ProjectGrid projects={activeProjects} />
        </section>
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="min-w-0">
            <CardTitle className="min-w-0 break-words">Recently opened</CardTitle>
            <Link
              href="/projects?sort=opened"
              className="inline-flex items-center text-[12px] text-muted transition-colors hover:text-fg min-h-[40px] md:min-h-0"
            >
              View all
            </Link>
          </CardHeader>
          <div className="min-w-0 overflow-x-auto">
            <ProjectRowList
              projects={recentlyOpened}
              timestamp="opened"
              empty="Projects you open will be tracked here."
            />
          </div>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="min-w-0">
            <CardTitle className="min-w-0 break-words">Favorites</CardTitle>
            <Link
              href="/favorites"
              className="inline-flex items-center text-[12px] text-muted transition-colors hover:text-fg min-h-[40px] md:min-h-0"
            >
              View all
            </Link>
          </CardHeader>
          <div className="min-w-0 overflow-x-auto">
            <ProjectRowList
              projects={favorites}
              empty="Star a project to pin it here."
            />
          </div>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="min-w-0">
            <CardTitle className="flex items-center gap-1.5 min-w-0 break-words">
              <Activity className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={1.75} />
              Recent activity
            </CardTitle>
          </CardHeader>
          <div className="min-w-0 overflow-x-auto">
            <ActivityFeed items={activity} />
          </div>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="min-w-0">
            <CardTitle className="min-w-0 break-words">Latest updates</CardTitle>
            <Link
              href="/projects"
              className="inline-flex items-center text-[12px] text-muted transition-colors hover:text-fg min-h-[40px] md:min-h-0"
            >
              View all
            </Link>
          </CardHeader>
          <div className="min-w-0 overflow-x-auto">
            <ProjectRowList
              projects={allRecent}
              empty="Nothing in the library yet."
            />
          </div>
        </Card>
      </div>

      {stats.total > 0 ? (
        <section className="min-w-0 space-y-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight text-fg">
            By status
          </h2>
          <div className="flex flex-wrap gap-2">
            {PROJECT_STATUSES.map((status) => {
              const count = stats.byStatus[status] ?? 0;
              if (count === 0) return null;
              const meta = STATUS_META[status];
              return (
                <Link
                  key={status}
                  href={`/projects?status=${status}${status === "archived" ? "&archived=1" : ""}`}
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)] min-h-[40px] md:min-h-0"
                  title={meta.description}
                >
                  <span className="text-muted">{meta.label}</span>
                  <span className="tabular-nums font-medium text-fg">{count}</span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
