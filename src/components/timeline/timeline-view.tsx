"use client";

/**
 * Release 2D.2 read-only project timeline (docs/design/2D.2-timeline.md).
 *
 * A fixed label column, a horizontally scrolling date grid with markers
 * placed on each item's date-only day, decorative dependency connectors, and
 * a table carrying the same facts as text. Loaded state is keyed by the
 * request it answers, and each load aborts the previous one, so neither
 * rapid navigation nor a workspace switch can show stale data.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Check, Circle, Diamond, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addDays, diffDays, formatDayLabel, todayInTimeZone, type DateOnly } from "@/core/calendar/dates";
import { isItemResolved } from "@/core/timeline/blocking";
import { shiftTimeline } from "@/core/timeline/range";
import type {
  TimelineConflict,
  TimelineItem,
  TimelineNode,
  TimelineResponse,
  TimelineTaskItem,
  TimelineZoom,
} from "@/core/timeline/types";
import { StaleTimelineError, TimelineRequestError, fetchTimeline } from "./timeline-api";

const noopSubscribe = () => () => {};
/** The browser's IANA zone. It decides only what "today" is (design note §3). */
function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    () => null,
  );
}

const DAY_WIDTH: Record<TimelineZoom, number> = { week: 96, month: 32, quarter: 12 };
const ROW_HEIGHT = 36;
const ZOOM_LABEL: Record<TimelineZoom, string> = { week: "Week", month: "Month", quarter: "Quarter" };
const CONFLICT_LABEL: Record<TimelineConflict, string> = {
  due_before_blocker: "Due before its blocker",
  due_after_milestone: "Due after its milestone",
};

function dayLabel(day: DateOnly, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) {
  return formatDayLabel(day, options);
}

function rangeTitle(zoom: TimelineZoom, from: DateOnly, to: DateOnly, anchor: DateOnly): string {
  if (zoom === "month") return dayLabel(anchor, { month: "long", year: "numeric" });
  if (zoom === "quarter") {
    const month = Number(anchor.slice(5, 7));
    return `Q${Math.floor((month - 1) / 3) + 1} ${anchor.slice(0, 4)}`;
  }
  return `${dayLabel(from, { month: "short", day: "numeric" })} – ${dayLabel(to)}`;
}

/** Text status: never colour alone (design note §11). */
function statusParts(item: TimelineItem, today: DateOnly): string[] {
  const parts: string[] = [];
  if (item.status === "done" || item.status === "completed") parts.push("Done");
  else if (item.status === "cancelled") parts.push("Cancelled");
  else if (item.status === "in_progress") parts.push("In progress");
  else parts.push("Open");
  if (item.kind === "task" && item.blocked) parts.push("Blocked");
  if (item.date !== null && item.date < today && !isItemResolved(item.kind, item.status)) parts.push("Overdue");
  return parts;
}

function StatusIcon({ item, today }: { item: TimelineItem; today: DateOnly }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (item.status === "done" || item.status === "completed") return <Check className={`${cls} text-emerald-400`} aria-hidden />;
  if (item.status === "cancelled") return <X className={`${cls} text-faint`} aria-hidden />;
  if (item.kind === "task" && item.blocked) return <Lock className={`${cls} text-amber-400`} aria-hidden />;
  if (item.date !== null && item.date < today) return <AlertTriangle className={`${cls} text-red-400`} aria-hidden />;
  return <Circle className={`${cls} text-muted`} aria-hidden />;
}

function itemHref(projectId: string, item: { kind: "task" | "milestone"; id: string }): string {
  const base = `/projects/${encodeURIComponent(projectId)}/tasks`;
  return item.kind === "task" ? `${base}#task-${encodeURIComponent(item.id)}` : base;
}

