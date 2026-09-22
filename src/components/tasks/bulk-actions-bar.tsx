"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { TASK_PRIORITY_META, TASK_STATUS_META } from "@/core/tasks/labels";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Milestone,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@/core/tasks/types";
import type { WorkspaceMemberDisplaySummary, WorkspaceMemberSummary } from "@/core/workspaces/types";
import type { BulkTaskItemResult, BulkTaskUpdateResponse } from "@/core/tasks/types";
import { cn } from "@/lib/utils";

export interface BulkFailedItem {
  taskId: string;
  title: string;
  error: string;
  retryable: boolean;
}

export interface BulkActionsOutcome {
  succeeded: number;
  updated: number;
  unchanged: number;
  failed: number;
  failedItems: BulkFailedItem[];
}

export function mergeRetryOutcome(
  priorOutcome: BulkActionsOutcome,
  retryResponse: BulkTaskUpdateResponse,
  taskTitleMap?: Map<string, string>,
): BulkActionsOutcome {
  const succeededInRetry = new Set(
    retryResponse.results.filter((r) => r.status !== "failed").map((r) => r.taskId),
  );
  const newlyFailedMap = new Map(
    retryResponse.results.filter((r) => r.status === "failed").map((r) => [r.taskId, r]),
  );

  const mergedFailedItems: BulkFailedItem[] = [];
  for (const priorItem of priorOutcome.failedItems) {
    if (succeededInRetry.has(priorItem.taskId)) {
      continue;
    }
    const retryResult = newlyFailedMap.get(priorItem.taskId);
    if (retryResult) {
      mergedFailedItems.push({
        taskId: priorItem.taskId,
        title: taskTitleMap?.get(priorItem.taskId) ?? priorItem.title,
        error: retryResult.error ?? "Failed to update",
        retryable: Boolean(retryResult.retryable),
      });
    } else {
      mergedFailedItems.push(priorItem);
    }
  }

  const newlyUpdated =
    retryResponse.updated ?? retryResponse.results.filter((r) => r.status === "updated").length;
  const newlyUnchanged =
    retryResponse.unchanged ?? retryResponse.results.filter((r) => r.status === "unchanged").length;

  const mergedUpdated = priorOutcome.updated + newlyUpdated;
  const mergedUnchanged = priorOutcome.unchanged + newlyUnchanged;
  const mergedSucceeded = mergedUpdated + mergedUnchanged;
  const mergedFailed = mergedFailedItems.length;

  return {
    succeeded: mergedSucceeded,
    updated: mergedUpdated,
    unchanged: mergedUnchanged,
    failed: mergedFailed,
    failedItems: mergedFailedItems,
  };
}

export interface BulkActionsBarProps {
  selectedTaskIds: Set<string>;
  allVisibleTasks: Task[];
  milestones?: Milestone[];
  milestonesLoading?: boolean;
  milestoneError?: string | null;
  members?: WorkspaceMemberDisplaySummary[];
  accountsMode?: boolean;
  isViewer?: boolean;
  workspaceId?: string;
  onClearSelection: () => void;
  onSelectionChange: (newSelected: Set<string>) => void;
  onRefresh: () => void;
  /** In My Work, project ID if all selected tasks belong to a single project. */
  singleProjectIdForSelection?: string | null;
}

export function formatOutcomeMessage(outcome: {
  updated: number;
  unchanged: number;
  failed: number;
}): string {
  const parts: string[] = [];

  if (outcome.updated > 0) {
    parts.push(`${outcome.updated} updated`);
  }
  if (outcome.unchanged > 0) {
    parts.push(`${outcome.unchanged} already matched`);
  }
  if (outcome.failed > 0) {
    parts.push(`${outcome.failed} failed`);
  }

  if (parts.length === 0) {
    return "No tasks were modified.";
  }

  if (outcome.unchanged === 0 && outcome.failed === 0) {
    return `Successfully updated ${outcome.updated} task${outcome.updated === 1 ? "" : "s"}.`;
  }
  if (outcome.updated === 0 && outcome.failed === 0) {
    return `${outcome.unchanged} task${outcome.unchanged === 1 ? "" : "s"} already matched.`;
  }

  const joined = parts.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}

