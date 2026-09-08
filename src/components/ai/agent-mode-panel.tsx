import { ShieldCheck } from "lucide-react";
import { AGENT_ACTION_SPECS } from "@/core/ai/approvals";
import { StatusDot, stateLabel } from "@/components/ai/status-dot";
import type { ProviderStatus } from "@/core/ai/types";

/**
 * What Agent mode is, and what it is not, said plainly.
 *
 * The alternative — quietly answering agent requests with the chat model — would
 * produce something that talks like an agent and can change nothing. Showing
 * the approval model now also means the rules are visible before anything can
 * act on them, which is the only order that makes them meaningful.
 */
export function AgentModePanel({
  status,
  enabled,
}: {
  status: ProviderStatus;
  enabled: boolean;
}) {
  return (
    <div className="space-y-4 px-4 py-5">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-faint" strokeWidth={1.75} />
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
            Agent mode
            <span className="flex items-center gap-1">
              <StatusDot state={status.state} />
              <span className="text-[11.5px] font-normal text-muted">
                Hermes {stateLabel(status.state).toLowerCase()}
              </span>
            </span>
          </p>
          <p className="max-w-2xl text-[12.5px] leading-relaxed text-muted">
            {status.detail}
          </p>
          {!enabled ? (
            <p className="text-[12px] text-faint">
              Turn on <strong className="font-medium text-muted">Agent integration</strong> in
              Settings → Local AI to enable it once it is connected.
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
          Approval rules an agent will run under
        </p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {AGENT_ACTION_SPECS.map((spec) => (
            <li
              key={spec.action}
              className="flex items-baseline justify-between gap-3 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-1.5"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-fg">{spec.label}</span>
                <span className="block truncate text-[11px] text-faint">{spec.description}</span>
              </span>
              <span
                className={
                  spec.defaultPolicy === "auto"
                    ? "shrink-0 text-[11px] font-medium text-emerald-400"
                    : spec.defaultPolicy === "ask"
                      ? "shrink-0 text-[11px] font-medium text-amber-400"
                      : "shrink-0 text-[11px] font-medium text-red-400"
                }
              >
                {spec.defaultPolicy === "auto"
                  ? "Automatic"
                  : spec.defaultPolicy === "ask"
                    ? "Asks first"
                    : "Blocked"}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] leading-relaxed text-faint">
          Chat mode has none of these abilities at all — it can read no files and run no
          commands, whatever it is asked.
        </p>
      </div>
    </div>
  );
}
