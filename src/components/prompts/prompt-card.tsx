"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Copy,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import type { Prompt } from "@/core/prompts/types";
import { cn, formatRelative } from "@/lib/utils";

/**
 * One prompt in the library.
 *
 * Copying is the primary action and sits on the card, because that is what a
 * prompt library is for: the whole point is getting the text into wherever you
 * are working with one click, not reading it here.
 */
export function PromptCard({ prompt }: { prompt: Prompt }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [favorite, setFavorite] = useState(prompt.favorite);
  const [confirming, setConfirming] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be denied; expanding still shows the text.
      setExpanded(true);
    }
  }

  async function toggleFavorite() {
    const next = !favorite;
    setFavorite(next);
    try {
      const response = await fetch(`/api/prompts/${prompt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: next }),
      });
      if (!response.ok) throw new Error();
      router.refresh();
    } catch {
      setFavorite(!next);
    }
  }

  async function remove() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    await fetch(`/api/prompts/${prompt.id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-line bg-surface transition-colors hover:border-[var(--border-strong)]">
      <div className="flex items-start gap-2.5 p-3.5">
        <button
          type="button"
          onClick={toggleFavorite}
          aria-pressed={favorite}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
            favorite
              ? "text-amber-400 hover:bg-amber-400/10"
              : "text-faint hover:bg-[var(--bg-subtle)] hover:text-muted",
          )}
        >
          <Star
            className="h-3.5 w-3.5"
            strokeWidth={1.75}
            fill={favorite ? "currentColor" : "none"}
          />
        </button>

        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-medium leading-snug text-fg">
            {prompt.title}
          </h3>

          <p
            className={cn(
              "mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted",
              expanded ? "" : "line-clamp-2",
            )}
          >
            {prompt.body}
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {prompt.category ? <Badge>{prompt.category}</Badge> : null}
            {prompt.model ? <Badge className="text-faint">{prompt.model}</Badge> : null}
            <span className="text-[11px] text-faint">
              {formatRelative(prompt.updatedAt)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copy}
            title="Copy prompt"
            className={cn(
              buttonClasses(copied ? "secondary" : "primary", "sm"),
              "min-w-[4.5rem] justify-center",
            )}
          >
            {copied ? (
              <Check className="h-3 w-3" strokeWidth={2.25} />
            ) : (
              <Copy className="h-3 w-3" strokeWidth={1.75} />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
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
          href={`/ai/prompts/${prompt.id}/edit`}
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
