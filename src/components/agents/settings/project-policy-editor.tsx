"use client";

import { useState } from "react";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { ProjectPolicy } from "@/core/agents/policy";
import { MAX_POLICY_CHECKS, MAX_EXCLUDED_PATHS, MAX_DEPENDENCY_LINKS } from "@/core/agents/policy-limits";
import {
  argvToText,
  textToArgv,
  isPolicyDirty,
} from "@/components/agents/settings/policy-form";

interface FormCheck {
  name: string;
  command: string;
  timeoutSec: number;
  required: boolean;
}

export interface ProjectPolicyEditorProps {
  projectId: string;
  initialPolicy: ProjectPolicy | null;
  loadError: string | null;
}

export function ProjectPolicyEditor({
  projectId,
  initialPolicy,
  loadError,
}: ProjectPolicyEditorProps) {
  if (loadError) {
    return (
      <p role="alert" className="text-[13px] text-red-500">
        {loadError}
      </p>
    );
  }

  if (!initialPolicy) {
    return (
      <p role="alert" className="text-[13px] text-red-500">
        Failed to load project policy.
      </p>
    );
  }

  return <PolicyForm projectId={projectId} initialPolicy={initialPolicy} />;
}

function PolicyForm({
  projectId,
  initialPolicy,
}: {
  projectId: string;
  initialPolicy: ProjectPolicy;
}) {
  const [savedPolicy, setSavedPolicy] = useState<ProjectPolicy>(initialPolicy);
  const [checks, setChecks] = useState<FormCheck[]>(() =>
    initialPolicy.checks.map((c) => ({
      name: c.name,
      command: argvToText(c.argv),
      timeoutSec: c.timeoutSec,
      required: c.required,
    })),
  );
  const [excludedPaths, setExcludedPaths] = useState<string[]>(
    () => [...initialPolicy.excludedPaths],
  );
  const [dependencyLinks, setDependencyLinks] = useState<string[]>(
    () => [...initialPolicy.dependencyLinks],
  );

  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const currentPolicy: ProjectPolicy = {
    checks: checks.map((c) => ({
      name: c.name,
      argv: textToArgv(c.command),
      timeoutSec: c.timeoutSec,
      required: c.required,
    })),
    excludedPaths,
    dependencyLinks,
  };

  const isDirty = isPolicyDirty(currentPolicy, savedPolicy);

  const handleAddCheck = () => {
    if (checks.length >= MAX_POLICY_CHECKS) return;
    if (statusMessage) setStatusMessage(null);
    setChecks((prev) => [
      ...prev,
      { name: "", command: "", timeoutSec: 60, required: true },
    ]);
  };

  const handleRemoveCheck = (index: number) => {
    if (statusMessage) setStatusMessage(null);
    setChecks((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCheck = (index: number, patch: Partial<FormCheck>) => {
    if (statusMessage) setStatusMessage(null);
    setChecks((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  };

  const handleAddExcludedPath = () => {
    if (excludedPaths.length >= MAX_EXCLUDED_PATHS) return;
    if (statusMessage) setStatusMessage(null);
    setExcludedPaths((prev) => [...prev, ""]);
  };

  const handleRemoveExcludedPath = (index: number) => {
    if (statusMessage) setStatusMessage(null);
    setExcludedPaths((prev) => prev.filter((_, i) => i !== index));
  };

  const updateExcludedPath = (index: number, value: string) => {
    if (statusMessage) setStatusMessage(null);
    setExcludedPaths((prev) =>
      prev.map((p, i) => (i === index ? value : p)),
    );
  };

  const handleAddDependencyLink = () => {
    if (dependencyLinks.length >= MAX_DEPENDENCY_LINKS) return;
    if (statusMessage) setStatusMessage(null);
    setDependencyLinks((prev) => [...prev, ""]);
  };

  const handleRemoveDependencyLink = (index: number) => {
    if (statusMessage) setStatusMessage(null);
    setDependencyLinks((prev) => prev.filter((_, i) => i !== index));
  };

  const updateDependencyLink = (index: number, value: string) => {
    if (statusMessage) setStatusMessage(null);
    setDependencyLinks((prev) =>
      prev.map((d, i) => (i === index ? value : d)),
    );
  };

  const handleSave = async () => {
    setIsSaving(true);
    setStatusMessage(null);
    setIssues(null);
    setGeneralError(null);

    try {
      const res = await fetch(`/api/agent-projects/${projectId}/policy`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(currentPolicy),
      });

      const data = await res.json().catch(() => null);

      if (res.status === 200 && data?.policy) {
        const returned: ProjectPolicy = data.policy;
        setSavedPolicy(returned);
        setChecks(
          returned.checks.map((c) => ({
            name: c.name,
            command: argvToText(c.argv),
            timeoutSec: c.timeoutSec,
            required: c.required,
          })),
        );
        setExcludedPaths(returned.excludedPaths);
        setDependencyLinks(returned.dependencyLinks);
        setStatusMessage("Saved");
      } else if (res.status === 400) {
        if (Array.isArray(data?.issues) && data.issues.length > 0) {
          setIssues(data.issues);
        } else if (data?.error) {
          setGeneralError(data.error);
        } else {
          setGeneralError("Validation failed.");
        }
      } else {
        setGeneralError(
          data?.error || `Request failed with status ${res.status}`,
        );
      }
    } catch (err) {
      setGeneralError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Checks */}
      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {checks.length === 0 ? (
            <div className="rounded-md border border-dashed border-line p-4 text-center">
              <p className="text-[12.5px] text-faint">
                No checks configured. Add a check to verify code changes before agent runs finish.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-line text-[11px] font-medium text-muted">
                    <th className="pb-2 pr-3 font-medium">Name</th>
                    <th className="pb-2 pr-3 font-medium">Command</th>
                    <th className="pb-2 pr-3 font-medium w-28">Timeout (s)</th>
                    <th className="pb-2 pr-3 font-medium w-40">Required</th>
                    <th className="pb-2 w-10">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {checks.map((check, index) => (
                    <tr key={index} className="group">
                      <td className="py-2.5 pr-3 align-middle">
                        <Input
                          value={check.name}
                          onChange={(e) =>
                            updateCheck(index, { name: e.target.value })
                          }
                          placeholder="e.g. test"
                          aria-label={`Check ${index + 1} name`}
                          disabled={isSaving}
                          className="text-[12px]"
                        />
                      </td>
                      <td className="py-2.5 pr-3 align-middle">
                        <Input
                          value={check.command}
                          onChange={(e) =>
                            updateCheck(index, { command: e.target.value })
                          }
                          placeholder="e.g. npm test"
                          aria-label={`Check ${index + 1} command`}
                          disabled={isSaving}
                          className="font-mono text-[12px]"
                        />
                      </td>
                      <td className="py-2.5 pr-3 align-middle">
                        <Input
                          type="number"
                          min={1}
                          value={check.timeoutSec}
                          onChange={(e) => {
                            const val = e.target.value === "" ? 0 : Number(e.target.value);
                            updateCheck(index, { timeoutSec: isNaN(val) ? 0 : val });
                          }}
                          aria-label={`Check ${index + 1} timeout`}
                          disabled={isSaving}
                          className="w-24 font-mono text-[12px]"
                        />
                      </td>
                      <td className="py-2.5 pr-3 align-middle">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={check.required}
                            onChange={(e) =>
                              updateCheck(index, { required: e.target.checked })
                            }
                            aria-label={`Check ${index + 1} required`}
                            disabled={isSaving}
                            className="h-4 w-4 rounded border-line accent-[var(--accent)]"
                          />
                          <span className="text-[12px] text-fg">Required</span>
                          {!check.required && (
                            <span className="text-[11px] text-muted font-normal">
                              informational
                            </span>
                          )}
                        </label>
                      </td>
                      <td className="py-2.5 align-middle text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveCheck(index)}
                          disabled={isSaving}
                          aria-label={`Remove check ${index + 1}`}
                          className="h-8 px-2 text-faint hover:text-red-400 shrink-0"
                          title="Remove check"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleAddCheck}
            disabled={isSaving || checks.length >= MAX_POLICY_CHECKS}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Check
          </Button>
        </CardBody>
      </Card>

      {/* 2. Excluded paths */}
      <Card>
        <CardHeader>
          <CardTitle>Excluded paths</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-[12.5px] leading-relaxed text-muted">
            Relative globs, e.g. secret/** or *.env. Agents cannot change these.
          </p>

          {excludedPaths.length === 0 ? (
            <div className="rounded-md border border-dashed border-line p-3 text-center">
              <p className="text-[12.5px] text-faint">No excluded paths configured.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {excludedPaths.map((path, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={path}
                    onChange={(e) => updateExcludedPath(index, e.target.value)}
                    placeholder="e.g. secret/** or *.env"
                    aria-label={`Excluded path ${index + 1}`}
                    disabled={isSaving}
                    className="flex-1 font-mono text-[12px]"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveExcludedPath(index)}
                    disabled={isSaving}
                    aria-label={`Remove excluded path ${index + 1}`}
                    className="h-8 px-2 text-faint hover:text-red-400 shrink-0"
                    title="Remove path"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleAddExcludedPath}
            disabled={isSaving || excludedPaths.length >= MAX_EXCLUDED_PATHS}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Add path
          </Button>
        </CardBody>
      </Card>

      {/* 3. Shared folders */}
      <Card>
        <CardHeader>
          <CardTitle>Shared folders</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {dependencyLinks.length > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-500">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                These folders are shared with agent worktrees: an agent or a check that writes into them changes your project&apos;s own copy. Only folders Git ignores are linked.
              </span>
            </div>
          )}

          {dependencyLinks.length === 0 ? (
            <div className="rounded-md border border-dashed border-line p-3 text-center">
              <p className="text-[12.5px] text-faint">No shared folders configured.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {dependencyLinks.map((folder, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={folder}
                    onChange={(e) => updateDependencyLink(index, e.target.value)}
                    placeholder="e.g. node_modules"
                    aria-label={`Shared folder ${index + 1}`}
                    disabled={isSaving}
                    className="flex-1 font-mono text-[12px]"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveDependencyLink(index)}
                    disabled={isSaving}
                    aria-label={`Remove shared folder ${index + 1}`}
                    className="h-8 px-2 text-faint hover:text-red-400 shrink-0"
                    title="Remove shared folder"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleAddDependencyLink}
            disabled={isSaving || dependencyLinks.length >= MAX_DEPENDENCY_LINKS}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Add folder
          </Button>
        </CardBody>
      </Card>

      {/* Save & Feedback */}
      <div className="space-y-3 pt-2">
        {statusMessage && (
          <p
            role="status"
            className="text-[13px] font-medium text-emerald-600 dark:text-emerald-400"
          >
            {statusMessage}
          </p>
        )}

        {issues && issues.length > 0 && (
          <ul
            role="alert"
            className="list-disc list-inside space-y-1 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-[12.5px] text-red-500"
          >
            {issues.map((issue, idx) => (
              <li key={idx}>{issue}</li>
            ))}
          </ul>
        )}

        {generalError && (
          <div
            role="alert"
            className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-500"
          >
            {generalError}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={isSaving || !isDirty}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
