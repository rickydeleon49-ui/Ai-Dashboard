/**
 * AI usage snapshot: reads the tracker CSVs (read-only) and summarises them.
 * Desktop only; the API route guards availability.
 */
import {
  DEFAULT_TIME_ZONE,
  summarizeUsage,
  type SourceFreshness,
  type UsageSummary,
} from "./summary";
import {
  USAGE_FILES,
  nodeUsageFs,
  readAntigravityWindows,
  readClaudeDaily,
  readClaudeWeeks,
  readCodexLimits,
  readCodexMac,
  readCodexWindows,
  readWindowsUpdated,
  type ClaudeWeek,
  type UsageFs,
  type UsageRow,
} from "./sources";

export * from "./summary";
export type { UsageRow, ClaudeWeek, UsageFs } from "./sources";

export interface UsageSnapshot extends UsageSummary {
  folder: string;
  /** Skipped files, bad rows and other notes. Never contains file contents. */
  warnings: string[];
}

export interface LoadUsageOptions {
  folder: string;
  now: Date;
  fs?: UsageFs;
  timeZone?: string;
}

function newest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function loadUsageSnapshot(opts: LoadUsageOptions): UsageSnapshot {
  const fs = opts.fs ?? nodeUsageFs;
  const folder = opts.folder;
  const warnings: string[] = [];

  const claudeDaily = readClaudeDaily(fs, folder);
  const claudeWeekly = readClaudeWeeks(fs, folder);
  const codexMac = readCodexMac(fs, folder);
  const codexWin = readCodexWindows(fs, folder);
  const agy = readAntigravityWindows(fs, folder);
  const limits = readCodexLimits(fs, folder);
  const winStamp = readWindowsUpdated(fs, folder);

  for (const r of [claudeDaily, claudeWeekly, codexMac, codexWin, agy, limits]) {
    warnings.push(...r.warnings);
  }

  const rows: UsageRow[] = [
    ...claudeDaily.data,
    ...codexMac.data,
    ...codexWin.data,
    ...agy.data,
  ];
  const weeks: ClaudeWeek[] = claudeWeekly.data;

  // The Windows trackers also stamp machines/windows-pc-updated.txt on every
  // run, which is a better sign of life than the CSV mtime when nothing changed.
  const winFresh = (mtime: string | null) => (mtime ? newest(mtime, winStamp) : null);

  const sources: SourceFreshness[] = [
    { tool: "claude-code", file: USAGE_FILES.claudeDaily, updatedAt: claudeDaily.mtime },
    { tool: "claude-code", file: USAGE_FILES.claudeWeekly, updatedAt: claudeWeekly.mtime },
    { tool: "codex", file: USAGE_FILES.codexMac, updatedAt: codexMac.mtime },
    { tool: "codex", file: USAGE_FILES.codexWindows, updatedAt: winFresh(codexWin.mtime) },
    { tool: "antigravity", file: USAGE_FILES.antigravityWindows, updatedAt: winFresh(agy.mtime) },
    { tool: "codex-limits", file: USAGE_FILES.codexLimits, updatedAt: winFresh(limits.mtime) },
  ];

  const summary = summarizeUsage(
    rows,
    weeks,
    limits.data,
    opts.now,
    opts.timeZone ?? DEFAULT_TIME_ZONE,
    sources,
  );
  return { ...summary, folder, warnings };
}

/* ------------------------------------------------------------------ */
/* Short in-memory cache so the page can poll                          */
/* ------------------------------------------------------------------ */

export const USAGE_CACHE_MS = 60_000;

let cached: { folder: string; at: number; snapshot: UsageSnapshot } | null = null;

export function loadUsageSnapshotCached(
  opts: LoadUsageOptions & { ttlMs?: number },
): UsageSnapshot {
  const ttl = opts.ttlMs ?? USAGE_CACHE_MS;
  const nowMs = opts.now.getTime();
  if (
    cached &&
    cached.folder === opts.folder &&
    nowMs - cached.at >= 0 &&
    nowMs - cached.at < ttl
  ) {
    return cached.snapshot;
  }
  const snapshot = loadUsageSnapshot(opts);
  cached = { folder: opts.folder, at: nowMs, snapshot };
  return snapshot;
}

export function clearUsageCache(): void {
  cached = null;
}
