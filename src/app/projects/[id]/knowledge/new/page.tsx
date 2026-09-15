import { notFound } from "next/navigation";
import Link from "next/link";
import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { KnowledgeDocumentForm } from "@/components/knowledge/knowledge-document-form";
import { projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  const project = workspaceId ? await projectRepository.findById(workspaceId, id) : null;
  return { title: project ? `New document — ${project.name}` : "New document" };
}

export default async function NewKnowledgeDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    return (
      <EmptyState
        icon={LogIn}
        title="Sign-in required"
        description="Sign in to add a knowledge base document."
      />
    );
  }

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

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
          <span className="text-muted">New</span>
        </nav>
        <h1 className="text-xl font-semibold tracking-tight text-fg">New document</h1>
      </div>
      <KnowledgeDocumentForm projectId={project.id} />
    </div>
  );
}
