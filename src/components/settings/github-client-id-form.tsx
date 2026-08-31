"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { ClientIdSource } from "@/core/github/device-flow";

/**
 * One-time setup for "Connect with GitHub".
 *
 * The client id is public by design, so unlike the access token it is shown in
 * full: being able to read it back is how someone confirms it matches the OAuth
 * app they created, and hiding a value that is not secret only makes the screen
 * harder to reason about.
 */
export function GitHubClientIdForm({
  clientId,
  source,
}: {
  clientId: string | null;
  source: ClientIdSource;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/settings/github-client-id", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: value }),
      });
      const body = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? "Could not save the Client ID");
        return;
      }

      setValue("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await fetch("/api/settings/github-client-id", { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      {clientId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-2">
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" strokeWidth={2} />
          <span className="min-w-0 text-[12.5px] text-fg">
            <span className="font-mono text-[11.5px]">{clientId}</span>
            <span className="ml-1.5 text-faint">
              {source === "environment" ? "from GITHUB_CLIENT_ID" : "saved here"}
            </span>
          </span>
          {source === "settings" ? (
            <Button
              type="button"
              size="sm"
              variant="danger"
              className="ml-auto"
              onClick={clear}
              disabled={busy}
            >
              <Trash2 className="h-3 w-3" strokeWidth={1.75} />
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}

      <Field
        label={clientId ? "Replace Client ID" : "OAuth app Client ID"}
        help={
          clientId
            ? undefined
            : "Enables Connect with GitHub. Needed once per machine."
        }
      >
        <Input
          name="clientId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Ov23li… or Iv1.…"
          className="font-mono text-[12px]"
        />
      </Field>

      {error ? <p className="text-[11.5px] text-red-400">{error}</p> : null}

      <Button type="submit" variant="primary" size="sm" disabled={busy || !value.trim()}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} /> : null}
        Save Client ID
      </Button>

      <p className="text-[11.5px] leading-relaxed text-faint">
        Create an OAuth app at{" "}
        <a
          href="https://github.com/settings/developers"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent-text)] hover:underline"
        >
          github.com/settings/developers
        </a>
        . The callback URL is required by the form but unused —{" "}
        <code className="font-mono">http://localhost</code> is fine. Tick{" "}
        <strong className="font-medium text-muted">Enable Device Flow</strong>, and
        leave <strong className="font-medium text-muted">Expire user access tokens</strong>{" "}
        unticked. No client secret is needed.
      </p>
    </form>
  );
}
