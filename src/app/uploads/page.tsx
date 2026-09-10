import { FileUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ProjectGrid } from "@/components/projects/project-card";
import { UploadProjectForm } from "@/components/projects/upload-project-form";
import { LOCAL_WORKSPACE_ID, projectRepository } from "@/db/repositories";
import { formatLimit, MAX_UPLOAD_BYTES } from "@/core/files/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Uploaded" };

/**
 * Projects that came from files rather than from a repository.
 *
 * The page is the create form and the resulting library on one screen because
 * that is the whole feature: everything needed to store an upload was already
 * built — the storage driver, the routes, the per-project file panel — and the
 * navigation, the dashboard tile and the command palette all pointed here. Only
 * the destination was missing, so every one of those links returned a 404.
 */
export default async function UploadsPage() {
  const projects = await projectRepository.list(LOCAL_WORKSPACE_ID, { source: "uploaded", sort: "updated" });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Uploaded"
        description={`Create a project from files on this machine. Up to ${formatLimit(
          MAX_UPLOAD_BYTES,
        )} per file.`}
      />

      <UploadProjectForm />

      <section className="space-y-3">
        <h2 className="text-[13px] font-medium text-fg">Uploaded projects</h2>
        {projects.length === 0 ? (
          <EmptyState
            icon={FileUp}
            title="Nothing uploaded yet"
            description="Create a project above, or attach files to any existing project from its page."
          />
        ) : (
          <ProjectGrid projects={projects} />
        )}
      </section>
    </div>
  );
}
