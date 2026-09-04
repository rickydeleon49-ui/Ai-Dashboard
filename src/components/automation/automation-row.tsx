"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Play, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import type { Automation } from "@/core/automation/service";
import { cn, formatRelative } from "@/lib/utils";

/** Cadences worth offering. Anything finer would just burn API calls. */
const INTERVALS = [
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 60, label: "Hourly" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 720, label: "Twice a day" },
  { minutes: 1440, label: "Daily" },
  { minutes: 10080, label: "Weekly" },
];

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-[11.5px] text-faint">Never run</span>;

  const map = {
    ok: { icon: Check, className: "text-emerald-400", label: "Ran" },
    skipped: { icon: SkipForward, className: "text-amber-400", label: "Skipped" },
    failed: { icon: AlertTriangle, className: "text-red-400", label: "Failed" },
  } as const;

  const entry = map[status as keyof typeof map] ?? map.ok;
  const Icon = entry.icon;

  return (
    <span className={cn("flex items-center gap-1 text-[11.5px]", entry.className)}>
      <Icon className="h-3 w-3" strokeWidth={2} />
      {entry.label}
    </span>
  );
}

export function AutomationRow({ automation }: { automation: Automation }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(automation.enabled);
  const [interval, setIntervalValue] = useState(automation.intervalMinutes);
  const [running, setRunning] = useState(false);

  async function patch(body: Record<string, unknown>) {
    await fetch(`/api/automations/${automation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    router.refresh();
  }

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    try {
      await patch({ enabled: next });
    } catch {
      setEnabled(!next);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      await fetch(`/api/automations/${automation.id}/run`, { method: "POST" });
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-56 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={enabled ? "Disable" : "Enable"}
              onClick={toggle}
              className={cn(
                "relative h-4.5 w-8 shrink-0 rounded-full transition-colors",
                enabled ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]",
              )}
            >
              {/* `left` is set explicitly: without it the knob falls back to its
                  static position at the track's right edge and renders outside. */}
              <span
                className={cn(
                  "absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform",
                  enabled ? "translate-x-3.5" : "translate-x-0",
                )}
              />
            </button>

            <h3 className="text-[13.5px] font-medium text-fg">
              {automation.definition?.name ?? automation.type}
            </h3>
          </div>

          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            {automation.definition?.description ??
              "This automation is no longer available in this version."}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={automation.lastStatus} />
            {automation.lastRunAt ? (
              <span className="text-[11.5px] text-faint">
                {formatRelative(automation.lastRunAt)}
              </span>
            ) : null}
          </div>

          {automation.lastMessage ? (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-faint">
              {automation.lastMessage}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Select
            aria-label="How often"
            value={interval}
            disabled={!enabled}
            onChange={(e) => {
              const next = Number(e.target.value);
              setIntervalValue(next);
              void patch({ intervalMinutes: next });
            }}
            className="w-auto min-w-32"
          >
            {INTERVALS.map((option) => (
              <option key={option.minutes} value={option.minutes}>
                {option.label}
              </option>
            ))}
          </Select>

          <Button type="button" size="md" onClick={runNow} disabled={running}>
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Run now
          </Button>
        </div>
      </div>
    </div>
  );
}
