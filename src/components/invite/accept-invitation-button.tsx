"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A real POST, not the GET that loaded this page — see the accept route's
 * own header comment for why a link click alone must never redeem it.
 */
export function AcceptInvitationButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not accept this invitation.");
        return;
      }
      router.push("/settings");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="primary" disabled={busy} onClick={accept}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Accept invitation
      </Button>
      {error ? <p className="text-[12px] text-red-400">{error}</p> : null}
    </div>
  );
}
