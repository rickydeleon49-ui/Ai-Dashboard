import Link from "next/link";
import { Bot, Boxes, Cpu, Database, Download, Github, LogIn, Palette, Users } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { GitHubTokenForm } from "@/components/settings/github-token-form";
import { GitHubConnect } from "@/components/settings/github-connect";
import { GitHubClientIdForm } from "@/components/settings/github-client-id-form";
import { UpdateCheck } from "@/components/settings/update-check";
import { APP_VERSION } from "@/config/app";
import { projectRepository } from "@/db/repositories";
import { resolveDatabasePath, resolveUploadsDir } from "@/db/path";
import { LocalAiSettings } from "@/components/settings/local-ai-settings";
import { WorkspaceManager } from "@/components/settings/workspace-manager";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import {
  CURRENT_WORKSPACE_COOKIE,
  resolveCurrentWorkspace,
  resolveWorkspaceIdForPage,
} from "@/core/workspaces/current-workspace";
import type { WorkspaceRole, WorkspaceWithRole } from "@/core/workspaces/types";
import { ClaimOwnershipForm } from "@/components/settings/claim-ownership-form";
import { WorkspaceMembers } from "@/components/settings/workspace-members";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

/**
 * GitHub connection, Local AI, Storage and Application below are all
 * single-tenant/legacy surfaces — global settings (one shared GitHub token,
 * one Ollama config, SQLite file paths) that were never given a
 * workspace_id. In accounts mode they'd be the same page for every
 * signed-in user regardless of role or workspace, which for GitHub's token
 * specifically is a real "any signed-in viewer can see the operator's
 * rather than exposing them half-scoped, matching proxy.ts's route
 * allowlist for the same domains.
 */
import { isAccountsMode } from "@/lib/auth-mode";

/**
 * Hosted multi-user mode only (AUTH_MODE=accounts) — desktop and today's
 * single-password hosted mode have no accounts or workspaces at all, so
 * this returns null there rather than rendering an empty or broken card.
 * `@/auth` and the workspace service are both dynamically imported for
 * the same reason proxy.ts's handleAccountsMode imports them dynamically:
 * this function is only ever reached in accounts mode, but a static
 * import would pull Auth.js and the Postgres client into every build.
 */
async function getWorkspacesSection(): Promise<{
  workspaces: WorkspaceWithRole[];
  currentId: string | null;
  currentUserId: string | null;
  currentRole: WorkspaceRole;
} | null> {
  if (process.env.AUTH_MODE !== "accounts" || !process.env.DATABASE_URL) return null;

  const [{ auth }, { listWorkspacesForUser }, { cookies }] = await Promise.all([
    import("@/auth"),
    import("@/core/workspaces/service"),
    import("next/headers"),
  ]);

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const workspaces = await listWorkspacesForUser(userId, 50);
  const cookieStore = await cookies();
  const current = resolveCurrentWorkspace(
    workspaces,
    cookieStore.get(CURRENT_WORKSPACE_COOKIE)?.value,
  );

  return {
    workspaces,
    currentId: current?.id ?? null,
    currentUserId: userId,
    currentRole: (current?.role as WorkspaceRole) ?? "viewer",
  };
}

/**
 * True only while there is something left to claim: accounts mode is on,
 * this deployment still has a DASHBOARD_PASSWORD configured (proof it was
 * once single-password hosted), and nobody has claimed it yet. Once claimed,
 * the card simply stops rendering — see src/core/ownership-claim/service.ts
 * for why a second attempt would fail anyway even without this check.
 */
async function shouldShowClaimOwnership(): Promise<boolean> {
  if (process.env.AUTH_MODE !== "accounts" || !process.env.DATABASE_URL) return false;
  if (!process.env.DASHBOARD_PASSWORD?.trim()) return false;

  const { isAlreadyClaimed } = await import("@/core/ownership-claim/service");
  return !(await isAlreadyClaimed());
}

