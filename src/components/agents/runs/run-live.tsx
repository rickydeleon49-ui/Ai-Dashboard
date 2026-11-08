"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { EVENT_AGENTS, isTerminalStatus } from "@/core/agents/types";
import { commentRejectionReason } from "@/core/agents/comment-rules";
import type { SeverityClass } from "@/core/agents/severity";
import {
  groupComments,
  newFileLineNumbers,
  type RunComment,
} from "./comments-logic";
import { RunComments } from "./run-comments";
import { RunApprovals } from "./run-approvals";
import {
  availableRounds,
  checksForRound,
  derivePlan,
  diffForRound,
  diffPatchForRound,
  findingsBySeverity,
  reviewForRound,
  roundLabel,
  selectedRound,
  SEVERITY_ORDER,
} from "./rounds-logic";
import {
  acceptEvent,
  deriveStatus,
  deriveTimeline,
  diffToText,
  emptyStreamState,
  eventsToPlainText,
  eventsUrl,
  filterByAgent,
  parseEventData,
  parseOutcome,
  patchLines,
  verdictFacts,
  type AgentFilter,
  type DiffFileView,
  type DiffPatchFileView,
  type PatchLineKind,
  type StreamState,
} from "./logic";

const TerminalView = dynamic(() => import("./terminal-view"), {
  ssr: false,
  loading: () => <div className="h-80 rounded-md border border-line bg-[var(--bg-subtle)]" />,
});

const RECONNECT_MS = 2000;

const SEVERITY_BADGE: Record<SeverityClass, string> = {
  blocking: "text-red-400",
  major: "text-yellow-400",
  minor: "text-muted",
};

const PATCH_LINE_CLASS: Record<PatchLineKind, string> = {
  add: "text-green-400",
  del: "text-red-400",
  hunk: "text-muted",
  meta: "text-faint",
  ctx: "text-fg",
};

