import Link from "next/link";
import { CheckCircle2, Github, Info, KeyRound } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { RepoList, SyncButton } from "@/components/github/repo-list";
import { ProjectGrid } from "@/components/projects/project-card";
import { getConnection, listCachedRepositories } from "@/core/github/service";
import { projectRepository } from "@/db/repositories";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "GitHub" };

export default async function GitHubPage() {
  const [connection, repos, linkedProjects] = await Promise.all([
    getConnection(),
    listCachedRepositories(),
    projectRepository.list({ source: "github", sort: "updated" }),
  ]);

  const lastSync = repos.reduce<string | null>(
    (latest, repo) => (!latest || repo.syncedAt > latest ? repo.syncedAt : latest),
    null,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="GitHub Hub"
        description="Sync your repositories, pin the ones you care about, and open any of them in a click."
        actions={<SyncButton mode={connection.mode} />}
      />

      {/* Connection status */}
      <Card>
        <CardBody className="flex flex-wrap items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-[var(--bg-subtle)]">
            {connection.connected ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" strokeWidth={1.75} />
            ) : (
              <KeyRound className="h-4 w-4 text-amber-400" strokeWidth={1.75} />
            )}
          </span>

          <div className="min-w-56 flex-1">
            <p className="text-[13px] font-medium text-fg">
              {connection.connected
                ? `Connected${connection.account ? ` as @${connection.account.login}` : ""}`
                : "Not connected — showing demo repositories"}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
              {connection.detail}
            </p>

            {!connection.connected ? (
              <div className="mt-3 space-y-2 rounded-lg border border-line bg-[var(--bg-subtle)] p-3">
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
                  <Info className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                  Connect real repositories
                </p>
                <ol className="ml-4 list-decimal space-y-1 text-[12.5px] leading-relaxed text-muted">
                  <li>
                    Create a token at{" "}
                    <a
                      href="https://github.com/settings/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--accent-text)] hover:underline"
                    >
                      github.com/settings/tokens
                    </a>{" "}
                    with the <code className="font-mono text-[11.5px]">repo</code> scope.
                  </li>
                  <li>
                    Add{" "}
                    <code className="font-mono text-[11.5px]">GITHUB_TOKEN=…</code> to
                    your <code className="font-mono text-[11.5px]">.env.local</code> (or
                    Railway service variables).
                  </li>
                  <li>Restart the app and press Sync repositories.</li>
                </ol>
                <p className="text-[11.5px] text-faint">
                  Phase 2 replaces this with a full OAuth flow — the interface below
                  does not change when it lands.
                </p>
              </div>
            ) : null}
          </div>

          {lastSync ? (
            <div className="text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
                Last sync
              </p>
              <p className="text-[13px] text-fg">{formatRelative(lastSync)}</p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* Repositories on the dashboard */}
      {linkedProjects.length > 0 ? (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight text-fg">
              On your dashboard
              <span className="ml-1.5 tabular-nums text-faint">
                {linkedProjects.length}
              </span>
            </h2>
            <Link
              href="/projects?source=github"
              className="text-[12px] text-muted transition-colors hover:text-fg"
            >
              View in library
            </Link>
          </div>
          <ProjectGrid projects={linkedProjects} />
        </section>
      ) : null}

      {/* All synced repositories */}
      <section className="space-y-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          All repositories
        </h2>

        {repos.length === 0 ? (
          <EmptyState
            icon={Github}
            title="No repositories synced yet"
            description={
              connection.connected
                ? "Press Sync repositories to pull your GitHub account into the dashboard."
                : "Press Sync repositories to load the demo set, or add a GITHUB_TOKEN to pull your real account."
            }
          />
        ) : (
          <RepoList repos={repos} />
        )}
      </section>
    </div>
  );
}
