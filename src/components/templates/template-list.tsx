"use client";

/** Release 2D.3 template list: browse, and (members) create an empty template. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { TemplateSummary } from "@/core/templates/types";
import { TemplateRequestError, templatesApi } from "./templates-api";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; templates: TemplateSummary[]; canEdit: boolean };

export function TemplateList() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    let cancelled = false;
    templatesApi
      .list()
      .then((r) => !cancelled && setState({ status: "ready", templates: r.templates, canEdit: r.canEdit }))
      .catch((e: unknown) => !cancelled && setState({ status: "error", message: e instanceof TemplateRequestError ? e.message : "Couldn’t load templates." }));
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const { template } = await templatesApi.create(name.trim());
      router.push(`/templates/${encodeURIComponent(template.id)}`);
    } catch (e) {
      setCreateError(e instanceof TemplateRequestError ? e.message : "Couldn’t create the template.");
      setCreating(false);
    }
  }

  if (state.status === "loading") return <p role="status" className="text-[13px] text-muted">Loading templates…</p>;
  if (state.status === "error") {
    return (
      <div role="alert" className="flex items-center gap-3 text-[13px] text-red-400">
        {state.message}
        <Button type="button" size="sm" variant="outline" className="min-h-[40px] md:min-h-0" onClick={() => { setState({ status: "loading" }); setReload((n) => n + 1); }}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 min-w-0" data-testid="template-list">
      {state.canEdit ? (
        <form onSubmit={create} className="flex max-w-xl flex-wrap items-end gap-2 min-w-0" aria-label="New template">
          <label className="min-w-0 flex-1 space-y-1.5">
            <span className="text-[12px] font-medium text-muted">New template name</span>
            <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} placeholder="e.g. Product launch" className="min-h-[40px] md:min-h-0" />
          </label>
          <Button type="submit" variant="primary" disabled={!name.trim() || creating} className="min-h-[40px] md:min-h-0">
            {creating ? "Creating…" : "Create template"}
          </Button>
          {createError ? <p role="alert" className="w-full text-[12px] text-red-400 break-words">{createError}</p> : null}
        </form>
      ) : (
        <p className="text-[12px] text-faint break-words">You can view and preview templates. Creating, editing and applying them needs the member role.</p>
      )}

      {state.templates.length === 0 ? (
        <div className="rounded-lg border border-line p-6 text-center" data-testid="template-empty">
          <LayoutTemplate className="mx-auto h-6 w-6 text-faint" aria-hidden />
          <p className="mt-2 text-[13px] text-muted">No templates yet.</p>
          <p className="text-[12px] text-faint break-words">A template describes a project’s milestones, tasks, checklists and documents, dated from a start day.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 min-w-0" aria-label="Templates">
          {state.templates.map((t) => (
            <li key={t.id} className="rounded-lg border border-line p-4 min-w-0">
              <Link href={`/templates/${encodeURIComponent(t.id)}`} className="text-[14px] font-medium text-fg hover:underline break-words min-h-[40px] md:min-h-0 inline-flex items-center">
                {t.name}
              </Link>
              {t.description ? <p className="mt-1 line-clamp-2 text-[12px] text-muted break-words">{t.description}</p> : null}
              <p className="mt-2 text-[11px] text-faint break-words">
                {t.counts.milestones} milestones · {t.counts.tasks} tasks · {t.counts.dependencies} dependencies · {t.counts.checklist} checklist items · {t.counts.documents} documents
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
