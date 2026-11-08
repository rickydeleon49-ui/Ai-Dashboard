/** Pure display helpers for the usage page and sidebar. No clock: callers pass `now`. */
import type { UsageTotals, WeekUsage } from "@/core/usage/summary";

export type BarLevel = "ok" | "warn" | "danger";

/** 2.4 B, 851 K, 12 M; small numbers stay whole. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const v = n / size;
      const text = Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "");
      return `${text} ${suffix}`;
    }
  }
  return Math.round(n).toString();
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

/** "12 min ago", "3 h ago", "2 d ago". */
export function formatRelative(iso: string | null, now: Date): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.floor((now.getTime() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "2 h 10 min", "45 min", "3 d 4 h"; null when unknown or already passed. */
export function formatCountdown(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.ceil((t - now.getTime()) / 60_000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem > 0 ? `${hours} h ${rem} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days} d ${h} h` : `${days} d`;
}

/** Whole-percent change from `previous` to `current`; null when there is no baseline. */
export function trendPct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** amber at 75 %, red at 90 %. */
export function barLevel(pct: number): BarLevel {
  if (pct >= 90) return "danger";
  if (pct >= 75) return "warn";
  return "ok";
}

export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/**
 * "On pace for X% of last week": this week's use per elapsed day, scaled to
 * seven days, compared with last week's total. Uses cost when both weeks have
 * it, otherwise tokens. null when there is nothing to compare.
 */
export function pacePct(
  thisWeek: Pick<WeekUsage, "tokens" | "costUsd" | "daysElapsed"> | null,
  lastWeek: Pick<UsageTotals, "tokens" | "costUsd"> | null,
): number | null {
  if (!thisWeek || !lastWeek) return null;
  const days = thisWeek.daysElapsed;
  if (days === null || !(days > 0)) return null;
  const useCost = thisWeek.costUsd !== null && lastWeek.costUsd !== null;
  const cur = useCost ? (thisWeek.costUsd ?? 0) : thisWeek.tokens;
  const prev = useCost ? (lastWeek.costUsd ?? 0) : lastWeek.tokens;
  if (!(prev > 0)) return null;
  return Math.round((((cur / days) * 7) / prev) * 100);
}
