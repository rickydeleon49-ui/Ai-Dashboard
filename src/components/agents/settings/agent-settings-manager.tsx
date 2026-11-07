"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ProviderProbesCard } from "./provider-probes-card";
import { WorkspaceRootsCard } from "./workspace-roots-card";
import { StorageSettingsCard } from "./storage-settings-card";
import type { AgentStorageSettings, RootStatus } from "@/core/agents/roots";
import type { ProviderProbeInfo } from "@/core/agents/provider-probes";

export function AgentSettingsManager({
  initialStorage,
  initialStatuses,
  initialProviders,
}: {
  initialStorage: AgentStorageSettings;
  initialStatuses: {
    workspaceRoots: RootStatus[];
    worktreeRoot: RootStatus;
    runStore: RootStatus;
  };
  initialProviders: ProviderProbeInfo[];
}) {
  const router = useRouter();
  const [storage, setStorage] = useState(initialStorage);
  const [statuses, setStatuses] = useState(initialStatuses);
  const [providers, setProviders] = useState(initialProviders);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      const res = await fetch("/api/agent-settings", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setStorage(data.storage);
        setStatuses(data.statuses);
        setProviders(data.providers);
      }
    } finally {
      setIsRefreshing(false);
      router.refresh();
    }
  };

  const handleAddRoot = async (newRoot: string): Promise<string | null> => {
    setIsSaving(true);
    try {
      const nextRoots = [...storage.workspaceRoots, newRoot];
      const res = await fetch("/api/agent-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceRoots: nextRoots }),
      });
      const data = await res.json();
      if (!res.ok) {
        return data.error ?? "Failed to add workspace root";
      }
      setStorage(data.storage);
      setStatuses(data.statuses);
      router.refresh();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Network error";
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveRoot = async (rootToRemove: string): Promise<void> => {
    setIsSaving(true);
    try {
      const nextRoots = storage.workspaceRoots.filter((r) => r !== rootToRemove);
      const res = await fetch("/api/agent-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceRoots: nextRoots }),
      });
      if (res.ok) {
        const data = await res.json();
        setStorage(data.storage);
        setStatuses(data.statuses);
        router.refresh();
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveWorktreeRoot = async (newWorktreeRoot: string): Promise<string | null> => {
    setIsSaving(true);
    try {
      const res = await fetch("/api/agent-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreeRoot: newWorktreeRoot }),
      });
      const data = await res.json();
      if (!res.ok) {
        return data.error ?? "Failed to save worktree root";
      }
      setStorage(data.storage);
      setStatuses(data.statuses);
      router.refresh();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Network error";
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <ProviderProbesCard
        providers={providers}
        onRefresh={refresh}
        isRefreshing={isRefreshing}
      />
      <WorkspaceRootsCard
        roots={storage.workspaceRoots}
        statuses={statuses.workspaceRoots}
        onAddRoot={handleAddRoot}
        onRemoveRoot={handleRemoveRoot}
        isSaving={isSaving}
      />
      <StorageSettingsCard
        worktreeRoot={storage.worktreeRoot}
        runStore={storage.runStore}
        worktreeStatus={statuses.worktreeRoot}
        runStoreStatus={statuses.runStore}
        onSaveWorktreeRoot={handleSaveWorktreeRoot}
        isSaving={isSaving}
      />
    </div>
  );
}
