"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Pencil, Pin, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/knowledge/markdown-view";
import type { KnowledgeDocument } from "@/core/knowledge/types";
import { cn, formatRelative } from "@/lib/utils";

/**
 * One document in a project's knowledge base — mirrors
 * `components/prompts/prompt-card.tsx`'s own structure (pin toggle,
 * expandable preview, edit/delete). Collapsed, it shows a plain-text summary
 * extracted on the server from the same Markdown tree the renderer uses;
 * expanded, it renders the document with `MarkdownView`. The title opens the
 * read-only document page. Viewers get no pin, edit or delete controls (the
 * API refuses those writes regardless).
 */
export function KnowledgeDocumentCard({
  projectId,
  document,
  summary,
  canEdit,
}: {
  projectId: string;
  document: KnowledgeDocument;
  summary: string;
  canEdit: boolean;
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
    <div className="min-w-0 rounded-xl border border-line bg-surface transition-colors hover:border-[var(--border-strong)]">
      <div className="flex items-start gap-2.5 p-3.5 min-w-0">
        {canEdit ? (
          <button
            type="button"
            onClick={togglePinned}
            aria-pressed={pinned}
            aria-label={pinned ? "Unpin document" : "Pin document"}
            className={cn(
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0 md:h-6 md:w-6",
              pinned
                ? "text-amber-400 hover:bg-amber-400/10"
                : "text-faint hover:bg-[var(--bg-subtle)] hover:text-muted",
            )}
          >
            <Pin className="h-3.5 w-3.5" strokeWidth={1.75} fill={pinned ? "currentColor" : "none"} />
          </button>
        ) : pinned ? (
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-amber-400" title="Pinned">
            <Pin className="h-3.5 w-3.5" strokeWidth={1.75} fill="currentColor" aria-label="Pinned" />
          </span>
        ) : null}

        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-medium leading-snug text-fg">
            <Link
              href={`/projects/${projectId}/knowledge/${document.id}`}
              className="break-words transition-colors hover:text-[var(--accent-text)]"
            >
              {document.title}
            </Link>
          </h3>

          {expanded ? (
            <MarkdownView source={document.content} className="mt-2 min-w-0 overflow-x-auto" />
          ) : summary ? (
            <p className="mt-1 line-clamp-2 break-words text-[12.5px] leading-relaxed text-muted">{summary}</p>
          ) : (
            <p className="mt-1 text-[12.5px] text-faint">No content yet.</p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {document.category ? <Badge className="break-words">{document.category}</Badge> : null}
            <span className="text-[11px] text-faint">{formatRelative(document.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-line px-2.5 py-1.5 min-w-0">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-faint transition-colors hover:text-fg min-h-[40px] md:min-h-0"
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
            strokeWidth={1.75}
          />
          {expanded ? "Collapse" : "Show full"}
        </button>

        {canEdit ? (
          <>
            <Link
              href={`/projects/${projectId}/knowledge/${document.id}/edit`}
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-faint transition-colors hover:text-fg min-h-[40px] md:min-h-0"
            >
              <Pencil className="h-3 w-3" strokeWidth={1.75} />
              Edit
            </Link>

            <button
              type="button"
              onClick={remove}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-faint transition-colors hover:text-red-400 min-h-[40px] md:min-h-0"
            >
              <Trash2 className="h-3 w-3" strokeWidth={1.75} />
              {confirming ? "Confirm" : "Delete"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
