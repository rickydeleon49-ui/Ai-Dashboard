/**
 * Pure logic for the run pages (AW1-13): event to terminal-line formatting,
 * seq dedupe / reconnect state, agent filter, and the views derived from the
 * event log. No React and no DOM, so it is unit-testable.
 *
 * Event payload text arrives already redacted (events.ts runs redactValue
 * before storing); nothing here adds data that was not in the event.
 */
import { RUN_STAGES, EVENT_AGENTS, isTerminalStatus } from "@/core/agents/types";

export interface UiEvent {
  runId: string;
  seq: number;
  ts: string;
  stage: string | null;
  agent: string;
  kind: string;
  payload: unknown;
}

export const MAX_UI_EVENTS = 5000;
export const MAX_FALLBACK_LINES = 2000;

export type AgentFilter = "all" | (typeof EVENT_AGENTS)[number];

/* ---------------------------- parsing ---------------------------- */

/** Parses one SSE `data:` string into an event, or null if it is not one. */
export function parseEventData(data: string): UiEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 1) return null;
  if (typeof r.kind !== "string" || typeof r.agent !== "string") return null;
  return {
    runId: typeof r.runId === "string" ? r.runId : "",
    seq: r.seq,
    ts: typeof r.ts === "string" ? r.ts : "",
    stage: typeof r.stage === "string" ? r.stage : null,
    agent: r.agent,
    kind: r.kind,
    payload: r.payload ?? null,
  };
}

/* ----------------------- dedupe / reconnect ---------------------- */

export interface StreamState {
  events: UiEvent[];
  /** Highest seq accepted; the Last-Event-ID to resume from. */
  lastSeen: number;
}

export const emptyStreamState: StreamState = { events: [], lastSeen: 0 };

/**
 * Accepts an event only if its seq is above lastSeen (replay after a
 * reconnect re-sends nothing we already have). Keeps at most MAX_UI_EVENTS.
 * Returns the same state object when the event is discarded.
 */
export function acceptEvent(state: StreamState, event: UiEvent): StreamState {
  if (event.seq <= state.lastSeen) return state;
  const events = [...state.events, event];
  const trimmed = events.length > MAX_UI_EVENTS ? events.slice(events.length - MAX_UI_EVENTS) : events;
  return { events: trimmed, lastSeen: event.seq };
}

/** URL to (re)open the stream from; `after` mirrors Last-Event-ID for manual reconnects. */
export function eventsUrl(runId: string, lastSeen: number): string {
  const base = `/api/agent-runs/${encodeURIComponent(runId)}/events`;
  return lastSeen > 0 ? `${base}?after=${lastSeen}` : base;
}

/* --------------------------- filtering --------------------------- */

export function filterByAgent(events: UiEvent[], agent: AgentFilter): UiEvent[] {
  return agent === "all" ? events : events.filter((e) => e.agent === agent);
}

/* ------------------------ terminal lines ------------------------- */

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
}

function oneLine(v: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  } catch {
    s = String(v);
  }
  s = s.replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Plain-text lines for an event (no colour codes). Used for the accessible
 * fallback log and as the base for the terminal lines.
 */
export function eventPlainLines(event: UiEvent): string[] {
  const p = obj(event.payload);
  const tag = `[${event.agent}]`;
  switch (event.kind) {
    case "output": {
      if (typeof event.payload === "string") return splitLines(event.payload).map((l) => `${tag} ${l}`);
      const text = str(p.text);
      if (text) return splitLines(text).map((l) => `${tag} ${l}`);
      if (p.final === true) return [`${tag} finished (${str(p.subtype) || "result"})`];
      if (p.sessionId || p.model) return [`${tag} session started${p.model ? ` (${oneLine(p.model)})` : ""}`];
      return [];
    }
    case "stage_started":
      return [`== stage ${event.stage ?? str(p.stage)} started`];
    case "stage_finished":
      return [`== stage ${event.stage ?? str(p.stage)} finished`];
    case "status_changed":
      return [`-- status: ${str(p.status)}${p.stage ? ` (${str(p.stage)})` : ""}`];
    case "tool_call":
      return [`${tag} tool: ${str(p.name) || "?"} ${oneLine(p.input, 160)}`];
    case "tool_result":
      return [`${tag} tool result${p.isError ? " (error)" : ""}: ${oneLine(p.content, 160)}`];
    case "check_result": {
      const code = p.exitCode === null || p.exitCode === undefined ? "none" : String(p.exitCode);
      const head = `${tag} check ${str(p.name)}: ${p.timedOut ? "timed out" : `exit ${code}`}`;
      const out = str(p.output);
      return out ? [head, ...splitLines(out).map((l) => `  ${l}`)] : [head];
    }
    case "diff_summary": {
      const t = obj(p.totals);
      return [`${tag} diff: ${String(t.files ?? 0)} file(s), +${String(t.additions ?? 0)} -${String(t.deletions ?? 0)}`];
    }
    case "review": {
      const findings = Array.isArray(p.findings) ? p.findings : [];
      const lines = [`${tag} review: ${str(p.verdict) || "?"} (${findings.length} finding(s))`];
      for (const f of findings) {
        const fo = obj(f);
        const where = fo.path ? ` ${str(fo.path)}${fo.line ? `:${String(fo.line)}` : ""}` : "";
        lines.push(`  ${str(fo.severity)}${where} ${oneLine(fo.message, 300)}`);
      }
      return lines;
    }
    case "error":
      return [`${tag} ERROR: ${str(p.message) || oneLine(event.payload)}`];
    case "warning":
      return [`${tag} warning: ${str(p.message) || oneLine(event.payload)}`];
    default:
      return [`${tag} ${event.kind}: ${oneLine(event.payload)}`];
  }
}

