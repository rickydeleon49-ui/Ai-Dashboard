import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { ProjectFilters } from "@/components/projects/project-filters";
import { ProjectGrid } from "@/components/projects/project-card";
import { LOCAL_WORKSPACE_ID, projectRepository } from "@/db/repositories";
import { buildProjectQuery } from "@/core/projects/query";
import type { SearchParams } from "@/lib/routing";

export const dynamic = "force-dynamic";
export const metadata = { title: "All Projects" };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = await searchParams;
  const query = buildProjectQuery(raw);

  const [projects, tags] = await Promise.all([
    projectRepository.list(LOCAL_WORKSPACE_ID, query),
    projectRepository.allTags(LOCAL_WORKSPACE_ID),
  ]);

  const filtered = Boolean(
    query.search || query.status || query.source || query.tag,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Project Library"
        description="Every project you work on — GitHub, uploaded and manual — in one searchable place."
        actions={
          <Link href="/projects/new" className={buttonClasses("primary", "md")}>
            New project
          </Link>
        }
      />

      <ProjectFilters tags={tags} />

      <div className="flex items-center justify-between text-[12px] text-faint">
        <span>
          {projects.length} {projects.length === 1 ? "project" : "projects"}
          {filtered ? " matching filters" : ""}
        </span>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title={filtered ? "No projects match those filters" : "No projects yet"}
          description={
            filtered
              ? "Try clearing a filter or widening your search."
              : "Create your first project, or sync GitHub to import your repositories."
          }
          action={
            filtered ? (
              <Link href="/projects" className={buttonClasses("secondary", "lg")}>
                Clear filters
              </Link>
            ) : (
              <Link href="/projects/new" className={buttonClasses("primary", "lg")}>
                New project
              </Link>
            )
          }
        />
      ) : (
        <ProjectGrid projects={projects} />
      )}
    </div>
  );
}
