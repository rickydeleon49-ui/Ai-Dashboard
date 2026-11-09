"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Diamond, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  firstOfMonth,
  formatDayLabel,
  monthRange,
  parseDateOnly,
  shiftPeriod,
  todayInTimeZone,
  weekRange,
  type DateOnly,
} from "@/core/calendar/dates";
import type { CalendarItem, UnscheduledTask } from "@/core/calendar/types";
import { compareCalendarItems } from "@/core/calendar/order";
import {
  StaleWorkspaceError,
  fetchFilterOptions,
  fetchRange,
  fetchUnscheduled,
  saveDueDate,
  switchWorkspace,
  type CalendarFilterState,
  type FilterOptionsResponse,
  type RangeResponse,
} from "./calendar-api";
import { RescheduleDialog } from "./reschedule-dialog";
import { FilterSearch } from "./filter-search";

type View = "month" | "week";
type Schedulable = CalendarItem | UnscheduledTask;

/** A date change the user has made but not yet saved (design note §6). */
interface PendingChange {
  item: Schedulable;
  fromDate: DateOnly | null;
  toDate: DateOnly;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DONE = new Set(["done", "cancelled", "completed"]);

function keyOf(item: { kind: string; id: string }): string {
  return `${item.kind}:${item.id}`;
}

function dayLabel(day: DateOnly): string {
  return formatDayLabel(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function shortLabel(day: DateOnly | null): string {
  return day ? formatDayLabel(day, { month: "short", day: "numeric", year: "numeric" }) : "no date";
}

// The browser's IANA zone. It decides only what "today" is; items are placed by
// their date-only calendar day, never converted through a zone (§2).
const noopSubscribe = () => () => {};
function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    () => null,
  );
}

export function CalendarView({
  workspaceId,
  accountsMode,
  workspaces,
}: {
  workspaceId: string;
  accountsMode: boolean;
  workspaces: { id: string; name: string }[];
}) {
  const router = useRouter();
  const timeZone = useBrowserTimeZone();
  const [view, setView] = useState<View>("month");
  // null means "the period containing today"; set once the user navigates.
  const [anchorOverride, setAnchorOverride] = useState<DateOnly | null>(null);
  const [filters, setFilters] = useState<CalendarFilterState>({ projectId: "", assignee: "", status: "all", kind: "all" });
  const [reloadToken, setReloadToken] = useState(0);

  const [range, setRange] = useState<{ key: string; data: RangeResponse | null; error: boolean } | null>(null);
  const [options, setOptions] = useState<FilterOptionsResponse | null>(null);
  // A value chosen through search that isn't in the capped option list; kept
  // so the select can still show it as selected.
  const [pickedProject, setPickedProject] = useState<{ id: string; name: string } | null>(null);
  const [pickedMember, setPickedMember] = useState<{ id: string; name: string } | null>(null);
  const [unscheduled, setUnscheduled] = useState<{
    key: string;
    items: UnscheduledTask[];
    nextCursor: string | null;
    error: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [pending, setPending] = useState<PendingChange | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<{ message: string; change: PendingChange } | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<{ item: Schedulable; date: DateOnly | null; returnFocus: HTMLElement | null } | null>(null);
  const [switching, setSwitching] = useState(false);
  const dragged = useRef<{ item: Schedulable; date: DateOnly | null } | null>(null);

  const today = timeZone ? todayInTimeZone(timeZone) : null;
  const anchor = anchorOverride ?? today;
  const visible = anchor ? (view === "month" ? monthRange(anchor) : weekRange(anchor)) : null;
  const filterKey = `${filters.projectId}|${filters.assignee}|${filters.status}|${filters.kind}`;
  const rangeKey = visible && timeZone ? `${visible.from}|${visible.to}|${filterKey}|${timeZone}|${reloadToken}` : null;
  const unscheduledKey = `${filters.projectId}|${filters.assignee}|${filters.status}|${reloadToken}`;

  useEffect(() => {
    if (!rangeKey || !visible || !timeZone) return;
    const controller = new AbortController();
    fetchRange(workspaceId, { from: visible.from, to: visible.to }, filters, timeZone, controller.signal)
      .then((data) => setRange({ key: rangeKey, data, error: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted || error instanceof StaleWorkspaceError) return;
        setRange({ key: rangeKey, data: null, error: true });
      });
    return () => controller.abort();
    // `visible`, `filters` and `timeZone` are fully captured by rangeKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, rangeKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetchUnscheduled(workspaceId, filters, null, controller.signal)
      .then((page) => setUnscheduled({ key: unscheduledKey, items: page.items, nextCursor: page.nextCursor, error: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted || error instanceof StaleWorkspaceError) return;
        setUnscheduled({ key: unscheduledKey, items: [], nextCursor: null, error: true });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, unscheduledKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetchFilterOptions(workspaceId, controller.signal)
      .then(setOptions)
      .catch(() => {
        // Filters degrade to "all"; the calendar itself reports load errors.
      });
    return () => controller.abort();
  }, [workspaceId]);

  const current = range && range.key === rangeKey ? range : null;
  const currentUnscheduled = unscheduled && unscheduled.key === unscheduledKey ? unscheduled : null;
  const canReschedule = Boolean(current?.data?.canReschedule ?? options?.canReschedule);
  const locked = saving || switching;

  /**
   * Re-reads the visible range and the first unscheduled page in place,
   * without blanking the grid: results replace the current data only while
   * the view is still the one they were requested for.
   */
  function refreshInPlace() {
    if (!rangeKey || !visible || !timeZone) return;
    const key = rangeKey;
    fetchRange(workspaceId, { from: visible.from, to: visible.to }, filters, timeZone)
      .then((data) => setRange((prev) => (prev?.key === key ? { key, data, error: false } : prev)))
      .catch(() => {
        // The locally confirmed state stays; the next navigation refetches.
      });
    const uKey = unscheduledKey;
    fetchUnscheduled(workspaceId, filters, null)
      .then((page) =>
        setUnscheduled((prev) =>
          prev?.key === uKey ? { key: uKey, items: page.items, nextCursor: page.nextCursor, error: false } : prev,
        ),
      )
      .catch(() => {});
  }

  /**
   * Applies a change the server has just CONFIRMED (the PATCH succeeded), so
   * the item never flashes back to its old date while the refresh is in flight.
   */
  function applyConfirmed(change: PendingChange) {
    const key = keyOf(change.item);
    setRange((prev) => {
      if (!prev?.data) return prev;
      const items = prev.data.items.filter((i) => keyOf(i) !== key);
      if (change.toDate >= prev.data.from && change.toDate <= prev.data.to) {
        const item = change.item;
        items.push({
          kind: item.kind,
          id: item.id,
          title: item.title,
          date: change.toDate,
          projectId: item.projectId,
          projectName: item.projectName,
          status: item.status,
          assigneeId: item.assigneeId,
        });
        items.sort(compareCalendarItems);
      }
      return { ...prev, data: { ...prev.data, items } };
    });
    setUnscheduled((prev) => (prev ? { ...prev, items: prev.items.filter((i) => keyOf(i) !== key) } : prev));
  }

  async function persist(change: PendingChange) {
    if (savingRef.current) return; // one save at a time, for any item
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setNotice("");
    try {
      await saveDueDate(change.item, change.toDate);
      applyConfirmed(change);
      setPending(null);
      setNotice(`Saved: “${change.item.title}” is now due ${shortLabel(change.toDate)}.`);
      refreshInPlace();
    } catch (error) {
      // Roll back to the last confirmed date: the overlay goes away, and the
      // confirmed data was never mutated.
      setPending(null);
      setSaveError({
        message: error instanceof Error ? error.message : "The change could not be saved.",
        change,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function propose(item: Schedulable, fromDate: DateOnly | null, toDate: DateOnly) {
    if (!canReschedule || locked) return;
    if (fromDate === toDate) return;
    if (pending && keyOf(pending.item) !== keyOf(item)) {
      setNotice("Save or cancel the pending change before moving another item.");
      return;
    }
    setSaveError(null);
    setNotice("");
    const originalDate = pending ? pending.fromDate : fromDate;
    // Dropping the item back on its confirmed day simply withdraws the change.
    if (toDate === originalDate) return setPending(null);
    setPending({ item, fromDate: originalDate, toDate });
  }

  function onDrop(day: DateOnly) {
    const source = dragged.current;
    dragged.current = null;
    if (source) propose(source.item, source.date, day);
  }

  // Previous/Next stop at the supported calendar (1900-01-01 … 9999-12-31).
  const previousAnchor = anchor ? shiftPeriod(view, anchor, -1) : null;
  const nextAnchor = anchor ? shiftPeriod(view, anchor, 1) : null;

  function navigate(step: 1 | -1 | "today") {
    if (step === "today") return setAnchorOverride(null);
    const target = step === 1 ? nextAnchor : previousAnchor;
    if (target) setAnchorOverride(target);
  }

  async function changeWorkspace(nextId: string) {
    if (nextId === workspaceId || pending || saving) return;
    setSwitching(true);
    try {
      await switchWorkspace(nextId);
      router.refresh();
    } catch (error) {
      setSwitching(false);
      setNotice(error instanceof Error ? `Couldn't switch workspace: ${error.message}` : "Couldn't switch workspace.");
    }
  }

  async function loadMore() {
    if (!currentUnscheduled?.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchUnscheduled(workspaceId, filters, currentUnscheduled.nextCursor);
      setUnscheduled((prev) =>
        prev && prev.key === unscheduledKey
          ? {
              ...prev,
              items: [...prev.items, ...page.items.filter((i) => !prev.items.some((p) => p.id === i.id))],
              nextCursor: page.nextCursor,
            }
          : prev,
      );
    } catch (error) {
      if (!(error instanceof StaleWorkspaceError)) setNotice("Couldn't load more unscheduled tasks. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  // Items per day, with the pending change applied as an overlay only.
  const byDay = new Map<DateOnly, (CalendarItem & { pending?: boolean })[]>();
  for (const item of current?.data?.items ?? []) {
    if (pending && keyOf(pending.item) === keyOf(item)) continue;
    const list = byDay.get(item.date) ?? [];
    list.push(item);
    byDay.set(item.date, list);
  }
  if (pending) {
    const list = byDay.get(pending.toDate) ?? [];
    list.unshift({ ...(pending.item as CalendarItem), kind: pending.item.kind, date: pending.toDate, pending: true });
    byDay.set(pending.toDate, list);
  }

  const heading = !visible || !anchor
    ? "Calendar"
    : view === "month"
      ? formatDayLabel(firstOfMonth(anchor), { month: "long", year: "numeric" })
      : `${shortLabel(visible.from)} – ${shortLabel(visible.to)}`;
  const anchorMonth = anchor ? parseDateOnly(anchor).month : 0;

  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <section aria-label="Calendar" className="min-w-0 space-y-3">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <div role="group" aria-label="View" className="flex gap-1">
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                disabled={locked}
                onClick={() => setView(v)}
                className={cn(
                  "inline-flex items-center justify-center h-7 rounded-md border px-2.5 text-[13px] font-medium capitalize transition-colors disabled:opacity-50 min-h-[40px] md:min-h-0",
                  view === v
                    ? "border-[var(--border-strong)] bg-[var(--bg-subtle)] text-fg underline underline-offset-4"
                    : "border-transparent text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" size="icon" variant="ghost" aria-label={`Previous ${view}`} disabled={locked || !previousAnchor} onClick={() => navigate(-1)} className="min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={locked || !anchor} onClick={() => navigate("today")} className="min-h-[40px] md:min-h-0">
              Today
            </Button>
            <Button type="button" size="icon" variant="ghost" aria-label={`Next ${view}`} disabled={locked || !nextAnchor} onClick={() => navigate(1)} className="min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0">
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <h2 className="text-sm font-semibold text-fg break-words" aria-live="polite">
            {heading}
          </h2>
          {timeZone ? (
            <p className="ml-auto text-[12px] text-faint break-words" data-testid="calendar-time-zone">
              Today is based on your time zone: {timeZone}. Due dates are whole calendar days.
            </p>
          ) : null}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 text-[12px] min-w-0">
          {accountsMode && workspaces.length > 0 ? (
            <label className="flex flex-col gap-1 text-muted min-w-0 w-full sm:w-auto">
              Workspace
              <select
                aria-label="Workspace"
                className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg min-h-[40px] md:min-h-0"
                value={workspaceId}
                disabled={locked || Boolean(pending)}
                onChange={(e) => changeWorkspace(e.target.value)}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-muted min-w-0 w-full sm:w-auto">
            Project
            <select
              aria-label="Project"
              className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg min-h-[40px] md:min-h-0"
              value={filters.projectId}
              disabled={locked}
              onChange={(e) => setFilters((f) => ({ ...f, projectId: e.target.value }))}
            >
              <option value="">All projects</option>
              {pickedProject && !options?.projects.some((p) => p.id === pickedProject.id) ? (
                <option value={pickedProject.id}>{pickedProject.name}</option>
              ) : null}
              {(options?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {options?.projectsTruncated ? (
            <FilterSearch
              workspaceId={workspaceId}
              type="projects"
              noun="projects"
              disabled={locked}
              onSelect={(project) => {
                setPickedProject(project);
                setFilters((f) => ({ ...f, projectId: project.id }));
              }}
            />
          ) : null}
          {accountsMode ? (
            <label className="flex flex-col gap-1 text-muted min-w-0 w-full sm:w-auto">
              Assignee
              <select
                aria-label="Assignee"
                className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg min-h-[40px] md:min-h-0"
                value={filters.assignee}
                disabled={locked}
                onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
              >
                <option value="">Anyone</option>
                <option value="me">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
                {pickedMember && !options?.members.some((m) => m.id === pickedMember.id) ? (
                  <option value={pickedMember.id}>{pickedMember.name}</option>
                ) : null}
                {(options?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? "Unnamed member"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {accountsMode && options?.membersTruncated ? (
            <FilterSearch
              workspaceId={workspaceId}
              type="members"
              noun="members"
              disabled={locked}
              onSelect={(member) => {
                setPickedMember(member);
                setFilters((f) => ({ ...f, assignee: member.id }));
              }}
            />
          ) : null}
          <label className="flex flex-col gap-1 text-muted min-w-0 w-full sm:w-auto">
            Status
            <select
              aria-label="Status"
              className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg min-h-[40px] md:min-h-0"
              value={filters.status}
              disabled={locked}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
            >
              <option value="all">Any status</option>
              <option value="open">Open</option>
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-muted min-w-0 w-full sm:w-auto">
            Show
            <select
              aria-label="Show"
              className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg min-h-[40px] md:min-h-0"
              value={filters.kind}
              disabled={locked}
              onChange={(e) => setFilters((f) => ({ ...f, kind: e.target.value }))}
            >
              <option value="all">Tasks and milestones</option>
              <option value="tasks">Tasks only</option>
              <option value="milestones">Milestones only</option>
            </select>
          </label>
        </div>

        {/* Filter lists are bounded; say so rather than silently hiding options. */}
        {options?.projectsTruncated || (accountsMode && options?.membersTruncated) ? (
          <div role="note" data-testid="calendar-filter-truncated" className="space-y-0.5 text-[12px] text-amber-400 break-words min-w-0">
            {options.projectsTruncated ? (
              <p>
                The project list shows the first {options.projectLimit.toLocaleString("en-US")} projects (A–Z). Use Search
                projects to filter by any other project.
              </p>
            ) : null}
            {accountsMode && options.membersTruncated ? (
              <p>
                The assignee list shows the first {options.memberLimit.toLocaleString("en-US")} active members (A–Z). Use
                Search members to filter by any other member.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Pending change / save errors / notices */}
        {pending ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--accent)] bg-[var(--bg-subtle)] px-3 py-2 text-[13px] min-w-0"
          >
            <span className="font-medium text-fg break-words">
              Pending: move “{pending.item.title}” from {shortLabel(pending.fromDate)} to {shortLabel(pending.toDate)}.
            </span>
            <span className="ml-auto flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="primary" disabled={saving} onClick={() => persist(pending)} className="min-h-[40px] md:min-h-0">
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setPending(null)} className="min-h-[40px] md:min-h-0">
                Cancel
              </Button>
            </span>
          </div>
        ) : null}
        {saveError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-400 min-w-0">
            <span className="break-words">
              Couldn’t reschedule “{saveError.change.item.title}”: {saveError.message} It is still due{" "}
              {shortLabel(saveError.change.fromDate)}.
            </span>
            <span className="ml-auto flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setPending(saveError.change);
                  void persist(saveError.change);
                }}
                className="min-h-[40px] md:min-h-0"
              >
                Retry
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSaveError(null)} className="min-h-[40px] md:min-h-0">
                Dismiss
              </Button>
            </span>
          </div>
        ) : null}
        <p role="status" aria-live="polite" className="text-[12px] text-muted break-words">
          {notice}
        </p>

        {/* Grid */}
        {!visible || !current ? (
          <p role="status" aria-busy="true" className="rounded-lg border border-line px-4 py-10 text-center text-[13px] text-muted break-words">
            Loading calendar…
          </p>
        ) : current?.error ? (
          <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-line px-4 py-10 text-center min-w-0">
            <p className="text-[13px] text-fg break-words">Couldn’t load the calendar.</p>
            <Button type="button" size="sm" onClick={() => setReloadToken((t) => t + 1)} className="min-h-[40px] md:min-h-0">
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-2 min-w-0">
            {current?.data?.truncated ? (
              <p className="text-[12px] text-amber-400 break-words">Showing the first 1,000 items in this range. Narrow the filters to see the rest.</p>
            ) : null}
            {current?.data && current.data.items.length === 0 && !pending ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-muted break-words">
                Nothing scheduled in this range.
              </p>
            ) : null}
            <div className="overflow-x-auto min-w-0">
              <div className="min-w-[640px] md:min-w-0">
                <div className="grid grid-cols-7 gap-px text-[11px] font-medium uppercase tracking-wide text-faint" aria-hidden="true">
                  {WEEKDAYS.map((d) => (
                    <div key={d} className="px-2 py-1">
                      {d}
                    </div>
                  ))}
                </div>
                <ol aria-label={`${heading} days`} className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-line bg-[var(--border)]">
                  {visible.days.map((day) => {
                    const items = byDay.get(day) ?? [];
                    const outside = view === "month" && parseDateOnly(day).month !== anchorMonth;
                    const isToday = day === today;
                    return (
                      <li
                        key={day}
                        data-day={day}
                        aria-label={`${dayLabel(day)}${isToday ? ", today" : ""}, ${items.length} item${items.length === 1 ? "" : "s"}`}
                        onDragOver={(e) => {
                          if (canReschedule && !locked) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          onDrop(day);
                        }}
                        className={cn(
                          "flex flex-col gap-1 bg-[var(--bg)] p-1.5 min-w-0",
                          view === "month" ? "min-h-28" : "min-h-72",
                          outside && "bg-[var(--bg-subtle)]/60",
                        )}
                      >
                        <span
                          className={cn(
                            "self-start rounded px-1 text-[12px] tabular-nums",
                            isToday ? "bg-[var(--accent)] font-semibold text-white" : outside ? "text-faint" : "text-muted",
                          )}
                        >
                          {parseDateOnly(day).day}
                          {isToday ? <span className="sr-only"> (today)</span> : null}
                        </span>
                        <ul className="flex flex-col gap-1 min-w-0">
                          {items.map((item) => (
                            <CalendarChip
                              key={keyOf(item)}
                              item={item}
                              pending={Boolean(item.pending)}
                              overdue={Boolean(today && item.date < today && !DONE.has(item.status) && !item.pending)}
                              canReschedule={canReschedule}
                              locked={locked || Boolean(pending && !item.pending)}
                              onDragStart={() => {
                                dragged.current = { item, date: item.pending ? (pending?.fromDate ?? null) : item.date };
                              }}
                              onReschedule={(el) =>
                                setEditing({ item, date: item.pending ? (pending?.fromDate ?? null) : item.date, returnFocus: el })
                              }
                            />
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Unscheduled panel */}
      <aside aria-labelledby="unscheduled-heading" className="space-y-2 min-w-0">
        <h2 id="unscheduled-heading" className="text-sm font-semibold text-fg break-words">
          Unscheduled tasks
        </h2>
        <p className="text-[12px] text-muted break-words">
          {canReschedule ? "Drag a task onto a day, or use Schedule." : "Tasks in this workspace without a due date."}
        </p>
        {!currentUnscheduled ? (
          <p role="status" aria-busy="true" className="text-[13px] text-muted break-words">
            Loading unscheduled tasks…
          </p>
        ) : currentUnscheduled.error ? (
          <div role="alert" className="space-y-2 text-[13px] min-w-0">
            <p className="text-fg break-words">Couldn’t load unscheduled tasks.</p>
            <Button type="button" size="sm" onClick={() => setReloadToken((t) => t + 1)} className="min-h-[40px] md:min-h-0">
              Retry
            </Button>
          </div>
        ) : currentUnscheduled.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted break-words">
            Every task has a due date.
          </p>
        ) : (
          <>
            <ul aria-label="Unscheduled tasks" className="space-y-1 min-w-0">
              {currentUnscheduled.items
                .filter((t) => !(pending && keyOf(pending.item) === keyOf(t)))
                .map((task) => (
                  <li
                    key={task.id}
                    draggable={canReschedule && !locked && !pending}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", keyOf(task));
                      dragged.current = { item: task, date: null };
                    }}
                    className="flex items-center gap-2 rounded-md border border-line bg-[var(--bg-subtle)]/40 px-2 py-1.5 text-[12px] min-w-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg">{task.title}</span>
                      <span className="block truncate text-faint">{task.projectName}</span>
                    </span>
                    {canReschedule ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={locked || Boolean(pending)}
                        aria-label={`Schedule ${task.title}`}
                        onClick={(e) => setEditing({ item: task, date: null, returnFocus: e.currentTarget })}
                        className="min-h-[40px] md:min-h-0"
                      >
                        Schedule
                      </Button>
                    ) : null}
                  </li>
                ))}
            </ul>
            {currentUnscheduled.nextCursor ? (
              <Button type="button" size="sm" variant="outline" disabled={loadingMore} onClick={loadMore} className="min-h-[40px] md:min-h-0">
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            ) : (
              <p className="text-[12px] text-faint break-words">End of unscheduled tasks</p>
            )}
          </>
        )}
      </aside>

      {editing ? (
        <RescheduleDialog
          title={editing.item.title}
          initialDate={editing.date ?? today ?? ""}
          saving={saving}
          onCancel={() => {
            const el = editing.returnFocus;
            setEditing(null);
            el?.focus();
          }}
          onSave={async (date) => {
            const change: PendingChange = { item: editing.item, fromDate: editing.date, toDate: date };
            const el = editing.returnFocus;
            setEditing(null);
            if (date === editing.date) return;
            setPending(change);
            await persist(change);
            el?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function CalendarChip({
  item,
  pending,
  overdue,
  canReschedule,
  locked,
  onDragStart,
  onReschedule,
}: {
  item: CalendarItem;
  pending: boolean;
  overdue: boolean;
  canReschedule: boolean;
  locked: boolean;
  onDragStart: () => void;
  onReschedule: (el: HTMLElement) => void;
}) {
  const isMilestone = item.kind === "milestone";
  return (
    <li
      data-item={`${item.kind}:${item.id}`}
      data-pending={pending ? "true" : undefined}
      draggable={canReschedule && !locked}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", `${item.kind}:${item.id}`);
        onDragStart();
      }}
      className={cn(
        "group rounded border px-1.5 py-1 text-[12px] leading-tight min-w-0",
        pending
          ? "border-dashed border-[var(--accent)] bg-[var(--bg-subtle)]"
          : isMilestone
            ? "border-[var(--border-strong)] bg-[var(--bg-elevated)]"
            : "border-line bg-[var(--bg-subtle)]/60",
        canReschedule && !locked && "cursor-grab",
      )}
    >
      <div className="flex items-start gap-1 min-w-0">
        {isMilestone ? (
          <Diamond className="mt-0.5 h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <CalendarDays className="mt-0.5 h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span className="sr-only">{isMilestone ? "Milestone: " : "Task: "}</span>
          <Link
            href={`/projects/${encodeURIComponent(item.projectId)}/tasks${isMilestone ? "" : `#task-${encodeURIComponent(item.id)}`}`}
            title={`${item.title} — ${item.projectName}`}
            className={cn(
              "line-clamp-2 break-words font-medium text-fg hover:underline",
              DONE.has(item.status) && "line-through opacity-70",
            )}
          >
            {item.title}
          </Link>
          <span className="block truncate text-[11px] text-faint">{item.projectName}</span>
          {pending ? <span className="text-[10px] font-semibold uppercase text-[var(--accent)]">Pending</span> : null}
          {overdue ? <span className="text-[10px] font-semibold uppercase text-red-400">Overdue</span> : null}
        </span>
      </div>
      {canReschedule && !pending ? (
        <button
          type="button"
          disabled={locked}
          onClick={(e) => onReschedule(e.currentTarget)}
          aria-label={`Reschedule ${item.title}`}
          className="mt-0.5 text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:underline disabled:opacity-50 min-h-[40px] md:min-h-0 flex items-center"
        >
          Reschedule
        </button>
      ) : null}
    </li>
  );
}
