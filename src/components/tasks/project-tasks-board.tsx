"use client";

/**
 * The whole interactive milestones/tasks board for one project — a plain
 * list layout (milestones as grouping headers, tasks nested under them),
 * not a board/calendar: those need Table/Board/Calendar primitives this
 * codebase doesn't have yet (see the release plan's own "explicitly
 * deferred" list). Kept as one client component rather than split into
 * many prop-drilled files: the interactive state (which row is expanding,
 * editing, or mid-create) is genuinely shared across milestone groups and
 * their tasks, not independent per row.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ListTodo,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";
import { MILESTONE_STATUS_META, TASK_PRIORITY_META, TASK_STATUS_META } from "@/core/tasks/labels";
import {
  MILESTONE_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Milestone,
  type Task,
} from "@/core/tasks/types";
import { cn, formatDate } from "@/lib/utils";

const DONE_STATUSES = new Set(["done", "cancelled"]);

function isOverdue(task: Task): boolean {
  return Boolean(task.dueDate) && !DONE_STATUSES.has(task.status) && new Date(task.dueDate!) < new Date();
}

async function postJson(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: payload?.error ?? "Something went wrong." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

export function ProjectTasksBoard({
  projectId,
  milestones,
  tasks,
}: {
  projectId: string;
  milestones: Milestone[];
  tasks: Task[];
}) {
  const router = useRouter();
  const [creatingMilestone, setCreatingMilestone] = useState(false);
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [creatingTaskFor, setCreatingTaskFor] = useState<string | "none" | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const groups: { milestone: Milestone | null; tasks: Task[] }[] = [
    ...milestones.map((milestone) => ({
      milestone,
      tasks: tasks.filter((t) => t.milestoneId === milestone.id),
    })),
    { milestone: null, tasks: tasks.filter((t) => t.milestoneId === null) },
  ];

  function refresh() {
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-fg">Milestones &amp; tasks</h2>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setCreatingMilestone((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New milestone
        </Button>
      </div>

      {creatingMilestone ? (
        <MilestoneFormInline
          projectId={projectId}
          onDone={() => {
            setCreatingMilestone(false);
            refresh();
          }}
          onCancel={() => setCreatingMilestone(false)}
        />
      ) : null}

      {groups.every((g) => g.tasks.length === 0) && milestones.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No milestones or tasks yet"
          description="Break this project down into milestones and tasks to track real progress."
        />
      ) : (
        groups.map((group) => (
          <Card key={group.milestone?.id ?? "none"}>
            {group.milestone ? (
              editingMilestoneId === group.milestone.id ? (
                <div className="border-b border-line p-4">
                  <MilestoneFormInline
                    projectId={projectId}
                    milestone={group.milestone}
                    onDone={() => {
                      setEditingMilestoneId(null);
                      refresh();
                    }}
                    onCancel={() => setEditingMilestoneId(null)}
                  />
                </div>
              ) : (
                <CardHeader>
                  <div className="flex min-w-0 items-center gap-2">
                    <CardTitle className="truncate">{group.milestone.title}</CardTitle>
                    <Badge className={MILESTONE_STATUS_META[group.milestone.status].className}>
                      {MILESTONE_STATUS_META[group.milestone.status].label}
                    </Badge>
                    {group.milestone.dueDate ? (
                      <span className="shrink-0 text-[11.5px] text-faint">
                        Due {formatDate(group.milestone.dueDate)}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[11.5px] tabular-nums text-faint">
                      {group.tasks.filter((t) => DONE_STATUSES.has(t.status)).length}/{group.tasks.length}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditingMilestoneId(group.milestone!.id)}
                      className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-fg"
                      title="Edit milestone"
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                    <DeleteMilestoneButton
                      projectId={projectId}
                      milestoneId={group.milestone.id}
                      onDeleted={refresh}
                    />
                  </div>
                </CardHeader>
              )
            ) : group.tasks.length > 0 || creatingTaskFor === "none" ? (
              <CardHeader>
                <CardTitle className="text-faint">No milestone</CardTitle>
              </CardHeader>
            ) : null}

            <CardBody className="space-y-2">
              {group.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  projectId={projectId}
                  task={task}
                  otherTasks={tasks.filter((t) => t.id !== task.id)}
                  editing={editingTaskId === task.id}
                  expanded={expandedTaskId === task.id}
                  onEditToggle={() => setEditingTaskId(editingTaskId === task.id ? null : task.id)}
                  onExpandToggle={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                  onChanged={refresh}
                  milestones={milestones}
                />
              ))}

              {creatingTaskFor === (group.milestone?.id ?? "none") ? (
                <TaskFormInline
                  projectId={projectId}
                  milestoneId={group.milestone?.id ?? null}
                  milestones={milestones}
                  onDone={() => {
                    setCreatingTaskFor(null);
                    refresh();
                  }}
                  onCancel={() => setCreatingTaskFor(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setCreatingTaskFor(group.milestone?.id ?? "none")}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-faint transition-colors hover:bg-[var(--bg-subtle)] hover:text-fg"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Add task
                </button>
              )}
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}

function MilestoneFormInline({
  projectId,
  milestone,
  onDone,
  onCancel,
}: {
  projectId: string;
  milestone?: Milestone;
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(milestone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const payload = {
      title: String(form.get("title") ?? "").trim(),
      description: String(form.get("description") ?? ""),
      status: String(form.get("status") ?? "open"),
      dueDate: String(form.get("dueDate") ?? ""),
    };
    const url = editing
      ? `/api/projects/${projectId}/milestones/${milestone!.id}`
      : `/api/projects/${projectId}/milestones`;
    const result = await postJson(url, editing ? "PATCH" : "POST", payload);
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-line bg-[var(--bg-subtle)] p-3">
      <Field label="Title">
        <Input name="title" required maxLength={200} autoFocus defaultValue={milestone?.title ?? ""} placeholder="Beta launch" />
      </Field>
      <Field label="Description">
        <Textarea name="description" rows={2} defaultValue={milestone?.description ?? ""} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Status">
          <Select name="status" defaultValue={milestone?.status ?? "open"}>
            {MILESTONE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {MILESTONE_STATUS_META[s].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due date">
          <Input type="date" name="dueDate" defaultValue={milestone?.dueDate?.slice(0, 10) ?? ""} />
        </Field>
      </div>
      {error ? <p className="text-[12px] text-red-400">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} /> : null}
          {editing ? "Save" : "Create milestone"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DeleteMilestoneButton({
  projectId,
  milestoneId,
  onDeleted,
}: {
  projectId: string;
  milestoneId: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setBusy(true);
    await postJson(`/api/projects/${projectId}/milestones/${milestoneId}`, "DELETE");
    setBusy(false);
    onDeleted();
  }

  return (
    <button
      type="button"
      onClick={remove}
      disabled={busy}
      title={confirming ? "Click again to confirm" : "Delete milestone"}
      className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-red-400 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />}
    </button>
  );
}

function TaskFormInline({
  projectId,
  milestoneId,
  milestones,
  task,
  onDone,
  onCancel,
}: {
  projectId: string;
  milestoneId?: string | null;
  milestones: Milestone[];
  task?: Task;
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(task);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const milestoneValue = String(form.get("milestoneId") ?? "");
    const payload = {
      title: String(form.get("title") ?? "").trim(),
      description: String(form.get("description") ?? ""),
      status: String(form.get("status") ?? "todo"),
      priority: String(form.get("priority") ?? "medium"),
      dueDate: String(form.get("dueDate") ?? ""),
      milestoneId: milestoneValue,
    };
    const url = editing ? `/api/tasks/${task!.id}` : `/api/projects/${projectId}/tasks`;
    const result = await postJson(url, editing ? "PATCH" : "POST", payload);
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "Something went wrong.");
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-line bg-[var(--bg-subtle)] p-3">
      <Field label="Title">
        <Input name="title" required maxLength={200} autoFocus defaultValue={task?.title ?? ""} placeholder="Write the migration script" />
      </Field>
      <Field label="Description">
        <Textarea name="description" rows={2} defaultValue={task?.description ?? ""} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Status">
          <Select name="status" defaultValue={task?.status ?? "todo"}>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_META[s].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select name="priority" defaultValue={task?.priority ?? "medium"}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {TASK_PRIORITY_META[p].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due date">
          <Input type="date" name="dueDate" defaultValue={task?.dueDate?.slice(0, 10) ?? ""} />
        </Field>
        <Field label="Milestone">
          <Select name="milestoneId" defaultValue={task?.milestoneId ?? milestoneId ?? ""}>
            <option value="">No milestone</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error ? <p className="text-[12px] text-red-400">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} /> : null}
          {editing ? "Save" : "Create task"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TaskRow({
  projectId,
  task,
  otherTasks,
  milestones,
  editing,
  expanded,
  onEditToggle,
  onExpandToggle,
  onChanged,
}: {
  projectId: string;
  task: Task;
  otherTasks: Task[];
  milestones: Milestone[];
  editing: boolean;
  expanded: boolean;
  onEditToggle: () => void;
  onExpandToggle: () => void;
  onChanged: () => void;
}) {
  const [statusSaving, setStatusSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function changeStatus(status: string) {
    setStatusSaving(true);
    await postJson(`/api/tasks/${task.id}`, "PATCH", { status });
    setStatusSaving(false);
    onChanged();
  }

  async function remove() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 4000);
      return;
    }
    await postJson(`/api/tasks/${task.id}`, "DELETE");
    onChanged();
  }

  if (editing) {
    return (
      <TaskFormInline
        projectId={projectId}
        milestones={milestones}
        task={task}
        onDone={onChanged}
        onCancel={onEditToggle}
      />
    );
  }

  const overdue = isOverdue(task);

  return (
    <div className="rounded-lg border border-line bg-[var(--bg-subtle)]/40">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Select
          value={task.status}
          disabled={statusSaving}
          onChange={(e) => changeStatus(e.target.value)}
          className="h-6.5 w-[8.5rem] shrink-0 text-[12px]"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_META[s].label}
            </option>
          ))}
        </Select>

        <button
          type="button"
          onClick={onExpandToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronDown
            className={cn("h-3 w-3 shrink-0 text-faint transition-transform", expanded && "rotate-180")}
            strokeWidth={1.75}
          />
          <span
            className={cn(
              "truncate text-[13px] text-fg",
              DONE_STATUSES.has(task.status) && "text-faint line-through",
            )}
          >
            {task.title}
          </span>
        </button>

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

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEditToggle}
            className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-fg"
            title="Edit task"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={remove}
            title={confirmingDelete ? "Click again to confirm" : "Delete task"}
            className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="space-y-3 border-t border-line px-3 py-2.5">
          {task.description ? (
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted">
              {task.description}
            </p>
          ) : null}
          <TaskDependencies taskId={task.id} otherTasks={otherTasks} onChanged={onChanged} />
        </div>
      ) : null}
    </div>
  );
}

function TaskDependencies({
  taskId,
  otherTasks,
  onChanged,
}: {
  taskId: string;
  otherTasks: Task[];
  onChanged: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [blockers, setBlockers] = useState<Task[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`/api/tasks/${taskId}/dependencies`);
    if (!response.ok) return;
    const body = (await response.json()) as { blockers: Task[] };
    setBlockers(body.blockers);
    setLoaded(true);
  }

  if (!loaded) {
    void load();
  }

  async function addDependency(dependsOnTaskId: string) {
    if (!dependsOnTaskId) return;
    setAdding(true);
    setError(null);
    const result = await postJson(`/api/tasks/${taskId}/dependencies`, "POST", { dependsOnTaskId });
    setAdding(false);
    if (!result.ok) {
      setError(result.error ?? "Could not add dependency.");
      return;
    }
    await load();
    onChanged();
  }

  async function removeDependency(dependsOnTaskId: string) {
    await postJson(`/api/tasks/${taskId}/dependencies?dependsOnTaskId=${encodeURIComponent(dependsOnTaskId)}`, "DELETE");
    await load();
    onChanged();
  }

  const linkedIds = new Set(blockers.map((b) => b.id));
  const pickable = otherTasks.filter((t) => !linkedIds.has(t.id));

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
        Blocked by
      </p>
      {blockers.length === 0 ? (
        <p className="text-[12px] text-faint">No dependencies.</p>
      ) : (
        <ul className="space-y-1">
          {blockers.map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-[12.5px] text-fg">
              <span className="truncate">{b.title}</span>
              <Badge className={TASK_STATUS_META[b.status].className}>
                {TASK_STATUS_META[b.status].label}
              </Badge>
              <button
                type="button"
                onClick={() => removeDependency(b.id)}
                className="ml-auto flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:text-red-400"
                title="Remove dependency"
              >
                <X className="h-3 w-3" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {pickable.length > 0 ? (
        <div className="flex items-center gap-2 pt-1">
          <Select
            disabled={adding}
            defaultValue=""
            onChange={(e) => {
              addDependency(e.target.value);
              e.target.value = "";
            }}
            className="h-7 max-w-xs text-[12px]"
          >
            <option value="" disabled>
              Add a dependency…
            </option>
            {pickable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
          {adding ? <Loader2 className="h-3 w-3 animate-spin text-faint" strokeWidth={2} /> : null}
        </div>
      ) : null}
      {error ? <p className="text-[11.5px] text-red-400">{error}</p> : null}
    </div>
  );
}
