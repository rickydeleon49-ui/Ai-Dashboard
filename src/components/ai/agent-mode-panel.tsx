"use client";

import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import {
  AGENT_ACTION_SPECS,
  policyLabel,
  type AgentAction,
  type ApprovalPolicies,
  type ApprovalPolicy,
} from "@/core/ai/approvals";
import { StatusDot, stateLabel } from "@/components/ai/status-dot";
import { Select } from "@/components/ui/field";
import type { ProviderStatus } from "@/core/ai/types";

/**
 * What Agent mode is, what it is not, and what it would be allowed to do.
 *
 * The rules were read-only while nothing consulted them, which made them a
 * description rather than a policy. They are now the policy the provider is
 * evaluated against, so they are editable here: blocking "Run a command" stops
 * Agent mode from starting Hermes at all, which the status line above reflects
 * immediately.
 */

const POLICY_CLASS: Record<ApprovalPolicy, string> = {
  auto: "text-emerald-400",
  ask: "text-amber-400",
  never: "text-red-400",
};

export function AgentModePanel({
  status,
  enabled,
  approvals,
}: {
  status: ProviderStatus;
  enabled: boolean;
  approvals: ApprovalPolicies;
}) {
  const [policies, setPolicies] = useState(approvals);
  const [saving, setSaving] = useState<AgentAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(action: AgentAction, policy: ApprovalPolicy) {
    const previous = policies[action];
    // Applied first so the row responds immediately; rolled back if the write
    // fails, because a control that silently keeps a value the server rejected
    // is worse than one that visibly snaps back.
    setPolicies((current) => ({ ...current, [action]: policy }));
    setSaving(action);
    setError(null);

    try {
      const response = await fetch("/api/ai/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [action]: policy }),
      });
      const body = (await response.json()) as {
        approvals?: ApprovalPolicies;
        error?: string;
      };
      if (!response.ok || !body.approvals) {
        setPolicies((current) => ({ ...current, [action]: previous }));
        setError(body.error ?? "Could not save that rule.");
        return;
      }
      setPolicies(body.approvals);
    } catch {
      setPolicies((current) => ({ ...current, [action]: previous }));
      setError("Could not reach the server.");
    } finally {
      setSaving(null);
    }
  }

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
          {AGENT_ACTION_SPECS.map((spec) => {
            const policy = policies[spec.action];
            return (
              <li
                key={spec.action}
                className="flex items-center justify-between gap-3 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-fg">{spec.label}</span>
                  <span className="block truncate text-[11px] text-faint">
                    {spec.description}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {saving === spec.action ? (
                    <Loader2 className="h-3 w-3 animate-spin text-faint" strokeWidth={2} />
                  ) : null}
                  <Select
                    value={policy}
                    aria-label={`${spec.label} policy`}
                    onChange={(event) =>
                      void change(spec.action, event.target.value as ApprovalPolicy)
                    }
                    className={`w-auto py-0.5 text-[11px] font-medium ${POLICY_CLASS[policy]}`}
                  >
                    {(["auto", "ask", "never"] as const).map((option) => (
                      <option key={option} value={option}>
                        {policyLabel(option)}
                      </option>
                    ))}
                  </Select>
                </span>
              </li>
            );
          })}
        </ul>

        {error ? (
          <p className="rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-300">
            {error}
          </p>
        ) : null}

        <p className="text-[11px] leading-relaxed text-faint">
          Chat mode has none of these abilities at all — it can read no files and run no
          commands, whatever it is asked. Blocking{" "}
          <strong className="font-medium text-muted">Run a command</strong> also stops Agent
          mode from starting Hermes.
        </p>
      </div>
    </div>
  );
}
