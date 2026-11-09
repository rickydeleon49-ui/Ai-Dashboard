import { notFound } from "next/navigation";
import Link from "next/link";
import { LogIn, Pencil, Pin } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { MarkdownView } from "@/components/knowledge/markdown-view";
import { knowledgeDocumentRepository, projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import { resolveKnowledgePageAccess } from "@/core/knowledge/page-access";
import { cn, formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  const document = workspaceId ? await knowledgeDocumentRepository.findById(workspaceId, docId) : null;
  if (!document || document.projectId !== id) return { title: "Document" };
  const project = await projectRepository.findById(workspaceId!, id);
  return { title: `${document.title} — ${project?.name ?? "Knowledge"}` };
}

/**
 * One knowledge document, read-only (Release 2E.1). Rendered on the server
 * with the same `MarkdownView` the editor previews with, so it is identical
 * on hosted accounts mode and the offline desktop app.
 */
export default async function KnowledgeDocumentPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
  const access = await resolveKnowledgePageAccess();
  if (!access) {
    return (
      <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to read this document." />
    );
  }
  const { workspaceId, canEdit } = access;

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  // A document reachable through the wrong project's URL is treated as absent,
  // the same as the edit page and the API route's `findScoped`.
  const document = await knowledgeDocumentRepository.findById(workspaceId, docId);
  if (!document || document.projectId !== project.id) notFound();

  return (
    <div className="min-w-0 space-y-5">
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
          <Link href={`/projects/${project.id}/knowledge`} className="transition-colors hover:text-fg">
            Knowledge
          </Link>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
          <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-fg">{document.title}</h1>
          {canEdit ? (
            <Link
              href={`/projects/${project.id}/knowledge/${document.id}/edit`}
              className={cn(buttonClasses("secondary", "md"), "min-h-[40px] md:min-h-0")}
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
              Edit
            </Link>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-1 min-w-0">
          {document.pinned ? (
            <span className="flex items-center gap-1 text-[11px] text-amber-400">
              <Pin className="h-3 w-3" strokeWidth={1.75} fill="currentColor" />
              Pinned
            </span>
          ) : null}
          {document.category ? <Badge className="break-words">{document.category}</Badge> : null}
          <span className="text-[11px] text-faint">Updated {formatRelative(document.updatedAt)}</span>
        </div>
      </div>

      <article className="max-w-3xl rounded-xl border border-line bg-surface px-5 py-4 min-w-0 overflow-x-auto">
        <MarkdownView source={document.content} />
      </article>
    </div>
  );
}
