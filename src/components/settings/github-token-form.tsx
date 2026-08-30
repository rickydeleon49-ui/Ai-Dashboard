"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { SecretStatus } from "@/core/settings/service";
import type { CredentialSource } from "@/core/github/provider";

/**
 * Saves a GitHub personal access token into the application's own settings.
 *
 * The stored token is never sent to the browser — the server returns only a
 * four-character hint, enough to tell one token from another. So this form has
 * two states: entering a new token, or confirming which one is already stored.
 */
export function GitHubTokenForm({
  status,
  credentialSource,
}: {
  status: SecretStatus;
  credentialSource: CredentialSource;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/settings/github-token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? "Could not save the token");
        return;
      }

      setToken("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/settings/github-token", { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {status.present ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-2">
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" strokeWidth={2} />
          <span className="text-[12.5px] text-fg">
            Token saved
            <span className="ml-1 font-mono text-faint">…{status.hint}</span>
          </span>
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
        </div>
      ) : credentialSource === "environment" ? (
        <p className="rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-2 text-[12.5px] text-muted">
          Using the <code className="font-mono text-[11.5px]">GITHUB_TOKEN</code>{" "}
          environment variable. Saving a token here will take precedence over it.
        </p>
      ) : null}

      <Field
        label={status.present ? "Replace token" : "Personal access token"}
        help="Stored on this machine only, and never shown again after saving."
      >
        <div className="flex gap-2">
          <Input
            name="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type={visible ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder="github_pat_… or ghp_…"
            className="font-mono text-[12px]"
          />
          <Button
            type="button"
            size="md"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide token" : "Show token"}
            title={visible ? "Hide token" : "Show token"}
          >
            {visible ? (
              <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
            ) : (
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </Button>
        </div>
      </Field>

      {error ? <p className="text-[11.5px] text-red-400">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy || !token.trim()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
          Save token
        </Button>
        {saved ? (
          <span className="text-[12px] text-emerald-400">
            Saved — sync the hub to pull your repositories.
          </span>
        ) : null}
      </div>

      <p className="text-[11.5px] leading-relaxed text-faint">
        Create one at{" "}
        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent-text)] hover:underline"
        >
          github.com/settings/tokens
        </a>
        . A fine-grained token needs repository access plus{" "}
        <strong className="font-medium text-muted">Contents: Read</strong> and{" "}
        <strong className="font-medium text-muted">Metadata: Read</strong>; a
        classic token needs the <code className="font-mono">repo</code> scope.
      </p>
    </form>
  );
}
