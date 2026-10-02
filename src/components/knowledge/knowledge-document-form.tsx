"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { MarkdownEditor } from "@/components/knowledge/markdown-editor";
import { KNOWLEDGE_CONTENT_MAX } from "@/core/knowledge/markdown";
import type { KnowledgeDocument } from "@/core/knowledge/types";

/**
 * A save failure the writer can act on. The typed text is never cleared, so
 * whatever went wrong, nothing written is lost.
 */
async function saveFailureMessage(response: Response): Promise<string> {
  let message: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) message = body.error;
  } catch {
    // Not JSON — fall through to a message based on the status alone.
  }
  if (response.status === 401) return "Your session has ended. Sign in again, then save — your text is still here.";
  if (response.status === 403) return message ?? "You have read-only access to this workspace, so this document cannot be saved.";
  if (response.status === 404) return "This document or project no longer exists, so it could not be saved.";
  return message ?? `Could not save the document (error ${response.status}). Your text is still here.`;
}

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
  const [content, setContent] = useState(document?.content ?? "");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (content.length > KNOWLEDGE_CONTENT_MAX) {
      setError(
        `Content is ${content.length.toLocaleString("en-US")} characters; the limit is ${KNOWLEDGE_CONTENT_MAX.toLocaleString("en-US")}. Shorten it, then save.`,
      );
      return;
    }
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      title: String(form.get("title") ?? "").trim(),
      content,
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
      if (!response.ok) {
        setError(await saveFailureMessage(response));
        setBusy(false);
        return;
      }

      router.push(`/projects/${projectId}/knowledge`);
      router.refresh();
    } catch {
      setError("Could not reach the server. Your text is still here — try saving again.");
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
              aria-label="Title"
              required
              maxLength={200}
              autoFocus={!editing}
              defaultValue={document?.title ?? ""}
              placeholder="Deploy runbook"
            />
          </Field>

          <MarkdownEditor
            name="content"
            label="Content"
            value={content}
            onChange={setContent}
            placeholder={"# Deploy runbook\n\n- [ ] Tag the release\n- [ ] Run migrations"}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <Field label="Category" help="Groups documents in the list. Optional.">
            <Input name="category" aria-label="Category" defaultValue={document?.category ?? ""} placeholder="runbooks" />
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
        <p
          role="alert"
          className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-300"
        >
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
