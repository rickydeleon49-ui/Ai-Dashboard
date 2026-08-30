import Link from "next/link";
import { Star } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { ProjectFilters } from "@/components/projects/project-filters";
import { ProjectGrid } from "@/components/projects/project-card";
import { projectRepository } from "@/db/repositories";
import { buildProjectQuery } from "@/core/projects/query";
import type { SearchParams } from "@/lib/routing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Favorites" };

export default async function FavoritesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = await searchParams;
  const [projects, tags] = await Promise.all([
    projectRepository.list(buildProjectQuery(raw, { favorite: true })),
    projectRepository.allTags(),
  ]);

  return (
    <div className="space-y-5">
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
            <Link href="/projects" className={buttonClasses("secondary", "lg")}>
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
