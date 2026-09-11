import { notFound } from "next/navigation";
import { LogIn } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ProjectForm } from "@/components/projects/project-form";
import { projectRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";

export const dynamic = "force-dynamic";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    // Practically unreachable: proxy.ts already requires a session in
    // accounts mode, and sign-in always creates a personal workspace.
    return (
      <EmptyState
        icon={LogIn}
        title="Sign-in required"
        description="Sign in to edit this project."
      />
    );
  }
  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Edit ${project.name}`}
        description="Changes are saved to your local dashboard database."
      />
      <ProjectForm project={project} />
    </div>
  );
}
