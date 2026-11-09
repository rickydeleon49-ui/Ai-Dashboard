"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import {
  APPROVAL_KINDS,
  KIND_LABELS,
  STATUS_LABELS,
  approveBlocker,
  buildTarget,
  isOpen,
  previewLines,
  sortNewestFirst,
  type Approval,
  type ApprovalKind,
} from "./approvals-logic";

export interface RunApprovalsProps {
  runId: string;
  finished: boolean;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  } catch {
    return iso;
  }
}

async function fetchApprovals(runId: string): Promise<Approval[]> {
  const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/approvals`, { cache: "no-store" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Failed to load approvals (${res.status})`);
  }
  const data = (await res.json()) as { approvals?: Approval[] };
  return sortNewestFirst(Array.isArray(data.approvals) ? data.approvals : []);
}

export function RunApprovals({ runId, finished }: RunApprovalsProps) {
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [fetchError, setFetchError] = React.useState<string | null>(null);

  // Form state
  const [selectedKind, setSelectedKind] = React.useState<ApprovalKind>("merge");
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [formSubmitting, setFormSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Decision state
  const [decisionRunning, setDecisionRunning] = React.useState<{
    id: string;
    decision: "approve" | "reject";
  } | null>(null);
  const [decisionError, setDecisionError] = React.useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = React.useState(false);

  const loadApprovals = React.useCallback(async () => {
    try {
      setApprovals(await fetchApprovals(runId));
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Initial load when finished
  React.useEffect(() => {
    if (!finished) return;
    let cancelled = false;
    fetchApprovals(runId)
      .then((list) => {
        if (cancelled) return;
        setApprovals(list);
        setFetchError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load approvals");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [finished, runId]);

  // Poll every 3 s while any approval is open
  React.useEffect(() => {
    if (!finished) return;
    const anyOpen = approvals.some((a) => isOpen(a.status));
    if (!anyOpen) return;

    const timer = setInterval(() => {
      void loadApprovals();
    }, 3000);

    return () => clearInterval(timer);
  }, [finished, approvals, loadApprovals]);

  if (!finished) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Approvals</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-[13px] text-muted">
            Actions unlock when the run finishes.
          </p>
        </CardBody>
      </Card>
    );
  }

  const hasOpenSameKind = approvals.some(
    (a) => a.kind === selectedKind && isOpen(a.status),
  );

  const updateField = (name: string, value: string) => {
    setFields((prev) => ({ ...prev, [name]: value }));
  };

  const handleRequestPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formSubmitting || hasOpenSameKind) return;

    const targetResult = buildTarget(selectedKind, fields);
    if ("error" in targetResult) {
      setFormError(targetResult.error);
      return;
    }

    setFormSubmitting(true);
    setFormError(null);
    setDecisionError(null);

    try {
      const res = await fetch(
        `/api/agent-runs/${encodeURIComponent(runId)}/approvals`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: selectedKind,
            target: targetResult.target,
          }),
        },
      );

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to create preview (${res.status})`);
      }

      setFields({});
      await loadApprovals();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create preview",
      );
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleDecision = async (
    approvalId: string,
    decision: "approve" | "reject",
  ) => {
    if (decisionRunning) return;
    setDecisionRunning({ id: approvalId, decision });
    setDecisionError(null);
    setReauthRequired(false);

    try {
      const res = await fetch(
        `/api/agent-runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 401 && data.error === "reauth_required") {
          setReauthRequired(true);
          return;
        }
        throw new Error(
          data.error || `Failed to ${decision} approval (${res.status})`,
        );
      }

      await loadApprovals();
    } catch (err) {
      setDecisionError(
        err instanceof Error ? err.message : `Failed to ${decision} approval`,
      );
    } finally {
      setDecisionRunning(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approvals</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {fetchError ? (
          <p
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[12px] font-medium text-red-400"
          >
            {fetchError}
          </p>
        ) : null}

        {reauthRequired ? (
          <p
            role="alert"
            className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[12px] font-medium text-amber-400"
          >
            <a
              className="underline"
              href={`/login?reauth=1&next=${encodeURIComponent(`/agents/runs/${runId}`)}`}
            >
              Sign in again to approve
            </a>
          </p>
        ) : null}

        {decisionError ? (
          <p
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[12px] font-medium text-red-400"
          >
            {decisionError}
          </p>
        ) : null}

        {formError ? (
          <p
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[12px] font-medium text-red-400"
          >
            {formError}
          </p>
        ) : null}

        {/* Request form */}
        <form
          onSubmit={handleRequestPreview}
          className="space-y-3 rounded-lg border border-line bg-[var(--bg-subtle)] p-3"
          aria-label="Request approval form"
        >
          <div>
            <label
              htmlFor="approval-kind-select"
              className="mb-1 block text-[12px] font-medium text-muted"
            >
              Action
            </label>
            <Select
              id="approval-kind-select"
              value={selectedKind}
              onChange={(e) => {
                setSelectedKind(e.target.value as ApprovalKind);
                setFormError(null);
              }}
              disabled={formSubmitting}
            >
              {APPROVAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k] ?? k}
                </option>
              ))}
            </Select>
          </div>

          {selectedKind === "merge" ? (
            <div>
              <label
                htmlFor="merge-target-branch-input"
                className="mb-1 block text-[12px] font-medium text-muted"
              >
                Branch to merge into
              </label>
              <Input
                id="merge-target-branch-input"
                value={fields["targetBranch"] ?? ""}
                onChange={(e) => updateField("targetBranch", e.target.value)}
                placeholder="e.g. main"
                disabled={formSubmitting}
              />
            </div>
          ) : null}

          {selectedKind === "push" ? (
            <div>
              <label
                htmlFor="push-remote-input"
                className="mb-1 block text-[12px] font-medium text-muted"
              >
                Remote (optional, default origin)
              </label>
              <Input
                id="push-remote-input"
                value={fields["remote"] ?? ""}
                onChange={(e) => updateField("remote", e.target.value)}
                placeholder="origin"
                disabled={formSubmitting}
              />
            </div>
          ) : null}

          {selectedKind === "draft_pr" ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="pr-base-input"
                  className="mb-1 block text-[12px] font-medium text-muted"
                >
                  Base branch
                </label>
                <Input
                  id="pr-base-input"
                  value={fields["base"] ?? ""}
                  onChange={(e) => updateField("base", e.target.value)}
                  placeholder="e.g. main"
                  disabled={formSubmitting}
                />
              </div>
              <div>
                <label
                  htmlFor="pr-remote-input"
                  className="mb-1 block text-[12px] font-medium text-muted"
                >
                  Remote (optional)
                </label>
                <Input
                  id="pr-remote-input"
                  value={fields["remote"] ?? ""}
                  onChange={(e) => updateField("remote", e.target.value)}
                  placeholder="origin"
                  disabled={formSubmitting}
                />
              </div>
              <div>
                <label
                  htmlFor="pr-title-input"
                  className="mb-1 block text-[12px] font-medium text-muted"
                >
                  Title (optional)
                </label>
                <Input
                  id="pr-title-input"
                  value={fields["title"] ?? ""}
                  onChange={(e) => updateField("title", e.target.value)}
                  placeholder="Draft PR title"
                  disabled={formSubmitting}
                />
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              type="submit"
              variant="primary"
              disabled={formSubmitting || hasOpenSameKind}
            >
              {formSubmitting ? "Requesting..." : "Preview"}
            </Button>
            {hasOpenSameKind ? (
              <span className="text-[12px] text-muted">
                An approval for this is already open.
              </span>
            ) : null}
          </div>
        </form>

        {/* Approvals list */}
        {approvals.length === 0 && !loading ? (
          <p className="text-[13px] text-muted">No approvals requested yet.</p>
        ) : null}

        {approvals.length > 0 ? (
          <ul className="space-y-3" aria-label="Approvals list">
            {approvals.map((approval) => {
              const lines = previewLines(approval);
              const blocker = approveBlocker(approval);
              const requestedTime = formatTime(approval.requestedAt);
              const isDecisionThis = decisionRunning?.id === approval.id;

              return (
                <li
                  key={approval.id}
                  className="space-y-2 rounded-md border border-line bg-[var(--bg-subtle)] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-fg">
                        {KIND_LABELS[approval.kind] ?? approval.kind}
                      </span>
                      <span className="rounded border border-line bg-[var(--bg-hover)] px-1.5 py-0.5 text-[11px] font-medium text-muted">
                        {STATUS_LABELS[approval.status] ?? approval.status}
                      </span>
                    </div>
                    <span className="text-[11px] text-faint">
                      {requestedTime}
                    </span>
                  </div>

                  {lines.length > 0 ? (
                    <div className="space-y-1">
                      {lines.map((line, idx) => (
                        <p key={idx} className="text-[13px] text-fg">
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : null}

                  {approval.kind === "draft_pr" &&
                  typeof approval.preview["body"] === "string" &&
                  approval.preview["body"] ? (
                    <details className="text-[12px] text-muted">
                      <summary className="cursor-pointer font-medium select-none hover:text-fg">
                        PR body
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded border border-line bg-[var(--bg-hover)] p-2 font-mono text-[11px] text-fg">
                        {approval.preview["body"] as string}
                      </pre>
                    </details>
                  ) : null}

                  {approval.kind === "apply_back" &&
                  Array.isArray(approval.preview["entries"]) &&
                  approval.preview["entries"].length > 0 ? (
                    <details className="text-[12px] text-muted">
                      <summary className="cursor-pointer font-medium select-none hover:text-fg">
                        Entries ({approval.preview["entries"].length})
                      </summary>
                      <ul className="mt-1 space-y-0.5 rounded border border-line bg-[var(--bg-hover)] p-2 font-mono text-[11px] text-fg">
                        {(approval.preview["entries"] as unknown[]).map(
                          (entry, idx) => {
                            const item =
                              typeof entry === "object" && entry !== null
                                ? (entry as { action?: unknown; path?: unknown })
                                : {};
                            const action =
                              typeof item.action === "string"
                                ? item.action
                                : "?";
                            const path =
                              typeof item.path === "string" ? item.path : "?";
                            return (
                              <li key={idx} className="flex gap-2">
                                <span className="w-14 text-[10px] font-semibold uppercase text-muted">
                                  {action}
                                </span>
                                <span className="break-all">{path}</span>
                              </li>
                            );
                          },
                        )}
                      </ul>
                    </details>
                  ) : null}

                  {(approval.kind === "merge" || approval.kind === "push") &&
                  Array.isArray(approval.preview["commits"]) &&
                  approval.preview["commits"].length > 0 ? (
                    <details className="text-[12px] text-muted">
                      <summary className="cursor-pointer font-medium select-none hover:text-fg">
                        Commits ({approval.preview["commits"].length})
                      </summary>
                      <ul className="mt-1 space-y-0.5 rounded border border-line bg-[var(--bg-hover)] p-2 font-mono text-[11px] text-fg">
                        {(approval.preview["commits"] as unknown[]).map(
                          (commit, idx) => {
                            const item =
                              typeof commit === "object" && commit !== null
                                ? (commit as {
                                    sha?: unknown;
                                    subject?: unknown;
                                  })
                                : {};
                            const sha =
                              typeof item.sha === "string"
                                ? item.sha.slice(0, 7)
                                : "???????";
                            const subject =
                              typeof item.subject === "string"
                                ? item.subject
                                : "";
                            return (
                              <li key={idx} className="flex gap-2">
                                <span className="font-mono text-muted">{sha}</span>
                                <span className="text-fg">{subject}</span>
                              </li>
                            );
                          },
                        )}
                      </ul>
                    </details>
                  ) : null}

                  {approval.status === "pending" ? (
                    <div className="space-y-2 border-t border-line/60 pt-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={isDecisionThis || blocker !== null}
                          onClick={() => handleDecision(approval.id, "approve")}
                          aria-label={`Approve ${KIND_LABELS[approval.kind] ?? approval.kind}`}
                        >
                          {isDecisionThis &&
                          decisionRunning?.decision === "approve"
                            ? "Approving..."
                            : "Approve"}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isDecisionThis}
                          onClick={() => handleDecision(approval.id, "reject")}
                          aria-label={`Reject ${KIND_LABELS[approval.kind] ?? approval.kind}`}
                        >
                          {isDecisionThis &&
                          decisionRunning?.decision === "reject"
                            ? "Rejecting..."
                            : "Reject"}
                        </Button>
                      </div>
                      {blocker ? (
                        <p className="text-[12px] font-medium text-red-400">
                          {blocker}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {approval.status === "failed" && approval.error ? (
                    <p
                      role="alert"
                      className="border-t border-line/60 pt-2 text-[12px] font-medium text-red-400"
                    >
                      {approval.error}
                    </p>
                  ) : null}

                  {approval.status === "done" &&
                  approval.result &&
                  typeof approval.result === "object" ? (
                    <div className="space-y-1 border-t border-line/60 pt-2 text-[12px]">
                      {Object.entries(approval.result).map(([k, v]) => {
                        if (
                          k === "url" &&
                          typeof v === "string" &&
                          v.startsWith("https://")
                        ) {
                          return (
                            <div
                              key={k}
                              className="flex flex-wrap items-center gap-1.5"
                            >
                              <span className="font-medium text-muted">
                                {k}:
                              </span>
                              <a
                                href={v}
                                target="_blank"
                                rel="noreferrer"
                                className="break-all text-[var(--accent)] hover:underline"
                              >
                                {v}
                              </a>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={k}
                            className="flex flex-wrap items-center gap-1.5"
                          >
                            <span className="font-medium text-muted">{k}:</span>
                            <span className="break-all font-mono text-fg">
                              {typeof v === "object" && v !== null
                                ? JSON.stringify(v)
                                : String(v)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
