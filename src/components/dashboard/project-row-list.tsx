import Link from "next/link";
import { Github, Star } from "lucide-react";
import { STATUS_META } from "@/core/projects/labels";
import type { Project } from "@/core/projects/types";
import { Badge } from "@/components/ui/badge";
import { cn, formatRelative } from "@/lib/utils";

/**
 * Dense one-line project listing for dashboard panels, where a full card grid
 * would cost too much vertical space.
 */
export function ProjectRowList({
  projects,
  timestamp = "updated",
  empty,
}: {
  projects: Project[];
  timestamp?: "updated" | "opened";
  empty: string;
}) {
  if (projects.length === 0) {
    return <p className="px-4 py-8 text-center text-[13px] text-faint break-words">{empty}</p>;
  }

  return (
    <ul className="divide-y divide-[var(--border)] min-w-0">
      {projects.map((project) => (
        <li key={project.id} className="min-w-0">
          <Link
            href={`/projects/${project.id}`}
            className="flex items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-[var(--bg-subtle)] min-h-[40px] md:min-h-0 min-w-0"
          >
            {project.source === "github" ? (
              <Github className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={1.75} />
            ) : (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--border-strong)]"
                aria-hidden
              />
            )}

            <span className="min-w-0 flex-1 break-words text-[13px] text-fg">
              {project.name}
            </span>

            {project.favorite ? (
              <Star
                className="h-3 w-3 shrink-0 text-amber-400"
                fill="currentColor"
                strokeWidth={1.75}
              />
            ) : null}

            <Badge className={cn("shrink-0", STATUS_META[project.status].className)}>
              {STATUS_META[project.status].label}
            </Badge>

            <span className="hidden shrink-0 text-[11px] tabular-nums text-faint sm:inline">
              {formatRelative(
                timestamp === "opened" ? project.lastOpenedAt : project.updatedAt,
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