export function BulkActionsBar({
  selectedTaskIds,
  allVisibleTasks,
  milestones = [],
  milestonesLoading = false,
  milestoneError = null,
  members = [],
  accountsMode = false,
  isViewer = false,
  workspaceId,
  onClearSelection,
  onSelectionChange,
  onRefresh,
  singleProjectIdForSelection,
}: BulkActionsBarProps) {
  const [status, setStatus] = useState<string>("");
  const [priority, setPriority] = useState<string>("");
  const [milestoneId, setMilestoneId] = useState<string>("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [dueDate, setDueDate] = useState<string>("");
  const [clearDueDate, setClearDueDate] = useState<boolean>(false);

  // Searchable assignee picker state
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [debouncedAssigneeSearch, setDebouncedAssigneeSearch] = useState("");
  const [fetchedMembers, setFetchedMembers] = useState<WorkspaceMemberSummary[]>([]);
  const [assigneeLoading, setAssigneeLoading] = useState(false);
  const assigneePickerRef = useRef<HTMLDivElement>(null);

  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [outcome, setOutcome] = useState<BulkActionsOutcome | null>(null);

  // Debounce search input by 250ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedAssigneeSearch(assigneeSearch.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [assigneeSearch]);

  // Fetch active members when picker is open with pagination/search
  useEffect(() => {
    if (!assigneePickerOpen || !workspaceId) return;
    let active = true;
    const controller = new AbortController();

    const params = new URLSearchParams({ status: "active", limit: "50" });
    if (debouncedAssigneeSearch) {
      params.set("search", debouncedAssigneeSearch);
    }

    fetch(`/api/workspaces/${workspaceId}/members?${params.toString()}`, {
      headers: { "Cache-Control": "no-store" },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { members: WorkspaceMemberSummary[] };
        if (active) {
          setFetchedMembers(data.members.filter((m) => m.status === "active"));
          setAssigneeLoading(false);
        }
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setFetchedMembers(
          members.filter((m): m is WorkspaceMemberSummary => m.status === "active" && Boolean(m.role)),
        );
        setAssigneeLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [assigneePickerOpen, debouncedAssigneeSearch, workspaceId, members]);

  // Handle outside clicks to close assignee popover
  useEffect(() => {
    if (!assigneePickerOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (assigneePickerRef.current && !assigneePickerRef.current.contains(e.target as Node)) {
        setAssigneePickerOpen(false);
        setAssigneeSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [assigneePickerOpen]);

  const allKnownMembersMap = useMemo(() => {
    const map = new Map<string, WorkspaceMemberDisplaySummary>();
    for (const m of members) map.set(m.id, m);
    for (const m of fetchedMembers) map.set(m.id, m);
    return map;
  }, [members, fetchedMembers]);

  const activeMembersToDisplay = useMemo(() => {
    if (workspaceId && (fetchedMembers.length > 0 || debouncedAssigneeSearch)) {
      return fetchedMembers;
    }
    const base = members.filter((m) => m.status === "active");
    if (!debouncedAssigneeSearch) return base;
    const q = debouncedAssigneeSearch.toLowerCase();
    return base.filter((m) => m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q));
  }, [workspaceId, fetchedMembers, members, debouncedAssigneeSearch]);

  if (selectedTaskIds.size === 0 && !outcome) {
    return null;
  }

  const selectedCount = selectedTaskIds.size;
  const taskMap = new Map(allVisibleTasks.map((t) => [t.id, t]));

  // Check if any change has been configured
  const hasChanges =
    status !== "" ||
    priority !== "" ||
    milestoneId !== "" ||
    assigneeId !== "" ||
    dueDate !== "" ||
    clearDueDate;

  // Determine if milestone selection is allowed
  const canSetMilestone =
    milestones.length > 0 &&
    (singleProjectIdForSelection === undefined || singleProjectIdForSelection !== null);

  const isPotentiallyDisruptive =
    status === "cancelled" || status === "done" || assigneeId === "__clear__";

  async function executeBulkUpdate(specificTaskIds?: string[]) {
    if (saving) return;
    const targetTaskIds = specificTaskIds ?? Array.from(selectedTaskIds);
    if (targetTaskIds.length === 0) return;

    const isRetry = specificTaskIds !== undefined;
    const priorOutcome = outcome;

    setShowConfirm(false);
    setSaving(true);
    if (!isRetry) {
      setOutcome(null);
    }

    const changes: Record<string, unknown> = {};
    if (status !== "") changes.status = status as TaskStatus;
    if (priority !== "") changes.priority = priority as TaskPriority;
    if (milestoneId === "__clear__") {
      changes.milestoneId = null;
    } else if (milestoneId !== "") {
      changes.milestoneId = milestoneId;
    }
    if (assigneeId === "__clear__") {
      changes.assigneeId = null;
    } else if (assigneeId !== "") {
      changes.assigneeId = assigneeId;
    }
    if (clearDueDate) {
      changes.dueDate = null;
    } else if (dueDate !== "") {
      changes.dueDate = dueDate;
    }

    try {
      const response = await fetch("/api/tasks/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: targetTaskIds,
          changes,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        const errMessage = body?.error ?? "Request failed";
        if (isRetry && priorOutcome) {
          const retriedSet = new Set(targetTaskIds);
          const mergedFailedItems = priorOutcome.failedItems.map((item) => {
            if (retriedSet.has(item.taskId)) {
              return { ...item, error: errMessage, retryable: response.status >= 500 };
            }
            return item;
          });
          setOutcome({
            ...priorOutcome,
            failedItems: mergedFailedItems,
          });
          onSelectionChange(new Set(mergedFailedItems.map((item) => item.taskId)));
        } else {
          setOutcome({
            succeeded: 0,
            updated: 0,
            unchanged: 0,
            failed: targetTaskIds.length,
            failedItems: targetTaskIds.map((id) => ({
              taskId: id,
              title: taskMap.get(id)?.title ?? id,
              error: errMessage,
              retryable: response.status >= 500,
            })),
          });
        }
        setSaving(false);
        return;
      }

      const data = (await response.json()) as BulkTaskUpdateResponse;

      if (isRetry && priorOutcome) {
        const merged = mergeRetryOutcome(
          priorOutcome,
          data,
          new Map(allVisibleTasks.map((t) => [t.id, t.title])),
        );
        setOutcome(merged);
        if (merged.failed === 0) {
          onClearSelection();
          resetForm();
        } else {
          onSelectionChange(new Set(merged.failedItems.map((item) => item.taskId)));
        }
      } else {
        const failedItems = data.results
          .filter((r) => r.status === "failed")
          .map((r) => ({
            taskId: r.taskId,
            title: taskMap.get(r.taskId)?.title ?? r.taskId,
            error: r.error ?? "Failed to update",
            retryable: Boolean(r.retryable),
          }));

        const updatedCount =
          data.updated ?? data.results.filter((r) => r.status === "updated").length;
        const unchangedCount =
          data.unchanged ?? data.results.filter((r) => r.status === "unchanged").length;

        setOutcome({
          succeeded: data.succeeded,
          updated: updatedCount,
          unchanged: unchangedCount,
          failed: data.failed,
          failedItems,
        });

        if (data.failed === 0) {
          onClearSelection();
          resetForm();
        } else {
          onSelectionChange(new Set(failedItems.map((item) => item.taskId)));
        }
      }

      onRefresh();
    } catch {
      if (isRetry && priorOutcome) {
        const retriedSet = new Set(targetTaskIds);
        const mergedFailedItems = priorOutcome.failedItems.map((item) => {
          if (retriedSet.has(item.taskId)) {
            return {
              ...item,
              error: "Network error. Please try again.",
              retryable: true,
            };
          }
          return item;
        });
        setOutcome({
          ...priorOutcome,
          failedItems: mergedFailedItems,
        });
        onSelectionChange(new Set(mergedFailedItems.map((item) => item.taskId)));
      } else {
        setOutcome({
          succeeded: 0,
          updated: 0,
          unchanged: 0,
          failed: targetTaskIds.length,
          failedItems: targetTaskIds.map((id) => ({
            taskId: id,
            title: taskMap.get(id)?.title ?? id,
            error: "Network error. Please try again.",
            retryable: true,
          })),
        });
      }
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setStatus("");
    setPriority("");
    setMilestoneId("");
    setAssigneeId("");
    setDueDate("");
    setClearDueDate(false);
    setAssigneePickerOpen(false);
    setAssigneeSearch("");
  }

  function handleApplyClick() {
    if (!hasChanges || selectedCount === 0 || saving || isViewer) return;
    if (isPotentiallyDisruptive) {
      setShowConfirm(true);
    } else {
      void executeBulkUpdate();
    }
  }

  const retryableFailedIds =
    outcome?.failedItems.filter((item) => item.retryable).map((item) => item.taskId) ?? [];
  const hasRetryableFailures = retryableFailedIds.length > 0;

  const selectedMember =
    assigneeId && assigneeId !== "__clear__" ? allKnownMembersMap.get(assigneeId) : null;
  const assigneeLabel =
    assigneeId === "__clear__"
      ? "Unassign"
      : selectedMember
      ? (selectedMember.name || selectedMember.email)
      : "Assignee...";

  return (
    <div
      role="region"
      aria-label="Bulk actions toolbar"
      className="sticky bottom-4 z-30 mx-auto w-full max-w-5xl rounded-xl border border-line bg-surface/95 p-3.5 shadow-2xl backdrop-blur-md transition-all"
    >
      {/* Outcome notification banner */}
      {outcome && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "mb-3 rounded-lg border p-2.5 text-xs transition-colors",
            outcome.failed === 0
              ? "border-emerald-500/30 bg-emerald-500/10 text-fg"
              : outcome.succeeded > 0
              ? "border-amber-500/30 bg-amber-500/10 text-fg"
              : "border-red-500/30 bg-red-500/10 text-fg",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {outcome.failed === 0 ? (
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0" />
              )}
              <span>{formatOutcomeMessage(outcome)}</span>
            </div>
            <div className="flex items-center gap-2">
              {hasRetryableFailures && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void executeBulkUpdate(retryableFailedIds)}
                  disabled={saving}
                  className="h-6 px-2 text-[11px] font-medium"
                >
                  Retry retryable failures
                </Button>
              )}
              <button
                type="button"
                onClick={() => setOutcome(null)}
                className="rounded p-0.5 text-faint hover:text-fg"
                aria-label="Dismiss message"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {outcome.failedItems.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-line/40 pt-2 text-[11.5px]">
              <p className="font-semibold">Failed tasks (retained in selection):</p>
              <ul className="max-h-24 list-disc space-y-0.5 overflow-y-auto pl-4">
                {outcome.failedItems.map((item) => (
                  <li key={item.taskId} className="truncate">
                    <span className="font-medium text-fg">{item.title}</span>: {item.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Count and Clear Selection */}
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex items-center rounded-md bg-[var(--bg-subtle)] px-2 py-1 text-[12px] font-semibold text-fg"
              aria-live="polite"
            >
              {selectedCount} task{selectedCount === 1 ? "" : "s"} selected
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onClearSelection();
                setOutcome(null);
              }}
              disabled={saving}
              className="h-7 text-[12px]"
            >
              Clear
            </Button>
          </div>

          {/* Action controls */}
          {!isViewer && (
            <div className="flex flex-wrap items-center gap-2">
              {/* Status */}
              <Select
                aria-label="Bulk update status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={saving}
                className="h-7 w-[7.5rem] text-[12px]"
              >
                <option value="">Status...</option>
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_META[s].label}
                  </option>
                ))}
              </Select>

              {/* Priority */}
              <Select
                aria-label="Bulk update priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                disabled={saving}
                className="h-7 w-[7.5rem] text-[12px]"
              >
                <option value="">Priority...</option>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {TASK_PRIORITY_META[p].label}
                  </option>
                ))}
              </Select>

              {/* Milestone */}
              <Select
                aria-label="Bulk update milestone"
                value={milestoneId}
                onChange={(e) => setMilestoneId(e.target.value)}
                disabled={
                  saving ||
                  milestonesLoading ||
                  singleProjectIdForSelection === null ||
                  Boolean(milestoneError)
                }
                className="h-7 w-[8.5rem] text-[12px]"
              >
                <option value="">
                  {milestonesLoading
                    ? "Loading milestones..."
                    : milestoneError
                    ? "Failed to load milestones"
                    : "Milestone..."}
                </option>
                <option value="__clear__">Clear milestone</option>
                {canSetMilestone ? (
                  milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))
                ) : (
                  <option value="" disabled>
                    (Multiple projects selected)
                  </option>
                )}
              </Select>
              {milestoneError && (
                <span
                  className="text-[11px] text-amber-500 font-medium"
                  role="status"
                  aria-live="polite"
                >
                  {milestoneError}
                </span>
              )}

              {/* Assignee (accounts mode) - searchable / paginated */}
              {accountsMode && (
                <div className="relative" ref={assigneePickerRef}>
                  <button
                    type="button"
                    aria-label="Bulk update assignee"
                    aria-haspopup="listbox"
                    aria-expanded={assigneePickerOpen}
                    disabled={saving}
                    onClick={() => {
                      if (!assigneePickerOpen && workspaceId) setAssigneeLoading(true);
                      setAssigneePickerOpen((prev) => !prev);
                    }}
                    className={cn(
                      "flex h-7 w-[9rem] items-center justify-between rounded-md border border-line bg-surface px-2 text-[12px] text-fg transition-colors",
                      "hover:border-[var(--border-strong)] focus:border-accent focus:outline-none",
                      saving && "opacity-50 cursor-not-allowed",
                      assigneeId && "font-medium text-fg",
                    )}
                  >
                    <span className="truncate">{assigneeLabel}</span>
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 shrink-0 text-faint transition-transform",
                        assigneePickerOpen && "rotate-180",
                      )}
                    />
                  </button>

                  {assigneePickerOpen && (
                    <div
                      className="absolute bottom-full left-0 z-50 mb-1 flex max-h-64 w-64 flex-col rounded-md border border-line bg-surface p-1 shadow-xl"
                      role="listbox"
                      aria-label="Assignee options"
                    >
                      {/* Search input */}
                      <div className="relative mb-1 p-1">
                        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                        <input
                          autoFocus
                          type="text"
                          aria-label="Search active members"
                          value={assigneeSearch}
                          onChange={(e) => {
                            setAssigneeSearch(e.target.value);
                            if (workspaceId) setAssigneeLoading(true);
                          }}
                          placeholder="Search active members..."
                          className="h-6.5 w-full rounded border border-line bg-[var(--bg-subtle)] pl-7 pr-2 text-[11.5px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
                        />
                      </div>

                      <div className="max-h-48 space-y-0.5 overflow-y-auto">
                        {/* Leave unchanged */}
                        <button
                          type="button"
                          role="option"
                          aria-selected={assigneeId === ""}
                          onClick={() => {
                            setAssigneeId("");
                            setAssigneePickerOpen(false);
                            setAssigneeSearch("");
                          }}
                          className={cn(
                            "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px] transition-colors",
                            assigneeId === ""
                              ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]"
                              : "text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                          )}
                        >
                          <span>(Don&apos;t change assignee)</span>
                          {assigneeId === "" && <Check className="h-3 w-3" />}
                        </button>

                        {/* Unassign */}
                        <button
                          type="button"
                          role="option"
                          aria-selected={assigneeId === "__clear__"}
                          onClick={() => {
                            setAssigneeId("__clear__");
                            setAssigneePickerOpen(false);
                            setAssigneeSearch("");
                          }}
                          className={cn(
                            "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px] transition-colors",
                            assigneeId === "__clear__"
                              ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]"
                              : "text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                          )}
                        >
                          <span>Unassign</span>
                          {assigneeId === "__clear__" && <Check className="h-3 w-3" />}
                        </button>

                        <div className="my-1 border-t border-line/40" />

                        {assigneeLoading ? (
                          <div className="flex items-center justify-center py-3 text-faint">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          </div>
                        ) : activeMembersToDisplay.length === 0 ? (
                          <p className="px-2 py-2 text-center text-[11px] text-faint">
                            No active members found
                          </p>
                        ) : (
                          activeMembersToDisplay.map((member) => {
                            const isSelected = assigneeId === member.id;
                            return (
                              <button
                                key={member.id}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                onClick={() => {
                                  setAssigneeId(member.id);
                                  setAssigneePickerOpen(false);
                                  setAssigneeSearch("");
                                }}
                                className={cn(
                                  "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px] transition-colors",
                                  isSelected
                                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]"
                                    : "text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                                )}
                              >
                                <div className="min-w-0 truncate">
                                  <p className="truncate font-medium">{member.name || member.email}</p>
                                  {member.name && member.email ? (
                                    <p className="truncate text-[10px] text-faint">{member.email}</p>
                                  ) : null}
                                </div>
                                {isSelected && <Check className="h-3 w-3 shrink-0" />}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Due date */}
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  aria-label="Bulk update due date"
                  value={dueDate}
                  onChange={(e) => {
                    setDueDate(e.target.value);
                    setClearDueDate(false);
                  }}
                  disabled={saving || clearDueDate}
                  className={cn(
                    "h-7 rounded-md border border-line bg-surface px-2 text-[12px] text-fg transition-colors focus:border-accent focus:outline-none",
                    clearDueDate && "opacity-50",
                  )}
                />
                <Button
                  type="button"
                  variant={clearDueDate ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => {
                    setClearDueDate(!clearDueDate);
                    if (!clearDueDate) setDueDate("");
                  }}
                  disabled={saving}
                  className="h-7 text-[11px]"
                  title="Clear due date across selected tasks"
                >
                  Clear date
                </Button>
              </div>

              {/* Apply / Confirm buttons */}
              {showConfirm ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-1">
                  <span className="px-1 text-[11.5px] font-medium text-amber-300">
                    Apply to {selectedCount} task{selectedCount === 1 ? "" : "s"}?
                  </span>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={saving}
                    onClick={() => void executeBulkUpdate()}
                    className="h-6.5 text-[11px]"
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => setShowConfirm(false)}
                    className="h-6.5 text-[11px]"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={!hasChanges || saving}
                  onClick={handleApplyClick}
                  className="h-7 text-[12px]"
                >
                  {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Apply changes
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
