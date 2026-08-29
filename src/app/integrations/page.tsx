import Link from "next/link";
import { CheckCircle2, Circle, Plug } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { getConnection } from "@/core/github/service";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const github = await getConnection();

  const integrations = [
    {
      name: "GitHub",
      description:
        "Repository listing, metadata, sync and one-click open. Personal access token today, OAuth in Phase 2.",
      connected: github.connected,
      detail: github.detail,
      href: "/github",
      phase: 1,
    },
    {
      name: "Local files",
      description:
        "Upload ZIPs, folders, documents and scripts, and attach them to any project.",
      connected: false,
      detail: "Storage layer and project_files table are in place; the UI lands in Phase 3.",
      href: "/uploads",
      phase: 3,
    },
    {
      name: "Claude / Anthropic API",
      description:
        "Assistants, generated documentation and AI workflows driven by the Claude API.",
      connected: false,
      detail: "Arrives with the AI workspace in Phase 4.",
      href: "/ai",
      phase: 4,
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        description="External services this dashboard connects to. Each one is a provider behind a stable interface, so adding another does not change the UI."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {integrations.map((integration) => (
          <Card key={integration.name}>
            <CardBody className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Plug className="h-4 w-4 text-muted" strokeWidth={1.75} />
                  <span className="text-[13.5px] font-medium text-fg">
                    {integration.name}
                  </span>
                </div>
                <span
                  className={cn(
                    "flex items-center gap-1 text-[11.5px]",
                    integration.connected ? "text-emerald-400" : "text-faint",
                  )}
                >
                  {integration.connected ? (
                    <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                  ) : (
                    <Circle className="h-3 w-3" strokeWidth={2} />
                  )}
                  {integration.connected
                    ? "Connected"
                    : integration.phase > 1
                      ? `Phase ${integration.phase}`
                      : "Not connected"}
                </span>
              </div>

              <p className="text-[12.5px] leading-relaxed text-muted">
                {integration.description}
              </p>
              <p className="text-[11.5px] leading-relaxed text-faint">
                {integration.detail}
              </p>

              <Link href={integration.href} className={buttonClasses("secondary", "sm")}>
                Open
              </Link>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
