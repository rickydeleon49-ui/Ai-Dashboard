"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { WorkspaceRole, WorkspaceWithRole } from "@/core/workspaces/types";

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export function WorkspaceManager({
  workspaces,
  currentId,
}: {
  workspaces: WorkspaceWithRole[];
  currentId: string | null;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchTo(workspaceId: string) {
    if (workspaceId === currentId) return;
    setSwitching(workspaceId);
    setError(null);
    try {
      const response = await fetch("/api/workspaces/current", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not switch workspaces");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSwitching(null);
    }
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not create the workspace");
        return;
      }
      setName("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-3 min-w-0">
      <ul className="space-y-1.5">
        {workspaces.map((workspace) => {
          const isCurrent = workspace.id === currentId;
          const isSwitching = switching === workspace.id;
          return (
            <li
              key={workspace.id}
              className="flex items-center justify-between gap-3 rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-2 min-w-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] text-fg">{workspace.name}</p>
                <p className="text-[11.5px] text-faint">
                  {workspace.kind === "personal" ? "Personal" : "Team"} ·{" "}
                  {ROLE_LABEL[workspace.role]}
                </p>
              </div>
              {isCurrent ? (
                <span className="flex shrink-0 items-center gap-1 text-[12px] text-emerald-400">
                  <Check className="h-3.5 w-3.5" strokeWidth={2} />
                  Current
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-[40px] md:min-h-0 shrink-0"
                  disabled={isSwitching}
                  onClick={() => switchTo(workspace.id)}
                >
                  {isSwitching ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Switch
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <form onSubmit={createWorkspace} className="flex flex-col gap-2 sm:flex-row sm:items-end min-w-0">
        <Field label="New team workspace" className="flex-1 min-w-0">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
            maxLength={100}
            required
            className="min-h-[40px] md:min-h-0"
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          className="min-h-[40px] md:min-h-0 shrink-0"
          disabled={creating || name.trim().length === 0}
        >
          {creating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          )}
          Create
        </Button>
      </form>

      {error ? <p className="text-[12px] text-red-400 break-words">{error}</p> : null}
    </div>
  );
}
