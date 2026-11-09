import Link from "next/link";
import { GitFork, Github, Lock, Star as StarIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FavoriteButton } from "./favorite-button";
import { SOURCE_META, STATUS_META, languageColor } from "@/core/projects/labels";
import type { Project } from "@/core/projects/types";
import { cn, formatCompact, formatRelative } from "@/lib/utils";

/** GitHub fields cached on `project.metadata.github` by the sync service. */
interface GithubMeta {
  language?: string | null;
  stars?: number;
  forks?: number;
  isPrivate?: boolean;
  defaultBranch?: string;
}

function githubMeta(project: Project): GithubMeta | null {
  const raw = project.metadata?.github;
  if (!raw || typeof raw !== "object") return null;
  return raw as GithubMeta;
}

/**
 * The single project card used everywhere — dashboard, library, favorites and
 * search results — for GitHub, uploaded and manual projects alike. Source-specific
 * detail (language dot, stars, private lock) renders only when present.
 */
export function ProjectCard({ project }: { project: Project }) {
  const status = STATUS_META[project.status];
  const source = SOURCE_META[project.source];
  const gh = githubMeta(project);

  return (
    <Link
      href={`/projects/${project.id}`}
      className={cn(
        "group relative flex flex-col rounded-xl border border-line bg-surface p-3.5 min-w-0",
        "transition-all duration-150 hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]",
      )}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {project.source === "github" ? (
              <Github className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={1.75} />
            ) : null}
            <h3 className="break-words text-[13.5px] font-medium leading-snug text-fg">
              {project.name}
            </h3>
            {gh?.isPrivate ? (
              <Lock className="h-3 w-3 shrink-0 text-faint" strokeWidth={2} />
            ) : null}
          </div>

          <p className="mt-1 line-clamp-2 min-h-[2.4em] text-[12.5px] leading-[1.45] text-muted break-words">
            {project.description ?? "No description yet."}
          </p>
        </div>

        <FavoriteButton
          projectId={project.id}
          favorite={project.favorite}
          className="-mr-1 -mt-1"
        />
      </div>

      {project.tags.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1 min-w-0">
          {project.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} className="break-words">{tag}</Badge>
          ))}
          {project.tags.length > 4 ? (
            <Badge className="text-faint">+{project.tags.length - 4}</Badge>
          ) : null}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-3 text-[11px] text-faint min-w-0">
        <Badge className={status.className}>{status.label}</Badge>
        <Badge>{source.label}</Badge>

        {gh?.language ? (
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: languageColor(gh.language) }}
              aria-hidden
            />
            <span className="break-words">{gh.language}</span>
          </span>
        ) : null}

        {gh?.stars ? (
          <span className="flex items-center gap-1 shrink-0">
            <StarIcon className="h-3 w-3" strokeWidth={1.75} />
            {formatCompact(gh.stars)}
          </span>
        ) : null}

        {gh?.forks ? (
          <span className="flex items-center gap-1 shrink-0">
            <GitFork className="h-3 w-3" strokeWidth={1.75} />
            {formatCompact(gh.forks)}
          </span>
        ) : null}

        <span className="ml-auto whitespace-nowrap">
          {formatRelative(project.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

/** Responsive grid wrapper, so every listing shares one set of breakpoints. */
export function ProjectGrid({ projects }: { projects: Project[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-w-0">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}
