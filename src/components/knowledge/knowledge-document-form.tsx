"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import type { KnowledgeDocument } from "@/core/knowledge/types";

/**
 * Create or edit a knowledge document. One component for both, so a new
 * field lands once — mirrors `components/prompts/prompt-form.tsx`'s own
 * shape. `projectId` is only ever used to build the API/redirect URLs;
 * it is never part of the request body (see `core/knowledge/schema.ts`).
 */
export function KnowledgeDocumentForm({
  projectId,
  document,
}: {
  projectId: string;
  document?: KnowledgeDocument;
}) {
  const router = useRouter();
  const editing = Boolean(document);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      title: String(form.get("title") ?? "").trim(),
      content: String(form.get("content") ?? ""),
      category: String(form.get("category") ?? ""),
      pinned: form.get("pinned") === "on",
    };

    try {
      const response = await fetch(
        editing
          ? `/api/projects/${projectId}/knowledge/${document!.id}`
          : `/api/projects/${projectId}/knowledge`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? "Could not save the document");
        setBusy(false);
        return;
      }

      router.push(`/projects/${projectId}/knowledge`);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-3xl space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <Field label="Title" hint="Required">
            <Input
              name="title"
              required
              maxLength={200}
              autoFocus={!editing}
              defaultValue={document?.title ?? ""}
              placeholder="Deploy runbook"
            />
          </Field>

          <Field label="Content">
            <Textarea
              name="content"
              rows={14}
              defaultValue={document?.content ?? ""}
              placeholder="Whatever future-you would want to find here…"
              className="font-mono text-[12.5px] leading-relaxed"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <Field label="Category" help="Groups documents in the list. Optional.">
            <Input name="category" defaultValue={document?.category ?? ""} placeholder="runbooks" />
          </Field>

          <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              name="pinned"
              defaultChecked={document?.pinned ?? false}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Pin to the top of the list
          </label>
        </CardBody>
      </Card>

      {error ? (
        <p className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
          {editing ? "Save changes" : "Save document"}
        </Button>
        <Link href={`/projects/${projectId}/knowledge`} className={buttonClasses("ghost", "lg")}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
