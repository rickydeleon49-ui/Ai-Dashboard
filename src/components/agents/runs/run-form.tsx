"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Select, Textarea, Input } from "@/components/ui/field";
import { EFFORT_LEVELS } from "@/core/agents/types";
import { buildModelOptions, resolveProviderModels } from "./model-options";
import { describeReviewIndependence } from "./role-independence";
import { buildRunRequest } from "./build-run-request";

export interface ProviderOption {
  id: string;
  label: string;
  /** Short probe summary, e.g. "installed 2.1.312" or "not installed". */
  note: string;
  usable: boolean;
  /** Configured models for this provider (AW1-17). */
  models?: string[];
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
  const firstUsable = providers.find((p) => p.usable)?.id ?? providers[0]?.id ?? "";
  const [projectId, setProjectId] = React.useState(projects[0]?.id ?? "");
  const [task, setTask] = React.useState("");

  const [implementer, setImplementer] = React.useState(firstUsable);
  const [implementerModel, setImplementerModel] = React.useState("");
  const [implementerEffort, setImplementerEffort] = React.useState("");

  const [planner, setPlanner] = React.useState("");
  const [plannerModel, setPlannerModel] = React.useState("");
  const [plannerEffort, setPlannerEffort] = React.useState("");

  const [reviewer, setReviewer] = React.useState("");
  const [reviewerModel, setReviewerModel] = React.useState("");
  const [reviewerEffort, setReviewerEffort] = React.useState("");

  const [checks, setChecks] = React.useState(checkSuggestions.join(", "));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleImplementerChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setImplementer(e.target.value);
    setImplementerModel("");
    setImplementerEffort("");
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

  const implementerModelOptions = buildModelOptions(resolveProviderModels(implementer, providers));
  const plannerModelOptions = buildModelOptions(resolveProviderModels(planner, providers));
  const reviewerModelOptions = buildModelOptions(resolveProviderModels(reviewer, providers));

  const independence = describeReviewIndependence({
    implementer: { provider: implementer },
    reviewer: reviewer ? { provider: reviewer } : undefined,
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
      };
      if (!res.ok || !data.run) {
        setError(data.issues?.[0]?.message ?? data.error ?? `Could not start the run (${res.status})`);
        setBusy(false);
        return;
      }
      router.push(`/agents/runs/${data.run.id}`);
    } catch {
      setError("Could not reach the server");
      setBusy(false);
    }
  }

  const providerOptions = providers.map((p) => (
    <option key={p.id} value={p.id}>
      {p.label} ({p.note})
    </option>
  ));

  return (
    <Card>
      <CardHeader>
        <CardTitle>New run</CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Project" help="Only projects with a local folder are listed.">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
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
              <Select value={implementer} onChange={handleImplementerChange} required>
                {providerOptions}
              </Select>
            </Field>
            <Field label="Model" hint="optional">
              {implementerModelOptions.length > 0 ? (
                <Select value={implementerModel} onChange={(e) => setImplementerModel(e.target.value)}>
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
              <Select value={implementerEffort} onChange={(e) => setImplementerEffort(e.target.value)}>
                <option value="">Provider default</option>
                {EFFORT_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
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
                {EFFORT_LEVELS.map((l) => (
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
                {EFFORT_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Required checks" help="Names from the project policy, separated by commas or spaces.">
            <Input value={checks} onChange={(e) => setChecks(e.target.value)} placeholder="lint, typecheck" />
          </Field>
          {error ? (
            <p role="alert" className="text-[12px] text-red-400">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" disabled={busy || !projectId || !implementer || !task.trim()}>
            {busy ? "Starting..." : "Start run"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
