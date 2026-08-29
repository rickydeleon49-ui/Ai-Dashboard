import Link from "next/link";
import {
  Archive,
  FolderPlus,
  GitBranch,
  PencilLine,
  RefreshCw,
  SquareArrowOutUpRight,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { ActivityItem } from "@/core/activity/service";
import { formatRelative } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  "project.created": FolderPlus,
  "project.updated": PencilLine,
  "project.status": GitBranch,
  "project.opened": SquareArrowOutUpRight,
  "project.archived": Archive,
  "project.deleted": Trash2,
  "github.synced": RefreshCw,
};

/** Chronological event list. Rows link to their project when one still exists. */
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-[13px] text-faint">
        Activity from across the dashboard will appear here.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-[var(--border)]">
      {items.map((item) => {
        const Icon = ICONS[item.type] ?? PencilLine;
        const body = (
          <>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
              {item.message}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-faint">
              {formatRelative(item.createdAt)}
            </span>
          </>
        );

        return (
          <li key={item.id}>
            {item.projectId ? (
              <Link
                href={`/projects/${item.projectId}`}
                className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-[var(--bg-subtle)]"
              >
                {body}
              </Link>
            ) : (
              <div className="flex items-start gap-2.5 px-4 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
