"use client";

import { useState } from "react";
import { HardDrive, CheckCircle2, AlertTriangle, ShieldCheck, Save } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import type { RootStatus } from "@/core/agents/roots";

export function StorageSettingsCard({
  worktreeRoot,
  runStore,
  worktreeStatus,
  runStoreStatus,
  onSaveWorktreeRoot,
  isSaving,
}: {
  worktreeRoot: string;
  runStore: string;
  worktreeStatus?: RootStatus;
  runStoreStatus?: RootStatus;
  onSaveWorktreeRoot: (newPath: string) => Promise<string | null>;
  isSaving: boolean;
}) {
  const [editingPath, setEditingPath] = useState(worktreeRoot);
  const [error, setError] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingPath.trim() === worktreeRoot) return;
    setError(null);
    setSavedSuccess(false);
    const err = await onSaveWorktreeRoot(editingPath.trim());
    if (err) {
      setError(err);
    } else {
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-faint" />
          Worktree & Run Storage
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Worktree Root */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] font-medium text-fg">Worktree Root</span>
            {worktreeStatus ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {worktreeStatus.available ? (
                  <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                    <CheckCircle2 className="h-3 w-3" />
                    Available
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-red-500 font-medium">
                    <AlertTriangle className="h-3 w-3" />
                    Missing
                  </span>
                )}
                {worktreeStatus.drive ? (
                  <Badge className="text-[10px] py-0">
                    Drive: {worktreeStatus.drive}
                  </Badge>
                ) : null}
                {worktreeStatus.fileSystem ? (
                  <Badge className="text-[10px] py-0">
                    FS: {worktreeStatus.fileSystem}
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>

          <form onSubmit={handleSave} className="flex items-center gap-2">
            <Input
              value={editingPath}
              onChange={(e) => {
                setEditingPath(e.target.value);
                setError(null);
              }}
              disabled={isSaving}
              className="flex-1 font-mono text-[12px]"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={isSaving || editingPath.trim() === worktreeRoot}
              className="gap-1.5 shrink-0"
            >
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
          </form>

          {worktreeStatus?.warning ? (
            <p className="text-[11px] text-amber-500">{worktreeStatus.warning}</p>
          ) : null}

          {savedSuccess ? (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              Worktree root saved successfully.
            </p>
          ) : null}

          {error ? (
            <p className="text-[11.5px] text-red-500 bg-red-500/5 border border-red-500/10 rounded px-2.5 py-1.5">
              {error}
            </p>
          ) : null}

          <p className="text-[11.5px] text-faint leading-relaxed">
            One worktree or snapshot per run is created in a dedicated <code className="font-mono">command-center</code> subfolder.
          </p>
        </div>

        {/* Run Control Storage (Read-only) */}
        <div className="space-y-1.5 pt-3 border-t border-line">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] font-medium text-fg flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-faint" />
              Run Control Storage
            </span>
            {runStoreStatus?.drive ? (
              <Badge className="text-[10px] py-0">
                Drive: {runStoreStatus.drive}
              </Badge>
            ) : null}
          </div>
          <div
            className="rounded-md border border-line bg-[var(--bg-subtle)] px-3 py-2 text-[12px] font-mono text-muted truncate"
            title={runStore}
          >
            {runStore}
          </div>
          <p className="text-[11.5px] text-faint leading-relaxed">
            Database, live event logs, and per-run permission grants live here on the system drive, kept isolated from code repositories.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
