"use client";

import { useState } from "react";
import { Trash2, Save, Eye } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";

interface PreviewEntry {
  runId: string;
  worktreePath: string;
  branch: string | null;
  action: "remove_worktree" | "skip";
  reason: string;
}

export function RetentionCard({ initialDays }: { initialDays: number | null }) {
  const [saved, setSaved] = useState<number | null>(initialDays);
  const [draft, setDraft] = useState(initialDays === null ? "" : String(initialDays));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [plan, setPlan] = useState<PreviewEntry[] | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const parsed = draft.trim() === "" ? null : Number(draft);
  const unchanged = parsed === saved;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 365)) {
      setError("Enter a whole number of days from 1 to 365, or leave it empty to turn cleanup off.");
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch("/api/agent-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      setSaved(data.retentionDays ?? null);
      setMessage(data.retentionDays === null ? "Cleanup is off." : "Saved.");
      setPlan(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIsSaving(false);
    }
  };

  const preview = async () => {
    setError(null);
    setIsPreviewing(true);
    try {
      const res = await fetch("/api/agent-runs/retention/preview", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load the preview");
        return;
      }
      setPlan(data.plan as PreviewEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIsPreviewing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-faint" />
          Worktree cleanup
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-[12px] text-muted">
          Remove the worktrees of dismissed runs after this many days. Only dismissed runs are touched, and a
          worktree with unsaved changes or a branch with unmerged commits is always kept. Empty means off.
        </p>
        <form onSubmit={save} noValidate className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={365}
            step={1}
            inputMode="numeric"
            placeholder="Off"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
              setMessage(null);
            }}
            disabled={isSaving}
            className="w-28 text-[12px]"
            aria-label="Remove worktrees of dismissed runs after this many days"
          />
          <span className="text-[12px] text-muted">days</span>
          <Button type="submit" size="sm" variant="secondary" disabled={isSaving || unchanged} className="gap-1.5 shrink-0">
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={preview} disabled={isPreviewing} className="gap-1.5 shrink-0">
            <Eye className="h-3.5 w-3.5" />
            Preview cleanup
          </Button>
        </form>
        {message ? <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">{message}</p> : null}
        {error ? (
          <p className="text-[11.5px] text-red-500 bg-red-500/5 border border-red-500/10 rounded px-2.5 py-1.5">{error}</p>
        ) : null}
        {plan !== null ? (
          plan.length === 0 ? (
            <p className="text-[12px] text-muted">
              {saved === null ? "Cleanup is off, so nothing would be removed." : "Nothing to clean up right now."}
            </p>
          ) : (
            <ul className="space-y-2">
              {plan.map((c) => (
                <li key={c.runId} className="rounded border border-border px-2.5 py-2 text-[12px] space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="text-[10px] py-0">{c.action === "remove_worktree" ? "Would remove" : "Would skip"}</Badge>
                    <a href={`/agents/runs/${c.runId}`} className="font-mono text-[11px] underline">
                      {c.runId}
                    </a>
                    {c.branch ? <span className="font-mono text-[11px] text-muted">{c.branch}</span> : null}
                  </div>
                  <p className="font-mono text-[11px] text-faint break-all">{c.worktreePath}</p>
                  <p className="text-muted">{c.reason}</p>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
