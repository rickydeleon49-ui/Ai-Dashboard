"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/field";
import {
  groupComments,
  parseCommentList,
  type RunComment,
} from "./comments-logic";

export interface RunCommentsProps {
  runId: string;
  round: number;
  files: string[];
  draft?: { file: string; line: number | null } | null;
  onDraftConsumed?: () => void;
  onCommentsChange?: (comments: RunComment[]) => void;
  /** When set, the add form is replaced by this note (older rounds are read-only). */
  readOnlyNote?: string;
}

async function fetchComments(runId: string, round: number): Promise<RunComment[]> {
  const res = await fetch(
    `/api/agent-runs/${encodeURIComponent(runId)}/comments?round=${encodeURIComponent(round)}`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Failed to load comments (${res.status})`);
  }
  return parseCommentList(await res.json());
}

export function RunComments({
  runId,
  round,
  files,
  draft,
  onDraftConsumed,
  onCommentsChange,
  readOnlyNote,
}: RunCommentsProps) {
  const [comments, setComments] = React.useState<RunComment[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Form state
  const [selectedFile, setSelectedFile] = React.useState<string>("");
  const [lineNumber, setLineNumber] = React.useState<string>("");
  const [body, setBody] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  // Bump to refetch after an add or delete.
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    fetchComments(runId, round)
      .then((list) => {
        if (cancelled) return;
        setComments(list);
        onCommentsChange?.(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load comments");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, round, reload, onCommentsChange]);

  // When draft changes, prefill file and line (adjusting state during render, not in an effect)
  const [prevDraft, setPrevDraft] = React.useState(draft);
  if (draft !== prevDraft) {
    setPrevDraft(draft);
    if (draft) {
      setSelectedFile(draft.file || "");
      setLineNumber(draft.line !== null && draft.line !== undefined ? String(draft.line) : "");
    }
  }

  // ...then focus the body and tell the parent the draft was used
  React.useEffect(() => {
    if (draft) {
      bodyRef.current?.focus();
      onDraftConsumed?.();
    }
  }, [draft, onDraftConsumed]);

  const handleFileChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedFile(val);
    if (!val) {
      setLineNumber("");
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedBody = body.trim();
    if (!trimmedBody || submitting) return;

    setSubmitting(true);
    setError(null);

    const payload: {
      round: number;
      file?: string;
      line?: number;
      body: string;
    } = {
      round,
      body: trimmedBody,
    };

    if (selectedFile) {
      payload.file = selectedFile;
      if (lineNumber.trim() !== "") {
        const parsed = Number.parseInt(lineNumber.trim(), 10);
        if (!Number.isNaN(parsed) && parsed >= 1) {
          payload.line = parsed;
        }
      }
    }

    try {
      const res = await fetch(
        `/api/agent-runs/${encodeURIComponent(runId)}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: Array<{ message: string }>;
        };
        const message =
          data.error ||
          data.issues?.map((i) => i.message).join(", ") ||
          `Failed to add comment (${res.status})`;
        setError(message);
        setSubmitting(false);
        return;
      }

      setBody("");
      setLineNumber("");
      setReload((n) => n + 1);
    } catch {
      setError("Failed to add comment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (deletingId) return;
    setDeletingId(commentId);
    setError(null);

    try {
      const res = await fetch(
        `/api/agent-runs/${encodeURIComponent(runId)}/comments/${encodeURIComponent(commentId)}`,
        { method: "DELETE" },
      );

      if (!res.ok && res.status !== 204) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || `Failed to delete comment (${res.status})`);
        setDeletingId(null);
        return;
      }

      setReload((n) => n + 1);
    } catch {
      setError("Failed to delete comment");
    } finally {
      setDeletingId(null);
    }
  };

  const grouped = React.useMemo(() => groupComments(comments), [comments]);

  const fileOptions = React.useMemo(() => {
    const list = [...files];
    if (selectedFile && !list.includes(selectedFile)) {
      list.unshift(selectedFile);
    }
    return list;
  }, [files, selectedFile]);

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-wrap items-center justify-between gap-2">
        <CardTitle>Comments</CardTitle>
        <Badge aria-live="polite">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </Badge>
      </CardHeader>
      <CardBody className="min-w-0 space-y-4">
        {error ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-400">
            {error}
          </p>
        ) : null}

        {comments.length === 0 && !loading ? (
          <p className="text-[13px] text-muted">No comments for round {round}.</p>
        ) : null}

        {grouped.general.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted">
              Whole run
            </h3>
            <ul className="space-y-2" aria-label="General comments">
              {grouped.general.map((c) => (
                <li
                  key={c.id}
                  className="min-w-0 rounded-md border border-line bg-[var(--bg-subtle)] p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="whitespace-pre-wrap break-words text-[13px] text-fg">{c.body}</p>
                      <span className="text-[11px] text-faint">{c.createdAt}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      className="self-start sm:self-auto min-h-[40px] md:min-h-0"
                      disabled={deletingId === c.id}
                      onClick={() => handleDeleteComment(c.id)}
                      aria-label="Delete comment"
                    >
                      {deletingId === c.id ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {Array.from(grouped.byFile.entries()).map(([filePath, lineMap]) => (
          <div key={filePath} className="min-w-0 space-y-2">
            <h3 className="break-all text-[12px] font-semibold text-muted">
              {filePath}
            </h3>
            <ul className="space-y-2" aria-label={`Comments on ${filePath}`}>
              {Array.from(lineMap.entries()).flatMap(([lineKey, fileComments]) =>
                fileComments.map((c) => (
                  <li
                    key={c.id}
                    className="min-w-0 rounded-md border border-line bg-[var(--bg-subtle)] p-3"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="break-all font-mono text-[12px] font-medium text-fg">
                            {filePath}
                            {c.line !== null ? `:${c.line}` : ""}
                          </span>
                          <span className="text-[11px] text-faint">{c.createdAt}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[13px] text-fg">{c.body}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="danger"
                        className="self-start sm:self-auto min-h-[40px] md:min-h-0"
                        disabled={deletingId === c.id}
                        onClick={() => handleDeleteComment(c.id)}
                        aria-label={`Delete comment on ${filePath}${c.line !== null ? `:${c.line}` : ""}`}
                      >
                        {deletingId === c.id ? "Deleting..." : "Delete"}
                      </Button>
                    </div>
                  </li>
                )),
              )}
            </ul>
          </div>
        ))}

        {readOnlyNote ? (
          <p className="border-t border-line pt-3 text-[12px] text-muted">{readOnlyNote}</p>
        ) : (
        <form onSubmit={handleAddComment} className="min-w-0 space-y-3 border-t border-line pt-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label htmlFor="comment-file-select" className="mb-1 block text-[12px] font-medium text-muted">
                File
              </label>
              <Select
                id="comment-file-select"
                value={selectedFile}
                onChange={handleFileChange}
                disabled={submitting}
              >
                <option value="">Whole run</option>
                {fileOptions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="comment-line-input" className="mb-1 block text-[12px] font-medium text-muted">
                Line
              </label>
              <Input
                id="comment-line-input"
                type="number"
                min={1}
                placeholder={selectedFile ? "e.g. 42" : "Select file first"}
                value={lineNumber}
                onChange={(e) => setLineNumber(e.target.value)}
                disabled={!selectedFile || submitting}
              />
            </div>
          </div>

          <div>
            <label htmlFor="comment-body-textarea" className="mb-1 block text-[12px] font-medium text-muted">
              Comment
            </label>
            <Textarea
              id="comment-body-textarea"
              ref={bodyRef}
              maxLength={4000}
              placeholder="Write a comment or correction instruction for this round..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={submitting}
              rows={3}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-faint">
              {body.length}/4000 characters
            </span>
            <Button
              type="submit"
              variant="primary"
              className="w-full sm:w-auto min-h-[40px] md:min-h-0"
              disabled={submitting || body.trim().length === 0}
            >
              {submitting ? "Adding..." : "Add"}
            </Button>
          </div>
        </form>
        )}
      </CardBody>
    </Card>
  );
}
