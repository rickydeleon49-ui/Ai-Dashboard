/**
 * Pure maths over the normalised usage rows. No file access, no clock: the
 * caller passes `now`.
 *
 * Periods (decision): "today" is the current calendar day in `timeZone`
 * (default Pacific, the trackers' own day). "Last 7 days" is today and the six
 * days before it; "previous 7" is the seven days before that. These are the
 * same for every tool. Claude Code additionally carries the tracker's own
 * Tuesday 02:00 PT weeks (`thisWeek` / `lastWeek`, from the weekly ALL rows);
 * the other tools have no such rows, so they use last 7 vs previous 7 only.
 */
import type {
  ClaudeWeek,
  CodexLimitsSnapshot,
  UsageRow,
  UsageTool,
} from "./sources";

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
/** A source whose file has not changed for this long is flagged stale. */
export const SOURCE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const TOP_MODEL_DAYS = 30;
const TOP_MODEL_COUNT = 5;

export const USAGE_TOOLS: UsageTool[] = ["claude-code", "codex", "antigravity"];

export interface SourceFreshness {
  tool: UsageTool | "codex-limits";
  file: string;
  /** ISO time of the newest sign of life (file mtime or tracker stamp), or null. */
  updatedAt: string | null;
}

export interface UsageTotals {
  tokens: number;
  replies: number;
  /** null when no row in the period carries a cost. */
  costUsd: number | null;
}

export interface MachineUsage extends UsageTotals {
  machine: string;
}

export interface ModelUsage extends UsageTotals {
  model: string;
}

export interface WeekUsage extends UsageTotals {
  weekStart: string;
  weekEnd: string;
  status: string;
  daysElapsed: number | null;
}

export interface ToolUsage {
  tool: UsageTool;
  /** True when at least one row exists for this tool. */
  hasData: boolean;
  today: UsageTotals;
  last7Days: UsageTotals;
  previous7Days: UsageTotals;
  /** Claude Code only (tracker weeks); null for the other tools. */
  thisWeek: WeekUsage | null;
  lastWeek: WeekUsage | null;
  /** Last 7 days, biggest first. */
  byMachine: MachineUsage[];
  /** Last 30 days, biggest first, top 5. */
  topModels: ModelUsage[];
  updatedAt: string | null;
  stale: boolean;
}

export interface LimitWindowSummary {
  usedPct: number | null;
  windowMin: number | null;
  resetsAt: string | null;
  /** Snapshot older than its window, or its reset time has passed. */
  stale: boolean;
}

export interface CodexLimitsSummary {
  snapshotAt: string;
  fiveHour: LimitWindowSummary;
  weekly: LimitWindowSummary;
  stale: boolean;
}

export interface UsageSummary {
  generatedAt: string;
  timeZone: string;
  today: string;
  tools: ToolUsage[];
  codexLimits: CodexLimitsSummary | null;
  sources: Array<SourceFreshness & { stale: boolean }>;
}

/** YYYY-MM-DD of `now` in `timeZone`. */
export function dayInZone(now: Date, timeZone: string): string {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = DEFAULT_TIME_ZONE;
  }
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

interface Acc {
  tokens: number;
  replies: number;
  cost: number;
  hasCost: boolean;
}

function newAcc(): Acc {
  return { tokens: 0, replies: 0, cost: 0, hasCost: false };
}

function add(acc: Acc, row: UsageRow): void {
  acc.tokens += row.totalTokens;
  acc.replies += row.replies;
  if (row.costUsd !== null) {
    acc.cost += row.costUsd;
    acc.hasCost = true;
  }
}

function totals(acc: Acc): UsageTotals {
  return {
    tokens: acc.tokens,
    replies: acc.replies,
    costUsd: acc.hasCost ? Math.round(acc.cost * 10_000) / 10_000 : null,
  };
}

function sortedBySize<T extends { tokens: number }>(items: T[]): T[] {
  return items.sort((a, b) => b.tokens - a.tokens);
}

function weekUsage(w: ClaudeWeek): WeekUsage {
  return {
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
    status: w.status,
    daysElapsed: w.daysElapsed,
    tokens: w.totalTokens,
    replies: w.replies,
    costUsd: w.costUsd,
  };
}

