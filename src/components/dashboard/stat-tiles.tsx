import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Stat {
  label: string;
  value: number | string;
  href: string;
  icon: LucideIcon;
  hint?: string;
}

/**
 * Compact metric row. Values are links, because on a dashboard a number is only
 * useful if it takes you to the thing it counts.
 */
export function StatTiles({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2.5 md:grid-cols-3 lg:grid-cols-5">
      {stats.map((stat) => (
        <Link
          key={stat.label}
          href={stat.href}
          className={cn(
            "group rounded-xl border border-line bg-surface p-3.5 transition-colors min-h-[40px] md:min-h-0 min-w-0",
            "hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]",
          )}
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="truncate text-[11.5px] font-medium text-muted">{stat.label}</span>
            <stat.icon
              className="h-3.5 w-3.5 shrink-0 text-faint transition-colors group-hover:text-muted"
              strokeWidth={1.75}
            />
          </div>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-fg break-words">
            {stat.value}
          </p>
          {stat.hint ? (
            <p className="mt-0.5 text-[11px] text-faint break-words">{stat.hint}</p>
          ) : null}
        </Link>
      ))}
    </div>
  );
}
