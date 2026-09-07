import Link from "next/link";
import { FileUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { ProjectFiles } from "@/components/projects/project-files";
import { projectRepository } from "@/db/repositories";
import { listProjectFiles } from "@/core/files/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Uploaded Files" };

export default async function UploadsPage() {
  const projects = await projectRepository.list();
  const entries = await Promise.all(
    projects.map(async (project) => ({
      project,
      files: await listProjectFiles(project.id),
    })),
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Uploaded Files"
        description="Attach archives, documents, scripts and assets to the project they belong to."
        actions={
          <Link href="/projects/new" className={buttonClasses("primary", "md")}>
            New project
          </Link>
        }
      />

      {entries.length === 0 ? (
        <EmptyState
          icon={FileUp}
          title="Create a project before uploading"
          description="Every uploaded file belongs to a project, so its context stays clear."
          action={
            <Link href="/projects/new" className={buttonClasses("primary", "lg")}>
              New project
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          {entries.map(({ project, files }) => (
            <section key={project.id} className="rounded-xl border border-line bg-[var(--bg-elevated)] p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium text-fg">{project.name}</h2>
                  <p className="mt-0.5 text-xs text-faint">
                    {files.length} {files.length === 1 ? "file" : "files"}
                  </p>
                </div>
                <Link href={`/projects/${project.id}`} className={buttonClasses("secondary", "sm")}>
                  Open project
                </Link>
              </div>
              <ProjectFiles projectId={project.id} files={files} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