function summarizeLimitWindow(
  w: CodexLimitsSnapshot["fiveHour"],
  snapshotMs: number,
  nowMs: number,
): LimitWindowSummary {
  const olderThanWindow =
    w.windowMin !== null && nowMs - snapshotMs > w.windowMin * 60_000;
  const resetPassed = w.resetsAt !== null && Date.parse(w.resetsAt) <= nowMs;
  return {
    usedPct: w.usedPct,
    windowMin: w.windowMin,
    resetsAt: w.resetsAt,
    stale: olderThanWindow || resetPassed,
  };
}

export function summarizeLimits(
  limits: CodexLimitsSnapshot | null,
  now: Date,
): CodexLimitsSummary | null {
  if (!limits) return null;
  const snapshotMs = Date.parse(limits.snapshotAt);
  const nowMs = now.getTime();
  const fiveHour = summarizeLimitWindow(limits.fiveHour, snapshotMs, nowMs);
  const weekly = summarizeLimitWindow(limits.weekly, snapshotMs, nowMs);
  return {
    snapshotAt: limits.snapshotAt,
    fiveHour,
    weekly,
    stale: fiveHour.stale || weekly.stale,
  };
}

function newestIso(values: Array<string | null>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isNaN(ms) && ms > bestMs) {
      best = v;
      bestMs = ms;
    }
  }
  return best;
}

function isStale(updatedAt: string | null, nowMs: number): boolean {
  if (!updatedAt) return true;
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) || nowMs - ms > SOURCE_STALE_AFTER_MS;
}

export function summarizeUsage(
  rows: UsageRow[],
  weeks: ClaudeWeek[],
  limits: CodexLimitsSnapshot | null,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
  sources: SourceFreshness[] = [],
): UsageSummary {
  const today = dayInZone(now, timeZone);
  const last7From = addDays(today, -6);
  const prev7From = addDays(today, -13);
  const prev7To = addDays(today, -7);
  const modelsFrom = addDays(today, -(TOP_MODEL_DAYS - 1));
  const nowMs = now.getTime();

  const tools: ToolUsage[] = USAGE_TOOLS.map((tool) => {
    const todayAcc = newAcc();
    const last7 = newAcc();
    const prev7 = newAcc();
    const machines = new Map<string, Acc>();
    const models = new Map<string, Acc>();
    let hasData = false;

    for (const row of rows) {
      if (row.tool !== tool) continue;
      hasData = true;
      if (row.date === today) add(todayAcc, row);
      if (row.date >= last7From && row.date <= today) {
        add(last7, row);
        const m = machines.get(row.machine) ?? newAcc();
        add(m, row);
        machines.set(row.machine, m);
      }
      if (row.date >= prev7From && row.date <= prev7To) add(prev7, row);
      if (row.date >= modelsFrom && row.date <= today) {
        const m = models.get(row.model) ?? newAcc();
        add(m, row);
        models.set(row.model, m);
      }
    }

    let thisWeek: WeekUsage | null = null;
    let lastWeek: WeekUsage | null = null;
    if (tool === "claude-code" && weeks.length > 0) {
      // Weeks arrive oldest first; the newest is "this week".
      const sorted = [...weeks].sort((a, b) =>
        a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0,
      );
      const cur = sorted[sorted.length - 1];
      const prev = sorted[sorted.length - 2];
      thisWeek = cur ? weekUsage(cur) : null;
      lastWeek = prev ? weekUsage(prev) : null;
    }

    const toolSources = sources.filter((s) => s.tool === tool);
    const updatedAt = newestIso(toolSources.map((s) => s.updatedAt));

    return {
      tool,
      hasData,
      today: totals(todayAcc),
      last7Days: totals(last7),
      previous7Days: totals(prev7),
      thisWeek,
      lastWeek,
      byMachine: sortedBySize(
        [...machines].map(([machine, a]) => ({ machine, ...totals(a) })),
      ),
      topModels: sortedBySize(
        [...models].map(([model, a]) => ({ model, ...totals(a) })),
      ).slice(0, TOP_MODEL_COUNT),
      updatedAt,
      stale: isStale(updatedAt, nowMs),
    };
  });

  return {
    generatedAt: now.toISOString(),
    timeZone,
    today,
    tools,
    codexLimits: summarizeLimits(limits, now),
    sources: sources.map((s) => ({ ...s, stale: isStale(s.updatedAt, nowMs) })),
  };
}
