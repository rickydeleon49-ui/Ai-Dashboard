"use client";

/**
 * Release 2D.3 template editor, preview and apply (docs/design/2D.3-reusable-templates.md).
 *
 * Three clearly separate things happen here:
 * 1. Editing the template — local until "Save template" (one PUT of the whole document).
 * 2. Previewing — the SERVER computes the resulting project from the SAVED
 *    template; nothing is created.
 * 3. Creating a real project — one POST; retries reuse the same request key,
 *    so a retry can never create a second project.
 * Viewers see a read-only template and a preview; the server enforces this.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/field";
import { PROJECT_TYPES } from "@/core/projects/types";
import { TASK_PRIORITIES } from "@/core/tasks/types";
import {
  TEMPLATE_PROJECT_STATUSES,
  type StoredTemplate,
  type TemplateContent,
  type TemplateIssue,
  type TemplatePreview,
} from "@/core/templates/types";
import { newRequestKey, TemplateRequestError, templatesApi } from "./templates-api";

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; template: StoredTemplate; canEdit: boolean };

function toContent(t: StoredTemplate): TemplateContent {
  const { id: _id, createdAt: _c, updatedAt: _u, ...content } = t;
  return content;
}

function move<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const copy = [...list];
  [copy[index], copy[target]] = [copy[target]!, copy[index]!];
  return copy;
}

function nextKey(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used);
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

const offsetValue = (v: string): number | null => (v.trim() === "" ? null : Math.trunc(Number(v)));

function Labeled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1 ${className ?? ""}`}>
      <span className="text-[11px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function RowControls({
  label,
  index,
  count,
  disabled,
  onMove,
  onRemove,
}: {
  label: string;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button type="button" size="icon" variant="ghost" aria-label={`Move ${label} up`} disabled={disabled || index === 0} onClick={() => onMove(-1)} className="min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0">
        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button type="button" size="icon" variant="ghost" aria-label={`Move ${label} down`} disabled={disabled || index === count - 1} onClick={() => onMove(1)} className="min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0">
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      </Button>
      <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove} className="min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0">
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}

function Issues({ issues }: { issues: TemplateIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul role="alert" className="space-y-1 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-300 min-w-0 break-words" data-testid="template-issues">
      {issues.map((i, n) => (
        <li key={n} className="break-words">
          <span className="font-mono text-[11px] break-all">{i.path}</span>: {i.message}
        </li>
      ))}
    </ul>
  );
}

export function TemplateEditor({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [draft, setDraft] = useState<TemplateContent | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<TemplateIssue[]>([]);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    templatesApi
      .get(templateId)
      .then((r) => {
        if (cancelled) return;
        setLoaded({ status: "ready", template: r.template, canEdit: r.canEdit });
        setDraft(toContent(r.template));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof TemplateRequestError && e.status === 404) setLoaded({ status: "missing" });
        else setLoaded({ status: "error", message: e instanceof TemplateRequestError ? e.message : "Couldn’t load the template." });
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const saved = loaded.status === "ready" ? loaded.template : null;
  const dirty = useMemo(() => !!saved && !!draft && JSON.stringify(toContent(saved)) !== JSON.stringify(draft), [saved, draft]);

  if (loaded.status === "loading" || (loaded.status === "ready" && !draft)) {
    return <p role="status" className="text-[13px] text-muted">Loading template…</p>;
  }
  if (loaded.status === "missing") {
    return <p role="alert" className="rounded-lg border border-line p-4 text-[13px] text-muted">This template isn’t available in your current workspace.</p>;
  }
  if (loaded.status === "error") return <p role="alert" className="text-[13px] text-red-400">{loaded.message}</p>;

  const canEdit = loaded.canEdit;
  const d = draft!;
  const locked = !canEdit || saving;
  const update = (patch: Partial<TemplateContent>) => setDraft({ ...d, ...patch });
  const taskLabel = (key: string) => d.tasks.find((t) => t.key === key)?.title || "untitled task";
  const hasChildren = (key: string) => d.tasks.some((t) => t.parentKey === key);

  async function save() {
    setSaving(true);
    setSaveIssues([]);
    setNotice("");
    try {
      const { template } = await templatesApi.save(templateId, d);
      setLoaded({ status: "ready", template, canEdit });
      setDraft(toContent(template));
      setNotice("Template saved.");
    } catch (e) {
      if (e instanceof TemplateRequestError) {
        setSaveIssues(e.issues.length > 0 ? e.issues : [{ path: "template", message: e.message }]);
      } else {
        setSaveIssues([{ path: "template", message: "Couldn’t save. Your changes are still here — try again." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await templatesApi.remove(templateId);
      router.push("/templates");
    } catch (e) {
      setConfirmDelete(false);
      setSaveIssues([{ path: "template", message: e instanceof TemplateRequestError ? e.message : "Couldn’t delete the template." }]);
    }
  }

  function removeTask(key: string) {
    update({
      tasks: d.tasks.filter((t) => t.key !== key).map((t) => (t.parentKey === key ? { ...t, parentKey: null } : t)),
      dependencies: d.dependencies.filter((x) => x.taskKey !== key && x.dependsOnKey !== key),
      checklist: d.checklist.filter((c) => c.taskKey !== key),
    });
  }

  return (
    <div className="space-y-6 min-w-0" data-testid="template-editor">
      <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg break-words">{saved!.name}</h1>
          <p className="text-[12px] text-faint break-words" data-testid="template-mode">
            {canEdit ? "Editing a template. Changes are not saved until you choose Save template." : "Viewing a template (read-only)."}
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            {dirty ? <span className="text-[12px] text-amber-300">Unsaved changes</span> : null}
            <Button type="button" variant="primary" disabled={!dirty || saving} onClick={save} className="min-h-[40px] md:min-h-0">
              {saving ? "Saving…" : "Save template"}
            </Button>
            {confirmDelete ? (
              <span className="flex flex-wrap items-center gap-2 text-[12px] min-w-0" role="group" aria-label="Confirm delete">
                <span className="break-words">Delete this template? Projects created from it are kept.</span>
                <Button type="button" size="sm" variant="danger" onClick={remove} className="min-h-[40px] md:min-h-0">Delete</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDelete(false)} className="min-h-[40px] md:min-h-0">Cancel</Button>
              </span>
            ) : (
              <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)} className="min-h-[40px] md:min-h-0">Delete template</Button>
            )}
          </div>
        ) : null}
      </div>
      {notice ? <p role="status" className="text-[12px] text-emerald-300 break-words">{notice}</p> : null}
      <Issues issues={saveIssues} />

      <fieldset disabled={locked} className="space-y-6 min-w-0">
        <section aria-labelledby="tpl-details" className="grid grid-cols-1 gap-3 rounded-lg border border-line p-4 md:grid-cols-2 min-w-0">
          <h2 id="tpl-details" className="text-sm font-semibold text-fg md:col-span-2 break-words">Template and project defaults</h2>
          <Labeled label="Template name" className="min-w-0"><Input value={d.name} maxLength={160} onChange={(e) => update({ name: e.target.value })} className="min-h-[40px] md:min-h-0" /></Labeled>
          <Labeled label="Template description" className="min-w-0"><Input value={d.description ?? ""} maxLength={2000} onChange={(e) => update({ description: e.target.value || null })} className="min-h-[40px] md:min-h-0" /></Labeled>
          <Labeled label="Project name" className="min-w-0"><Input value={d.project.name} maxLength={160} onChange={(e) => update({ project: { ...d.project, name: e.target.value } })} className="min-h-[40px] md:min-h-0" /></Labeled>
          <Labeled label="Project description" className="min-w-0"><Input value={d.project.description ?? ""} maxLength={2000} onChange={(e) => update({ project: { ...d.project, description: e.target.value || null } })} className="min-h-[40px] md:min-h-0" /></Labeled>
          <Labeled label="Project type" className="min-w-0">
            <Select value={d.project.type} onChange={(e) => update({ project: { ...d.project, type: e.target.value as TemplateContent["project"]["type"] } })} className="min-h-[40px] md:min-h-0">
              {PROJECT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Labeled>
          <Labeled label="Project status" className="min-w-0">
            <Select value={d.project.status} onChange={(e) => update({ project: { ...d.project, status: e.target.value as TemplateContent["project"]["status"] } })} className="min-h-[40px] md:min-h-0">
              {TEMPLATE_PROJECT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Labeled>
        </section>

        <section aria-labelledby="tpl-milestones" className="space-y-3 rounded-lg border border-line p-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <h2 id="tpl-milestones" className="text-sm font-semibold text-fg break-words">Milestones ({d.milestones.length})</h2>
            <Button type="button" size="sm" variant="outline" className="min-h-[40px] md:min-h-0" onClick={() => update({ milestones: [...d.milestones, { key: nextKey("m", d.milestones.map((m) => m.key)), title: "", description: null, targetOffset: null }] })}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add milestone
            </Button>
          </div>
          {d.milestones.map((m, i) => (
            <div key={m.key} className="flex flex-wrap items-end gap-2 border-t border-line/60 pt-3 min-w-0" data-testid={`milestone-row-${i}`}>
              <Labeled label={`Milestone ${i + 1} title`} className="min-w-48 flex-1">
                <Input value={m.title} maxLength={200} onChange={(e) => update({ milestones: d.milestones.map((x) => (x.key === m.key ? { ...x, title: e.target.value } : x)) })} className="min-h-[40px] md:min-h-0" />
              </Labeled>
              <Labeled label="Target: days after start" className="w-full sm:w-40 md:w-40 min-w-0">
                <Input type="number" min={0} max={3650} value={m.targetOffset ?? ""} onChange={(e) => update({ milestones: d.milestones.map((x) => (x.key === m.key ? { ...x, targetOffset: offsetValue(e.target.value) } : x)) })} className="min-h-[40px] md:min-h-0" />
              </Labeled>
              <RowControls
                label={`milestone ${m.title || i + 1}`}
                index={i}
                count={d.milestones.length}
                disabled={locked}
                onMove={(delta) => update({ milestones: move(d.milestones, i, delta) })}
                onRemove={() => update({ milestones: d.milestones.filter((x) => x.key !== m.key), tasks: d.tasks.map((t) => (t.milestoneKey === m.key ? { ...t, milestoneKey: null } : t)) })}
              />
            </div>
          ))}
        </section>

        <section aria-labelledby="tpl-tasks" className="space-y-3 rounded-lg border border-line p-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <h2 id="tpl-tasks" className="text-sm font-semibold text-fg break-words">Tasks ({d.tasks.length})</h2>
            <Button type="button" size="sm" variant="outline" className="min-h-[40px] md:min-h-0" onClick={() => update({ tasks: [...d.tasks, { key: nextKey("t", d.tasks.map((t) => t.key)), title: "", description: null, priority: "medium", dueOffset: null, milestoneKey: null, parentKey: null }] })}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add task
            </Button>
          </div>
          {d.tasks.map((t, i) => {
            const items = d.checklist.map((c, index) => ({ c, index })).filter((x) => x.c.taskKey === t.key);
            return (
              <div key={t.key} className={`space-y-2 border-t border-line/60 pt-3 min-w-0 ${t.parentKey ? "ml-3 sm:ml-6 border-l pl-3" : ""}`} data-testid={`task-row-${i}`}>
                <div className="flex flex-wrap items-end gap-2 min-w-0">
                  <Labeled label={`Task ${i + 1} title`} className="min-w-48 flex-1">
                    <Input value={t.title} maxLength={200} onChange={(e) => update({ tasks: d.tasks.map((x) => (x.key === t.key ? { ...x, title: e.target.value } : x)) })} className="min-h-[40px] md:min-h-0" />
                  </Labeled>
                  <Labeled label="Priority" className="w-full sm:w-28 md:w-28 min-w-0">
                    <Select value={t.priority} onChange={(e) => update({ tasks: d.tasks.map((x) => (x.key === t.key ? { ...x, priority: e.target.value as typeof t.priority } : x)) })} className="min-h-[40px] md:min-h-0">
                      {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </Select>
                  </Labeled>
                  <Labeled label="Due: days after start" className="w-full sm:w-36 md:w-36 min-w-0">
                    <Input type="number" min={0} max={3650} value={t.dueOffset ?? ""} onChange={(e) => update({ tasks: d.tasks.map((x) => (x.key === t.key ? { ...x, dueOffset: offsetValue(e.target.value) } : x)) })} className="min-h-[40px] md:min-h-0" />
                  </Labeled>
                  <Labeled label="Milestone" className="w-full sm:w-40 md:w-40 min-w-0">
                    <Select value={t.milestoneKey ?? ""} onChange={(e) => update({ tasks: d.tasks.map((x) => (x.key === t.key ? { ...x, milestoneKey: e.target.value || null } : x)) })} className="min-h-[40px] md:min-h-0">
                      <option value="">None</option>
                      {d.milestones.map((m) => <option key={m.key} value={m.key}>{m.title || "untitled milestone"}</option>)}
                    </Select>
                  </Labeled>
                  <Labeled label="Subtask of" className="w-full sm:w-40 md:w-40 min-w-0">
                    <Select
                      value={t.parentKey ?? ""}
                      disabled={locked || hasChildren(t.key)}
                      onChange={(e) => update({ tasks: d.tasks.map((x) => (x.key === t.key ? { ...x, parentKey: e.target.value || null } : x)) })}
                      className="min-h-[40px] md:min-h-0"
                    >
                      <option value="">None (top level)</option>
                      {d.tasks.filter((p) => p.key !== t.key && p.parentKey === null).map((p) => <option key={p.key} value={p.key}>{p.title || "untitled task"}</option>)}
                    </Select>
                  </Labeled>
                  <RowControls label={`task ${t.title || i + 1}`} index={i} count={d.tasks.length} disabled={locked} onMove={(delta) => update({ tasks: move(d.tasks, i, delta) })} onRemove={() => removeTask(t.key)} />
                </div>
                <div className="space-y-1 pl-1 min-w-0">
                  {items.map(({ c, index }, n) => (
                    <div key={index} className="flex flex-wrap sm:flex-nowrap items-end gap-2 min-w-0">
                      <Labeled label={`Checklist item ${n + 1} for ${t.title || "task"}`} className="flex-1 min-w-0">
                        <Input value={c.text} maxLength={500} onChange={(e) => update({ checklist: d.checklist.map((x, j) => (j === index ? { ...x, text: e.target.value } : x)) })} className="min-h-[40px] md:min-h-0" />
                      </Labeled>
                      <Button type="button" size="icon" variant="ghost" aria-label={`Remove checklist item ${n + 1} from ${t.title || "task"}`} onClick={() => update({ checklist: d.checklist.filter((_, j) => j !== index) })} className="min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0">
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="ghost" className="min-h-[40px] md:min-h-0" onClick={() => update({ checklist: [...d.checklist, { taskKey: t.key, text: "" }] })}>
                    <Plus className="h-3.5 w-3.5" aria-hidden /> Add checklist item to {t.title || `task ${i + 1}`}
                  </Button>
                </div>
              </div>
            );
          })}
        </section>

        <section aria-labelledby="tpl-deps" className="space-y-3 rounded-lg border border-line p-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <h2 id="tpl-deps" className="text-sm font-semibold text-fg break-words">Dependencies ({d.dependencies.length})</h2>
            <Button type="button" size="sm" variant="outline" className="min-h-[40px] md:min-h-0" disabled={locked || d.tasks.length < 2} onClick={() => update({ dependencies: [...d.dependencies, { taskKey: d.tasks[1]!.key, dependsOnKey: d.tasks[0]!.key }] })}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add dependency
            </Button>
          </div>
          <p className="text-[11px] text-faint break-words">“A depends on B” means A cannot be finished until B is. Cycles are rejected when you save.</p>
          {d.dependencies.map((dep, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 min-w-0">
              <Labeled label={`Dependency ${i + 1}: task`} className="w-full sm:min-w-40 sm:flex-1 md:w-auto md:min-w-40 md:flex-1 min-w-0">
                <Select value={dep.taskKey} onChange={(e) => update({ dependencies: d.dependencies.map((x, j) => (j === i ? { ...x, taskKey: e.target.value } : x)) })} className="min-h-[40px] md:min-h-0">
                  {d.tasks.map((t) => <option key={t.key} value={t.key}>{t.title || "untitled task"}</option>)}
                </Select>
              </Labeled>
              <span className="pb-2 text-[12px] text-muted">depends on</span>
              <Labeled label={`Dependency ${i + 1}: depends on`} className="w-full sm:min-w-40 sm:flex-1 md:w-auto md:min-w-40 md:flex-1 min-w-0">
                <Select value={dep.dependsOnKey} onChange={(e) => update({ dependencies: d.dependencies.map((x, j) => (j === i ? { ...x, dependsOnKey: e.target.value } : x)) })} className="min-h-[40px] md:min-h-0">
                  {d.tasks.map((t) => <option key={t.key} value={t.key}>{t.title || "untitled task"}</option>)}
                </Select>
              </Labeled>
              <Button type="button" size="icon" variant="ghost" aria-label={`Remove dependency ${i + 1}`} onClick={() => update({ dependencies: d.dependencies.filter((_, j) => j !== i) })} className="min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0">
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
        </section>

        <section aria-labelledby="tpl-docs" className="space-y-3 rounded-lg border border-line p-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <h2 id="tpl-docs" className="text-sm font-semibold text-fg break-words">Knowledge documents ({d.documents.length})</h2>
            <Button type="button" size="sm" variant="outline" className="min-h-[40px] md:min-h-0" onClick={() => update({ documents: [...d.documents, { title: "", content: "", category: null, pinned: false }] })}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add document
            </Button>
          </div>
          {d.documents.map((doc, i) => (
            <div key={i} className="space-y-2 border-t border-line/60 pt-3 min-w-0">
              <div className="flex flex-wrap items-end gap-2 min-w-0">
                <Labeled label={`Document ${i + 1} title`} className="min-w-48 flex-1">
                  <Input value={doc.title} maxLength={200} onChange={(e) => update({ documents: d.documents.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} className="min-h-[40px] md:min-h-0" />
                </Labeled>
                <Labeled label="Category" className="w-full sm:w-40 md:w-40 min-w-0">
                  <Input value={doc.category ?? ""} maxLength={120} onChange={(e) => update({ documents: d.documents.map((x, j) => (j === i ? { ...x, category: e.target.value || null } : x)) })} className="min-h-[40px] md:min-h-0" />
                </Labeled>
                <label className="flex items-center gap-2 pb-2 text-[12px] text-muted min-h-[40px] md:min-h-0">
                  <input type="checkbox" checked={doc.pinned} onChange={(e) => update({ documents: d.documents.map((x, j) => (j === i ? { ...x, pinned: e.target.checked } : x)) })} />
                  Pinned
                </label>
                <RowControls label={`document ${doc.title || i + 1}`} index={i} count={d.documents.length} disabled={locked} onMove={(delta) => update({ documents: move(d.documents, i, delta) })} onRemove={() => update({ documents: d.documents.filter((_, j) => j !== i) })} />
              </div>
              <Labeled label={`Document ${i + 1} content`} className="min-w-0">
                <Textarea value={doc.content} maxLength={50_000} onChange={(e) => update({ documents: d.documents.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)) })} />
              </Labeled>
            </div>
          ))}
        </section>
      </fieldset>

      <ApplyPanel templateId={templateId} template={saved!} canApply={canEdit} dirty={dirty} taskLabel={taskLabel} />
    </div>
  );
}

function ApplyPanel({
  templateId,
  template,
  canApply,
  dirty,
  taskLabel,
}: {
  templateId: string;
  template: StoredTemplate;
  canApply: boolean;
  dirty: boolean;
  taskLabel: (key: string) => string;
}) {
  const router = useRouter();
  const [startDate, setStartDate] = useState("");
  const [name, setName] = useState(template.project.name);
  const [preview, setPreview] = useState<{ signature: string; data: TemplatePreview } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<{ message: string; issues: TemplateIssue[]; retryable: boolean } | null>(null);
  // One request key per (template version, start date, name): retries reuse it.
  const [requestKey, setRequestKey] = useState<{ signature: string; key: string } | null>(null);

  const signature = `${templateId}|${template.updatedAt}|${startDate}|${name.trim()}`;
  const current = preview && preview.signature === signature ? preview.data : null;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(startDate);

  async function runPreview() {
    setLoadingPreview(true);
    setPreviewError("");
    try {
      const r = await templatesApi.preview(templateId, startDate, name.trim() || undefined);
      setPreview({ signature, data: r.preview });
    } catch (e) {
      setPreviewError(e instanceof TemplateRequestError ? e.message : "Couldn’t load the preview. Try again.");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function createProject() {
    const key = requestKey && requestKey.signature === signature ? requestKey.key : newRequestKey();
    setRequestKey({ signature, key });
    setApplying(true);
    setApplyError(null);
    try {
      const r = await templatesApi.apply(templateId, { idempotencyKey: key, startDate, name: name.trim() || undefined });
      router.push(`/projects/${encodeURIComponent(r.project.id)}`);
    } catch (e) {
      if (e instanceof TemplateRequestError && e.status < 500) {
        setApplyError({ message: e.message, issues: e.issues, retryable: false });
      } else {
        setApplyError({
          message: "We couldn’t confirm the project was created. Retrying is safe: it will not create a second project.",
          issues: [],
          retryable: true,
        });
      }
      setApplying(false);
    }
  }

  return (
    <section aria-labelledby="tpl-apply" className="space-y-4 rounded-lg border border-[var(--accent)]/40 p-4 min-w-0" data-testid="template-apply">
      <div className="min-w-0">
        <h2 id="tpl-apply" className="text-sm font-semibold text-fg break-words">Create a project from this template</h2>
        <p className="text-[12px] text-faint break-words">Preview first — previewing never creates anything. Dates are calculated from the start date you choose.</p>
      </div>
      {dirty ? <p className="text-[12px] text-amber-300 break-words">Save your changes first: the preview and the project use the saved template.</p> : null}
      <div className="flex flex-wrap items-end gap-2 min-w-0">
        <Labeled label="Project start date" className="w-full sm:w-44 md:w-44 min-w-0">
          <Input type="date" min="1900-01-01" max="9999-12-31" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="min-h-[40px] md:min-h-0" />
        </Labeled>
        <Labeled label="New project name" className="min-w-48 flex-1">
          <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} className="min-h-[40px] md:min-h-0" />
        </Labeled>
        <Button type="button" variant="outline" disabled={!validDate || !name.trim() || dirty || loadingPreview} onClick={runPreview} className="min-h-[40px] md:min-h-0">
          {loadingPreview ? "Previewing…" : "Preview project"}
        </Button>
      </div>
      {previewError ? <p role="alert" className="text-[12px] text-red-400 break-words">{previewError}</p> : null}

      {current ? (
        <div className="space-y-3 rounded-md border border-line bg-[var(--bg-subtle)] p-3 min-w-0 overflow-x-auto" data-testid="template-preview">
          <p className="text-[12px] font-medium text-amber-200 break-words">Preview only — nothing has been created yet.</p>
          <p className="text-[13px] text-fg break-words">
            <span className="font-semibold">{current.projectName}</span>, starting {current.startDate}
          </p>
          <p className="text-[12px] text-muted break-words" data-testid="preview-counts">
            {current.counts.milestones} milestones · {current.counts.tasks} tasks ({current.counts.subtasks} subtasks) · {current.counts.dependencies} dependencies · {current.counts.checklist} checklist items · {current.counts.documents} documents · {current.counts.records} records in total
          </p>
          {current.milestones.length > 0 ? (
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold text-muted">Milestones</h3>
              <ul className="text-[12px] min-w-0">
                {current.milestones.map((m) => <li key={m.key} className="break-words">{m.title} — {m.targetDate ?? "no target date"}</li>)}
              </ul>
            </div>
          ) : null}
          {current.tasks.length > 0 ? (
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold text-muted">Tasks</h3>
              <ul className="text-[12px] min-w-0" aria-label="Preview tasks">
                {current.tasks.map((t) => (
                  <li key={t.key} className={`break-words ${t.parentKey ? "ml-3 sm:ml-5" : ""}`}>
                    {t.parentKey ? "↳ " : ""}
                    {t.title} — {t.dueDate ? `due ${t.dueDate}` : "no due date"} · {t.priority}
                    {t.checklistCount > 0 ? ` · ${t.checklistCount} checklist items` : ""}
                    {t.dependsOn.length > 0 ? ` · depends on ${t.dependsOn.map(taskLabel).join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {current.documents.length > 0 ? (
            <div className="min-w-0">
              <h3 className="text-[12px] font-semibold text-muted">Knowledge documents</h3>
              <ul className="text-[12px] min-w-0">
                {current.documents.map((doc, i) => <li key={i} className="break-words">{doc.title}{doc.category ? ` (${doc.category})` : ""}{doc.pinned ? " · pinned" : ""}</li>)}
              </ul>
            </div>
          ) : null}
          <ul className="text-[11px] text-faint min-w-0">{current.warnings.map((w) => <li key={w} className="break-words">{w}</li>)}</ul>
          <Issues issues={current.errors} />
          {canApply ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 min-w-0">
              <Button type="button" variant="primary" disabled={applying || current.errors.length > 0 || dirty} onClick={createProject} className="min-h-[40px] md:min-h-0">
                {applying ? "Creating project…" : applyError?.retryable ? "Retry creating project" : `Create project “${current.projectName}”`}
              </Button>
              <span className="text-[11px] text-faint break-words">This creates a real project in your workspace.</span>
            </div>
          ) : (
            <p className="text-[12px] text-faint break-words">Creating projects from templates needs the member role.</p>
          )}
          {applyError ? (
            <div role="alert" className="space-y-1 text-[12px] text-red-400 break-words">
              <p className="break-words">{applyError.message}</p>
              <Issues issues={applyError.issues} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
