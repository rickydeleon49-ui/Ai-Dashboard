import { notFound } from "next/navigation";
import Link from "next/link";
import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { KnowledgeDocumentForm } from "@/components/knowledge/knowledge-document-form";
import { knowledgeDocumentRepository, projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  const document = workspaceId ? await knowledgeDocumentRepository.findById(workspaceId, docId) : null;
  const project = workspaceId ? await projectRepository.findById(workspaceId, id) : null;
  return { title: document ? `Edit ${document.title} — ${project?.name ?? ""}` : "Edit document" };
}

export default async function EditKnowledgeDocumentPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    return (
      <EmptyState
        icon={LogIn}
        title="Sign-in required"
        description="Sign in to edit this document."
      />
    );
  }

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  // A document reachable through the wrong project's URL is treated as
  // absent — same reasoning as the API route's own `findScoped`.
  const document = await knowledgeDocumentRepository.findById(workspaceId, docId);
  if (!document || document.projectId !== project.id) notFound();

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
          <Link href={`/projects/${project.id}/knowledge`} className="transition-colors hover:text-fg">
            Knowledge
          </Link>
          <span>/</span>
          <span className="text-muted">Edit</span>
        </nav>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Edit {document.title}</h1>
      </div>
      <KnowledgeDocumentForm projectId={project.id} document={document} />
    </div>
  );
}
