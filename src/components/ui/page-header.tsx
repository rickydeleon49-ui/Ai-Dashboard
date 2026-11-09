import * as React from "react";
import { cn } from "@/lib/utils";

/** Consistent title block for every page. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between min-w-0",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg break-words">{title}</h1>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted break-words">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2 min-w-0">{actions}</div>
      ) : null}
    </div>
  );
}
