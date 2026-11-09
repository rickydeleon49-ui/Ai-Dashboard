import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { KnowledgeDocumentCard } from "@/components/knowledge/knowledge-document-card";
import { KnowledgeDocumentFilters } from "@/components/knowledge/knowledge-document-filters";
import { knowledgeDocumentRepository, projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import { resolveKnowledgePageAccess } from "@/core/knowledge/page-access";
import { summarizeMarkdown } from "@/core/knowledge/markdown";
import type { SearchParams } from "@/lib/routing";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  const project = workspaceId ? await projectRepository.findById(workspaceId, id) : null;
  return { title: project ? `Knowledge — ${project.name}` : "Knowledge base" };
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
  const access = await resolveKnowledgePageAccess();
  if (!access) {
    return (
      <EmptyState
        icon={LogIn}
        title="Sign-in required"
        description="Sign in to see this project's knowledge base."
      />
    );
  }
  const { workspaceId, canEdit } = access;

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  const raw = await searchParams;
  const first = (key: string) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const search = first("search")?.trim() || undefined;
  const category = first("category");

  // Categories are counted in the database rather than by loading every
  // document. A search re-derives at most one bounded batch of older
  // documents' search text and reports whether any are still pending.
  const [listing, categories] = await Promise.all([
    search
      ? knowledgeDocumentRepository.search(workspaceId, project.id, { search, category })
      : knowledgeDocumentRepository.list(workspaceId, project.id, { category }).then((documents) => ({ documents, index: null })),
    knowledgeDocumentRepository.categoryCounts(workspaceId, project.id),
  ]);
  const { documents, index } = listing;
  const incomplete = index !== null && !index.complete;
  const filtered = Boolean(search || category);

  // A link to the same search, with a counter so it always navigates: each
  // visit indexes one more bounded batch.
  const round = Number.parseInt(first("indexing") ?? "0", 10);
  const continueParams = new URLSearchParams();
  if (search) continueParams.set("search", search);
  if (category) continueParams.set("category", category);
  continueParams.set("indexing", String((Number.isFinite(round) ? round : 0) + 1));
  const continueHref = `/projects/${project.id}/knowledge?${continueParams.toString()}`;
  const pendingLabel = index ? `${index.pending} older ${index.pending === 1 ? "document" : "documents"}` : "";

  return (
    <div className="space-y-5 min-w-0">
      <div className="space-y-1 min-w-0">
        <nav className="flex flex-wrap items-center gap-1.5 text-[12px] text-faint min-w-0">
          <Link href="/projects" className="transition-colors hover:text-fg">
            Projects
          </Link>
          <span>/</span>
          <Link href={`/projects/${project.id}`} className="transition-colors hover:text-fg break-words">
            {project.name}
          </Link>
          <span>/</span>
          <span className="text-muted">Knowledge</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg break-words min-w-0">{project.name}</h1>
          {canEdit ? (
            <Link
              href={`/projects/${project.id}/knowledge/new`}
              className={cn(buttonClasses("primary", "md"), "min-h-[40px] md:min-h-0")}
            >
              New document
            </Link>
          ) : null}
        </div>
      </div>

      <KnowledgeDocumentFilters categories={categories} />

      {incomplete ? (
        <div
          role="status"
          data-testid="knowledge-search-pending"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-200 min-w-0"
        >
          <p className="break-words min-w-0">
            Search is still indexing {pendingLabel} in this project, so these results may be missing matches.
          </p>
          <Link href={continueHref} className={cn(buttonClasses("secondary", "md"), "min-h-[40px] md:min-h-0")}>
            Continue indexing
          </Link>
        </div>
      ) : null}

      {documents.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={incomplete ? "No matches yet" : filtered ? "No documents match" : "No documents yet"}
          description={
            incomplete
              ? `Nothing indexed so far matches. ${pendingLabel} still to index could.`
              : filtered
                ? "Try a different search, or clear the filters."
                : "Notes, runbooks, decisions — anything future-you would want to find here."
          }
          action={
            filtered ? (
              <Link href={`/projects/${project.id}/knowledge`} className={cn(buttonClasses("secondary", "lg"), "min-h-[40px] md:min-h-0")}>
                Clear filters
              </Link>
            ) : canEdit ? (
              <Link href={`/projects/${project.id}/knowledge/new`} className={cn(buttonClasses("primary", "lg"), "min-h-[40px] md:min-h-0")}>
                New document
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="text-[12px] text-faint break-words">
            {documents.length} {documents.length === 1 ? "document" : "documents"}
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-1 lg:grid-cols-2 min-w-0">
            {documents.map((document) => (
              <KnowledgeDocumentCard
                key={document.id}
                projectId={project.id}
                document={document}
                summary={summarizeMarkdown(document.content)}
                canEdit={canEdit}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