function nodeText(node: TimelineNode | undefined, id: string): string {
  if (!node) return "a task outside this view";
  const day = node.date ? `due ${dayLabel(node.date)}` : "no due date";
  const where = node.inProject ? "" : `, in ${node.projectName}`;
  return `${node.title} (${day}${where}${node.status === "done" ? ", done" : node.status === "cancelled" ? ", cancelled" : ""})`;
}

function blockingPathText(item: TimelineTaskItem, nodes: Record<string, TimelineNode>): string {
  if (!item.blocked) return "";
  const partial = item.blocking.complete ? "" : " (dependency explanation incomplete: the graph is too large to load in full)";
  if (item.blocking.roots.length === 0) return `Blocked by work outside the loaded dependency graph${partial}.`;
  // One chain per root, each read from this task outward.
  const parentOf = new Map(item.blocking.path.map(([from, to]) => [to, from]));
  return item.blocking.roots
    .map((root) => {
      const chain: string[] = [];
      let at: string | undefined = root;
      while (at && at !== item.id) {
        chain.unshift(nodes[at]?.title ?? "unknown task");
        at = parentOf.get(at);
      }
      return chain.join(" → ");
    })
    .join("; ") + partial;
}

type Loaded =
  | { key: string; data: TimelineResponse }
  | { key: string; error: "not_found" | "denied" | "failed"; message: string };

