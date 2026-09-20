"use client";

/** The task list on My Work — read-focused, with a quick status change; full editing lives on the project's own tasks page. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/field";
import { TASK_PRIORITY_META, TASK_STATUS_META } from "@/core/tasks/labels";
import { TASK_STATUSES, type Task } from "@/core/tasks/types";
import type { WorkspaceMemberDisplaySummary, WorkspaceRole } from "@/core/workspaces/types";
import { cn, formatDate } from "@/lib/utils";
import { AssigneeBadge } from "./assignee-picker";
import { TaskChecklistBadge } from "./task-checklist";

const DONE_STATUSES = new Set(["done", "cancelled"]);

function isOverdue(task: Task): boolean {
  return Boolean(task.dueDate) && !DONE_STATUSES.has(task.status) && new Date(task.dueDate!) < new Date();
}

export function MyWorkList({
  tasks,
  projectNames,
  accountsMode = false,
  callerRole = "viewer",
  members = [],
}: {
  tasks: Task[];
  projectNames: Map<string, string>;
  accountsMode?: boolean;
  callerRole?: WorkspaceRole;
  members?: WorkspaceMemberDisplaySummary[];
}) {
  const membersMap = new Map<string, WorkspaceMemberDisplaySummary>(members.map((m) => [m.id, m]));
  const isViewer = accountsMode && callerRole === "viewer";

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <MyWorkRow
          key={task.id}
          task={task}
          projectName={projectNames.get(task.projectId) ?? "Unknown project"}
          accountsMode={accountsMode}
          isViewer={isViewer}
          assigneeMember={task.assigneeId ? membersMap.get(task.assigneeId) : null}
        />
      ))}
    </div>
  );
}

function MyWorkRow({
  task,
  projectName,
  accountsMode,
  isViewer,
  assigneeMember,
}: {
  task: Task;
  projectName: string;
  accountsMode: boolean;
  isViewer: boolean;
  assigneeMember?: WorkspaceMemberDisplaySummary | null;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeStatus(status: string) {
    if (isViewer) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        // The select reverts on its own: `value` is bound to `task.status`
        // from props, and router.refresh() below re-fetches it. Surfacing
        // why matters most for the 409 a still-blocked task's "Done" gets.
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not change status.");
        setTimeout(() => setError(null), 5000);
      }
    } catch {
      setError("Could not reach the server.");
      setTimeout(() => setError(null), 5000);
    } finally {
      setSaving(false);
    }
    router.refresh();
  }

  const overdue = isOverdue(task);

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Select
          value={task.status}
          disabled={saving || isViewer}
          aria-label={`Status for ${task.title}`}
          onChange={(e) => changeStatus(e.target.value)}
          className="h-6.5 w-[8.5rem] shrink-0 text-[12px]"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_META[s].label}
            </option>
          ))}
        </Select>

        <Link
          href={`/projects/${task.projectId}/tasks`}
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] text-fg transition-colors hover:text-[var(--accent-text)]",
            DONE_STATUSES.has(task.status) && "text-faint line-through",
          )}
        >
          {task.title}
        </Link>

        {accountsMode && (task.assigneeId || isViewer) ? (
          <div className="shrink-0">
            {task.assigneeId ? (
              <AssigneeBadge member={assigneeMember} userId={task.assigneeId} />
            ) : (
              <span className="text-[11.5px] text-faint">Unassigned</span>
            )}
          </div>
        ) : null}

        <span className="shrink-0 truncate text-[11.5px] text-faint">{projectName}</span>

        <Badge className={cn("shrink-0", TASK_PRIORITY_META[task.priority].className)}>
          {TASK_PRIORITY_META[task.priority].label}
        </Badge>

        {(task.checklistTotal ?? 0) > 0 ? (
          <TaskChecklistBadge done={task.checklistDone ?? 0} total={task.checklistTotal ?? 0} />
        ) : null}

        {task.blocked ? (
          <Badge className="shrink-0 text-amber-300 bg-amber-400/10 ring-amber-400/25">Blocked</Badge>
        ) : null}

        {task.dueDate ? (
          <span className={cn("shrink-0 text-[11.5px]", overdue ? "text-red-400" : "text-faint")}>
            {formatDate(task.dueDate)}
          </span>
        ) : null}

        {saving ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-faint" strokeWidth={2} /> : null}
      </div>

      {error ? (
        <p className="border-t border-line px-2.5 py-1.5 text-[11.5px] text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
