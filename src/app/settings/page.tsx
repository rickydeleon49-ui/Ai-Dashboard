import { Boxes, Cpu, Database, Github, Palette, Users } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getConnection, getCredentialSource } from "@/core/github/service";
import { describeSecret, SETTING_KEYS } from "@/core/settings/service";
import { GitHubTokenForm } from "@/components/settings/github-token-form";
import { GitHubConnect } from "@/components/settings/github-connect";
import {
  getClientId,
  getClientIdSource,
  isDeviceFlowConfigured,
} from "@/core/github/device-flow";
import { GitHubClientIdForm } from "@/components/settings/github-client-id-form";
import { UpdateCheck } from "@/components/settings/update-check";
import { APP_VERSION } from "@/config/app";
import { LOCAL_WORKSPACE_ID, projectRepository } from "@/db/repositories";
import { resolveDatabasePath, resolveUploadsDir } from "@/db/path";
import { LocalAiSettings } from "@/components/settings/local-ai-settings";
import { getAiOverview } from "@/core/ai/service";
import { WorkspaceManager } from "@/components/settings/workspace-manager";
import { CURRENT_WORKSPACE_COOKIE, resolveCurrentWorkspace } from "@/core/workspaces/current-workspace";
import type { WorkspaceWithRole } from "@/core/workspaces/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

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

  return { workspaces, currentId: current?.id ?? null };
}

export default async function SettingsPage() {
  const [stats, github, tags, credentialSource, ai, workspacesSection] = await Promise.all([
    projectRepository.stats(LOCAL_WORKSPACE_ID),
    getConnection(),
    projectRepository.allTags(LOCAL_WORKSPACE_ID),
    getCredentialSource(),
    getAiOverview(),
    getWorkspacesSection(),
  ]);

  const tokenStatus = describeSecret(SETTING_KEYS.githubToken);
  const canConnect = isDeviceFlowConfigured();
  const clientId = getClientId();
  const clientIdSource = getClientIdSource();

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

        {/* Spans both columns: it has more controls than anything else here,
            and squeezing them into half the width would wrap every label. */}
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