export function TimelineView({
  workspaceId,
  projectId,
  projectName,
  accountsMode,
}: {
  workspaceId: string;
  projectId: string;
  projectName: string;
  accountsMode: boolean;
}) {
  const timeZone = useBrowserTimeZone();
  const [zoom, setZoom] = useState<TimelineZoom>("month");
  const [anchorOverride, setAnchorOverride] = useState<DateOnly | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [showLines, setShowLines] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const browserToday = timeZone ? todayInTimeZone(timeZone) : null;
  const anchor = anchorOverride ?? browserToday;
  const key = anchor && timeZone ? `${workspaceId}|${projectId}|${zoom}|${anchor}|${timeZone}|${reloadToken}` : null;

  useEffect(() => {
    if (!key || !anchor || !timeZone) return;
    const controller = new AbortController();
    fetchTimeline({ workspaceId, projectId, zoom, anchor, timeZone }, controller.signal)
      .then((data) => setLoaded({ key, data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted || error instanceof StaleTimelineError) return;
        if (error instanceof TimelineRequestError && error.status === 404) {
          setLoaded({ key, error: "not_found", message: error.message });
        } else if (error instanceof TimelineRequestError && (error.status === 401 || error.status === 403)) {
          setLoaded({ key, error: "denied", message: error.message });
        } else if (error instanceof TimelineRequestError && error.status === 503) {
          setLoaded({ key, error: "failed", message: error.message });
        } else {
          setLoaded({ key, error: "failed", message: "Couldn’t load the timeline." });
        }
      });
    return () => controller.abort();
    // zoom, anchor and timeZone are fully captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId, key]);

  // Only a result for the CURRENT request is ever rendered.
  const current = loaded && loaded.key === key ? loaded : null;
  const data = current && "data" in current ? current.data : null;

  const previous = anchor ? shiftTimeline(zoom, anchor, -1) : null;
  const next = anchor ? shiftTimeline(zoom, anchor, 1) : null;

  return (
    <div className="space-y-4 min-w-0" data-testid="timeline">
      <div className="flex flex-wrap items-end gap-3 min-w-0">
        <div role="group" aria-label="Zoom" className="flex flex-wrap gap-1">
          {(["week", "month", "quarter"] as const).map((z) => (
            <Button
              key={z}
              type="button"
              size="sm"
              variant={z === zoom ? "primary" : "outline"}
              aria-pressed={z === zoom}
              className="min-h-[40px] md:min-h-0"
              onClick={() => setZoom(z)}
            >
              {ZOOM_LABEL[z]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Previous ${zoom}`}
            disabled={!previous}
            className="min-h-[40px] md:min-h-0"
            onClick={() => previous && setAnchorOverride(previous)}
          >
            Previous
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-[40px] md:min-h-0"
            onClick={() => setAnchorOverride(null)}
          >
            Today
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Next ${zoom}`}
            disabled={!next}
            className="min-h-[40px] md:min-h-0"
            onClick={() => next && setAnchorOverride(next)}
          >
            Next
          </Button>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted min-h-[40px] md:min-h-0 cursor-pointer">
          <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
          Show dependency lines
        </label>
        <h2 className="ml-auto text-sm font-semibold text-fg break-words" aria-live="polite" data-testid="timeline-range">
          {data ? rangeTitle(data.zoom, data.from, data.to, data.anchor) : ""}
        </h2>
      </div>
      <p className="text-[12px] text-faint break-words">
        Read-only. Tasks are shown on their due date; start dates are not recorded yet. Today is based on your time zone
        {timeZone ? `: ${timeZone}` : ""}.
      </p>

      {!current ? (
        <p role="status" className="text-[13px] text-muted">
          Loading timeline…
        </p>
      ) : "error" in current ? (
        current.error === "failed" ? (
          <div role="alert" className="flex items-center gap-3 text-[13px] text-red-400">
            {current.message}
            <Button type="button" size="sm" variant="outline" className="min-h-[40px] md:min-h-0" onClick={() => setReloadToken((t) => t + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <div role="alert" className="rounded-lg border border-line p-4 text-[13px] text-muted break-words" data-testid="timeline-unavailable">
            {current.error === "not_found"
              ? "This project isn’t available in your current workspace."
              : current.message}
          </div>
        )
      ) : (
        <TimelineBody
          data={current.data}
          today={browserToday ?? current.data.today}
          projectName={projectName}
          accountsMode={accountsMode}
          showLines={showLines}
          focusId={focusId}
          onFocusItem={setFocusId}
        />
      )}
    </div>
  );
}

function TimelineBody({
  data,
  today,
  projectName,
  accountsMode,
  showLines,
  focusId,
  onFocusItem,
}: {
  data: TimelineResponse;
  /** The browser's calendar date (design note §3) — the same "today" the Calendar uses. */
  today: DateOnly;
  projectName: string;
  accountsMode: boolean;
  showLines: boolean;
  focusId: string | null;
  onFocusItem: (id: string | null) => void;
}) {
  const days = useMemo(() => {
    const count = diffDays(data.from, data.to);
    return Array.from({ length: count + 1 }, (_, i) => addDays(data.from, i));
  }, [data.from, data.to]);
  const dayWidth = DAY_WIDTH[data.zoom];
  const gridWidth = days.length * dayWidth;
  const rowOf = new Map(data.items.map((item, i) => [item.id, i]));
  const xOf = (day: DateOnly) => diffDays(data.from, day) * dayWidth + dayWidth / 2;
  const assigneeName = new Map(data.assignees.map((a) => [a.id, a.name ?? "Unnamed member"]));
  const todayInRange = today >= data.from && today <= data.to;

  // Edges on any blocking path (and on the focused item's path) are emphasised.
  const pathEdges = new Set<string>();
  const focusEdges = new Set<string>();
  for (const item of [...data.items, ...data.undated]) {
    if (item.kind !== "task") continue;
    for (const [from, to] of item.blocking.path) {
      pathEdges.add(`${from}>${to}`);
      if (item.id === focusId) focusEdges.add(`${from}>${to}`);
    }
  }
  const drawn = data.edges.filter((e) => rowOf.has(e.taskId) && rowOf.has(e.dependsOnTaskId));

  const truncations = [
    data.truncated.tasks && `more than ${data.limits.tasks} tasks are due in this range`,
    data.truncated.milestones && `more than ${data.limits.milestones} milestones are due in this range`,
    data.truncated.undatedTasks && `more than ${data.limits.undatedTasks} tasks have no due date`,
    data.truncated.undatedMilestones && `more than ${data.limits.undatedMilestones} milestones have no target date`,
    data.truncated.edges &&
      `the dependency graph is larger than ${data.limits.edges} links, so some blocking explanations are incomplete (blocked status is still exact)`,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="space-y-5 min-w-0">
      {truncations.length > 0 ? (
        <div role="note" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200 break-words" data-testid="timeline-truncated">
          <p className="font-medium">Some work isn’t shown: {truncations.join("; ")}.</p>
          <p>Switch to a narrower zoom (Month or Week) to see everything in a shorter range.</p>
        </div>
      ) : null}

      {data.items.length === 0 ? (
        <p className="rounded-lg border border-line p-4 text-[13px] text-muted break-words" data-testid="timeline-empty">
          Nothing is scheduled in this range. Use Previous, Next or a wider zoom, or see the undated work below.
        </p>
      ) : (
        <div className="flex overflow-hidden rounded-lg border border-line min-w-0" data-testid="timeline-chart">
          <div className="w-56 shrink-0 border-r border-line bg-[var(--bg-elevated)]">
            <div className="flex h-12 items-end border-b border-line px-2 pb-1 text-[11px] font-medium text-faint">Item</div>
            <ul aria-label="Timeline items">
              {data.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-1.5 truncate border-b border-line/60 px-2 text-[12px]"
                  style={{ height: ROW_HEIGHT }}
                  onMouseEnter={() => onFocusItem(item.id)}
                  onMouseLeave={() => onFocusItem(null)}
                >
                  <StatusIcon item={item} today={today} />
                  <Link
                    href={itemHref(data.projectId, item)}
                    onFocus={() => onFocusItem(item.id)}
                    onBlur={() => onFocusItem(null)}
                    className={`truncate text-fg hover:underline ${item.status === "cancelled" ? "line-through text-faint" : ""}`}
                  >
                    {item.kind === "milestone" ? "Milestone: " : ""}
                    {item.title}
                  </Link>
                  <span className="sr-only">, {statusParts(item, today).join(", ")}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto" data-testid="timeline-scroll">
            <div className="relative" style={{ width: gridWidth }}>
              <TimeHeader days={days} zoom={data.zoom} dayWidth={dayWidth} />
              <div className="relative" style={{ height: data.items.length * ROW_HEIGHT }}>
                {todayInRange ? (
                  <div
                    aria-hidden
                    data-testid="timeline-today"
                    className="absolute inset-y-0 w-px bg-[var(--accent)]"
                    style={{ left: xOf(today) }}
                  />
                ) : null}
                {data.items.map((item, row) => (
                  <div
                    key={item.id}
                    className="absolute left-0 right-0 border-b border-line/40"
                    style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                  >
                    {item.date ? (
                      <Marker item={item} today={today} left={xOf(item.date)} />
                    ) : null}
                  </div>
                ))}
                {showLines && drawn.length > 0 ? (
                  <svg
                    aria-hidden
                    data-testid="timeline-lines"
                    className="pointer-events-none absolute inset-0"
                    width={gridWidth}
                    height={data.items.length * ROW_HEIGHT}
                  >
                    <defs>
                      <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                        <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                      </marker>
                    </defs>
                    {drawn.map((e) => {
                      const blocker = data.items[rowOf.get(e.dependsOnTaskId)!]!;
                      const dependent = data.items[rowOf.get(e.taskId)!]!;
                      const x1 = xOf(blocker.date!);
                      const y1 = rowOf.get(e.dependsOnTaskId)! * ROW_HEIGHT + ROW_HEIGHT / 2;
                      const x2 = xOf(dependent.date!);
                      const y2 = rowOf.get(e.taskId)! * ROW_HEIGHT + ROW_HEIGHT / 2;
                      const k = `${e.taskId}>${e.dependsOnTaskId}`;
                      const onPath = pathEdges.has(k);
                      const focused = focusEdges.has(k);
                      const bend = Math.max(16, Math.abs(x2 - x1) / 2);
                      return (
                        <path
                          key={k}
                          data-edge={k}
                          data-on-path={onPath ? "true" : "false"}
                          d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke="currentColor"
                          className={onPath ? "text-amber-400" : "text-faint"}
                          strokeWidth={focused ? 3 : onPath ? 2 : 1}
                          strokeDasharray={onPath ? undefined : "3 3"}
                          markerEnd="url(#tl-arrow)"
                        />
                      );
                    })}
                  </svg>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      <TimelineTable
        caption={`Timeline items from ${dayLabel(data.from)} to ${dayLabel(data.to)}`}
        testId="timeline-table"
        items={data.items}
        data={data}
        today={today}
        projectName={projectName}
        accountsMode={accountsMode}
        assigneeName={assigneeName}
      />

      <section aria-labelledby="timeline-undated" className="space-y-2" data-testid="timeline-undated">
        <h3 id="timeline-undated" className="text-sm font-semibold text-fg">
          Undated and partially dated work ({data.undated.length})
        </h3>
        {data.undated.length === 0 ? (
          <p className="text-[13px] text-muted">Every task and milestone in this project has a date.</p>
        ) : (
          <TimelineTable
            caption="Tasks without a due date and milestones without a target date"
            testId="timeline-undated-table"
            items={data.undated}
            data={data}
            today={today}
            projectName={projectName}
            accountsMode={accountsMode}
            assigneeName={assigneeName}
          />
        )}
      </section>
    </div>
  );
}

function TimeHeader({ days, zoom, dayWidth }: { days: DateOnly[]; zoom: TimelineZoom; dayWidth: number }) {
  // Month labels span their days; below them, day numbers (week/month) or week starts (quarter).
  const months: { label: string; start: number; count: number }[] = [];
  days.forEach((day, i) => {
    const label = dayLabel(day, { month: "short", year: "numeric" });
    const last = months[months.length - 1];
    if (last && last.label === label) last.count += 1;
    else months.push({ label, start: i, count: 1 });
  });
  return (
    <div className="sticky top-0 h-12 border-b border-line bg-[var(--bg-elevated)] text-[11px] text-faint" aria-hidden>
      <div className="relative h-6">
        {months.map((m) => (
          <span key={`${m.label}-${m.start}`} className="absolute truncate px-1 pt-1 font-medium" style={{ left: m.start * dayWidth, width: m.count * dayWidth }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="relative h-6">
        {days.map((day, i) =>
          zoom === "quarter" ? (
            i % 7 === 0 ? (
              <span key={day} className="absolute border-l border-line/60 pl-0.5" style={{ left: i * dayWidth, width: 7 * dayWidth }}>
                {dayLabel(day, { month: "short", day: "numeric" })}
              </span>
            ) : null
          ) : (
            <span key={day} className="absolute text-center" style={{ left: i * dayWidth, width: dayWidth }}>
              {zoom === "week" ? dayLabel(day, { weekday: "short", day: "numeric" }) : Number(day.slice(8, 10))}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function Marker({ item, today, left }: { item: TimelineItem; today: DateOnly; left: number }) {
  const resolved = isItemResolved(item.kind, item.status);
  const overdue = item.date !== null && item.date < today && !resolved;
  const blocked = item.kind === "task" && item.blocked;
  const tone = item.status === "cancelled"
    ? "border-faint text-faint"
    : resolved
      ? "border-emerald-400 bg-emerald-400/30 text-emerald-300"
      : blocked
        ? "border-amber-400 bg-amber-400/20 text-amber-300"
        : overdue
          ? "border-red-400 bg-red-400/20 text-red-300"
          : "border-[var(--accent)] bg-[var(--accent)]/30 text-fg";
  return (
    <div
      aria-hidden
      data-testid={`marker-${item.id}`}
      data-day={item.date ?? ""}
      className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center"
      style={{ left }}
    >
      {item.kind === "milestone" ? (
        <Diamond className={`h-4 w-4 ${tone.split(" ").filter((c) => c.startsWith("text-")).join(" ")}`} fill="currentColor" />
      ) : (
        <span className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${tone} ${item.status === "cancelled" ? "border-dashed" : ""}`}>
          {resolved && item.status !== "cancelled" ? <Check className="h-2.5 w-2.5" /> : null}
          {item.status === "cancelled" ? <X className="h-2.5 w-2.5" /> : null}
          {blocked && !resolved ? <Ban className="h-2.5 w-2.5" /> : null}
        </span>
      )}
    </div>
  );
}

function TimelineTable({
  caption,
  testId,
  items,
  data,
  today,
  projectName,
  accountsMode,
  assigneeName,
}: {
  caption: string;
  testId: string;
  items: TimelineItem[];
  data: TimelineResponse;
  today: DateOnly;
  projectName: string;
  accountsMode: boolean;
  assigneeName: Map<string, string>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-line min-w-0">
      <table className="w-full min-w-[720px] text-left text-[12px]" data-testid={testId}>
        <caption className="px-3 py-2 text-left text-[12px] font-medium text-muted">{caption}</caption>
        <thead className="border-b border-line text-faint">
          <tr>
            <th scope="col" className="px-3 py-1.5">Item</th>
            <th scope="col" className="px-3 py-1.5">Type</th>
            <th scope="col" className="px-3 py-1.5">Project</th>
            <th scope="col" className="px-3 py-1.5">Due / target</th>
            <th scope="col" className="px-3 py-1.5">Status</th>
            {accountsMode ? <th scope="col" className="px-3 py-1.5">Assignee</th> : null}
            <th scope="col" className="px-3 py-1.5">Blocked</th>
            <th scope="col" className="px-3 py-1.5">Immediate blockers</th>
            <th scope="col" className="px-3 py-1.5">Blocking path</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-line/60 align-top" data-row={item.id}>
              <th scope="row" className="px-3 py-1.5 font-normal">
                <Link href={itemHref(data.projectId, item)} className={`text-fg hover:underline min-h-[40px] md:min-h-0 inline-flex items-center ${item.status === "cancelled" ? "line-through" : ""}`}>
                  {item.title}
                </Link>
              </th>
              <td className="px-3 py-1.5">{item.kind === "task" ? "Task" : "Milestone"}</td>
              <td className="px-3 py-1.5">{projectName}</td>
              <td className="px-3 py-1.5">
                {item.date
                  ? dayLabel(item.date)
                  : item.kind === "task" && item.milestoneDate
                    ? `No due date — milestone target ${item.milestoneDate}`
                    : item.kind === "milestone"
                      ? "Milestone — no target date"
                      : "No due date"}
              </td>
              <td className="px-3 py-1.5">
                {statusParts(item, today).join(" · ")}
                {item.kind === "task" && item.conflicts.length > 0 ? (
                  <span className="block text-amber-300">{item.conflicts.map((c) => CONFLICT_LABEL[c]).join(" · ")}</span>
                ) : null}
              </td>
              {accountsMode ? (
                <td className="px-3 py-1.5">
                  {item.kind === "task" && item.assigneeId ? (assigneeName.get(item.assigneeId) ?? "Unknown member") : "—"}
                </td>
              ) : null}
              <td className="px-3 py-1.5">{item.kind === "task" ? (item.blocked ? "Yes" : "No") : "—"}</td>
              <td className="px-3 py-1.5">
                {item.kind === "task" && item.blocking.immediateBlockers.length > 0
                  ? item.blocking.immediateBlockers.map((id) => nodeText(data.nodes[id], id)).join("; ")
                  : "—"}
              </td>
              <td className="px-3 py-1.5">{item.kind === "task" && item.blocked ? blockingPathText(item, data.nodes) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
