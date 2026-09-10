import Link from "next/link";
import { Settings2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { LocalAiWorkspace } from "@/components/ai/local-ai-workspace";
import { LOCAL_WORKSPACE_ID, projectRepository } from "@/db/repositories";
import { getAiOverview } from "@/core/ai/service";
import { listConversations, findConversation } from "@/core/ai/conversations";
import { buildProjectContext } from "@/core/projects/context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Local AI" };

/**
 * The local AI conversation surface.
 *
 * Which project and which conversation are open live in the URL, matching how
 * every other view in the dashboard works: the state is shareable, the back
 * button behaves, and the git branch is re-read on the server each time rather
 * than going stale in a client cache.
 */
export default async function LocalAiPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; c?: string }>;
}) {
  const params = await searchParams;
  const [overview, projects, conversations] = await Promise.all([
    getAiOverview(),
    projectRepository.list(LOCAL_WORKSPACE_ID, { sort: "updated" }),
    Promise.resolve(listConversations()),
  ]);

  const conversation = params.c ? findConversation(params.c) : null;

  // Precedence: the URL, then the conversation's own project, then wherever the
  // user was last. Only the first is something they just asked for.
  const requestedProjectId =
    params.project ?? conversation?.projectId ?? overview.settings.lastProjectId ?? "";
  const project = projects.find((entry) => entry.id === requestedProjectId) ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Local AI"
        description="Your own models, running on this machine, with your projects for context."
        actions={
          <Link href="/settings#local-ai" className={buttonClasses("secondary", "md")}>
            <Settings2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Local AI settings
          </Link>
        }
      />

      {overview.runtime === "hosted" ? (
        <Card>
          <CardBody className="space-y-1.5">
            <p className="text-[13px] font-medium text-fg">
              Local AI needs the desktop application
            </p>
            <p className="max-w-2xl text-[12.5px] leading-relaxed text-muted">
              This copy of Command Center is running on a server, which has no Ollama and
              no access to your machine. Open the desktop app to use your local models —
              everything else in the dashboard works the same in both.
            </p>
          </CardBody>
        </Card>
      ) : (
        <LocalAiWorkspace
          /* Remounts when the open conversation changes, so the transcript is
             seeded from the server instead of being merged into live state. */
          key={conversation?.id ?? "new"}
          overview={overview}
          projects={projects.map((entry) => ({ id: entry.id, name: entry.name }))}
          projectContext={project ? buildProjectContext(project) : null}
          conversations={conversations}
          conversation={conversation}
          projectId={project?.id ?? null}
          conversationId={conversation?.id ?? null}
        />
      )}
    </div>
  );
}
