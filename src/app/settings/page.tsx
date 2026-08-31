import { Boxes, Database, Github, Palette } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getConnection, getCredentialSource } from "@/core/github/service";
import { describeSecret, SETTING_KEYS } from "@/core/settings/service";
import { GitHubTokenForm } from "@/components/settings/github-token-form";
import { GitHubConnect } from "@/components/settings/github-connect";
import { isDeviceFlowConfigured } from "@/core/github/device-flow";
import { UpdateCheck } from "@/components/settings/update-check";
import { APP_VERSION } from "@/config/app";
import { projectRepository } from "@/db/repositories";
import { resolveDatabasePath, resolveUploadsDir } from "@/db/path";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const [stats, github, tags, credentialSource] = await Promise.all([
    projectRepository.stats(),
    getConnection(),
    projectRepository.allTags(),
    getCredentialSource(),
  ]);

  const tokenStatus = describeSecret(SETTING_KEYS.githubToken);
  const canConnect = isDeviceFlowConfigured();

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
            ) : null}

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
