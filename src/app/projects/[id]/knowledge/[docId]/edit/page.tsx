import { notFound } from "next/navigation";
import Link from "next/link";
import { Eye, LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { KnowledgeDocumentForm } from "@/components/knowledge/knowledge-document-form";
import { knowledgeDocumentRepository, projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import { resolveKnowledgePageAccess } from "@/core/knowledge/page-access";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  const document = workspaceId ? await knowledgeDocumentRepository.findById(workspaceId, docId) : null;
  // The same scoping as the page body: a document reached through another
  // project's URL is absent, so its title must not appear in <title> either.
  if (!document || document.projectId !== id) return { title: "Edit document" };
  const project = await projectRepository.findById(workspaceId!, id);
  return { title: `Edit ${document.title} — ${project?.name ?? ""}` };
}

export default async function EditKnowledgeDocumentPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
  const access = await resolveKnowledgePageAccess();
  if (!access) {
    return (
      <EmptyState
        icon={LogIn}
        title="Sign-in required"
        description="Sign in to edit this document."
      />
    );
  }
  const { workspaceId, canEdit } = access;

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  // A document reachable through the wrong project's URL is treated as
  // absent — same reasoning as the API route's own `findScoped`.
  const document = await knowledgeDocumentRepository.findById(workspaceId, docId);
  if (!document || document.projectId !== project.id) notFound();

  if (!canEdit) {
    return (
      <EmptyState
        icon={Eye}
        title="Read-only access"
        description="Viewers can read this document but cannot change it."
        action={
          <Link href={`/projects/${project.id}/knowledge/${document.id}`} className="text-[13px] text-[var(--accent-text)] hover:underline min-h-[40px] md:min-h-0 inline-flex items-center">
            Read the document
          </Link>
        }
      />
    );
  }

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
          <Link href={`/projects/${project.id}/knowledge`} className="transition-colors hover:text-fg">
            Knowledge
          </Link>
          <span>/</span>
          <span className="text-muted">Edit</span>
        </nav>
        <h1 className="text-xl font-semibold tracking-tight text-fg break-words">Edit {document.title}</h1>
      </div>
      <KnowledgeDocumentForm projectId={project.id} document={document} />
    </div>
  );
}
