"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Pencil, Pin, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { KnowledgeDocument } from "@/core/knowledge/types";
import { cn, formatRelative } from "@/lib/utils";

/**
 * One document in a project's knowledge base — mirrors
 * `components/prompts/prompt-card.tsx`'s own structure (pin toggle,
 * expandable preview, edit/delete). There is no separate "view" page:
 * the edit page's textarea already shows the full content, same as prompts.
 */
export function KnowledgeDocumentCard({
  projectId,
  document,
}: {
  projectId: string;
  document: KnowledgeDocument;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(document.pinned);
  const [confirming, setConfirming] = useState(false);

  async function togglePinned() {
    const next = !pinned;
    setPinned(next);
    try {
      const response = await fetch(`/api/projects/${projectId}/knowledge/${document.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: next }),
      });
      if (!response.ok) throw new Error();
      router.refresh();
    } catch {
      setPinned(!next);
    }
  }

  async function remove() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    await fetch(`/api/projects/${projectId}/knowledge/${document.id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-line bg-surface transition-colors hover:border-[var(--border-strong)]">
      <div className="flex items-start gap-2.5 p-3.5">
        <button
          type="button"
          onClick={togglePinned}
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin document" : "Pin document"}
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
            pinned
              ? "text-amber-400 hover:bg-amber-400/10"
              : "text-faint hover:bg-[var(--bg-subtle)] hover:text-muted",
          )}
        >
          <Pin className="h-3.5 w-3.5" strokeWidth={1.75} fill={pinned ? "currentColor" : "none"} />
        </button>

        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-medium leading-snug text-fg">{document.title}</h3>

          {document.content ? (
            <p
              className={cn(
                "mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted",
                expanded ? "" : "line-clamp-2",
              )}
            >
              {document.content}
            </p>
          ) : (
            <p className="mt-1 text-[12.5px] text-faint">No content yet.</p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {document.category ? <Badge>{document.category}</Badge> : null}
            <span className="text-[11px] text-faint">{formatRelative(document.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 border-t border-line px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-faint transition-colors hover:text-fg"
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
            strokeWidth={1.75}
          />
          {expanded ? "Collapse" : "Show full"}
        </button>

        <Link
          href={`/projects/${projectId}/knowledge/${document.id}/edit`}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-faint transition-colors hover:text-fg"
        >
          <Pencil className="h-3 w-3" strokeWidth={1.75} />
          Edit
        </Link>

        <button
          type="button"
          onClick={remove}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-faint transition-colors hover:text-red-400"
        >
          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
          {confirming ? "Confirm" : "Delete"}
        </button>
      </div>
    </div>
  );
}
