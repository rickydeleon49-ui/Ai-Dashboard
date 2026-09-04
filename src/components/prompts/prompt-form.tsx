"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import { PROMPT_CATEGORIES, type Prompt } from "@/core/prompts/types";

/** Create or edit a prompt. One component for both, so a new field lands once. */
export function PromptForm({ prompt }: { prompt?: Prompt }) {
  const router = useRouter();
  const editing = Boolean(prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      title: String(form.get("title") ?? "").trim(),
      body: String(form.get("body") ?? "").trim(),
      model: String(form.get("model") ?? ""),
      category: String(form.get("category") ?? ""),
      favorite: form.get("favorite") === "on",
    };

    try {
      const response = await fetch(
        editing ? `/api/prompts/${prompt!.id}` : "/api/prompts",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? "Could not save the prompt");
        setBusy(false);
        return;
      }

      router.push("/ai/prompts");
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
          <Field label="Name" hint="Required">
            <Input
              name="title"
              required
              maxLength={160}
              autoFocus={!editing}
              defaultValue={prompt?.title ?? ""}
              placeholder="Code review checklist"
            />
          </Field>

          <Field label="Prompt" hint="Required">
            <Textarea
              name="body"
              required
              rows={14}
              defaultValue={prompt?.body ?? ""}
              placeholder="The text you want to reuse…"
              className="font-mono text-[12.5px] leading-relaxed"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" help="Groups prompts in the library.">
              <Input
                name="category"
                list="prompt-categories"
                defaultValue={prompt?.category ?? ""}
                placeholder="coding"
              />
              {/* A datalist rather than a select: the suggestions help, but the
                  set is not fixed and inventing one should not need a code change. */}
              <datalist id="prompt-categories">
                {PROMPT_CATEGORIES.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </Field>

            <Field label="Model" help="Optional — only when it matters.">
              <Input
                name="model"
                defaultValue={prompt?.model ?? ""}
                placeholder="claude-opus-5"
              />
            </Field>
          </div>

          <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              name="favorite"
              defaultChecked={prompt?.favorite ?? false}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Pin to the top of the library
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
          {editing ? "Save changes" : "Save prompt"}
        </Button>
        <Link href="/ai/prompts" className={buttonClasses("ghost", "lg")}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
