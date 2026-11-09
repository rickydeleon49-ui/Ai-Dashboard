"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Dismiss / Restore for a finished run, plus the muted "Dismissed on <date>" line. */
export function RunDismiss({
  runId,
  finished,
  initialDismissedAt,
}: {
  runId: string;
  finished: boolean;
  initialDismissedAt: string | null;
}) {
  const router = useRouter();
  const [dismissedAt, setDismissedAt] = useState<string | null>(initialDismissedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!finished && !dismissedAt) return null;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/dismiss`, {
        method: dismissedAt ? "DELETE" : "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not change the run");
        return;
      }
      setDismissedAt(data.run?.dismissedAt ?? null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="min-h-[40px] md:min-h-0"
        onClick={toggle}
        disabled={busy}
      >
        {dismissedAt ? "Restore" : "Dismiss"}
      </Button>
      {dismissedAt ? (
        <span className="text-[12px] text-muted">Dismissed on {dismissedAt.slice(0, 10)}</span>
      ) : null}
      {error ? <span className="break-words text-[12px] text-red-500">{error}</span> : null}
    </div>
  );
}
