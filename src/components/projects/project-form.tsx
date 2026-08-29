"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";
import { STATUS_META, TYPE_META } from "@/core/projects/labels";
import {
  PROJECT_STATUSES,
  PROJECT_TYPES,
  type Project,
} from "@/core/projects/types";

/**
 * Create/edit form for manual projects, driven by the same API route the rest of
 * the app uses. It is deliberately one component for both modes so a new field
 * only has to be added once.
 */
export function ProjectForm({ project }: { project?: Project }) {
  const router = useRouter();
  const editing = Boolean(project);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get("name") ?? "").trim(),
      description: String(form.get("description") ?? ""),
      type: String(form.get("type") ?? "software"),
      status: String(form.get("status") ?? "idea"),
      tags: String(form.get("tags") ?? ""),
      repositoryUrl: String(form.get("repositoryUrl") ?? ""),
      projectUrl: String(form.get("projectUrl") ?? ""),
      localPath: String(form.get("localPath") ?? ""),
      notes: String(form.get("notes") ?? ""),
      favorite: form.get("favorite") === "on",
      ...(editing ? {} : { source: "manual" as const }),
    };

    try {
      const response = await fetch(
        editing ? `/api/projects/${project!.id}` : "/api/projects",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      const body = (await response.json()) as
        | { project: Project }
        | { error: string };

      if (!response.ok || "error" in body) {
        setError("error" in body ? body.error : "Something went wrong.");
        setSaving(false);
        return;
      }

      router.push(`/projects/${body.project.id}`);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check that the app is running.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <Field label="Name" hint="Required">
            <Input
              name="name"
              required
              maxLength={160}
              autoFocus={!editing}
              defaultValue={project?.name ?? ""}
              placeholder="Starfield Mod Tools"
            />
          </Field>

          <Field label="Description">
            <Textarea
              name="description"
              rows={3}
              defaultValue={project?.description ?? ""}
              placeholder="What is this project, in one or two lines?"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              <Select name="type" defaultValue={project?.type ?? "software"}>
                {PROJECT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_META[type].label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Status">
              <Select name="status" defaultValue={project?.status ?? "idea"}>
                {PROJECT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_META[status].label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Tags" help="Comma separated. Used for filtering and search.">
            <Input
              name="tags"
              defaultValue={project?.tags.join(", ") ?? ""}
              placeholder="ai, automation, side-project"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <Field label="Repository URL" help="Any git host, not just GitHub.">
            <Input
              name="repositoryUrl"
              type="url"
              defaultValue={project?.repositoryUrl ?? ""}
              placeholder="https://github.com/you/project"
            />
          </Field>

          <Field label="Project / live URL">
            <Input
              name="projectUrl"
              type="url"
              defaultValue={project?.projectUrl ?? ""}
              placeholder="https://project.up.railway.app"
            />
          </Field>

          <Field label="Local path" help="Where the project lives on your machine.">
            <Input
              name="localPath"
              defaultValue={project?.localPath ?? ""}
              placeholder="~/code/starfield-mod-tools"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <Field label="Notes" help="Markdown-friendly scratch space for this project.">
            <Textarea
              name="notes"
              rows={6}
              defaultValue={project?.notes ?? ""}
              placeholder="Next steps, decisions, links…"
            />
          </Field>

          <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              name="favorite"
              defaultChecked={project?.favorite ?? false}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Pin to favorites
          </label>
        </CardBody>
      </Card>

      {error ? (
        <p className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="lg" disabled={saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
          ) : null}
          {editing ? "Save changes" : "Create project"}
        </Button>
        <Link
          href={editing ? `/projects/${project!.id}` : "/projects"}
          className={buttonClasses("ghost", "lg")}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
