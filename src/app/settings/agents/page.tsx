import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { getAgentStorageSettings, inspectRootStatus } from "@/core/agents/roots";
import { getProviderProbes } from "@/core/agents/provider-probes";
import { AgentSettingsManager } from "@/components/agents/settings/agent-settings-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent Settings" };

export default async function AgentSettingsPage() {
  if (!isAgentRunsEnabled()) {
    notFound();
  }

  const storage = await getAgentStorageSettings();
  const rootsStatus = storage.workspaceRoots.map((r) => inspectRootStatus(r));
  const worktreeStatus = inspectRootStatus(storage.worktreeRoot, {
    createdOnDemand: true,
  });
  const runStoreStatus = inspectRootStatus(storage.runStore, {
    createdOnDemand: true,
  });
  const providers = await getProviderProbes();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Settings"
        description="Configure workspace roots, worktrees, and inspect CLI provider readiness for autonomous agent runs."
      />
      <AgentSettingsManager
        initialStorage={storage}
        initialStatuses={{
          workspaceRoots: rootsStatus,
          worktreeRoot: worktreeStatus,
          runStore: runStoreStatus,
        }}
        initialProviders={providers}
      />
    </div>
  );
}
