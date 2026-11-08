"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select, Textarea, Input } from "@/components/ui/field";
import { buildModelOptions, resolveProviderModels } from "./model-options";
import { describeReviewIndependence } from "./role-independence";
import { buildRunRequest } from "./build-run-request";
import {
  defaultReviewRoles,
  effortLevelsFor,
  implementerProviders,
  reviewRoleProviders,
} from "./role-defaults";

export interface ProviderOption {
  id: string;
  label: string;
  /** Short probe summary, e.g. "installed 2.1.312" or "not installed". */
  note: string;
  usable: boolean;
  /** Configured models for this provider (AW1-17). */
  models?: string[];
  /** Probe facts used for role defaults (AW2-04b). */
  installed?: boolean;
  authenticated?: boolean | "unknown";
  /** False for providers that cannot implement (Codex is read-only in AW.2). */
  canImplement?: boolean;
}

export interface ProjectOption {
  id: string;
  name: string;
}

export function RunForm({
  projects,
  providers,
  checkSuggestions,
}: {
  projects: ProjectOption[];
  providers: ProviderOption[];
  checkSuggestions: string[];
}) {
  const router = useRouter();
  const implementerChoices = implementerProviders(providers);
  const firstUsable =
    implementerChoices.find((p) => p.usable)?.id ??
    implementerChoices[0]?.id ??
    "";
  const reviewDefaults = React.useMemo(
    () => defaultReviewRoles(providers),
    [providers],
  );
  const [projectId, setProjectId] = React.useState(projects[0]?.id ?? "");
  const [task, setTask] = React.useState("");

  const [implementer, setImplementer] = React.useState(firstUsable);
  const [implementerModel, setImplementerModel] = React.useState("");
  const [implementerEffort, setImplementerEffort] = React.useState("");

  const [planner, setPlanner] = React.useState(reviewDefaults.planner.provider);
  const [plannerModel, setPlannerModel] = React.useState(
    reviewDefaults.planner.model,
  );
  const [plannerEffort, setPlannerEffort] = React.useState(
    reviewDefaults.planner.effort,
  );

  const [reviewer, setReviewer] = React.useState(
    reviewDefaults.reviewer.provider,
  );
  const [reviewerModel, setReviewerModel] = React.useState(
    reviewDefaults.reviewer.model,
  );
  const [reviewerEffort, setReviewerEffort] = React.useState(
    reviewDefaults.reviewer.effort,
  );

  const [checks, setChecks] = React.useState(checkSuggestions.join(", "));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [inventory, setInventory] = React.useState<{
    plugins: { name: string; hasHooks: boolean }[];
    mcpServers: string[];
  } | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  // A failed load is not retried automatically (no fetch loop); the server
  // still checks on submit and a 409 returns the current inventory.
  const [inventoryFailed, setInventoryFailed] = React.useState(false);
  // Bumped to fetch the inventory again (retry button, 409 without inventory).
  const [inventoryReload, setInventoryReload] = React.useState(0);
  const isAntigravityImplementer = implementer === "antigravity";

  React.useEffect(() => {
    if (!isAntigravityImplementer) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agent-runs/antigravity-inventory");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          plugins?: { name: string; hasHooks: boolean }[];
          mcpServers?: string[];
        };
        if (cancelled) return;
        setInventory({
          plugins: Array.isArray(data.plugins) ? data.plugins : [],
          mcpServers: Array.isArray(data.mcpServers) ? data.mcpServers : [],
        });
        setInventoryFailed(false);
      } catch {
        if (!cancelled) setInventoryFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAntigravityImplementer, inventoryReload]);

  const loadInventory = () => {
    setInventoryFailed(false);
    setInventoryReload((n) => n + 1);
  };

  const handleImplementerChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setImplementer(e.target.value);
    setImplementerModel("");
    setImplementerEffort("");
    setAcknowledged(false);
  };

  const handlePlannerChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPlanner(e.target.value);
    setPlannerModel("");
    setPlannerEffort("");
  };

  const handleReviewerChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setReviewer(e.target.value);
    setReviewerModel("");
    setReviewerEffort("");
  };

  const implementerModelOptions = buildModelOptions(
    resolveProviderModels(implementer, providers),
  );
  const plannerModelOptions = buildModelOptions(
    resolveProviderModels(planner, providers),
  );
  const reviewerModelOptions = buildModelOptions(
    resolveProviderModels(reviewer, providers),
  );

  const independence = describeReviewIndependence({
    implementer: { provider: implementer },
    reviewer: reviewer ? { provider: reviewer } : undefined,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const isAntigravity = implementer === "antigravity";
    const body = buildRunRequest({
      projectId,
      task,
      roles: {
        implementer: {
          provider: implementer,
          model: implementerModel,
          effort: implementerEffort,
        },
        planner: planner
          ? {
              provider: planner,
              model: plannerModel,
              effort: plannerEffort,
            }
          : undefined,
        reviewer: reviewer
          ? {
              provider: reviewer,
              model: reviewerModel,
              effort: reviewerEffort,
            }
          : undefined,
      },
      checks,
      antigravityAcknowledgement:
        isAntigravity && acknowledged && inventory
          ? {
              plugins: inventory.plugins.map((p) => p.name),
              mcpServers: inventory.mcpServers,
            }
          : undefined,
    });
    try {
      const res = await fetch("/api/agent-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        run?: { id: string };
        error?: string;
        issues?: Array<{ message: string }>;
        inventory?: {
          plugins: { name: string; hasHooks: boolean }[];
          mcpServers: string[];
        };
      };
      if (!res.ok || !data.run) {
        if (res.status === 409 && data.inventory) {
          setInventory({
            plugins: Array.isArray(data.inventory.plugins)
              ? data.inventory.plugins
              : [],
            mcpServers: Array.isArray(data.inventory.mcpServers)
              ? data.inventory.mcpServers
              : [],
          });
          setAcknowledged(false);
        } else if (res.status === 409 && isAntigravity) {
          loadInventory();
          setAcknowledged(false);
        }
        setError(
          data.issues?.[0]?.message ??
            data.error ??
            `Could not start the run (${res.status})`,
        );
        setBusy(false);
        return;
      }
      router.push(`/agents/runs/${data.run.id}`);
    } catch {
      setError("Could not reach the server");
      setBusy(false);
    }
  }

  const optionsFor = (list: ProviderOption[]) =>
    list.map((p) => (
      <option key={p.id} value={p.id}>
        {p.label} ({p.note})
      </option>
    ));
  const providerOptions = optionsFor(reviewRoleProviders(providers));
  const implementerOptions = optionsFor(implementerChoices);

  const isAntigravity = implementer === "antigravity";
  const hasInventoryItems = Boolean(
    inventory &&
    (inventory.plugins.length > 0 || inventory.mcpServers.length > 0),
  );
  const isAckRequired = isAntigravity && hasInventoryItems;
  const isSubmitDisabled =
    busy ||
    !projectId ||
    !implementer ||
    !task.trim() ||
    (isAntigravity &&
      ((inventory === null && !inventoryFailed) ||
        (isAckRequired && !acknowledged)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>New run</CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Project"
            help="Only projects with a local folder are listed."
          >
            <Select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              required
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Task">
            <Textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              maxLength={20000}
              required
              placeholder="Describe the change the implementer should make."
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Implementer">
              <Select
                value={implementer}
                onChange={handleImplementerChange}
                required
              >
                {implementerOptions}
              </Select>
            </Field>
            <Field label="Model" hint="optional">
              {implementerModelOptions.length > 0 ? (
                <Select
                  value={implementerModel}
                  onChange={(e) => setImplementerModel(e.target.value)}
                >
                  {implementerModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={implementerModel}
                  onChange={(e) => setImplementerModel(e.target.value)}
                  placeholder="provider default"
                />
              )}
            </Field>
            <Field label="Effort" hint="optional">
              <Select
                value={implementerEffort}
                onChange={(e) => setImplementerEffort(e.target.value)}
              >
                <option value="">Provider default</option>
                {effortLevelsFor(implementer).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {isAntigravity ? (
            <div className="rounded-md border border-line bg-[var(--bg-subtle)] p-3 space-y-2 text-[12px]">
              <div className="font-semibold text-fg">
                Antigravity loads these into the run
              </div>
              {inventory === null && inventoryFailed ? (
                <p className="text-muted">
                  Could not read the Antigravity plugins.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={loadInventory}
                  >
                    Try again
                  </button>
                </p>
              ) : inventory === null ? (
                <p className="text-muted">Loading inventory...</p>
              ) : !hasInventoryItems ? (
                <p className="text-muted">No plugins or MCP servers found.</p>
              ) : (
                <>
                  {inventory.plugins.length > 0 ? (
                    <div>
                      <div className="text-[11px] font-medium text-muted uppercase tracking-wider">
                        Plugins
                      </div>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-fg">
                        {inventory.plugins.map((p) => (
                          <li key={p.name}>
                            {p.name}
                            {p.hasHooks ? " (has hooks)" : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {inventory.mcpServers.length > 0 ? (
                    <div>
                      <div className="text-[11px] font-medium text-muted uppercase tracking-wider">
                        MCP servers
                      </div>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-fg">
                        {inventory.mcpServers.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <label className="flex items-center gap-2 pt-1 font-normal text-fg cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      className="rounded border-line"
                    />
                    <span>I reviewed these plugins and MCP servers</span>
                  </label>
                </>
              )}
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Planner" hint="optional">
              <Select value={planner} onChange={handlePlannerChange}>
                <option value="">None</option>
                {providerOptions}
              </Select>
            </Field>
            <Field label="Model" hint="optional">
              {plannerModelOptions.length > 0 ? (
                <Select
                  value={plannerModel}
                  onChange={(e) => setPlannerModel(e.target.value)}
                  disabled={!planner}
                >
                  {plannerModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={plannerModel}
                  onChange={(e) => setPlannerModel(e.target.value)}
                  placeholder="provider default"
                  disabled={!planner}
                />
              )}
            </Field>
            <Field label="Effort" hint="optional">
              <Select
                value={plannerEffort}
                onChange={(e) => setPlannerEffort(e.target.value)}
                disabled={!planner}
              >
                <option value="">Provider default</option>
                {effortLevelsFor(planner).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Reviewer" hint="optional">
              <Select value={reviewer} onChange={handleReviewerChange}>
                <option value="">None</option>
                {providerOptions}
              </Select>
              <p className="text-[11px] text-muted">{independence.label}</p>
            </Field>
            <Field label="Model" hint="optional">
              {reviewerModelOptions.length > 0 ? (
                <Select
                  value={reviewerModel}
                  onChange={(e) => setReviewerModel(e.target.value)}
                  disabled={!reviewer}
                >
                  {reviewerModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={reviewerModel}
                  onChange={(e) => setReviewerModel(e.target.value)}
                  placeholder="provider default"
                  disabled={!reviewer}
                />
              )}
            </Field>
            <Field label="Effort" hint="optional">
              <Select
                value={reviewerEffort}
                onChange={(e) => setReviewerEffort(e.target.value)}
                disabled={!reviewer}
              >
                <option value="">Provider default</option>
                {effortLevelsFor(reviewer).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Required checks"
            help="Names from the project policy, separated by commas or spaces."
          >
            <Input
              value={checks}
              onChange={(e) => setChecks(e.target.value)}
              placeholder="lint, typecheck"
            />
          </Field>
          {error ? (
            <p role="alert" className="text-[12px] text-red-400">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" disabled={isSubmitDisabled}>
            {busy ? "Starting..." : "Start run"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