function colourFor(event: UiEvent): string {
  switch (event.kind) {
    case "error":
      return ANSI.red;
    case "warning":
      return ANSI.yellow;
    case "stage_started":
    case "stage_finished":
    case "status_changed":
      return ANSI.cyan;
    case "check_result":
    case "review":
    case "diff_summary":
      return ANSI.green;
    case "tool_call":
    case "tool_result":
      return ANSI.dim;
    default:
      return "";
  }
}

/** Removes raw control bytes (including ESC) so agent text cannot drive the terminal; keeps tab. */
function stripControls(s: string): string {
  // C1 controls too: xterm treats U+009B as CSI and U+009D as OSC.
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/**
 * Lines to write to xterm for an event. Payload text is written as-is except
 * that control bytes are removed, so agent output cannot move the cursor or
 * inject sequences; only our own colour codes wrap each line.
 */
export function eventTerminalLines(event: UiEvent): string[] {
  const colour = colourFor(event);
  return eventPlainLines(event).map((line) => {
    const clean = stripControls(line);
    return colour ? `${colour}${clean}${ANSI.reset}` : clean;
  });
}

/** Terminal text for a list of events, CRLF-terminated (xterm needs \r\n). */
export function eventsToTerminalText(events: UiEvent[]): string {
  return events
    .flatMap(eventTerminalLines)
    .map((l) => `${l}\r\n`)
    .join("");
}

/** Plain text for the accessible log / copy button, bounded to the last lines. */
export function eventsToPlainText(events: UiEvent[], maxLines = MAX_FALLBACK_LINES): string {
  const lines = events.flatMap(eventPlainLines).map(stripControls);
  const kept = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  return kept.join("\n");
}

/* ------------------------- derived views ------------------------- */

export type StageState = "pending" | "running" | "done";

export function deriveTimeline(events: UiEvent[]): Array<{ stage: string; state: StageState }> {
  const started = new Set<string>();
  const finished = new Set<string>();
  for (const e of events) {
    if (!e.stage) continue;
    if (e.kind === "stage_finished") finished.add(e.stage);
    else started.add(e.stage);
  }
  // Any stage before a later started stage has been passed.
  let lastStarted = -1;
  RUN_STAGES.forEach((s, i) => {
    if (started.has(s) || finished.has(s)) lastStarted = i;
  });
  return RUN_STAGES.map((stage, i) => {
    if (finished.has(stage) || i < lastStarted) return { stage, state: "done" as const };
    if (started.has(stage)) return { stage, state: "running" as const };
    return { stage, state: "pending" as const };
  });
}

export interface CheckView {
  name: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  output: string;
}

export function deriveChecks(events: UiEvent[]): CheckView[] {
  const out: CheckView[] = [];
  for (const e of events) {
    if (e.kind !== "check_result") continue;
    const p = obj(e.payload);
    out.push({
      name: str(p.name) || "(unnamed)",
      exitCode: typeof p.exitCode === "number" ? p.exitCode : null,
      timedOut: p.timedOut === true,
      durationMs: typeof p.durationMs === "number" ? p.durationMs : null,
      output: str(p.output),
    });
  }
  return out;
}

export interface DiffFileView {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  outOfScope: boolean;
  excluded: boolean;
}

export interface DiffView {
  files: DiffFileView[];
  totals: { files: number; additions: number; deletions: number };
}

/** The latest diff_summary event, or null. */
export function deriveDiff(events: UiEvent[]): DiffView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.kind !== "diff_summary") continue;
    const p = obj(e.payload);
    const files: DiffFileView[] = (Array.isArray(p.files) ? p.files : []).map((f) => {
      const fo = obj(f);
      return {
        path: str(fo.path),
        oldPath: typeof fo.oldPath === "string" ? fo.oldPath : undefined,
        status: str(fo.status) || "modified",
        additions: typeof fo.additions === "number" ? fo.additions : 0,
        deletions: typeof fo.deletions === "number" ? fo.deletions : 0,
        binary: fo.binary === true,
        outOfScope: fo.outOfScope === true,
        excluded: fo.excluded === true,
      };
    });
    const t = obj(p.totals);
    return {
      files,
      totals: {
        files: typeof t.files === "number" ? t.files : files.length,
        additions: typeof t.additions === "number" ? t.additions : 0,
        deletions: typeof t.deletions === "number" ? t.deletions : 0,
      },
    };
  }
  return null;
}

