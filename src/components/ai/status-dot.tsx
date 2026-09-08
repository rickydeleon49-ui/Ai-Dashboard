import { cn } from "@/lib/utils";
import type { AiState } from "@/core/ai/types";

/**
 * The one place a connection state becomes a colour and a word.
 *
 * Centralised so the workspace header, the settings panel and the AI hub card
 * can never disagree about what "ready" looks like.
 */
const STATE_META: Record<AiState, { label: string; dot: string; text: string }> = {
  ready: { label: "Ready", dot: "bg-emerald-400", text: "text-emerald-400" },
  generating: { label: "Generating", dot: "bg-emerald-400 animate-pulse", text: "text-emerald-400" },
  loading_model: { label: "Loading model", dot: "bg-amber-400 animate-pulse", text: "text-amber-400" },
  starting: { label: "Starting", dot: "bg-amber-400 animate-pulse", text: "text-amber-400" },
  offline: { label: "Offline", dot: "bg-zinc-500", text: "text-muted" },
  disabled: { label: "Disabled", dot: "bg-zinc-600", text: "text-faint" },
  unsupported: { label: "Unavailable", dot: "bg-zinc-600", text: "text-faint" },
  error: { label: "Error", dot: "bg-red-400", text: "text-red-400" },
};

export function stateLabel(state: AiState): string {
  return STATE_META[state].label;
}

export function StatusDot({ state, className }: { state: AiState; className?: string }) {
  return (
    <span
      className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", STATE_META[state].dot, className)}
      aria-hidden
    />
  );
}

export function StatusText({ state, className }: { state: AiState; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <StatusDot state={state} />
      <span className={cn("text-[12px] font-medium", STATE_META[state].text)}>
        {STATE_META[state].label}
      </span>
    </span>
  );
}