export default async function SettingsPage() {
  const accountsMode = isAccountsMode();
  const agentRunsEnabled = isAgentRunsEnabled();
  const workspaceId = await resolveWorkspaceIdForPage();
  if (!workspaceId) {
    // Practically unreachable: proxy.ts already requires a session in
    // accounts mode, and sign-in always creates a personal workspace.
    return (
      <div className="space-y-5">
        <PageHeader title="Settings" />
        <EmptyState icon={LogIn} title="Sign-in required" description="Sign in to see your settings." />
      </div>
    );
  }

  const [stats, tags, github, credentialSource, ai, workspacesSection, showClaimOwnership] =
    await Promise.all([
      projectRepository.stats(workspaceId),
      projectRepository.allTags(workspaceId),
      // These are global, single-tenant surfaces (see isAccountsMode's own
      // comment) — skipped entirely in accounts mode rather than fetched
      // and merely hidden, since getAiOverview in particular does real
      // local-network work (checking for a local Ollama) this deployment
      // shape never has.
      accountsMode ? null : import("@/core/github/service").then((m) => m.getConnection()),
      accountsMode ? null : import("@/core/github/service").then((m) => m.getCredentialSource()),
      accountsMode ? null : import("@/core/ai/service").then((m) => m.getAiOverview()),
      getWorkspacesSection(),
      shouldShowClaimOwnership(),
    ]);

  const tokenStatus = accountsMode
    ? { present: false, hint: null }
    : (await import("@/core/settings/service")).describeSecret(
        (await import("@/core/settings/service")).SETTING_KEYS.githubToken,
      );
  const canConnect = accountsMode
    ? false
    : (await import("@/core/github/device-flow")).isDeviceFlowConfigured();
  const clientId = accountsMode
    ? ""
    : (await import("@/core/github/device-flow")).getClientId();
  const clientIdSource = accountsMode
    ? ("none" as const)
    : (await import("@/core/github/device-flow")).getClientIdSource();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="How this dashboard is configured and where its data lives."
      />

      {/* items-start so a tall card does not stretch its neighbour. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Palette className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
              Appearance
            </CardTitle>
          </CardHeader>
          <CardBody className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[13px] text-fg">Color theme</p>
              <p className="text-[12px] text-muted">
                Dark by default. System follows your OS preference.
              </p>
            </div>
            <ThemeToggle />
          </CardBody>
        </Card>

        {github && credentialSource ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Github className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                GitHub
              </CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <Row label="Status" value={github.connected ? "Connected" : "Not connected"} />
              <Row label="Mode" value={github.mode} />
              {github.account ? <Row label="Account" value={`@${github.account.login}`} /> : null}
              <p className="text-[12px] leading-relaxed text-muted">{github.detail}</p>

              {canConnect ? (
                <div className="border-t border-line pt-3">
                  <GitHubConnect connected={github.connected} />
                </div>
              ) : (
                /* Without a client id there is nothing to connect to, so the
                   setup is shown outright rather than hidden behind a summary. */
                <div className="border-t border-line pt-3">
                  <GitHubClientIdForm clientId={clientId} source={clientIdSource} />
                </div>
              )}

              <details className="border-t border-line pt-3">
                <summary className="cursor-pointer text-[12.5px] text-muted transition-colors hover:text-fg">
                  {canConnect
                    ? "Use a personal access token instead"
                    : "Connect with a personal access token"}
                </summary>
                <div className="pt-3">
                  <GitHubTokenForm
                    status={tokenStatus}
                    credentialSource={credentialSource}
                  />
                </div>
              </details>

              {canConnect ? (
                <details className="border-t border-line pt-3">
                  <summary className="cursor-pointer text-[12.5px] text-muted transition-colors hover:text-fg">
                    OAuth app
                  </summary>
                  <div className="pt-3">
                    <GitHubClientIdForm clientId={clientId} source={clientIdSource} />
                  </div>
                </details>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {workspacesSection ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                Workspaces
              </CardTitle>
            </CardHeader>
            <CardBody>
              <WorkspaceManager
                workspaces={workspacesSection.workspaces}
                currentId={workspacesSection.currentId}
              />
            </CardBody>
          </Card>
        ) : null}

        {accountsMode && workspacesSection?.currentId ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                Workspace Members
              </CardTitle>
            </CardHeader>
            <CardBody>
              <WorkspaceMembers
                workspaceId={workspacesSection.currentId}
                callerRole={workspacesSection.currentRole}
                currentUserId={workspacesSection.currentUserId}
              />
            </CardBody>
          </Card>
        ) : null}

        {showClaimOwnership ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                Claim legacy data
              </CardTitle>
            </CardHeader>
            <CardBody>
              <ClaimOwnershipForm />
            </CardBody>
          </Card>
        ) : null}

        {/* Spans both columns: it has more controls than anything else here,
            and squeezing them into half the width would wrap every label. */}
        {ai ? (
          <Card id="local-ai" className="lg:col-span-2 scroll-mt-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                Local AI
              </CardTitle>
            </CardHeader>
            <CardBody>
              <LocalAiSettings overview={ai} />
            </CardBody>
          </Card>
        ) : null}

        {accountsMode ? null : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Database className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                Storage
              </CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              <Row label="Database" value={resolveDatabasePath()} mono />
              <Row label="Uploads" value={resolveUploadsDir()} mono />
              <p className="pt-1 text-[12px] leading-relaxed text-muted">
                Both are set by <code className="font-mono">DATABASE_PATH</code> and{" "}
                <code className="font-mono">UPLOADS_DIR</code>. On Railway, point them at a
                mounted volume so your data survives redeploys.
              </p>
            </CardBody>
          </Card>
        )}

        {accountsMode ? null : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Boxes className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                Application
              </CardTitle>
            </CardHeader>
            <CardBody>
              <UpdateCheck version={APP_VERSION} />
            </CardBody>
          </Card>
        )}

        {agentRunsEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Bot className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
                Agent Workflow
              </CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <p className="text-[12px] leading-relaxed text-muted">
                Configure workspace roots, isolated worktree roots, and inspect CLI provider readiness for autonomous agent runs.
              </p>
              <div>
                <Link
                  href="/settings/agents"
                  className={buttonClasses("secondary", "sm")}
                >
                  Configure Agent Settings
                </Link>
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Library</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2">
            <Row label="Projects" value={String(stats.total)} />
            <Row label="Archived" value={String(stats.archived)} />
            <Row label="GitHub" value={String(stats.github)} />
            <Row label="Uploaded" value={String(stats.uploaded)} />
            <Row label="Manual" value={String(stats.manual)} />
            <Row label="Tags" value={String(tags.length)} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-[12.5px] text-muted">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[12.5px] text-fg ${mono ? "font-mono text-[11.5px]" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
