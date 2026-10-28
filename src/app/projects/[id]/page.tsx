import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CircleDot,
  Cpu,
  ExternalLink,
  GitBranch,
  GitFork,
  GitPullRequest,
  Github,
  Lock,
  LogIn,
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
import { EmptyState } from "@/components/ui/empty-state";
import { knowledgeDocumentRepository, milestoneRepository, projectRepository, taskRepository } from "@/db/repositories";
import { resolveWorkspaceIdForPage } from "@/core/workspaces/current-workspace";
import type { ActivityItem } from "@/core/activity/service";
import { ProjectFiles } from "@/components/projects/project-files";
import { LocalActions } from "@/components/projects/local-actions";
import { SOURCE_META, STATUS_META, TYPE_META, languageColor } from "@/core/projects/labels";
import { MILESTONE_STATUS_META } from "@/core/tasks/labels";
import { githubLinks } from "@/core/github/types";
import type { Project, ProjectFile } from "@/core/projects/types";
import type { Milestone, Task } from "@/core/tasks/types";
import type { KnowledgeDocument } from "@/core/knowledge/types";
import { formatCompact, formatDate, formatRelative } from "@/lib/utils";
import { formatDueDate } from "@/lib/due-dates";
import { isAccountsMode } from "@/lib/auth-mode";

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
  const workspaceId = await resolveWorkspaceIdForPage();
  const project = workspaceId ? await projectRepository.findById(workspaceId, id) : null;
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
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    // Practically unreachable: proxy.ts already requires a session in
    // accounts mode, and sign-in always creates a personal workspace.
    return (
      <EmptyState
        icon={LogIn}
        title="Sign-in required"
        description="Sign in to see this project."
      />
    );
  }
  const project = await projectRepository.findById(workspaceId, id);
  if (!project) notFound();

  // Activity and file attachments are still SQLite-only, unscoped by
  // workspace (see proxy.ts's ACCOUNTS_MODE_ALLOWED_PAGES comment) — a
  // Postgres project's id never matches any SQLite row, so calling these
  // in accounts mode would just be a wasted, always-empty query.
  const [activity, files]: [ActivityItem[], ProjectFile[]] = isAccountsMode()
    ? [[], []]
    : await Promise.all([
        import("@/core/activity/service").then((m) => m.listProjectActivity(project.id, 15)),
        import("@/core/files/service").then((m) => m.listProjectFiles(project.id)),
      ]);
  const [milestones, tasks, knowledgeDocuments]: [Milestone[], Task[], KnowledgeDocument[]] = await Promise.all([
    milestoneRepository.list(workspaceId, project.id),
    taskRepository.list(workspaceId, project.id),
    knowledgeDocumentRepository.list(workspaceId, project.id),
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
        {/* The workspace reads the project from the URL, so this link is the
            whole of "open in AI" — no hidden state to set first. */}
        <Link
          href={`/ai/chat?project=${encodeURIComponent(project.id)}`}
          className={buttonClasses("secondary", "md")}
        >
          <Cpu className="h-3.5 w-3.5" strokeWidth={1.75} />
          Open in AI Workspace
        </Link>

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
          {/* Milestones & tasks */}
          <MilestonesTasksCard projectId={project.id} milestones={milestones} tasks={tasks} />

          {/* Knowledge base */}
          <KnowledgeBaseCard projectId={project.id} documents={knowledgeDocuments} />

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

          {isAccountsMode() ? null : (
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
          )}

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
                <LocalActions projectId={project.id} localPath={project.localPath} />
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

const DONE_TASK_STATUSES = new Set(["done", "cancelled"]);

/**
 * The grounded slice of "project overview" this release delivers — real
 * counts from the milestones/tasks domain (Phase 2, Release A), not a
 * placeholder. GitHub issues/PRs, deployment status, uptime and business
 * metrics are explicitly out of scope for this release; see the release
 * plan's own "explicitly deferred" list.
 */
function MilestonesTasksCard({
  projectId,
  milestones,
  tasks,
}: {
  projectId: string;
  milestones: Milestone[];
  tasks: Task[];
}) {
  const done = tasks.filter((t) => DONE_TASK_STATUSES.has(t.status)).length;
  const overdue = tasks.filter(
    (t) => t.dueDate && !DONE_TASK_STATUSES.has(t.status) && new Date(t.dueDate) < new Date(),
  ).length;
  const blocked = tasks.filter((t) => t.blocked).length;
  const upcomingMilestones = milestones
    .filter((m) => m.status === "open")
    .sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    })
    .slice(0, 3);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Milestones &amp; tasks</CardTitle>
        <Link
          href={`/projects/${projectId}/tasks`}
          className="text-[12px] text-muted transition-colors hover:text-fg"
        >
          Open
        </Link>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Detail label="Tasks">{tasks.length}</Detail>
          <Detail label="Done">
            {done}/{tasks.length}
          </Detail>
          <Detail label="Overdue">
            <span className={overdue > 0 ? "text-red-400" : undefined}>{overdue}</span>
          </Detail>
          <Detail label="Blocked">
            <span className={blocked > 0 ? "text-amber-300" : undefined}>{blocked}</span>
          </Detail>
        </div>

        {upcomingMilestones.length > 0 ? (
          <div className="space-y-1.5 border-t border-line pt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
              Upcoming milestones
            </p>
            <ul className="space-y-1">
              {upcomingMilestones.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[13px]">
                  <Link
                    href={`/projects/${projectId}/tasks`}
                    className="min-w-0 flex-1 truncate text-fg transition-colors hover:text-[var(--accent-text)]"
                  >
                    {m.title}
                  </Link>
                  <Badge className={MILESTONE_STATUS_META[m.status].className}>
                    {MILESTONE_STATUS_META[m.status].label}
                  </Badge>
                  {m.dueDate ? (
                    <span className="shrink-0 text-[11.5px] text-faint">{formatDueDate(m.dueDate)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : tasks.length === 0 && milestones.length === 0 ? (
          <p className="text-[13px] text-faint">
            No milestones or tasks yet. Break this project down to track real progress.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Doc count plus pinned/recently-updated titles, linking into the full
 * knowledge base — same shape as `MilestonesTasksCard` above (Phase 2,
 * Release B).
 */
function KnowledgeBaseCard({
  projectId,
  documents,
}: {
  projectId: string;
  documents: KnowledgeDocument[];
}) {
  const highlighted = [...documents]
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge base</CardTitle>
        <Link
          href={`/projects/${projectId}/knowledge`}
          className="text-[12px] text-muted transition-colors hover:text-fg"
        >
          Open
        </Link>
      </CardHeader>
      <CardBody className="space-y-3">
        <Detail label="Documents">{documents.length}</Detail>

        {highlighted.length > 0 ? (
          <ul className="space-y-1 border-t border-line pt-3">
            {highlighted.map((doc) => (
              <li key={doc.id} className="flex items-center gap-2 text-[13px]">
                <Link
                  href={`/projects/${projectId}/knowledge/${doc.id}/edit`}
                  className="min-w-0 flex-1 truncate text-fg transition-colors hover:text-[var(--accent-text)]"
                >
                  {doc.title}
                </Link>
                {doc.category ? <Badge>{doc.category}</Badge> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-faint">
            No documents yet. Keep notes, runbooks and decisions somewhere findable.
          </p>
        )}
      </CardBody>
    </Card>
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
