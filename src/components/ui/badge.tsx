import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Small ring-outlined label. Colour comes from the caller (see
 * `src/core/projects/labels.ts`) so that domain meaning lives with the domain.
 */
export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        "leading-4 ring-1 ring-inset whitespace-nowrap",
        "text-muted bg-[var(--bg-subtle)] ring-[var(--border)]",
        className,
      )}
      {...props}
    />
  );
}
