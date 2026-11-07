"use client";

import { useState } from "react";
import { FolderGit2, Plus, Trash2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import type { RootStatus } from "@/core/agents/roots";

export function WorkspaceRootsCard({
  roots,
  statuses,
  onAddRoot,
  onRemoveRoot,
  isSaving,
}: {
  roots: string[];
  statuses: RootStatus[];
  onAddRoot: (path: string) => Promise<string | null>;
  onRemoveRoot: (path: string) => Promise<void>;
  isSaving: boolean;
}) {
  const [candidatePath, setCandidatePath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!candidatePath.trim()) return;
    setError(null);
    const err = await onAddRoot(candidatePath.trim());
    if (err) {
      setError(err);
    } else {
      setCandidatePath("");
    }
  };

  const statusMap = new Map(statuses.map((s) => [s.path, s]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderGit2 className="h-4 w-4 text-faint" />
          Workspace Roots
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-muted">
          Designated folders where projects live on this machine (e.g. <code className="font-mono text-fg">H:\Ai Repo clones</code>). Registering a project outside every workspace root is strictly refused to protect system folders.
        </p>

        {/* Existing roots list */}
        {roots.length === 0 ? (
          <div className="rounded-md border border-dashed border-line p-4 text-center">
            <p className="text-[12.5px] text-faint">
              No workspace roots configured. Add a directory below to enable agent runs.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {roots.map((root) => {
              const status = statusMap.get(root);
              const available = status ? status.available : true;
              return (
                <div
                  key={root}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-[var(--bg-subtle)] px-3 py-2.5"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12px] text-fg truncate" title={root}>
                        {root}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      {available ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                          <CheckCircle2 className="h-3 w-3" />
                          Available
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-red-500 font-medium">
                          <AlertTriangle className="h-3 w-3" />
                          Drive unavailable
                        </span>
                      )}
                      {status?.drive ? (
                        <Badge className="text-[10px] py-0">
                          Drive: {status.drive}
                        </Badge>
                      ) : null}
                      {status?.fileSystem ? (
                        <Badge
                          className={`text-[10px] py-0 ${
                            status.fileSystem === "NTFS" || status.fileSystem === "APFS"
                              ? "text-muted"
                              : "text-amber-500 border-amber-500/30"
                          }`}
                        >
                          FS: {status.fileSystem}
                        </Badge>
                      ) : null}
                      {status?.warning ? (
                        <span className="text-[10.5px] text-amber-500">{status.warning}</span>
                      ) : null}
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRemoveRoot(root)}
                    disabled={isSaving}
                    className="h-7 px-2 text-faint hover:text-red-400 shrink-0"
                    title="Remove workspace root"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add root form */}
        <form onSubmit={handleAdd} className="space-y-2 pt-2 border-t border-line">
          <div className="flex items-center gap-2">
            <Input
              value={candidatePath}
              onChange={(e) => setCandidatePath(e.target.value)}
              placeholder="e.g. H:\Ai Repo clones or /Users/name/projects"
              disabled={isSaving}
              className="flex-1 font-mono text-[12px]"
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={isSaving || !candidatePath.trim()}
              className="gap-1.5 shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Root
            </Button>
          </div>
          {error ? (
            <p className="text-[11.5px] text-red-500 bg-red-500/5 border border-red-500/10 rounded px-2.5 py-1.5">
              {error}
            </p>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}
