"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Gauge, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import type {
  CodexLimitsSummary,
  LimitWindowSummary,
  ToolUsage,
  UsageTotals,
} from "@/core/usage/summary";
import {
  barLevel,
  clampPct,
  formatCompact,
  formatCountdown,
  formatRelative,
  formatUsd,
  pacePct,
  trendPct,
  type BarLevel,
} from "@/lib/usage-format";
import { cn } from "@/lib/utils";
import { AppUsageCard } from "./app-usage-card";
import { useNow, useUsageSnapshot } from "./use-usage-snapshot";

const TOOL_ORDER = ["claude-code", "codex", "antigravity"] as const;
const TOOL_LABEL: Record<(typeof TOOL_ORDER)[number], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

const LEVEL_BAR: Record<BarLevel, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
};
const LEVEL_TEXT: Record<BarLevel, string> = {
  ok: "text-muted",
  warn: "text-amber-500",
  danger: "text-red-500",
};

const NUM = "tabular-nums";

function machineLabel(machine: string): string {
  if (machine === "mac") return "Mac";
  if (machine === "windows-pc") return "PC";
  return machine;
}

export function UsageView() {
  const { snapshot, loading, error, refresh } = useUsageSnapshot();
  const now = useNow();

  if (!snapshot) {
    return (
      <p className="text-[13px] text-muted" role="status">
        {loading ? "Loading usage..." : (error ?? "No usage data.")}
      </p>
    );
  }

  const byTool = new Map(snapshot.tools.map((t) => [t.tool, t]));
  const anyData = snapshot.tools.some((t) => t.hasData) || snapshot.codexLimits !== null;

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-[12px] text-red-500">
          {error}. Showing the last result.
        </p>
      ) : null}

      {anyData ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {TOOL_ORDER.map((id) => {
            const tool = byTool.get(id);
            return tool ? (
              <ToolCard
                key={id}
                tool={tool}
                limits={id === "codex" ? snapshot.codexLimits : null}
                now={now}
              />
            ) : null;
          })}
        </div>
      ) : (
        <EmptyState
          icon={Gauge}
          title="No usage data yet"
          description={`No tracker files were found in ${snapshot.folder}.`}
        />
      )}

      {/* USG-02: the app's own Ollama / Hermes chat and LM Studio advisor usage. */}
      <AppUsageCard />

      {snapshot.warnings.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px]">
          <summary className="cursor-pointer text-muted">
            Data notes ({snapshot.warnings.length})
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] text-muted">
            {snapshot.warnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <FolderFooter folder={snapshot.folder} onChanged={refresh} />
    </div>
  );
}

