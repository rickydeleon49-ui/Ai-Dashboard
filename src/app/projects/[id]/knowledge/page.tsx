import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { KnowledgeDocumentCard } from "@/components/knowledge/knowledge-document-card";
import { KnowledgeDocumentFilters } from "@/components/knowledge/knowledge-document-filters";
import { knowledgeDocumentRepository, projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import type { SearchParams } from "@/lib/routing";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  const project = workspaceId ? await projectRepository.findById(workspaceId, id) : null;
  return { title: project ? `Knowledge — ${project.name}` : "Knowledge base" };
}

/** Categories in use for this project, with counts — mirrors `promptCategories()`'s own reasoning. */
function categoriesWithCounts(documents: { category: string | null }[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const doc of documents) {
    if (!doc.category) continue;
    counts.set(doc.category, (counts.get(doc.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** A project's knowledge base — see docs/OVERVIEW.md §2 for the release this landed in. */
export default async function ProjectKnowledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    return (
      <EmptyState
        icon={LogIn}
        title="Sign-in required"
        description="Sign in to see this project's knowledge base."
      />
    );
  }

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  const raw = await searchParams;
  const first = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const search = first("search");
  const category = first("category");

  const [documents, allDocuments] = await Promise.all([
    knowledgeDocumentRepository.list(workspaceId, project.id, { search, category }),
    knowledgeDocumentRepository.list(workspaceId, project.id),
  ]);
  const categories = categoriesWithCounts(allDocuments);
  const filtered = Boolean(search || category);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <nav className="flex items-center gap-1.5 text-[12px] text-faint">
          <Link href="/projects" className="transition-colors hover:text-fg">
            Projects
          </Link>
          <span>/</span>
          <Link href={`/projects/${project.id}`} className="transition-colors hover:text-fg">
            {project.name}
          </Link>
          <span>/</span>
          <span className="text-muted">Knowledge</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{project.name}</h1>
          <Link
            href={`/projects/${project.id}/knowledge/new`}
            className={buttonClasses("primary", "md")}
          >
            New document
          </Link>
        </div>
      </div>

      <KnowledgeDocumentFilters categories={categories} />

      {documents.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={filtered ? "No documents match" : "No documents yet"}
          description={
            filtered
              ? "Try a different search, or clear the filters."
              : "Notes, runbooks, decisions — anything future-you would want to find here."
          }
          action={
            filtered ? (
              <Link href={`/projects/${project.id}/knowledge`} className={buttonClasses("secondary", "lg")}>
                Clear filters
              </Link>
            ) : (
              <Link href={`/projects/${project.id}/knowledge/new`} className={buttonClasses("primary", "lg")}>
                New document
              </Link>
            )
          }
        />
      ) : (
        <>
          <p className="text-[12px] text-faint">
            {documents.length} {documents.length === 1 ? "document" : "documents"}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {documents.map((document) => (
              <KnowledgeDocumentCard key={document.id} projectId={project.id} document={document} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
