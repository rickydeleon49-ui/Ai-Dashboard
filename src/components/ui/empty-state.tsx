import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The default for any section with nothing in it yet.
 *
 * Empty states carry the weight of a growing app: each one says what the
 * section is for and offers the action that fills it.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-line",
        "bg-surface/40 px-6 py-14 text-center",
        className,
      )}
    >
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-[var(--bg-subtle)]">
        <Icon className="h-4.5 w-4.5 text-muted" strokeWidth={1.75} />
      </div>
      <h3 className="text-sm font-medium text-fg">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
