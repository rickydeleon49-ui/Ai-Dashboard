import Link from "next/link";
import {
  Activity,
  CircleDot,
  FileUp,
  FolderGit2,
  Github,
  Layers,
  Star,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTiles, type Stat } from "@/components/dashboard/stat-tiles";
import { QuickActions } from "@/components/dashboard/quick-actions";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { ProjectRowList } from "@/components/dashboard/project-row-list";
import { ProjectGrid } from "@/components/projects/project-card";
import { projectRepository } from "@/db/repositories";
import { listRecentActivity } from "@/core/activity/service";
import { STATUS_META } from "@/core/projects/labels";
import { PROJECT_STATUSES } from "@/core/projects/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [stats, activeProjects, recentlyOpened, favorites, allRecent, activity] =
    await Promise.all([
      projectRepository.stats(),
      projectRepository.list({ status: "active", sort: "updated", limit: 8 }),
      projectRepository.list({ sort: "opened", limit: 6 }),
      projectRepository.list({ favorite: true, sort: "updated", limit: 6 }),
      projectRepository.list({ sort: "updated", limit: 8 }),
      listRecentActivity(10),
    ]);

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
    <div className="space-y-7">
      <PageHeader
        title="Dashboard"
        description="Everything you are building, in one place."
        actions={
          <Link href="/projects" className={buttonClasses("secondary", "md")}>
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
              <Link href="/projects/new" className={buttonClasses("primary", "lg")}>
                New project
              </Link>
              <Link href="/github" className={buttonClasses("secondary", "lg")}>
                <Github className="h-3.5 w-3.5" strokeWidth={1.75} />
                Connect GitHub
              </Link>
            </div>
          }
        />
      ) : null}

      <section className="space-y-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          Quick actions
        </h2>
        <QuickActions />
      </section>

      {activeProjects.length > 0 ? (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight text-fg">
              Currently working on
            </h2>
            <Link
              href="/projects?status=active"
              className="text-[12px] text-muted transition-colors hover:text-fg"
            >
              View all
            </Link>
          </div>
          <ProjectGrid projects={activeProjects} />
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Recently opened</CardTitle>
            <Link
              href="/projects?sort=opened"
              className="text-[12px] text-muted transition-colors hover:text-fg"
            >
              View all
            </Link>
          </CardHeader>
          <ProjectRowList
            projects={recentlyOpened}
            timestamp="opened"
            empty="Projects you open will be tracked here."
          />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Favorites</CardTitle>
            <Link
              href="/favorites"
              className="text-[12px] text-muted transition-colors hover:text-fg"
            >
              View all
            </Link>
          </CardHeader>
          <ProjectRowList
            projects={favorites}
            empty="Star a project to pin it here."
          />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
              Recent activity
            </CardTitle>
          </CardHeader>
          <ActivityFeed items={activity} />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Latest updates</CardTitle>
            <Link
              href="/projects"
              className="text-[12px] text-muted transition-colors hover:text-fg"
            >
              View all
            </Link>
          </CardHeader>
          <ProjectRowList
            projects={allRecent}
            empty="Nothing in the library yet."
          />
        </Card>
      </div>

      {stats.total > 0 ? (
        <section className="space-y-2.5">
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
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]"
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
