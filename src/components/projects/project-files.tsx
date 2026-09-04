"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Download,
  FileArchive,
  FileCode,
  FileText,
  File as FileIcon,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { ProjectFile } from "@/core/projects/types";
import { cn, formatBytes, formatRelative } from "@/lib/utils";

/** A rough icon by extension — enough to tell an archive from a note at a glance. */
function iconFor(filename: string) {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return FileArchive;
  if (["js", "ts", "tsx", "jsx", "py", "sh", "json", "yml", "yaml", "toml"].includes(ext))
    return FileCode;
  if (["md", "txt", "pdf", "doc", "docx", "rtf"].includes(ext)) return FileText;
  return FileIcon;
}

export function ProjectFiles({
  projectId,
  files,
}: {
  projectId: string;
  files: ProjectFile[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(selected: FileList | null) {
    if (!selected || selected.length === 0) return;

    setBusy(true);
    setError(null);

    const form = new FormData();
    for (const file of Array.from(selected)) form.append("files", file);

    try {
      const response = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        body: form,
      });
      const body = (await response.json()) as {
        error?: string;
        failed?: Array<{ filename: string; error: string }>;
      };

      // A batch can partly succeed. Naming the files that did not land is the
      // difference between a usable message and "Upload failed" next to a list
      // that visibly grew.
      if (body.failed && body.failed.length > 0) {
        setError(
          body.failed
            .map((failure) => `${failure.filename}: ${failure.error}`)
            .join(" · "),
        );
      } else if (!response.ok) {
        setError(body.error ?? "Upload failed");
      }

      // Refresh whenever anything stored, including a partial batch.
      if (response.ok) router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/files/${id}`, { method: "DELETE" });
      if (!response.ok) {
        // Previously swallowed: a failed delete left the row on screen with no
        // explanation, which reads as the button being broken.
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? "Could not delete that file.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
      className={cn(
        "rounded-lg transition-colors",
        dragging && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-elevated)]",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => void upload(e.target.files)}
      />

      {files.length === 0 ? (
        <EmptyState
          icon={Upload}
          title={dragging ? "Drop to upload" : "No files attached"}
          description="Drag files here, or browse. ZIP archives, documents, scripts and configuration all work."
          className="border-0 bg-transparent py-8"
          action={
            <Button
              type="button"
              variant="primary"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              Add files
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-lg border border-line">
            {files.map((file) => {
              const Icon = iconFor(file.filename);
              return (
                <li
                  key={file.id}
                  className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-[var(--bg-subtle)]"
                >
                  <Icon className="h-4 w-4 shrink-0 text-faint" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fg">
                      {file.filename}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {formatBytes(file.size)} · {formatRelative(file.createdAt)}
                    </span>
                  </span>
                  <a
                    href={`/api/files/${file.id}`}
                    download={file.filename}
                    title="Download"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-[var(--bg-hover)] hover:text-fg"
                  >
                    <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </a>
                  <button
                    type="button"
                    onClick={() => void remove(file.id)}
                    disabled={busy}
                    title="Remove"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </li>
              );
            })}
          </ul>

          <Button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Add files
          </Button>
        </div>
      )}

      {error ? (
        <p className="mt-2 rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
