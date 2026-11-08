"use client";

import { barLevel } from "@/lib/usage-format";
import { formatUsd } from "@/lib/usage-format";
import { cn } from "@/lib/utils";
import { useUsageSnapshot } from "./use-usage-snapshot";

const LEVEL_CLASS = {
  ok: "text-muted",
  warn: "text-amber-500",
  danger: "text-red-500",
} as const;

/** Tiny inline summary next to the Usage nav item: "Codex 19% · $95". */
export function SidebarUsageSummary() {
  const { snapshot } = useUsageSnapshot();
  if (!snapshot) return null;

  const fiveHour = snapshot.codexLimits?.fiveHour;
  const codexPct =
    fiveHour && fiveHour.usedPct !== null && !fiveHour.stale
      ? Math.round(fiveHour.usedPct)
      : null;
  const claude = snapshot.tools.find((t) => t.tool === "claude-code");
  const cost = claude?.today.costUsd ?? null;

  if (codexPct === null && cost === null) return null;

  return (
    <span className="flex items-center gap-1 text-[11px] tabular-nums text-faint">
      {codexPct !== null ? (
        <span className={cn(LEVEL_CLASS[barLevel(codexPct)])} title="Codex 5-hour limit used">
          Codex {codexPct}%
        </span>
      ) : null}
      {codexPct !== null && cost !== null ? <span aria-hidden>·</span> : null}
      {cost !== null ? <span title="Claude Code today, API-equivalent">{formatUsd(cost)}</span> : null}
    </span>
  );
}
