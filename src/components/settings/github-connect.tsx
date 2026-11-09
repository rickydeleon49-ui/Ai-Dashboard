"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, ExternalLink, Github, Loader2 } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Connects a GitHub account with the OAuth device flow.
 *
 * The person is shown a short code and a link; approving it in the browser
 * completes the connection here. Polling runs from the browser rather than the
 * server: GitHub dictates how often it may be asked, and a device code lives for
 * up to fifteen minutes — far too long to hold a request open.
 */
type Phase = "idle" | "waiting" | "done" | "error";

interface Started {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

type Outcome =
  | { kind: "authorized" }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until GitHub resolves the authorization, one way or another.
 *
 * Lives outside the component: it reads the clock and loops, neither of which
 * belongs in a render path. `cancelled` is a mutable flag the component flips on
 * unmount so a flow left behind stops asking GitHub.
 */
async function pollUntilResolved(
  started: Started,
  cancelled: { current: boolean },
): Promise<Outcome> {
  let seconds = started.interval;
  const deadline = Date.now() + started.expiresIn * 1000;

  while (!cancelled.current) {
    await sleep(seconds * 1000);
    if (cancelled.current) return { kind: "cancelled" };

    if (Date.now() > deadline) {
      return {
        kind: "failed",
        message: "The code expired before it was approved. Try connecting again.",
      };
    }

    let result: { status?: string; interval?: number; message?: string };
    try {
      const response = await fetch("/api/github/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode: started.deviceCode }),
      });
      result = await response.json();
    } catch {
      return {
        kind: "failed",
        message: "Lost contact with the server while waiting for GitHub.",
      };
    }

    switch (result.status) {
      case "authorized":
        return { kind: "authorized" };
      case "pending":
        break;
      case "slow_down":
        // GitHub sets the pace; ignoring it gets the flow rejected outright.
        seconds = result.interval ?? seconds + 5;
        break;
      case "denied":
        return { kind: "failed", message: "Authorization was declined on GitHub." };
      case "expired":
        return {
          kind: "failed",
          message: "The code expired before it was approved. Try again.",
        };
      default:
        return { kind: "failed", message: result.message ?? "Authorization failed." };
    }
  }

  return { kind: "cancelled" };
}

export function GitHubConnect({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [started, setStarted] = useState<Started | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cancelled = useRef(false);

  // A flow left running when the user navigates away must stop polling GitHub.
  useEffect(() => {
    const flag = cancelled;
    return () => {
      flag.current = true;
    };
  }, []);

  async function connect() {
    setPhase("waiting");
    setMessage(null);
    cancelled.current = false;

    let begun: Started;
    try {
      const response = await fetch("/api/github/device", { method: "POST" });
      const body = (await response.json()) as Started & { error?: string };

      if (!response.ok || body.error) {
        setPhase("error");
        setMessage(body.error ?? "Could not start the connection.");
        return;
      }
      begun = body;
    } catch {
      setPhase("error");
      setMessage("Could not reach the server.");
      return;
    }

    setStarted(begun);
    window.open(begun.verificationUri, "_blank", "noopener,noreferrer");

    const outcome = await pollUntilResolved(begun, cancelled);
    if (outcome.kind === "cancelled") return;

    if (outcome.kind === "authorized") {
      setPhase("done");
      setStarted(null);
      setMessage("Connected. Sync the hub to pull your repositories.");
      router.refresh();
      return;
    }

    setPhase("error");
    setMessage(outcome.message);
  }

  async function copyCode() {
    if (!started) return;
    try {
      await navigator.clipboard.writeText(started.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the code is on screen regardless.
    }
  }

  if (phase === "waiting" && started) {
    return (
      <div className="space-y-2.5 rounded-md border border-line bg-[var(--bg-subtle)] p-3 min-w-0">
        <p className="text-[12.5px] text-muted break-words">
          Enter this code on GitHub to finish connecting:
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border border-line bg-[var(--bg-elevated)] px-2.5 py-1.5 font-mono text-[15px] tracking-[0.2em] text-fg">
            {started.userCode}
          </code>
          <Button type="button" size="sm" className="min-h-[40px] md:min-h-0" onClick={copyCode}>
            {copied ? (
              <Check className="h-3 w-3 text-emerald-400" strokeWidth={2} />
            ) : (
              <Copy className="h-3 w-3" strokeWidth={1.75} />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
          <a
            href={started.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonClasses("secondary", "sm"), "min-h-[40px] md:min-h-0")}
          >
            <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
            Open GitHub
          </a>
        </div>

        <p className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
          Waiting for approval…
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 min-w-0">
      <Button
        type="button"
        variant={connected ? "secondary" : "primary"}
        className="min-h-[40px] md:min-h-0"
        onClick={connect}
      >
        <Github className="h-3.5 w-3.5" strokeWidth={1.75} />
        {connected ? "Reconnect with GitHub" : "Connect with GitHub"}
      </Button>

      {message ? (
        <p
          className={`text-[11.5px] leading-relaxed break-words ${
            phase === "error" ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
