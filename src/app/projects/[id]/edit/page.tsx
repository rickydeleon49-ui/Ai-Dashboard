import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectForm } from "@/components/projects/project-form";
import { LOCAL_WORKSPACE_ID, projectRepository } from "@/db/repositories";

export const dynamic = "force-dynamic";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await projectRepository.findById(LOCAL_WORKSPACE_ID, id);
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
