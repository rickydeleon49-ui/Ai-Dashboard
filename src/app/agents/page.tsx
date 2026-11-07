import Link from "next/link";
import { notFound } from "next/navigation";
import { Bot } from "lucide-react";
import { isNotNull } from "drizzle-orm";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { RunForm, type ProviderOption } from "@/components/agents/runs/run-form";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projects } from "@/db/schema";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { listRuns } from "@/core/agents/runs";
import { claudeAdapter } from "@/core/agents/adapters/claude-code";
import { fakeAdapter } from "@/core/agents/adapters/fake";
import type { AgentAdapter } from "@/core/agents/adapters/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

async function describeProvider(adapter: AgentAdapter): Promise<ProviderOption> {
  try {
    const probe = await adapter.probe();
    const note = !probe.installed
      ? "not installed"
      : `installed${probe.version ? ` ${probe.version}` : ""}${probe.authenticated === false ? ", not signed in" : ""}`;
    return { id: adapter.id, label: adapter.displayName, note, usable: probe.installed && probe.authenticated !== false };
  } catch {
    return { id: adapter.id, label: adapter.displayName, note: "probe failed", usable: false };
  }
}

export default async function AgentsPage() {
  if (!isAgentRunsEnabled()) notFound();
  ensureDatabaseReady();

  const adapters: AgentAdapter[] = [claudeAdapter];
  if (process.env.NODE_ENV !== "production") adapters.push(fakeAdapter);

  const [providers, runs] = await Promise.all([
    Promise.all(adapters.map(describeProvider)),
    listRuns(db, { limit: 50 }),
  ]);

  const projectRows = db
    .select({ id: projects.id, name: projects.name, localPath: projects.localPath })
    .from(projects)
    .where(isNotNull(projects.localPath))
    .all()
    .filter((p) => (p.localPath ?? "").trim().length > 0);
  const nameById = new Map(
    db.select({ id: projects.id, name: projects.name }).from(projects).all().map((p) => [p.id, p.name]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Pick a local project and an implementer, then watch the plan, implement, check and review loop."
      />

      {projectRows.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No project with a local folder"
          description="Set a local folder on a project to start an agent run."
          action={<Link href="/projects" className="text-[13px] text-[var(--accent)]">Open projects</Link>}
        />
      ) : (
        <RunForm
          projects={projectRows.map((p) => ({ id: p.id, name: p.name }))}
          providers={providers}
          checkSuggestions={[]}
        />
      )}

      <section aria-labelledby="run-history">
        <h2 id="run-history" className="mb-2 text-[13px] font-semibold text-fg">
          Run history
        </h2>
        {runs.length === 0 ? (
          <p className="text-[13px] text-muted">No runs yet.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase text-faint">
                <tr>
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Project</th>
                  <th className="px-4 py-2">Task</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-line last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-muted">{run.createdAt.replace("T", " ").slice(0, 16)}</td>
                    <td className="px-4 py-2">{nameById.get(run.projectId) ?? run.projectId}</td>
                    <td className="max-w-md truncate px-4 py-2">
                      <Link href={`/agents/runs/${run.id}`} className="text-[var(--accent)] hover:underline">
                        {run.request?.task?.slice(0, 120) || run.id}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <Badge>{run.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}