const STATUS_MARK: Record<string, string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

/** Plain-text diff overview for the `<pre>` block (the runner records a summary, not patch text). */
export function diffToText(diff: DiffView): string {
  if (diff.files.length === 0) return "No changes.";
  const lines = diff.files.map((f) => {
    const mark = STATUS_MARK[f.status] ?? "?";
    const name = f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path;
    const counts = f.binary ? "binary" : `+${f.additions} -${f.deletions}`;
    const flags = [f.excluded ? "EXCLUDED" : "", f.outOfScope ? "out of scope" : ""].filter(Boolean).join(", ");
    return `${mark}  ${name}  (${counts})${flags ? `  [${flags}]` : ""}`;
  });
  lines.push("", `${diff.totals.files} file(s), +${diff.totals.additions} -${diff.totals.deletions}`);
  return lines.join("\n");
}

export interface ReviewView {
  verdict: string;
  findings: Array<{ severity: string; path?: string; line?: number; message: string; actionable: boolean }>;
}

export function deriveReview(events: UiEvent[]): ReviewView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.kind !== "review") continue;
    const p = obj(e.payload);
    const findings = (Array.isArray(p.findings) ? p.findings : []).map((f) => {
      const fo = obj(f);
      return {
        severity: str(fo.severity),
        path: typeof fo.path === "string" ? fo.path : undefined,
        line: typeof fo.line === "number" ? fo.line : undefined,
        message: str(fo.message),
        actionable: fo.actionable === true,
      };
    });
    return { verdict: str(p.verdict), findings };
  }
  return null;
}

/** Latest status the event log reports, or null. */
export function deriveStatus(events: UiEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.kind === "status_changed") {
      const s = obj(e.payload).status;
      if (typeof s === "string") return s;
    }
  }
  return null;
}

export interface OutcomeView {
  status: string;
  facts: {
    implementerExitCode: number | null;
    diffFiles: number;
    excludedTouched: string[];
    checks: Array<{ name: string; exitCode: number | null; timedOut: boolean }>;
    reviewVerdict: string | null;
  };
  missing: string[];
  error?: string;
}

/** Narrows the stored run outcome (unknown JSON) into a view, or null. */
export function parseOutcome(raw: unknown): OutcomeView | null {
  const o = obj(raw);
  const f = obj(o.facts);
  if (typeof o.status !== "string" || !o.facts) return null;
  return {
    status: o.status,
    facts: {
      implementerExitCode: typeof f.implementerExitCode === "number" ? f.implementerExitCode : null,
      diffFiles: typeof f.diffFiles === "number" ? f.diffFiles : 0,
      excludedTouched: Array.isArray(f.excludedTouched)
        ? f.excludedTouched.filter((x): x is string => typeof x === "string")
        : [],
      checks: (Array.isArray(f.checks) ? f.checks : []).map((c) => {
        const co = obj(c);
        return {
          name: str(co.name),
          exitCode: typeof co.exitCode === "number" ? co.exitCode : null,
          timedOut: co.timedOut === true,
        };
      }),
      reviewVerdict: typeof f.reviewVerdict === "string" ? f.reviewVerdict : null,
    },
    missing: Array.isArray(o.missing) ? o.missing.filter((x): x is string => typeof x === "string") : [],
    error: typeof o.error === "string" ? o.error : undefined,
  };
}

export interface VerdictFact {
  label: string;
  ok: boolean;
  detail: string;
}

/** The three facts the runner decides on (design section 7). */
export function verdictFacts(outcome: OutcomeView, requiredChecks: string[]): VerdictFact[] {
  const { facts } = outcome;
  const diffOk = facts.diffFiles > 0 && facts.excludedTouched.length === 0;
  const failedChecks = requiredChecks.filter((name) => {
    const c = facts.checks.find((x) => x.name === name);
    return !c || c.timedOut || c.exitCode !== 0;
  });
  return [
    {
      label: "Non-empty diff, no excluded paths",
      ok: diffOk,
      detail:
        facts.diffFiles === 0
          ? "No changes were made"
          : facts.excludedTouched.length > 0
            ? `Excluded paths changed: ${facts.excludedTouched.join(", ")}`
            : `${facts.diffFiles} file(s) changed`,
    },
    {
      label: "Every required check passed",
      ok: failedChecks.length === 0,
      detail:
        requiredChecks.length === 0
          ? "No checks were required"
          : failedChecks.length === 0
            ? `${requiredChecks.length} check(s) passed`
            : `Failed or missing: ${failedChecks.join(", ")}`,
    },
    {
      label: "Reviewer approved",
      ok: facts.reviewVerdict === "approve",
      detail: facts.reviewVerdict ? facts.reviewVerdict.replace("_", " ") : "No valid review",
    },
  ];
}

export function isRunActive(status: string | null | undefined): boolean {
  return !!status && !isTerminalStatus(status);
}

/** Splits a free-text check list ("lint, typecheck") into names. */
export function parseCheckNames(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s, i, a) => s.length > 0 && a.indexOf(s) === i);
}
