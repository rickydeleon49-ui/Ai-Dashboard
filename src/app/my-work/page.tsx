import { ListTodo, LogIn } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { MyWorkFilters } from "@/components/tasks/my-work-filters";
import { MyWorkList } from "@/components/tasks/my-work-list";
import { projectRepository, taskRepository } from "@/db/repositories";
import { resolveWorkspaceAndUserForPage } from "@/core/workspaces/current-workspace";
import { isAccountsMode } from "@/lib/auth-mode";
import type { TaskPriority, TaskStatus } from "@/core/tasks/types";
import type { WorkspaceMemberDisplaySummary, WorkspaceRole } from "@/core/workspaces/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "My Work" };

/**
 * Every task across the current workspace, scoped to the caller's own
 * assignment in accounts mode; on desktop there is no user concept, so
 * it's every task in the one workspace that exists (see
 * `taskRepository.listForWorkspace`'s own doc comment).
 */
export default async function MyWorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const accountsMode = isAccountsMode();
  const resolved = await resolveWorkspaceAndUserForPage();
  if (!resolved) {
    return <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see your work." />;
  }
  const { workspaceId, userId } = resolved;

  const params = await searchParams;
  const statusParam = typeof params.status === "string" ? params.status : undefined;
  const priorityParam = typeof params.priority === "string" ? params.priority : undefined;
  const projectParam = typeof params.project === "string" ? params.project : undefined;
  const assignmentParam = typeof params.assignment === "string" ? params.assignment : undefined;

  let queryAssigneeId: string | undefined = undefined;
  let queryAssignedBy: string | undefined = undefined;
  let queryUnassigned: boolean | undefined = undefined;

  let callerRole: WorkspaceRole = "viewer";
  let membersList: WorkspaceMemberDisplaySummary[] = [];

  if (accountsMode) {
    if (userId) {
      const { getMembership } = await import("@/core/workspaces/service");
      const membership = await getMembership(workspaceId, userId);
      callerRole = membership?.role ?? "viewer";
    }

    if (assignmentParam === "by_me") {
      queryAssignedBy = userId ?? undefined;
    } else if (assignmentParam === "unassigned") {
      queryUnassigned = true;
    } else if (assignmentParam === "all") {
      // all tasks in workspace
    } else {
      // default: assigned to me
      queryAssigneeId = userId ?? undefined;
    }
  }

  const [tasks, projects] = await Promise.all([
    taskRepository.listForWorkspace(workspaceId, {
      status: statusParam as TaskStatus | "all" | undefined,
      priority: priorityParam as TaskPriority | "all" | undefined,
      assigneeId: queryAssigneeId,
      assignedBy: queryAssignedBy,
      unassigned: queryUnassigned,
      sort: "dueDate",
    }),
    projectRepository.list(workspaceId, {}),
  ]);

  const filteredTasks = projectParam ? tasks.filter((t) => t.projectId === projectParam) : tasks;
  const projectNames = new Map(projects.map((p) => [p.id, p.name] as const));

  if (accountsMode && filteredTasks.length > 0) {
    const referencedUserIds = Array.from(
      new Set(
        filteredTasks
          .flatMap((t) => [t.assigneeId, t.assignedBy])
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const { getMemberDisplaySummaries } = await import("@/core/workspaces/service");
    const referencedSummaries =
      referencedUserIds.length > 0
        ? await getMemberDisplaySummaries(workspaceId, referencedUserIds, callerRole)
        : [];

    if (callerRole !== "viewer") {
      const { listMembersPaginated } = await import("@/core/workspaces/service");
      const activeList = await listMembersPaginated(workspaceId, { status: "active", limit: 100 });
      const map = new Map<string, WorkspaceMemberDisplaySummary>();
      for (const m of activeList.members) map.set(m.id, m);
      for (const m of referencedSummaries) map.set(m.id, m);
      membersList = Array.from(map.values());
    } else {
      membersList = referencedSummaries;
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="My Work"
        description="Everything assigned to you, across every project in this workspace."
      />

      <MyWorkFilters
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        accountsMode={accountsMode}
      />

      {filteredTasks.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="Nothing here"
          description="Tasks assigned to you will show up here, across every project."
        />
      ) : (
        <MyWorkList
          tasks={filteredTasks}
          projectNames={projectNames}
          accountsMode={accountsMode}
          callerRole={callerRole}
          members={membersList}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}
