/**
 * Readers for the usage files the AI-tool trackers already write (read-only).
 *
 * Every reader skips a missing, unreadable, oversized or unrecognised file
 * with a note in `warnings`; none of them throws.
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { parseCsv } from "./csv";

export type UsageTool = "claude-code" | "codex" | "antigravity";

export interface UsageRow {
  tool: UsageTool;
  machine: string;
  /** YYYY-MM-DD in the tracker's own (Pacific) day. */
  date: string;
  model: string;
  totalTokens: number;
  replies: number;
  /** API-equivalent USD, or null when the file does not carry it. */
  costUsd: number | null;
}

export interface ClaudeWeek {
  /** Raw tracker label, e.g. "2026-07-28 02:00 PT". Sorts chronologically. */
  weekStart: string;
  weekEnd: string;
  totalTokens: number;
  replies: number;
  costUsd: number | null;
  status: string;
  daysElapsed: number | null;
}

export interface CodexLimitWindow {
  usedPct: number | null;
  windowMin: number | null;
  /** ISO time or null. */
  resetsAt: string | null;
}

export interface CodexLimitsSnapshot {
  snapshotAt: string;
  fiveHour: CodexLimitWindow;
  weekly: CodexLimitWindow;
}

/** Minimal file access so tests can inject a fake. */
export interface UsageFs {
  /** Size and modified time, or null when the path is not a readable file. */
  stat(path: string): { size: number; mtimeMs: number } | null;
  readText(path: string): string;
}

