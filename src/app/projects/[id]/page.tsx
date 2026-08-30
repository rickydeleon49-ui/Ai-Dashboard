import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CircleDot,
  ExternalLink,
  GitBranch,
  GitFork,
  GitPullRequest,
  Github,
  HardDrive,
  Lock,
  Pencil,
  Star as StarIcon,
  Unlock,
} from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { FavoriteButton } from "@/components/projects/favorite-button";
import {
  ArchiveButton,
  CopyButton,
  DeleteButton,
  OpenProjectButton,
} from "@/components/projects/project-actions";
import { ActivityFeed } from "@/components/dashboard/activity-feed";
import { projectRepository } from "@/db/repositories";
import { listProjectActivity } from "@/core/activity/service";
import { listProjectFiles } from "@/core/files/service";
import { ProjectFiles } from "@/components/projects/project-files";
import { SOURCE_META, STATUS_META, TYPE_META, languageColor } from "@/core/projects/labels";
import { githubLinks } from "@/core/github/types";
import type { Project } from "@/core/projects/types";
import { formatCompact, formatDate, formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface GithubMeta {
  fullName?: string;
  owner?: string;
  language?: string | null;
  stars?: number;
  forks?: number;
  openIssues?: number;
  isPrivate?: boolean;
  isFork?: boolean;
  defaultBranch?: string;
  htmlUrl?: string;
  topics?: string[];
  pushedAt?: string | null;
}

function githubMeta(project: Project): GithubMeta | null {
  const raw = project.metadata?.github;
  if (!raw || typeof raw !== "object") return null;
  return raw as GithubMeta;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await projectRepository.findById(id);
  return { title: project?.name ?? "Project" };
}

/**
 * One detail page for every project, regardless of source.
 *
 * Source-specific panels (the GitHub repository block, the uploaded-files block)
 * render only when their data exists — which is what makes the same page work
 * for GitHub, uploaded and manual projects without branching into three pages.
 */
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await projectRepository.findById(id);
  if (!project) notFound();

  const [activity, files] = await Promise.all([
    listProjectActivity(project.id, 15),
    listProjectFiles(project.id),
  ]);
  const status = STATUS_META[project.status];
  const gh = githubMeta(project);
  const repoUrl = project.repositoryUrl ?? gh?.htmlUrl ?? null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="space-y-3">
        <nav className="flex items-center gap-1.5 text-[12px] text-faint">
          <Link href="/projects" className="transition-colors hover:text-fg">
            Projects
          </Link>
          <span>/</span>
          <span className="text-muted">{SOURCE_META[project.source].label}</span>
        </nav>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {project.source === "github" ? (
                <Github className="h-4.5 w-4.5 shrink-0 text-muted" strokeWidth={1.75} />
              ) : null}
              <h1 className="text-xl font-semibold tracking-tight text-fg">
                {project.name}
              </h1>
              <FavoriteButton
                projectId={project.id}
                favorite={project.favorite}
                size="md"
              />
            </div>

            <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
              {project.description ?? "No description yet."}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge className={status.className}>{status.label}</Badge>
              <Badge>{SOURCE_META[project.source].label}</Badge>
              <Badge>{TYPE_META[project.type].label}</Badge>
              {project.archived ? <Badge>Archived</Badge> : null}
              {gh?.isPrivate !== undefined ? (
                <Badge>
                  {gh.isPrivate ? (
                    <Lock className="h-2.5 w-2.5" strokeWidth={2.25} />
                  ) : (
                    <Unlock className="h-2.5 w-2.5" strokeWidth={2.25} />
                  )}
                  {gh.isPrivate ? "Private" : "Public"}
                </Badge>
              ) : null}
              {project.tags.map((tag) => (
                <Link key={tag} href={`/projects?tag=${encodeURIComponent(tag)}`}>
                  <Badge className="transition-colors hover:text-fg">{tag}</Badge>
                </Link>
              ))}
            </div>
          </div>

          <Link
            href={`/projects/${project.id}/edit`}
            className={buttonClasses("secondary", "md")}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            Edit
          </Link>
        </div>
      </div>

      {/* Primary actions */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
        {project.projectUrl ? (
          <OpenProjectButton projectId={project.id} href={project.projectUrl}>
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
            Open Project
          </OpenProjectButton>
        ) : null}

        {repoUrl ? (
          <>
            <OpenProjectButton
              projectId={project.id}
              href={githubLinks.repo(repoUrl)}
              variant={project.projectUrl ? "secondary" : "primary"}
            >
              <Github className="h-3.5 w-3.5" strokeWidth={1.75} />
              Open GitHub
            </OpenProjectButton>

            <a
              href={githubLinks.issues(repoUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses("secondary", "md")}
            >
              <CircleDot className="h-3.5 w-3.5" strokeWidth={1.75} />
              Issues
              {gh?.openIssues ? (
                <span className="tabular-nums text-faint">{gh.openIssues}</span>
              ) : null}
            </a>

            <a
              href={githubLinks.pulls(repoUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses("secondary", "md")}
            >
              <GitPullRequest className="h-3.5 w-3.5" strokeWidth={1.75} />
              Pull requests
            </a>

            <a
              href={githubLinks.projects(repoUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses("secondary", "md")}
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              Projects
            </a>

            <CopyButton value={repoUrl} />
          </>
        ) : null}

        {!repoUrl && !project.projectUrl ? (
          <p className="px-1 text-[12.5px] text-faint">
            Add a repository or project URL to get one-click launch buttons here.
          </p>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <ArchiveButton project={project} />
          <DeleteButton project={project} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* GitHub repository panel */}
          {gh ? (
            <Card>
              <CardHeader>
                <CardTitle>Repository</CardTitle>
                {gh.fullName ? (
                  <span className="font-mono text-[11.5px] text-faint">
                    {gh.fullName}
                  </span>
                ) : null}
              </CardHeader>
              <CardBody className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                <Detail label="Language">
                  {gh.language ? (
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: languageColor(gh.language) }}
                        aria-hidden
                      />
                      {gh.language}
                    </span>
                  ) : (
                    "—"
                  )}
                </Detail>
                <Detail label="Stars">
                  <span className="flex items-center gap-1.5">
                    <StarIcon className="h-3 w-3 text-faint" strokeWidth={1.75} />
                    {formatCompact(gh.stars ?? 0)}
                  </span>
                </Detail>
                <Detail label="Forks">
                  <span className="flex items-center gap-1.5">
                    <GitFork className="h-3 w-3 text-faint" strokeWidth={1.75} />
                    {formatCompact(gh.forks ?? 0)}
                  </span>
                </Detail>
                <Detail label="Default branch">
                  <span className="flex items-center gap-1.5 font-mono text-[12px]">
                    <GitBranch className="h-3 w-3 text-faint" strokeWidth={1.75} />
                    {gh.defaultBranch ?? "main"}
                  </span>
                </Detail>
                <Detail label="Visibility">
                  {gh.isPrivate ? "Private" : "Public"}
                </Detail>
                <Detail label="Fork">{gh.isFork ? "Yes" : "No"}</Detail>
                <Detail label="Last push">{formatRelative(gh.pushedAt)}</Detail>
                <Detail label="Synced">{formatRelative(project.syncedAt)}</Detail>
              </CardBody>
            </Card>
          ) : null}

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
              <Link
                href={`/projects/${project.id}/edit`}
                className="text-[12px] text-muted transition-colors hover:text-fg"
              >
                Edit
              </Link>
            </CardHeader>
            <CardBody>
              {project.notes ? (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                  {project.notes}
                </p>
              ) : (
                <p className="text-[13px] text-faint">
                  No notes yet. Use notes for next steps, decisions and links you keep
                  losing.
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Files &amp; assets</CardTitle>
              {files.length > 0 ? (
                <span className="text-[12px] tabular-nums text-faint">
                  {files.length}
                </span>
              ) : null}
            </CardHeader>
            <CardBody>
              <ProjectFiles projectId={project.id} files={files} />
            </CardBody>
          </Card>

          {/* Activity */}
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <ActivityFeed items={activity} />
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <Detail label="Status">{status.label}</Detail>
              <Detail label="Type">{TYPE_META[project.type].label}</Detail>
              <Detail label="Source">{SOURCE_META[project.source].label}</Detail>
              <Detail label="Created">{formatDate(project.createdAt)}</Detail>
              <Detail label="Last updated">{formatRelative(project.updatedAt)}</Detail>
              <Detail label="Last opened">
                {formatRelative(project.lastOpenedAt)}
              </Detail>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Links</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2.5">
              <LinkRow label="Repository" href={project.repositoryUrl} />
              <LinkRow label="Project URL" href={project.projectUrl} />
              {project.localPath ? (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
                    Local path
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 break-all font-mono text-[12px] text-fg">
                    <HardDrive className="h-3 w-3 shrink-0 text-faint" strokeWidth={1.75} />
                    {project.localPath}
                  </p>
                </div>
              ) : null}
              {!project.repositoryUrl && !project.projectUrl && !project.localPath ? (
                <p className="text-[12.5px] text-faint">No links added yet.</p>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
        {label}
      </p>
      <div className="mt-0.5 text-[13px] text-fg">{children}</div>
    </div>
  );
}

function LinkRow({ label, href }: { label: string; href: string | null }) {
  if (!href) return null;
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
        {label}
      </p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 flex items-center gap-1.5 break-all text-[12.5px] text-[var(--accent-text)] transition-colors hover:underline"
      >
        <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.75} />
        {href.replace(/^https?:\/\//, "")}
      </a>
    </div>
  );
}
