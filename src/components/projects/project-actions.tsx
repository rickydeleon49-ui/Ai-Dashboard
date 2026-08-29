"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Copy, Check, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Project } from "@/core/projects/types";

/** Copies text to the clipboard and confirms inline for a moment. */
export function CopyButton({
  value,
  label = "Copy repository URL",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the button simply does not confirm.
    }
  }

  return (
    <Button type="button" onClick={copy} title={label}>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2} />
      ) : (
        <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
      )}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function ArchiveButton({ project }: { project: Project }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        archived: !project.archived,
        // Archiving also moves the status, so the library reads consistently.
        ...(project.archived ? {} : { status: "archived" }),
      }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <Button type="button" onClick={toggle} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
      ) : project.archived ? (
        <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={1.75} />
      ) : (
        <Archive className="h-3.5 w-3.5" strokeWidth={1.75} />
      )}
      {project.archived ? "Restore" : "Archive"}
    </Button>
  );
}

export function DeleteButton({ project }: { project: Project }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setBusy(true);
    await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    router.push("/projects");
    router.refresh();
  }

  return (
    <Button type="button" variant="danger" onClick={remove} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
      ) : (
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
      )}
      {confirming ? "Click again to confirm" : "Delete"}
    </Button>
  );
}

/**
 * Records that the project was opened, then follows the link.
 *
 * The tracking call is fire-and-forget: opening the project must never wait on
 * (or be blocked by) the dashboard's own bookkeeping.
 */
export function OpenProjectButton({
  projectId,
  href,
  children,
  variant = "primary",
}: {
  projectId: string;
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();

  function onClick() {
    void fetch(`/api/projects/${projectId}/open`, { method: "POST" })
      .then(() => router.refresh())
      .catch(() => undefined);
  }

  return (
    <Button
      type="button"
      variant={variant}
      onClick={() => {
        onClick();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
    >
      {children}
    </Button>
  );
}
