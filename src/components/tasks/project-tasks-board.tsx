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
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ListTodo,
  Loader2,
  Pencil,
  Plus,
  Trash2,
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
import type { WorkspaceMemberDisplaySummary, WorkspaceRole } from "@/core/workspaces/types";
import { todayInTimeZone, type DateOnly } from "@/core/calendar/dates";
import { cn } from "@/lib/utils";
import { formatDueDate, formatInstantDate, isDueBefore } from "@/lib/due-dates";
import { useBrowserTimeZone } from "@/lib/use-browser-time-zone";
import { AssigneeBadge, AssigneePicker } from "./assignee-picker";
import { TaskChecklist, TaskChecklistBadge } from "./task-checklist";
import { BulkActionsBar } from "./bulk-actions-bar";

const DONE_STATUSES = new Set(["done", "cancelled"]);

// A due date is a whole calendar day (its stored UTC date); only "today" comes
// from the browser's zone, and it is unknown (null) during server rendering.
function isOverdue(task: Task, today: DateOnly | null): boolean {
  return !DONE_STATUSES.has(task.status) && isDueBefore(task.dueDate, today);
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
  accountsMode = false,
  workspaceId,
  currentUserId,
  callerRole = "member",
  initialMembers = [],
}: {
  projectId: string;
  milestones: Milestone[];
  tasks: Task[];
  accountsMode?: boolean;
  workspaceId?: string;
  currentUserId?: string | null;
  callerRole?: WorkspaceRole;
  initialMembers?: WorkspaceMemberDisplaySummary[];
}) {
  const router = useRouter();
  const [creatingMilestone, setCreatingMilestone] = useState(false);
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [creatingTaskFor, setCreatingTaskFor] = useState<string | "none" | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [assignmentFilter, setAssignmentFilter] = useState<"all" | "to_me" | "by_me" | "unassigned">("all");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());

  const isViewer = accountsMode && callerRole === "viewer";
  const membersMap = new Map<string, WorkspaceMemberDisplaySummary>(
    initialMembers.map((m) => [m.id, m]),
  );

  const filteredTasks = tasks.filter((task) => {
    if (!accountsMode || assignmentFilter === "all") return true;
    if (assignmentFilter === "to_me") return task.assigneeId === currentUserId;
    if (assignmentFilter === "by_me") return task.assignedBy === currentUserId;
    if (assignmentFilter === "unassigned") return !task.assigneeId;
    return true;
  });

  const visibleIds = useMemo(() => filteredTasks.map((t) => t.id), [filteredTasks]);
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);

  const effectiveSelectedTaskIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of selectedTaskIds) {
      if (visibleIdSet.has(id)) next.add(id);
    }
    return next;
  }, [selectedTaskIds, visibleIdSet]);

  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => effectiveSelectedTaskIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => effectiveSelectedTaskIds.has(id));

  function toggleSelectTask(id: string) {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      setSelectedTaskIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      setSelectedTaskIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) {
          next.add(id);
        }
        return next;
      });
    }
  }

  function clearSelection() {
    setSelectedTaskIds(new Set());
  }

  const groups: { milestone: Milestone | null; tasks: Task[] }[] = [
    ...milestones.map((milestone) => ({
      milestone,
      tasks: filteredTasks.filter((t) => t.milestoneId === milestone.id),
    })),
    { milestone: null, tasks: filteredTasks.filter((t) => t.milestoneId === null) },
  ];

  function refresh() {
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-fg">Milestones &amp; tasks</h2>
        {!isViewer ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setCreatingMilestone((v) => !v)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            New milestone
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {accountsMode ? (
            <Select
              aria-label="Filter tasks by assignment"
              value={assignmentFilter}
              onChange={(e) => setAssignmentFilter(e.target.value as typeof assignmentFilter)}
              className="w-auto min-w-36 text-[12.5px]"
            >
              <option value="all">All assignees</option>
              <option value="to_me">Assigned to me</option>
              <option value="by_me">Assigned by me</option>
              <option value="unassigned">Unassigned</option>
            </Select>
          ) : null}
          {accountsMode && assignmentFilter !== "all" ? (
            <button
              type="button"
              onClick={() => setAssignmentFilter("all")}
              className="h-8 rounded-md px-2 text-[12.5px] text-faint transition-colors hover:text-fg"
            >
              Clear filter
            </button>
          ) : null}
        </div>

        {!isViewer && filteredTasks.length > 0 ? (
          <label className="flex cursor-pointer items-center gap-2 select-none text-[12.5px] text-faint hover:text-fg">
            <input
              type="checkbox"
              aria-label="Select all visible tasks"
              checked={allVisibleSelected}
              ref={(el) => {
                if (el) {
                  el.indeterminate = someVisibleSelected && !allVisibleSelected;
                }
              }}
              onChange={toggleSelectAllVisible}
              className="h-3.5 w-3.5 rounded border-line bg-surface text-accent focus:ring-accent"
            />
            <span>Select all visible ({filteredTasks.length})</span>
          </label>
        ) : null}
      </div>


      {creatingMilestone && !isViewer ? (
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
              editingMilestoneId === group.milestone.id && !isViewer ? (
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
                      <span data-testid="milestone-due" className="shrink-0 text-[11.5px] text-faint">
                        Due {formatDueDate(group.milestone.dueDate)}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[11.5px] tabular-nums text-faint">
                      {group.tasks.filter((t) => DONE_STATUSES.has(t.status)).length}/{group.tasks.length}
                    </span>
                  </div>
                  {!isViewer ? (
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
                  ) : null}
                </CardHeader>
              )
            ) : group.tasks.length > 0 || (creatingTaskFor === "none" && !isViewer) ? (
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
                  editing={editingTaskId === task.id && !isViewer}
                  expanded={expandedTaskId === task.id}
                  selected={effectiveSelectedTaskIds.has(task.id)}
                  onToggleSelect={() => toggleSelectTask(task.id)}
                  onEditToggle={() => setEditingTaskId(editingTaskId === task.id ? null : task.id)}
                  onExpandToggle={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                  onChanged={refresh}
                  milestones={milestones}
                  accountsMode={accountsMode}
                  workspaceId={workspaceId}
                  isViewer={isViewer}
                  membersMap={membersMap}
                  initialMembers={initialMembers}
                />
              ))}

              {!isViewer ? (
                creatingTaskFor === (group.milestone?.id ?? "none") ? (
                  <TaskFormInline
                    projectId={projectId}
                    milestoneId={group.milestone?.id ?? null}
                    milestones={milestones}
                    accountsMode={accountsMode}
                    workspaceId={workspaceId}
                    initialMembers={initialMembers}
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
                )
              ) : null}
            </CardBody>
          </Card>
        ))
      )}

      {!isViewer ? (
        <BulkActionsBar
          selectedTaskIds={effectiveSelectedTaskIds}
          allVisibleTasks={filteredTasks}
          milestones={milestones}
          members={initialMembers}
          accountsMode={accountsMode}
          isViewer={isViewer}
          workspaceId={workspaceId}
          onClearSelection={clearSelection}
          onSelectionChange={setSelectedTaskIds}
          onRefresh={refresh}
        />
      ) : null}
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
  accountsMode,
  workspaceId,
  initialMembers,
  onDone,
  onCancel,
}: {
  projectId: string;
  milestoneId?: string | null;
  milestones: Milestone[];
  task?: Task;
  accountsMode?: boolean;
  workspaceId?: string;
  initialMembers?: WorkspaceMemberDisplaySummary[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(task);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialAssigneeId = task?.assigneeId ?? null;
  const [assigneeId, setAssigneeId] = useState<string | null>(initialAssigneeId);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const milestoneValue = String(form.get("milestoneId") ?? "");
    const payload: Record<string, unknown> = {
      title: String(form.get("title") ?? "").trim(),
      description: String(form.get("description") ?? ""),
      status: String(form.get("status") ?? "todo"),
      priority: String(form.get("priority") ?? "medium"),
      dueDate: String(form.get("dueDate") ?? ""),
      milestoneId: milestoneValue,
    };

    if (accountsMode) {
      if (editing) {
        // Defense in depth: only send assigneeId when actually changed by user!
        if (assigneeId !== initialAssigneeId) {
          payload.assigneeId = assigneeId;
        }
      } else {
        if (assigneeId) {
          payload.assigneeId = assigneeId;
        }
      }
    }

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

      {accountsMode && workspaceId ? (
        <Field label="Assignee">
          <AssigneePicker
            workspaceId={workspaceId}
            value={assigneeId}
            onChange={setAssigneeId}
            knownMembers={initialMembers}
            disabled={saving}
          />
        </Field>
      ) : null}

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
  selected,
  onToggleSelect,
  onEditToggle,
  onExpandToggle,
  onChanged,
  accountsMode,
  workspaceId,
  isViewer,
  membersMap,
  initialMembers,
}: {
  projectId: string;
  task: Task;
  otherTasks: Task[];
  milestones: Milestone[];
  editing: boolean;
  expanded: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onEditToggle: () => void;
  onExpandToggle: () => void;
  onChanged: () => void;
  accountsMode?: boolean;
  workspaceId?: string;
  isViewer?: boolean;
  membersMap?: Map<string, WorkspaceMemberDisplaySummary>;
  initialMembers?: WorkspaceMemberDisplaySummary[];
}) {
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const timeZone = useBrowserTimeZone();
  const [progressOverride, setProgressOverride] = useState<{
    taskId: string;
    done: number;
    total: number;
  } | null>(null);

  const checklistSummary =
    progressOverride && progressOverride.taskId === task.id
      ? { done: progressOverride.done, total: progressOverride.total }
      : (task.checklistTotal ?? 0) > 0
      ? { done: task.checklistDone ?? 0, total: task.checklistTotal ?? 0 }
      : null;

  async function changeStatus(status: string) {
    if (isViewer) return;
    setStatusSaving(true);
    setStatusError(null);
    const result = await postJson(`/api/tasks/${task.id}`, "PATCH", { status });
    setStatusSaving(false);
    if (!result.ok) {
      // The select reverts on its own: `value` is bound to `task.status`
      // from props, and onChanged() below re-fetches it. Surfacing why
      // matters most for the 409 a still-blocked task's "Done" now gets.
      setStatusError(result.error ?? "Could not change status.");
      setTimeout(() => setStatusError(null), 5000);
    }
    onChanged();
  }

  async function remove() {
    if (isViewer) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 4000);
      return;
    }
    await postJson(`/api/tasks/${task.id}`, "DELETE");
    onChanged();
  }

  if (editing && !isViewer) {
    return (
      <TaskFormInline
        projectId={projectId}
        milestones={milestones}
        task={task}
        accountsMode={accountsMode}
        workspaceId={workspaceId}
        initialMembers={initialMembers}
        onDone={onChanged}
        onCancel={onEditToggle}
      />
    );
  }

  const overdue = isOverdue(task, timeZone ? todayInTimeZone(timeZone) : null);
  const assignedOn = formatInstantDate(task.assignedAt, timeZone);
  const assigneeMember = task.assigneeId && membersMap ? membersMap.get(task.assigneeId) : null;
  const assignerMember = task.assignedBy && membersMap ? membersMap.get(task.assignedBy) : null;

  return (
    <div id={`task-${task.id}`} className="scroll-mt-20 rounded-lg border border-line bg-[var(--bg-subtle)]/40">
      <div className="flex items-center gap-2 px-2.5 py-2">
        {!isViewer && onToggleSelect ? (
          <input
            type="checkbox"
            aria-label={`Select task ${task.title}`}
            checked={Boolean(selected)}
            onChange={onToggleSelect}
            className="h-3.5 w-3.5 shrink-0 rounded border-line bg-surface text-accent focus:ring-accent"
          />
        ) : null}

        <Select
          value={task.status}
          disabled={statusSaving || isViewer}
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

        {accountsMode && (task.assigneeId || isViewer) ? (
          <div className="shrink-0">
            {task.assigneeId ? (
              <AssigneeBadge member={assigneeMember} userId={task.assigneeId} />
            ) : (
              <span className="text-[11.5px] text-faint">Unassigned</span>
            )}
          </div>
        ) : null}

        <Badge className={cn("shrink-0", TASK_PRIORITY_META[task.priority].className)}>
          {TASK_PRIORITY_META[task.priority].label}
        </Badge>

        {task.blocked ? (
          <Badge className="shrink-0 text-amber-300 bg-amber-400/10 ring-amber-400/25">Blocked</Badge>
        ) : null}

        {checklistSummary ? (
          <TaskChecklistBadge done={checklistSummary.done} total={checklistSummary.total} />
        ) : null}

        {task.dueDate ? (
          <span
            data-testid="task-due"
            data-overdue={overdue ? "true" : undefined}
            className={cn("shrink-0 text-[11.5px]", overdue ? "text-red-400" : "text-faint")}
          >
            {formatDueDate(task.dueDate)}
          </span>
        ) : null}

        {!isViewer ? (
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
        ) : null}
      </div>

      {statusError ? (
        <p className="border-t border-line px-3 py-1.5 text-[11.5px] text-red-400">{statusError}</p>
      ) : null}

      {expanded ? (
        <div className="space-y-3 border-t border-line px-3 py-2.5">
          {task.description ? (
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted">
              {task.description}
            </p>
          ) : null}

          {accountsMode && (task.assignedBy || task.assignedAt) ? (
            <p className="text-[11.5px] text-faint">
              Assigned
              {task.assignedBy
                ? ` by ${assignerMember?.name || assignerMember?.email || "teammate"}`
                : ""}
              {assignedOn ? ` on ${assignedOn}` : ""}
            </p>
          ) : null}

          <TaskChecklist
            taskId={task.id}
            isViewer={isViewer}
            onProgressChange={(done, total) => {
              setProgressOverride({ taskId: task.id, done, total });
            }}
            onTaskCreated={onChanged}
          />

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

  // Lazy-load on first expand: dependencies aren't needed just to see the task row.
  if (!loaded) {
    load();
  }

  async function addDependency(dependsOnTaskId: string) {
    if (!dependsOnTaskId) return;
    setError(null);
    const result = await postJson(`/api/tasks/${taskId}/dependencies`, "POST", { dependsOnTaskId });
    if (!result.ok) {
      setError(result.error ?? "Could not add dependency.");
      return;
    }
    setAdding(false);
    load();
    onChanged();
  }

  async function removeDependency(dependsOnTaskId: string) {
    setError(null);
    await postJson(`/api/tasks/${taskId}/dependencies?dependsOnTaskId=${encodeURIComponent(dependsOnTaskId)}`, "DELETE");
    load();
    onChanged();
  }

  const blockerIds = new Set(blockers.map((b) => b.id));
  const availableTasks = otherTasks.filter((t) => !blockerIds.has(t.id));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] font-medium text-faint">Blocked by ({blockers.length})</span>
        {!adding && availableTasks.length > 0 ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-[11.5px] text-faint transition-colors hover:text-fg"
          >
            + Add blocker
          </button>
        ) : null}
      </div>

      {blockers.length > 0 ? (
        <ul className="space-y-1">
          {blockers.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between gap-2 rounded bg-surface px-2 py-1 text-[12px]"
            >
              <span className={cn("truncate text-muted", DONE_STATUSES.has(b.status) && "line-through text-faint")}>
                {b.title}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge className={cn("text-[10px]", TASK_STATUS_META[b.status].className)}>
                  {TASK_STATUS_META[b.status].label}
                </Badge>
                <button
                  type="button"
                  onClick={() => removeDependency(b.id)}
                  className="text-faint hover:text-red-400"
                  title="Remove blocker"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <div className="flex items-center gap-2 pt-1">
          <Select
            onChange={(e) => addDependency(e.target.value)}
            defaultValue=""
            className="h-7 text-[12px]"
            autoFocus
          >
            <option value="" disabled>
              Select a task that must finish first...
            </option>
            {availableTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
    </div>
  );
}
