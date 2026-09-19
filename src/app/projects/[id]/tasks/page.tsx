import Link from "next/link";
import { notFound } from "next/navigation";
import { LogIn } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ProjectTasksBoard } from "@/components/tasks/project-tasks-board";
import { milestoneRepository, projectRepository, taskRepository, LOCAL_WORKSPACE_ID } from "@/db/repositories";
import { resolveWorkspaceAndUserForPage } from "@/core/workspaces/current-workspace";
import { isAccountsMode } from "@/lib/auth-mode";
import type { WorkspaceMemberSummary, WorkspaceRole } from "@/core/workspaces/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolveWorkspaceAndUserForPage();
  const workspaceId = resolved?.workspaceId ?? LOCAL_WORKSPACE_ID;
  const project = workspaceId ? await projectRepository.findById(workspaceId, id) : null;
  return { title: project ? `Tasks — ${project.name}` : "Tasks" };
}

/** Milestones & tasks for one project — see docs/OVERVIEW.md §2 for the release this landed in. */
export default async function ProjectTasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const accountsMode = isAccountsMode();
  let workspaceId = LOCAL_WORKSPACE_ID;
  let currentUserId: string | null = null;
  let callerRole: WorkspaceRole = "viewer";
  let workspaceMembersList: WorkspaceMemberSummary[] = [];

  if (accountsMode) {
    const resolved = await resolveWorkspaceAndUserForPage();
    if (!resolved) {
      return (
        <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see this project's tasks." />
      );
    }
    workspaceId = resolved.workspaceId;
    currentUserId = resolved.userId;
    if (currentUserId) {
      const { getMembership, listMembersPaginated } = await import("@/core/workspaces/service");
      const membership = await getMembership(workspaceId, currentUserId);
      callerRole = membership?.role ?? "viewer";
      const membersResult = await listMembersPaginated(workspaceId, {
        status: "all",
        callerRole: "owner",
        limit: 200,
      });
      workspaceMembersList = membersResult.members;
    }
  }

  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  const [milestones, tasks] = await Promise.all([
    milestoneRepository.list(workspaceId, id),
    taskRepository.list(workspaceId, id),
  ]);

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
          <span className="text-muted">Tasks</span>
        </nav>
        <h1 className="text-xl font-semibold tracking-tight text-fg">{project.name}</h1>
      </div>

      <ProjectTasksBoard
        projectId={project.id}
        milestones={milestones}
        tasks={tasks}
        accountsMode={accountsMode}
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        callerRole={callerRole}
        initialMembers={workspaceMembersList}
      />
    </div>
  );
}