export const nodeUsageFs: UsageFs = {
  stat(p) {
    try {
      const s = nodeFs.statSync(p);
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 200_000;

export const USAGE_FILES = {
  claudeDaily: "claude-code-usage-daily.csv",
  claudeWeekly: "claude-code-usage-weekly.csv",
  codexMac: "codex-usage-daily.csv",
  codexWindows: "tools/windows-pc-codex-daily.csv",
  antigravityWindows: "tools/windows-pc-antigravity-daily.csv",
  codexLimits: "tools/windows-pc-codex-limits.csv",
  windowsUpdated: "machines/windows-pc-updated.txt",
} as const;

export interface ReadResult<T> {
  data: T;
  warnings: string[];
  /** File modified time (ISO) when the file was read, else null. */
  mtime: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

interface LoadedCsv {
  rows: Record<string, string>[];
  mtime: string;
}

/** Read and parse one CSV, or return null and push a warning. */
function loadCsv(
  fs: UsageFs,
  file: string,
  required: string[],
  warnings: string[],
  label: string,
): LoadedCsv | null {
  const st = fs.stat(file);
  if (!st) {
    warnings.push(`${label}: file not found`);
    return null;
  }
  if (st.size > MAX_FILE_BYTES) {
    warnings.push(`${label}: file is larger than ${MAX_FILE_BYTES} bytes, skipped`);
    return null;
  }
  let text: string;
  try {
    text = fs.readText(file);
  } catch {
    warnings.push(`${label}: could not be read`);
    return null;
  }
  const parsed = parseCsv(text);
  const missing = required.filter((c) => !parsed.header.includes(c));
  if (missing.length > 0) {
    warnings.push(`${label}: unknown header, missing ${missing.join(", ")}`);
    return null;
  }
  let rows = parsed.rows;
  if (rows.length > MAX_ROWS) {
    warnings.push(`${label}: more than ${MAX_ROWS} rows, extra rows ignored`);
    rows = rows.slice(0, MAX_ROWS);
  }
  return { rows, mtime: new Date(st.mtimeMs).toISOString() };
}

interface DailySpec {
  tool: UsageTool;
  file: string;
  required: string[];
  /** Fixed machine name, or null to read the `machine` column. */
  machine: string | null;
  totalCol: string;
  repliesCol: string;
  costCol: string | null;
}

function readDaily(fs: UsageFs, folder: string, spec: DailySpec): ReadResult<UsageRow[]> {
  const warnings: string[] = [];
  const csv = loadCsv(
    fs,
    nodePath.join(folder, spec.file),
    spec.required,
    warnings,
    spec.file,
  );
  if (!csv) return { data: [], warnings, mtime: null };
  const out: UsageRow[] = [];
  let bad = 0;
  for (const r of csv.rows) {
    const date = (r["date"] ?? "").trim();
    const total = num(r[spec.totalCol]);
    const replies = num(r[spec.repliesCol]);
    if (!DATE_RE.test(date) || total === null || total < 0 || replies === null) {
      bad++;
      continue;
    }
    const machine = spec.machine ?? ((r["machine"] ?? "").trim() || "unknown");
    out.push({
      tool: spec.tool,
      machine,
      date,
      model: (r["model"] ?? "").trim() || "unknown",
      totalTokens: total,
      replies,
      costUsd: spec.costCol ? num(r[spec.costCol]) : null,
    });
  }
  if (bad > 0) warnings.push(`${spec.file}: skipped ${bad} bad row(s)`);
  return { data: out, warnings, mtime: csv.mtime };
}

export function readClaudeDaily(fs: UsageFs, folder: string): ReadResult<UsageRow[]> {
  return readDaily(fs, folder, {
    tool: "claude-code",
    file: USAGE_FILES.claudeDaily,
    required: ["machine", "date", "model", "total", "replies"],
    machine: null,
    totalCol: "total",
    repliesCol: "replies",
    costCol: "cost_usd",
  });
}

export function readCodexMac(fs: UsageFs, folder: string): ReadResult<UsageRow[]> {
  return readDaily(fs, folder, {
    tool: "codex",
    file: USAGE_FILES.codexMac,
    required: ["date", "model", "total_tokens", "responses"],
    machine: "mac",
    totalCol: "total_tokens",
    repliesCol: "responses",
    costCol: null,
  });
}

export function readCodexWindows(fs: UsageFs, folder: string): ReadResult<UsageRow[]> {
  return readDaily(fs, folder, {
    tool: "codex",
    file: USAGE_FILES.codexWindows,
    required: ["machine", "date", "model", "total", "replies"],
    machine: null,
    totalCol: "total",
    repliesCol: "replies",
    costCol: null,
  });
}

export function readAntigravityWindows(
  fs: UsageFs,
  folder: string,
): ReadResult<UsageRow[]> {
  return readDaily(fs, folder, {
    tool: "antigravity",
    file: USAGE_FILES.antigravityWindows,
    required: ["machine", "date", "model", "total", "replies"],
    machine: null,
    totalCol: "total",
    repliesCol: "replies",
    costCol: null,
  });
}

/** Only the ALL (total) rows, oldest first. */
export function readClaudeWeeks(fs: UsageFs, folder: string): ReadResult<ClaudeWeek[]> {
  const warnings: string[] = [];
  const label = USAGE_FILES.claudeWeekly;
  const csv = loadCsv(
    fs,
    nodePath.join(folder, label),
    ["week_start", "week_end", "model", "total", "status"],
    warnings,
    label,
  );
  if (!csv) return { data: [], warnings, mtime: null };
  const out: ClaudeWeek[] = [];
  let bad = 0;
  for (const r of csv.rows) {
    if ((r["model"] ?? "").trim() !== "ALL") continue;
    const weekStart = (r["week_start"] ?? "").trim();
    const total = num(r["total"]);
    if (weekStart === "" || total === null || total < 0) {
      bad++;
      continue;
    }
    out.push({
      weekStart,
      weekEnd: (r["week_end"] ?? "").trim(),
      totalTokens: total,
      replies: num(r["replies"]) ?? 0,
      costUsd: num(r["cost_usd"]),
      status: (r["status"] ?? "").trim(),
      daysElapsed: num(r["days_elapsed"]),
    });
  }
  if (bad > 0) warnings.push(`${label}: skipped ${bad} bad row(s)`);
  out.sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
  return { data: out, warnings, mtime: csv.mtime };
}

function isoOrNull(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (t === "") return null;
  return Number.isNaN(Date.parse(t)) ? null : t;
}

/** The newest snapshot row (by snapshot_at), or null. */
export function readCodexLimits(
  fs: UsageFs,
  folder: string,
): ReadResult<CodexLimitsSnapshot | null> {
  const warnings: string[] = [];
  const label = USAGE_FILES.codexLimits;
  const csv = loadCsv(
    fs,
    nodePath.join(folder, label),
    ["snapshot_at", "five_hour_used_pct", "weekly_used_pct"],
    warnings,
    label,
  );
  if (!csv) return { data: null, warnings, mtime: null };
  let best: { at: string; ms: number; row: Record<string, string> } | null = null;
  let bad = 0;
  for (const r of csv.rows) {
    const at = isoOrNull(r["snapshot_at"]);
    if (!at) {
      bad++;
      continue;
    }
    const ms = Date.parse(at);
    if (!best || ms > best.ms) best = { at, ms, row: r };
  }
  if (bad > 0) warnings.push(`${label}: skipped ${bad} bad row(s)`);
  if (!best) return { data: null, warnings, mtime: csv.mtime };
  const r = best.row;
  return {
    data: {
      snapshotAt: best.at,
      fiveHour: {
        usedPct: num(r["five_hour_used_pct"]),
        windowMin: num(r["five_hour_window_min"]),
        resetsAt: isoOrNull(r["five_hour_resets_at"]),
      },
      weekly: {
        usedPct: num(r["weekly_used_pct"]),
        windowMin: num(r["weekly_window_min"]),
        resetsAt: isoOrNull(r["weekly_resets_at"]),
      },
    },
    warnings,
    mtime: csv.mtime,
  };
}

/** Newest ISO line in machines/windows-pc-updated.txt, or null. */
export function readWindowsUpdated(fs: UsageFs, folder: string): string | null {
  const file = nodePath.join(folder, USAGE_FILES.windowsUpdated);
  const st = fs.stat(file);
  if (!st || st.size > MAX_FILE_BYTES) return null;
  try {
    let best: string | null = null;
    let bestMs = -Infinity;
    for (const line of fs.readText(file).split(/\r?\n/)) {
      const t = line.trim();
      if (t === "" || t === "updated") continue;
      const ms = Date.parse(t);
      if (!Number.isNaN(ms) && ms > bestMs) {
        best = new Date(ms).toISOString();
        bestMs = ms;
      }
    }
    return best;
  } catch {
    return null;
  }
}
