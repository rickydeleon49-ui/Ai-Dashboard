import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { RunDismiss } from "@/components/agents/runs/run-dismiss";
import { RunLive } from "@/components/agents/runs/run-live";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getRun } from "@/core/agents/runs";
import { TERMINAL_STATUSES } from "@/core/agents/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent run" };

export default async function AgentRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isAgentRunsEnabled()) notFound();
  ensureDatabaseReady();

  const { id } = await params;
  const run = await getRun(db, id);
  if (!run) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent run"
        description={
          <>
            <span className="line-clamp-3 whitespace-pre-wrap">{run.request?.task}</span>
            <Link href="/agents" className="mt-1 inline-block text-[var(--accent)] hover:underline">
              Back to runs
            </Link>
          </>
        }
      />
      <RunDismiss
        runId={run.id}
        finished={(TERMINAL_STATUSES as readonly string[]).includes(run.status)}
        initialDismissedAt={run.dismissedAt}
      />
      <RunLive
        runId={run.id}
        initialStatus={run.status}
        initialOutcome={run.outcome}
        requiredChecks={run.request?.checks ?? []}
        hasReviewStage={Boolean(run.request?.roles?.planner || run.request?.roles?.reviewer)}
      />
    </div>
  );
}
