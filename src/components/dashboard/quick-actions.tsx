import Link from "next/link";
import { QUICK_ACTIONS } from "@/config/quick-actions";
import { cn } from "@/lib/utils";

/** Frequently used entry points. Later-phase actions are shown but muted. */
export function QuickActions() {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
      {QUICK_ACTIONS.map((action) => {
        const upcoming = action.phase > 1;
        return (
          <Link
            key={action.label}
            href={action.href}
            className={cn(
              "group flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 min-h-[40px] md:min-h-0 min-w-0",
              "transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]",
              upcoming && "opacity-65",
            )}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-[var(--bg-subtle)] transition-colors group-hover:border-[var(--accent)]/40 group-hover:bg-[var(--accent-soft)]">
              <action.icon
                className="h-3.5 w-3.5 text-muted transition-colors group-hover:text-[var(--accent-text)]"
                strokeWidth={1.75}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-[13px] font-medium text-fg">
                  {action.label}
                </span>
                {upcoming ? (
                  <span className="shrink-0 rounded bg-[var(--bg-subtle)] px-1 py-px text-[9px] font-medium uppercase tracking-wide text-faint">
                    P{action.phase}
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-[11.5px] text-faint">
                {action.description}
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
