"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

/**
 * Shown only while there is something to claim (see getOwnershipClaimSection
 * in src/app/settings/page.tsx) — a fresh accounts-mode deployment with no
 * prior DASHBOARD_PASSWORD-protected data never renders this at all.
 */
export function ClaimOwnershipForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<{ projectsImported: number } | null>(null);

  async function claim(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ownership-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await response.json()) as { error?: string; projectsImported?: number };
      if (!response.ok) {
        setError(body.error ?? "Could not claim this deployment's data.");
        return;
      }
      setClaimed({ projectsImported: body.projectsImported ?? 0 });
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (claimed) {
    return (
      <p className="text-[13px] text-fg">
        Claimed {claimed.projectsImported} project{claimed.projectsImported === 1 ? "" : "s"} into
        your personal workspace.
      </p>
    );
  }

  return (
    <form onSubmit={claim} className="space-y-3">
      <p className="text-[12px] leading-relaxed text-muted">
        This deployment has existing single-password data. Enter its dashboard password once to
        import it into your own workspace — this can only be done by one account, one time.
      </p>
      <Field label="Dashboard password">
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy || !password}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Claim this deployment&rsquo;s data
      </Button>
      {error ? <p className="text-[12px] text-red-400">{error}</p> : null}
    </form>
  );
}
