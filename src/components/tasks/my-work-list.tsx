"use client";

/** The task list on My Work — read-focused, with a quick status change; full editing lives on the project's own tasks page. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/field";
import { TASK_PRIORITY_META, TASK_STATUS_META } from "@/core/tasks/labels";
import { TASK_STATUSES, type Task } from "@/core/tasks/types";
import { cn, formatDate } from "@/lib/utils";

const DONE_STATUSES = new Set(["done", "cancelled"]);

function isOverdue(task: Task): boolean {
  return Boolean(task.dueDate) && !DONE_STATUSES.has(task.status) && new Date(task.dueDate!) < new Date();
}

export function MyWorkList({
  tasks,
  projectNames,
}: {
  tasks: Task[];
  projectNames: Map<string, string>;
}) {
  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <MyWorkRow key={task.id} task={task} projectName={projectNames.get(task.projectId) ?? "Unknown project"} />
      ))}
    </div>
  );
}

function MyWorkRow({ task, projectName }: { task: Task; projectName: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function changeStatus(status: string) {
    setSaving(true);
    try {
      await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } finally {
      setSaving(false);
    }
    router.refresh();
  }

  const overdue = isOverdue(task);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2">
      <Select
        value={task.status}
        disabled={saving}
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

      <span className="shrink-0 truncate text-[11.5px] text-faint">{projectName}</span>

      <Badge className={cn("shrink-0", TASK_PRIORITY_META[task.priority].className)}>
        {TASK_PRIORITY_META[task.priority].label}
      </Badge>

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
  );
}
