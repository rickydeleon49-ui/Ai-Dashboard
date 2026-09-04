"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Card, CardBody } from "@/components/ui/card";
import { cn, formatBytes } from "@/lib/utils";

/**
 * Creates a project from files rather than a repository.
 *
 * Two steps behind one button: the project is created first so the files have
 * something to belong to, then the files are attached to it. If the upload half
 * fails the project still exists, which is recoverable — the alternative,
 * holding the bytes until a project is confirmed, loses the upload instead.
 */
export function UploadProjectForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((current) => [...current, ...Array.from(list)]);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();

    try {
      const created = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: String(form.get("description") ?? ""),
          source: "uploaded",
          status: "active",
        }),
      });

      const body = (await created.json()) as
        | { project: { id: string } }
        | { error: string };

      if (!created.ok || "error" in body) {
        setError("error" in body ? body.error : "Could not create the project");
        setBusy(false);
        return;
      }

      const projectId = body.project.id;

      if (files.length > 0) {
        const upload = new FormData();
        for (const file of files) upload.append("files", file);

        const response = await fetch(`/api/projects/${projectId}/files`, {
          method: "POST",
          body: upload,
        });

        if (!response.ok) {
          const failure = (await response.json()) as { error?: string };
          // The project exists; say so rather than implying nothing happened.
          setError(
            `${failure.error ?? "Upload failed"} — the project was created, so you can add files from its page.`,
          );
          setBusy(false);
          return;
        }
      }

      router.push(`/projects/${projectId}`);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <Field label="Project name" hint="Required">
            <Input name="name" required maxLength={160} placeholder="Design assets" />
          </Field>
          <Field label="Description">
            <Textarea
              name="description"
              rows={2}
              placeholder="What is in this upload?"
            />
          </Field>
        </CardBody>
      </Card>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "cursor-pointer rounded-xl border border-dashed px-6 py-10 text-center transition-colors",
          dragging
            ? "border-[var(--accent)] bg-[var(--accent-soft)]"
            : "border-line bg-surface/40 hover:border-[var(--border-strong)]",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => addFiles(e.target.files)}
        />
        <FileUp className="mx-auto h-5 w-5 text-muted" strokeWidth={1.5} />
        <p className="mt-2 text-[13px] font-medium text-fg">
          {dragging ? "Drop them here" : "Drag files here, or click to browse"}
        </p>
        <p className="mt-1 text-[12px] text-muted">
          ZIP archives, documents, scripts, configuration — anything up to 100MB each.
        </p>
      </div>

      {files.length > 0 ? (
        <Card>
          <CardBody className="space-y-1.5">
            <p className="text-[12px] text-muted">
              {files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(total)}
            </p>
            <ul className="space-y-0.5">
              {files.map((file, i) => (
                <li
                  key={`${file.name}-${i}`}
                  className="flex items-center justify-between gap-3 text-[12.5px]"
                >
                  <span className="truncate text-fg">{file.name}</span>
                  <span className="shrink-0 text-faint">{formatBytes(file.size)}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setFiles([])}
              className="pt-1 text-[11.5px] text-faint transition-colors hover:text-fg"
            >
              Clear
            </button>
          </CardBody>
        </Card>
      ) : null}

      {error ? (
        <p className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" size="lg" disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
        Create uploaded project
      </Button>
    </form>
  );
}
