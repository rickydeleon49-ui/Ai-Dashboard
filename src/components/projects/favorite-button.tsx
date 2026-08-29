"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Optimistic favorite toggle.
 *
 * Flips local state immediately, then reconciles with the server; on failure it
 * rolls back rather than leaving the star lying about the stored value.
 */
export function FavoriteButton({
  projectId,
  favorite,
  className,
  size = "sm",
}: {
  projectId: string;
  favorite: boolean;
  className?: string;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useState(favorite);
  const [, startTransition] = useTransition();

  async function toggle(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const next = !optimistic;
    setOptimistic(next);

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: next }),
      });
      if (!response.ok) throw new Error("Request failed");
      startTransition(() => router.refresh());
    } catch {
      setOptimistic(!next);
    }
  }

  const dimension = size === "md" ? "h-8 w-8" : "h-6.5 w-6.5";
  const icon = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={optimistic}
      aria-label={optimistic ? "Remove from favorites" : "Add to favorites"}
      title={optimistic ? "Remove from favorites" : "Add to favorites"}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md transition-colors",
        dimension,
        optimistic
          ? "text-amber-400 hover:bg-amber-400/10"
          : "text-faint hover:bg-[var(--bg-subtle)] hover:text-muted",
        className,
      )}
    >
      <Star
        className={icon}
        strokeWidth={1.75}
        fill={optimistic ? "currentColor" : "none"}
      />
    </button>
  );
}
