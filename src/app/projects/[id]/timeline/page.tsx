import Link from "next/link";
import { notFound } from "next/navigation";
import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { TimelineView } from "@/components/timeline/timeline-view";
import { projectRepository, LOCAL_WORKSPACE_ID } from "@/db/repositories";
import { resolveWorkspaceAndUserForPage } from "@/core/workspaces/current-workspace";
import { isAccountsMode } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveWorkspaceAndUserForPage();
  const workspaceId = resolved?.workspaceId ?? LOCAL_WORKSPACE_ID;
  const project = workspaceId ? await projectRepository.findById(workspaceId, id) : null;
  return { title: project ? `Timeline — ${project.name}` : "Timeline" };
}

/**
 * Release 2D.2 read-only project timeline (docs/design/2D.2-timeline.md).
 * The view is keyed by workspace and project, so switching either remounts it
 * with nothing cached; the API re-authorizes every read.
 */
export default async function ProjectTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const accountsMode = isAccountsMode();
  let workspaceId = LOCAL_WORKSPACE_ID;

  if (accountsMode) {
    const resolved = await resolveWorkspaceAndUserForPage();
    if (!resolved) {
      return <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see this project's timeline." />;
    }
    workspaceId = resolved.workspaceId;
  }

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <nav className="flex items-center gap-1.5 text-[12px] text-faint" aria-label="Breadcrumb">
          <Link href="/projects" className="transition-colors hover:text-fg">
            Projects
          </Link>
          <span>/</span>
          <Link href={`/projects/${project.id}`} className="transition-colors hover:text-fg">
            {project.name}
          </Link>
          <span>/</span>
          <span className="text-muted">Timeline</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{project.name} — Timeline</h1>
          <Link href={`/projects/${project.id}/tasks`} className="text-[12px] text-muted transition-colors hover:text-fg">
            Tasks
          </Link>
        </div>
      </div>
      <TimelineView
        key={`${workspaceId}:${project.id}`}
        workspaceId={workspaceId}
        projectId={project.id}
        projectName={project.name}
        accountsMode={accountsMode}
      />
    </div>
  );
}
