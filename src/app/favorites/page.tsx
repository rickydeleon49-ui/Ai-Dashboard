import Link from "next/link";
import { LogIn, Star } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { ProjectFilters } from "@/components/projects/project-filters";
import { ProjectGrid } from "@/components/projects/project-card";
import { projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import { buildProjectQuery } from "@/core/projects/query";
import { cn } from "@/lib/utils";
import type { SearchParams } from "@/lib/routing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Favorites" };

export default async function FavoritesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    // Practically unreachable: proxy.ts already requires a session in
    // accounts mode, and sign-in always creates a personal workspace.
    return (
      <div className="min-w-0 space-y-5">
        <PageHeader title="Favorites" />
        <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see your favorites." />
      </div>
    );
  }

  const raw = await searchParams;
  const [projects, tags] = await Promise.all([
    projectRepository.list(workspaceId, buildProjectQuery(raw, { favorite: true })),
    projectRepository.allTags(workspaceId),
  ]);

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        title="Favorites"
        description="Pinned projects, kept one click away."
      />

      <ProjectFilters tags={tags} />

      {projects.length === 0 ? (
        <EmptyState
          icon={Star}
          title="No favorites yet"
          description="Star a project from any card or its detail page and it will be pinned here."
          action={
            <Link href="/projects" className={cn(buttonClasses("secondary", "lg"), "min-h-[40px] md:min-h-0")}>
              Browse projects
            </Link>
          }
        />
      ) : (
        <ProjectGrid projects={projects} />
      )}
    </div>
  );
}