function Trend({ current, previous }: { current: UsageTotals; previous: UsageTotals }) {
  const pct = trendPct(current.tokens, previous.tokens);
  if (pct === null) {
    return <span className="text-faint">no earlier week to compare</span>;
  }
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className={NUM}>
        {pct > 0 ? "+" : ""}
        {pct}%
      </span>
      <span className="text-faint">vs previous 7 days</span>
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-faint">{label}</p>
      <p className={cn("text-lg font-semibold text-fg", NUM)}>{value}</p>
      {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}

function ToolCard({
  tool,
  limits,
  now,
}: {
  tool: ToolUsage;
  limits: CodexLimitsSummary | null;
  now: Date;
}) {
  const id = tool.tool;
  const label = TOOL_LABEL[id];
  const pace = id === "claude-code" ? pacePct(tool.thisWeek, tool.lastWeek) : null;
  const split =
    id === "antigravity"
      ? tool.topModels.filter((m) => m.model === "agy-cli" || m.model === "agy-ide")
      : [];

  return (
    <Card aria-label={`${label} usage`}>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <div className="flex items-center gap-2 text-[11px] text-faint">
          {tool.stale ? <Badge>stale</Badge> : null}
          <span>Updated {formatRelative(tool.updatedAt, now)}</span>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {!tool.hasData && !limits ? (
          <p className="text-[13px] text-muted">No data yet.</p>
        ) : null}

        {tool.hasData ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Today" value={`${formatCompact(tool.today.tokens)} tokens`} hint={`${tool.today.replies.toLocaleString("en-US")} replies`} />
              {tool.today.costUsd !== null ? (
                <Stat label="Cost today" value={formatUsd(tool.today.costUsd)} hint="API-equivalent" />
              ) : null}
            </div>

            <div className="text-[13px] text-muted">
              <p>
                Last 7 days:{" "}
                <span className={cn("text-fg", NUM)}>{formatCompact(tool.last7Days.tokens)}</span>
                {tool.last7Days.costUsd !== null ? (
                  <span className={NUM}> · {formatUsd(tool.last7Days.costUsd)}</span>
                ) : null}
              </p>
              <p className="text-[12px]">
                <Trend current={tool.last7Days} previous={tool.previous7Days} />
              </p>
            </div>
          </>
        ) : null}

        {id === "claude-code" && tool.thisWeek ? (
          <div className="border-t border-line pt-3 text-[13px] text-muted">
            <p className="text-[11px] uppercase tracking-wide text-faint">This week (resets Tue 02:00 PT)</p>
            <p>
              <span className={cn("text-fg", NUM)}>{formatCompact(tool.thisWeek.tokens)}</span>
              {tool.thisWeek.costUsd !== null ? (
                <span className={NUM}> · {formatUsd(tool.thisWeek.costUsd)}</span>
              ) : null}
              {tool.thisWeek.daysElapsed !== null ? (
                <span className="text-faint"> · day {Math.ceil(tool.thisWeek.daysElapsed)} of 7</span>
              ) : null}
            </p>
            {pace !== null ? (
              <p className={NUM}>On pace for {pace}% of last week</p>
            ) : null}
          </div>
        ) : null}

        {id === "codex" && limits ? (
          <div className="space-y-3 border-t border-line pt-3">
            <LimitBar label="5-hour" window={limits.fiveHour} now={now} />
            <LimitBar label="Weekly" window={limits.weekly} now={now} />
          </div>
        ) : null}

        {id === "antigravity" ? (
          <div className="space-y-1 border-t border-line pt-3 text-[13px] text-muted">
            {split.length > 0 ? (
              split.map((m) => (
                <p key={m.model} className="flex justify-between gap-2">
                  <span>{m.model === "agy-cli" ? "CLI" : "IDE"} <span className="text-faint">(30 days)</span></span>
                  <span className={NUM}>
                    {formatCompact(m.tokens)} · {m.replies.toLocaleString("en-US")} replies
                  </span>
                </p>
              ))
            ) : null}
            <p className="text-[11px] text-faint">
              agy doesn&apos;t expose its quota, so no limit bar.
            </p>
          </div>
        ) : null}

        {tool.byMachine.length > 0 ? (
          <div className="border-t border-line pt-3">
            <p className="text-[11px] uppercase tracking-wide text-faint">By machine (7 days)</p>
            <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
              {tool.byMachine.map((m) => (
                <li key={m.machine} className="flex justify-between gap-2">
                  <span>{machineLabel(m.machine)}</span>
                  <span className={NUM}>{formatCompact(m.tokens)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {id !== "antigravity" && tool.topModels.length > 0 ? (
          <div className="border-t border-line pt-3">
            <p className="text-[11px] uppercase tracking-wide text-faint">Top models (30 days)</p>
            <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
              {tool.topModels.slice(0, 3).map((m) => (
                <li key={m.model} className="flex justify-between gap-2">
                  <span className="truncate">{m.model}</span>
                  <span className={NUM}>{formatCompact(m.tokens)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function LimitBar({
  label,
  window: w,
  now,
}: {
  label: string;
  window: LimitWindowSummary;
  now: Date;
}) {
  if (w.usedPct === null) {
    return (
      <div className="text-[13px] text-muted">
        {label}: <span className="text-faint">unknown</span>
      </div>
    );
  }
  const pct = clampPct(w.usedPct);
  const level = barLevel(pct);
  const countdown = w.stale ? null : formatCountdown(w.resetsAt, now);
  return (
    <div className={cn(w.stale && "opacity-60")}>
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="text-muted">{label}</span>
        <span className={cn("font-medium", NUM, w.stale ? "text-muted" : level === "ok" ? "text-fg" : LEVEL_TEXT[level])}>
          {Math.round(pct)}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Codex ${label} limit used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]"
      >
        <div
          className={cn("h-full rounded-full", w.stale ? "bg-[var(--text-subtle)]" : LEVEL_BAR[level])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-faint">
        {w.stale ? "old snapshot" : countdown ? `resets in ${countdown}` : "reset time unknown"}
      </p>
    </div>
  );
}

function FolderFooter({ folder, onChanged }: { folder: string; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(folder);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/usage", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: value.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setProblem(body?.error ?? `Could not change the folder (${res.status})`);
        return;
      }
      setEditing(false);
      await onChanged();
    } catch {
      setProblem("Could not reach the usage service");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-[12px] text-muted">
      {editing ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="sr-only" htmlFor="usage-folder">
            Usage folder (absolute path)
          </label>
          <Input
            id="usage-folder"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Absolute path to the usage folder"
            className="sm:max-w-md"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy || value.trim() === ""}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="flex flex-wrap items-center gap-2">
          <span>Folder:</span>
          <code className="break-all text-fg">{folder}</code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setValue(folder);
              setEditing(true);
            }}
          >
            Change
          </Button>
        </p>
      )}
      {problem ? (
        <p role="alert" className="text-red-500">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