/** One file's patch in a collapsible block; the lines render only once opened (patches can be large). */
function PatchBlock({
  file,
  summary,
  commentsByLine,
  onSelectLine,
}: {
  file: DiffPatchFileView;
  summary: DiffFileView | undefined;
  commentsByLine?: Map<number | "file", RunComment[]>;
  onSelectLine?: (draft: { file: string; line: number | null }) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const name = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
  let note = "";
  if (file.patch === "") {
    if (summary?.binary) note = "Binary file";
    else if (summary?.excluded) note = "Excluded file — content hidden";
    else if (file.truncated) note = "Truncated — patch text left out (size limit)";
    else note = "No patch text.";
  }

  const lines = React.useMemo(() => (open && file.patch !== "" ? patchLines(file.patch) : []), [open, file.patch]);
  const lineNumbers = React.useMemo(
    () => (open && lines.length > 0 ? newFileLineNumbers(lines.map((l) => l.text)) : []),
    [open, lines],
  );

  return (
    <details
      className="rounded-md border border-line bg-[var(--bg-subtle)]"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer break-all px-2 py-1 text-[12px] text-fg">
        {name}
        {file.truncated && file.patch !== "" ? <span className="ml-2 text-faint">Truncated</span> : null}
      </summary>
      {open ? (
        note ? (
          <p className="px-2 pb-2 text-[12px] text-muted">{note}</p>
        ) : (
          <pre className="max-h-96 overflow-auto whitespace-pre px-2 pb-2 font-mono text-[12px]">
            {lines.map((l, i) => {
              const lineNum = lineNumbers[i] ?? null;
              const count = lineNum !== null ? commentsByLine?.get(lineNum)?.length ?? 0 : 0;
              const isClickable = lineNum !== null && Boolean(onSelectLine);
              return (
                <span
                  key={i}
                  className={`block ${PATCH_LINE_CLASS[l.kind]} ${
                    isClickable ? "cursor-pointer hover:bg-[var(--bg-hover)]" : ""
                  }`}
                  onClick={isClickable ? () => onSelectLine?.({ file: file.path, line: lineNum }) : undefined}
                >
                  <span className="inline-block w-10 select-none pr-2 text-right text-faint">
                    {lineNum !== null ? lineNum : ""}
                  </span>
                  <span>{l.text === "" ? " " : l.text}</span>
                  {count > 0 ? (
                    <span
                      className="ml-2 inline-flex items-center rounded bg-[var(--accent-soft)] px-1 text-[10px] font-semibold text-[var(--accent)] select-none"
                      title={`${count} comment${count === 1 ? "" : "s"}`}
                    >
                      {count}
                    </span>
                  ) : null}
                </span>
              );
            })}
            {file.truncated ? <span className="block text-faint">… Truncated</span> : null}
          </pre>
        )
      ) : null}
    </details>
  );
}

export interface RunLiveProps {
  runId: string;
  initialStatus: string;
  initialOutcome: unknown;
  requiredChecks: string[];
  /** False for AW.1 runs (no planner or reviewer): comments are never read. */
  hasReviewStage?: boolean;
}

export function RunLive({ runId, initialStatus, initialOutcome, requiredChecks, hasReviewStage = true }: RunLiveProps) {
  const [stream, setStream] = React.useState<StreamState>(emptyStreamState);
  const [filter, setFilter] = React.useState<AgentFilter>("all");
  const [outcomeRaw, setOutcomeRaw] = React.useState<unknown>(initialOutcome);
  const [connection, setConnection] = React.useState<"connecting" | "live" | "reconnecting" | "ended">("connecting");
  const [stopState, setStopState] = React.useState<"idle" | "sending" | "sent" | "error">("idle");
  const [stopError, setStopError] = React.useState<string | null>(null);
  const [resumeState, setResumeState] = React.useState<"idle" | "sending" | "sent" | "error">("idle");
  const [resumeError, setResumeError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [draft, setDraft] = React.useState<{ file: string; line: number | null } | null>(null);
  const [comments, setComments] = React.useState<RunComment[]>([]);
  const [pickedRound, setPickedRound] = React.useState<number | null>(null);
  const lastSeenRef = React.useRef(0);
  React.useEffect(() => {
    lastSeenRef.current = stream.lastSeen;
  }, [stream.lastSeen]);

  const status = deriveStatus(stream.events) ?? initialStatus;
  const terminal = isTerminalStatus(status);
  const resumable = status === "interrupted" || status === "failed" || status === "stopped";

  // Pull the stored outcome once the run is terminal.
  React.useEffect(() => {
    if (!terminal || parseOutcome(outcomeRaw)) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { run?: { outcome?: unknown } };
        if (!cancelled && body.run?.outcome) setOutcomeRaw(body.run.outcome);
      } catch {
        // verdict stays hidden; the log still shows the result
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [terminal, runId, outcomeRaw]);

  // SSE: EventSource resumes with Last-Event-ID on its own; after a hard close
  // we reopen with ?after=<lastSeen>. Events at or below lastSeen are dropped.
  React.useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = () => {
      if (closed) return;
      es = new EventSource(eventsUrl(runId, lastSeenRef.current));
      es.onopen = () => setConnection("live");
      es.addEventListener("agent-event", (msg) => {
        const event = parseEventData((msg as MessageEvent<string>).data);
        if (event) setStream((s) => acceptEvent(s, event));
      });
      es.addEventListener("end", () => {
        setConnection("ended");
        es?.close();
        closed = true;
      });
      es.onerror = () => {
        if (closed) return;
        if (es && es.readyState === EventSource.CLOSED) {
          setConnection("reconnecting");
          es.close();
          timer = setTimeout(open, RECONNECT_MS);
        } else {
          setConnection("reconnecting");
        }
      };
    };
    open();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [runId]);

  const visible = React.useMemo(() => filterByAgent(stream.events, filter), [stream.events, filter]);
  const plain = React.useMemo(() => eventsToPlainText(visible), [visible]);
  const timeline = React.useMemo(() => deriveTimeline(stream.events, terminal), [stream.events, terminal]);
  const rounds = React.useMemo(() => availableRounds(stream.events), [stream.events]);
  const latestRound = rounds[rounds.length - 1] ?? 0;
  // Follows new rounds until the user picks one by hand.
  const round = selectedRound(rounds, pickedRound);
  const plan = React.useMemo(() => derivePlan(stream.events), [stream.events]);
  const checks = React.useMemo(() => checksForRound(stream.events, round), [stream.events, round]);
  const diff = React.useMemo(() => diffForRound(stream.events, round), [stream.events, round]);
  const diffPatch = React.useMemo(() => diffPatchForRound(stream.events, round), [stream.events, round]);
  const diffFiles = React.useMemo(() => {
    if (diffPatch && diffPatch.files.length > 0) return diffPatch.files.map((f) => f.path);
    if (diff && diff.files.length > 0) return diff.files.map((f) => f.path);
    return [];
  }, [diffPatch, diff]);
  const groupedComments = React.useMemo(() => groupComments(comments), [comments]);
  const review = React.useMemo(() => reviewForRound(stream.events, round), [stream.events, round]);
  const findings = React.useMemo(() => (review ? findingsBySeverity(review) : null), [review]);
  const outcome = parseOutcome(outcomeRaw);

  async function stop() {
    setStopState("sending");
    setStopError(null);
    try {
      const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
      if (res.ok) {
        setStopState("sent");
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStopError(body.error ?? `Stop failed (${res.status})`);
        setStopState("error");
      }
    } catch {
      setStopError("Stop request failed");
      setStopState("error");
    }
  }

  async function resume() {
    setResumeState("sending");
    setResumeError(null);
    try {
      const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
      if (res.ok) {
        setResumeState("sent");
        // The event stream closed when the run ended; reload to follow the resumed attempt.
        setTimeout(() => window.location.reload(), 1500);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResumeError(body.error ?? `Resume failed (${res.status})`);
        setResumeState("error");
      }
    } catch {
      setResumeError("Resume request failed");
      setResumeState("error");
    }
  }

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(plain);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <div className="flex items-center gap-2">
            <Badge aria-live="polite">{status}</Badge>
            <span className="text-[11px] text-faint">stream: {connection}</span>
            {!terminal ? (
              <Button variant="danger" size="sm" onClick={stop} disabled={stopState === "sending" || stopState === "sent"}>
                {stopState === "sent" ? "Stopping..." : "Stop"}
              </Button>
            ) : null}
            {resumable ? (
              <Button size="sm" onClick={resume} disabled={resumeState === "sending" || resumeState === "sent"}>
                {resumeState === "sent" ? "Resuming..." : "Resume"}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardBody>
          {stopError ? <p className="mb-2 text-[12px] text-red-400">{stopError}</p> : null}
          {resumeError ? (
            <p role="alert" className="mb-2 text-[12px] text-red-400">
              {resumeError}
            </p>
          ) : null}
          <ol className="flex flex-wrap gap-2" aria-label="Stage timeline">
            {timeline.map((t) => (
              <li key={t.stage}>
                <Badge
                  className={
                    t.state === "done"
                      ? "text-green-400"
                      : t.state === "running"
                        ? "text-[var(--accent)]"
                        : "text-faint"
                  }
                >
                  {t.stage}: {t.state}
                </Badge>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      {outcome ? (
        <Card>
          <CardHeader>
            <CardTitle>Final verdict</CardTitle>
            <Badge className={outcome.status === "succeeded" ? "text-green-400" : "text-red-400"}>
              {outcome.status}
            </Badge>
          </CardHeader>
          <CardBody className="space-y-2">
            <ul className="space-y-1 text-[13px]">
              {verdictFacts(outcome, requiredChecks).map((f) => (
                <li key={f.label}>
                  <span className={f.ok ? "text-green-400" : "text-red-400"}>{f.ok ? "Pass" : "Fail"}</span>{" "}
                  <span className="text-fg">{f.label}</span> <span className="text-muted">({f.detail})</span>
                </li>
              ))}
            </ul>
            {outcome.missing.length > 0 ? (
              <p className="text-[12px] text-muted">Missing: {outcome.missing.join("; ")}</p>
            ) : null}
            {outcome.error ? <p className="text-[12px] text-red-400">Error: {outcome.error}</p> : null}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Live output</CardTitle>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="agent-filter">
              Filter by agent
            </label>
            <Select
              id="agent-filter"
              className="w-36"
              value={filter}
              onChange={(e) => setFilter(e.target.value as AgentFilter)}
            >
              <option value="all">All agents</option>
              {EVENT_AGENTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={copyLog}>
              {copied ? "Copied" : "Copy log"}
            </Button>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <TerminalView events={visible} resetKey={filter} />
          <details>
            <summary className="cursor-pointer text-[12px] text-muted">Plain-text log (screen reader friendly)</summary>
            <pre
              role="log"
              aria-label="Run log"
              className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-[var(--bg-subtle)] p-2 text-[12px] text-fg"
            >
              {plain || "No output yet."}
            </pre>
          </details>
        </CardBody>
      </Card>

      {plan ? (
        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-[13px]">
            <p className="whitespace-pre-wrap text-fg">{plan.task}</p>
            {plan.scopePaths.length > 0 ? (
              <div>
                <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted">Scope</h3>
                <ul className="list-disc pl-5 font-mono text-[12px]">
                  {plan.scopePaths.map((p) => (
                    <li key={p} className="break-all">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.acceptance.length > 0 ? (
              <div>
                <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted">Acceptance</h3>
                <ul className="list-disc pl-5">
                  {plan.acceptance.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.checks.length > 0 ? (
              <p className="text-[12px] text-muted">Advisory checks: {plan.checks.join(", ")}</p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {rounds.length > 1 ? (
        <div role="group" aria-label="Round" className="flex flex-wrap items-center gap-2">
          {rounds.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === round ? "primary" : undefined}
              aria-pressed={r === round}
              onClick={() => setPickedRound(r)}
            >
              {roundLabel(r)}
            </Button>
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Changed files</CardTitle>
          {diff ? (
            <span className="text-[11px] text-faint">
              {diff.totals.files} file(s), +{diff.totals.additions} -{diff.totals.deletions}
            </span>
          ) : null}
        </CardHeader>
        <CardBody>
          {diff ? (
            <pre className="max-h-96 overflow-auto whitespace-pre rounded-md border border-line bg-[var(--bg-subtle)] p-2 text-[12px] text-fg">
              {diffToText(diff)}
            </pre>
          ) : (
            <p className="text-[13px] text-muted">No diff yet.</p>
          )}
          {diff && diffPatch && diffPatch.files.length > 0 ? (
            <div className="mt-3 space-y-2">
              {diffPatch.truncated ? <p className="text-[12px] text-faint">Truncated: some patch text is cut or left out.</p> : null}
              {diffPatch.files.map((f) => (
                <PatchBlock
                  key={`${f.oldPath ?? ""}>${f.path}`}
                  file={f}
                  summary={diff.files.find((s) => s.path === f.path)}
                  commentsByLine={groupedComments.byFile.get(f.path)}
                  onSelectLine={(d) => setDraft(d)}
                />
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <RunComments
        runId={runId}
        round={round}
        readOnlyNote={
          commentRejectionReason({ status, hasReviewStage }) ??
          (round < latestRound
            ? `Comments are picked up for the latest round only. Switch to ${roundLabel(latestRound)} to add one.`
            : undefined)
        }
        files={diffFiles}
        draft={draft}
        onDraftConsumed={() => setDraft(null)}
        onCommentsChange={setComments}
      />

      <RunApprovals runId={runId} finished={status === "succeeded" || status === "failed" || status === "stopped"} />

      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
        </CardHeader>
        <CardBody>
          {checks.length === 0 ? (
            <p className="text-[13px] text-muted">No check results yet.</p>
          ) : (
            <ul className="space-y-2">
              {checks.map((c, i) => (
                <li key={`${c.name}-${i}`}>
                  <details>
                    <summary className="cursor-pointer text-[13px]">
                      <span className={!c.timedOut && c.exitCode === 0 ? "text-green-400" : "text-red-400"}>
                        {!c.timedOut && c.exitCode === 0 ? "Pass" : "Fail"}
                      </span>{" "}
                      {c.name}{" "}
                      <span className="text-muted">
                        ({c.timedOut ? "timed out" : `exit ${c.exitCode ?? "none"}`}
                        {c.durationMs !== null ? `, ${Math.round(c.durationMs / 100) / 10}s` : ""})
                      </span>
                    </summary>
                    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-[var(--bg-subtle)] p-2 text-[12px]">
                      {c.output || "(no output)"}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {review ? (
        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <Badge>{review.verdict.replace("_", " ")}</Badge>
          </CardHeader>
          <CardBody>
            {review.findings.length === 0 ? (
              <p className="text-[13px] text-muted">No findings.</p>
            ) : (
              <div className="space-y-3 text-[13px]">
                {SEVERITY_ORDER.map((cls) => {
                  const list = findings?.groups[cls] ?? [];
                  if (list.length === 0) return null;
                  return (
                    <div key={cls}>
                      <h3 className="mb-1 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
                        <Badge className={SEVERITY_BADGE[cls]}>{cls}</Badge>
                        <span>{list.length}</span>
                      </h3>
                      <ul className="space-y-1">
                        {list.map((f, i) => (
                          <li key={i}>
                            <span className="font-medium">{f.severity}</span>
                            {f.path ? (
                              <span className="text-muted">
                                {" "}
                                {f.path}
                                {f.line ? `:${f.line}` : ""}
                              </span>
                            ) : null}{" "}
                            {f.message}
                            {f.actionable ? <span className="ml-2 text-[11px] text-[var(--accent)]">actionable</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
