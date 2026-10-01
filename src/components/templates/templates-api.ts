/**
 * Browser-side calls for Release 2D.3 templates. Every call goes to the
 * template routes, which own authorization, validation and atomicity; the
 * browser never creates project records itself.
 */
import type {
  StoredTemplate,
  TemplateContent,
  TemplateIssue,
  TemplatePreview,
  TemplateSummary,
} from "@/core/templates/types";

export class TemplateRequestError extends Error {
  readonly status: number;
  readonly issues: TemplateIssue[];
  constructor(status: number, message: string, issues: TemplateIssue[] = []) {
    super(message);
    this.name = "TemplateRequestError";
    this.status = status;
    this.issues = issues;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const b = (body ?? {}) as { error?: unknown; issues?: unknown };
    throw new TemplateRequestError(
      response.status,
      typeof b.error === "string" ? b.error : `Request failed (${response.status}).`,
      Array.isArray(b.issues) ? (b.issues as TemplateIssue[]) : [],
    );
  }
  return body as T;
}

const idPath = (id: string) => `/api/templates/${encodeURIComponent(id)}`;

export const templatesApi = {
  list: () => call<{ workspaceId: string; canEdit: boolean; templates: TemplateSummary[] }>("/api/templates"),
  create: (name: string) =>
    call<{ template: StoredTemplate }>("/api/templates", { method: "POST", body: JSON.stringify({ name }) }),
  get: (id: string) => call<{ workspaceId: string; canEdit: boolean; template: StoredTemplate }>(idPath(id)),
  save: (id: string, content: TemplateContent) =>
    call<{ template: StoredTemplate }>(idPath(id), { method: "PUT", body: JSON.stringify(content) }),
  remove: (id: string) => call<{ deleted: true }>(idPath(id), { method: "DELETE" }),
  preview: (id: string, startDate: string, name: string | undefined, signal?: AbortSignal) => {
    const params = new URLSearchParams({ startDate });
    if (name) params.set("name", name);
    return call<{ workspaceId: string; canApply: boolean; preview: TemplatePreview }>(
      `${idPath(id)}/preview?${params.toString()}`,
      { signal },
    );
  },
  apply: (id: string, body: { idempotencyKey: string; startDate: string; name?: string }) =>
    call<{ created: boolean; project: { id: string; name: string } }>(`${idPath(id)}/apply`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** A fresh request key for one apply attempt series (the same key is reused for retries). */
export function newRequestKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
