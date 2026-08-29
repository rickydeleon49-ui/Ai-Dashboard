import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { ProjectFilters } from "@/components/projects/project-filters";
import { ProjectGrid } from "@/components/projects/project-card";
import { projectRepository } from "@/db/repositories";
import { projectQuerySchema } from "@/core/projects/schema";
import type { ProjectQuery } from "@/core/projects/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "All Projects" };

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Translates URL search params into a repository query.
 * Shared by every listing page so filters behave identically everywhere.
 */
export function buildQuery(
  raw: Record<string, string | string[] | undefined>,
  overrides: Partial<ProjectQuery> = {},
): ProjectQuery {
  const flat = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );

  const parsed = projectQuerySchema.safeParse({
    search: flat.search,
    source: flat.source,
    status: flat.status,
    type: flat.type,
    tag: flat.tag,
    sort: flat.sort,
  });

  const base: ProjectQuery = parsed.success ? parsed.data : {};
  return {
    ...base,
    includeArchived: flat.archived === "1",
    ...overrides,
  };
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = await searchParams;
  const query = buildQuery(raw);

  const [projects, tags] = await Promise.all([
    projectRepository.list(query),
    projectRepository.allTags(),
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
