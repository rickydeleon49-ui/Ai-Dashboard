"use client";

import { useState } from "react";
import { ArrowUpRight, Loader2, RefreshCw } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UpdateStatus } from "@/core/updates/service";

/**
 * Reports whether a newer release exists.
 *
 * The check runs on demand rather than on page load: it is a network call to
 * GitHub, and nobody opens Settings expecting to wait for one.
 */
export function UpdateCheck({ version }: { version: string }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    try {
      const response = await fetch("/api/updates");
      setStatus((await response.json()) as UpdateStatus);
    } catch {
      setStatus({
        current: version,
        latest: null,
        updateAvailable: false,
        releasesUrl: "",
        detail: "Could not reach the server.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5 min-w-0">
      <div className="flex items-baseline justify-between gap-4 min-w-0">
        <span className="text-[12.5px] text-muted shrink-0">Version</span>
        <span className="font-mono text-[12px] text-fg min-w-0 truncate text-right">{version}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="min-h-[40px] md:min-h-0"
          onClick={check}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
          ) : (
            <RefreshCw className="h-3 w-3" strokeWidth={1.75} />
          )}
          Check for updates
        </Button>

        {status?.updateAvailable ? (
          <a
            href={status.releasesUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonClasses("primary", "sm"), "min-h-[40px] md:min-h-0")}
          >
            Get {status.latest}
            <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
          </a>
        ) : null}
      </div>

      {status?.detail ? (
        <p className="text-[11.5px] leading-relaxed text-faint break-words">{status.detail}</p>
      ) : null}
    </div>
  );
}
