"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUp,
  Cpu,
  GitBranch,
  MessageSquarePlus,
  Paperclip,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { StatusDot, stateLabel } from "@/components/ai/status-dot";
import { AgentModePanel } from "@/components/ai/agent-mode-panel";
import { cn, formatBytes } from "@/lib/utils";
import type { AiOverview } from "@/core/ai/service";
import type {
  Conversation,
  ConversationWithMessages,
  MessageAttachment,
} from "@/core/ai/conversations";
import type { ProjectFile } from "@/core/projects/types";
import type { ProjectContext } from "@/core/projects/context";
import type { AiMode, AiState } from "@/core/ai/types";

/**
 * The local AI surface inside the AI Workspace.
 *
 * One client component owns the whole interaction because it is one
 * interaction: the model in the header, the transcript, the composer and the
 * stop button all describe a single generation, and splitting them would mean
 * lifting that state into something shared anyway. Everything that is *not*
 * per-keystroke — the project, the conversation, the git branch — stays in the
 * URL and is rendered on the server, so a reload reopens exactly what was open.
 */

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  stoppedReason: string | null;
  attachments: MessageAttachment[];
  pending?: boolean;
}

/** Files can only be attached to a message once a project scopes them. */
const MAX_ATTACHMENTS = 8;

interface Props {
  overview: AiOverview;
  projects: { id: string; name: string }[];
  projectContext: ProjectContext | null;
  conversations: Conversation[];
  conversation: ConversationWithMessages | null;
  projectId: string | null;
  conversationId: string | null;
}

/** Turns an error code into something worth reading. */
const ERROR_HELP: Record<string, string> = {
  offline: "Ollama is not answering. Start it and try again.",
  model_missing: "That model is not installed. Pull it with Ollama, then reload.",
  timeout: "The model took too long to respond. A smaller model or context may help.",
  out_of_memory:
    "There was not enough memory to load that model. Try a smaller model or a smaller context size.",
  cancelled: "Generation stopped.",
  malformed: "The AI service sent something this app could not read.",
  unsupported: "Agent mode is not connected yet.",
  not_configured: "Local AI is turned off in Settings.",
};

export function LocalAiWorkspace({
  overview,
  projects,
  projectContext,
  conversations,
  conversation,
  projectId,
  conversationId,
}: Props) {
  const router = useRouter();

  const [status, setStatus] = useState(overview.local);
  const [models, setModels] = useState(overview.models);
  const [loaded, setLoaded] = useState(overview.loaded);
  const [model, setModel] = useState(overview.selectedModel ?? "");
  const [mode, setMode] = useState<AiMode>(overview.settings.mode);
  const [starting, setStarting] = useState(false);

  /*
   * Seeded from the server once, not synchronised on every render.
   *
   * The page mounts this component with the conversation id as its key, so
   * opening a different conversation is a remount and this initialiser runs
   * again with the right transcript. Copying props into state on each render
   * instead would fight the tokens still streaming in.
   */
  const [messages, setMessages] = useState<DisplayMessage[]>(() =>
    (conversation?.messages ?? [])
      .filter((message) => message.role !== "system")
      .map((message) => ({
        id: message.id,
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        stoppedReason: message.stoppedReason,
        attachments: message.attachments,
      })),
  );
  const [draft, setDraft] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);

  /*
   * Attachments belong to the next message, not to the conversation.
   *
   * The project's uploaded files are listed here so the user can pick the ones
   * this question is about; the selection is cleared once it has been sent, so
   * a long conversation does not quietly re-send the same files every turn.
   */
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);

  /*
   * Switching project drops the selection during the render that reports it,
   * rather than in an effect. An effect would let one paint happen with the
   * previous project's files still listed as attached, and React's own advice
   * for "state derived from a prop that changed" is exactly this.
   */
  const [filesFor, setFilesFor] = useState<string | null>(projectId);
  if (filesFor !== projectId) {
    setFilesFor(projectId);
    setProjectFiles([]);
    setSelectedFiles([]);
    setPickerOpen(false);
    setAttachmentNotice(null);
  }

  useEffect(() => {
    if (!projectId) return;

    // A project switched mid-request would otherwise apply the previous
    // project's file list to the new one.
    let current = true;
    fetch(`/api/projects/${projectId}/files`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { files: [] }))
      .then((body: { files?: ProjectFile[] }) => {
        if (current) setProjectFiles(body.files ?? []);
      })
      .catch(() => {
        if (current) setProjectFiles([]);
      });

    return () => {
      current = false;
    };
  }, [projectId]);

  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const activeConversation = useRef<string | null>(conversationId);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/status", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as AiOverview;
      setStatus(body.local);
      setModels(body.models);
      setLoaded(body.loaded);
      setModel((current) =>
        current && body.models.some((entry) => entry.name === current)
          ? current
          : (body.selectedModel ?? ""),
      );
    } catch {
      // A failed status poll is not worth interrupting anyone over; the next
      // one will either succeed or the state will already read offline.
    }
  }, []);

  // Polled only while idle. Probing during a generation adds a request per
  // fifteen seconds to a connection that is already busy proving it works.
  useEffect(() => {
    if (generating) return;
    const timer = setInterval(refreshStatus, 15_000);
    return () => clearInterval(timer);
  }, [generating, refreshStatus]);

  const startOllama = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const bridge = typeof window !== "undefined" ? window.desktop : undefined;
      if (!bridge?.ai) {
        setError({
          message: "Starting Ollama needs the desktop application.",
          code: "unsupported",
        });
        return;
      }
      const result = await bridge.ai.start();
      if (!result.ok) {
        setError({ message: result.error, code: "start_failed" });
      }
      await refreshStatus();
      router.refresh();
    } finally {
      setStarting(false);
    }
  }, [refreshStatus, router]);

  const displayState: AiState = generating ? "generating" : status.state;
  const residentModel = loaded.find((entry) => entry.name === model) ?? null;
  const canSend =
    status.state === "ready" && Boolean(model) && !generating && draft.trim().length > 0;

  const navigate = useCallback(
    (next: { project?: string | null; conversation?: string | null }) => {
      const params = new URLSearchParams();
      const project = next.project === undefined ? projectId : next.project;
      const chat = next.conversation === undefined ? conversationId : next.conversation;
      if (project) params.set("project", project);
      if (chat) params.set("c", chat);
      const query = params.toString();
      router.push(query ? `/ai/chat?${query}` : "/ai/chat");
    },
    [conversationId, projectId, router],
  );

  async function send() {
    const content = draft.trim();
    if (!content || generating) return;

    const controller = new AbortController();
    abortRef.current = controller;

    const pendingId = `pending-${Date.now()}`;
    setDraft("");
    setError(null);
    setGenerating(true);
    const sending = selectedFiles;
    setAttachmentNotice(null);
    setMessages((current) => [
      ...current,
      {
        id: `${pendingId}-user`,
        role: "user",
        content,
        stoppedReason: null,
        // Replaced by the server's own list once it says what it accepted.
        attachments: projectFiles
          .filter((file) => sending.includes(file.id))
          .map((file) => ({
            id: file.id,
            filename: file.filename,
            size: file.size,
            truncated: false,
          })),
      },
      {
        id: pendingId,
        role: "assistant",
        content: "",
        stoppedReason: null,
        attachments: [],
        pending: true,
      },
    ]);

    const append = (text: string) =>
      setMessages((current) =>
        current.map((message) =>
          message.id === pendingId ? { ...message, content: message.content + text } : message,
        ),
      );

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: content,
          model,
          mode,
          conversationId: activeConversation.current,
          projectId,
          attachments: sending,
        }),
      });

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string; code?: string }
          | null;
        throw new StreamFailure(body?.error ?? "The AI service refused the request.", body?.code);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let createdConversation: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event.type === "conversation" && typeof event.id === "string") {
            createdConversation = event.id;
            activeConversation.current = event.id;
          } else if (event.type === "attachments") {
            const accepted = Array.isArray(event.attached)
              ? (event.attached as MessageAttachment[])
              : [];
            const refused = Array.isArray(event.rejected)
              ? (event.rejected as { filename: string | null; reason: string }[])
              : [];

            // The server decides what was actually sent — a file deleted since
            // the picker was opened, or one too large to fit, never arrives.
            setSelectedFiles([]);
            setMessages((current) =>
              current.map((message) =>
                message.id === `${pendingId}-user`
                  ? { ...message, attachments: accepted }
                  : message,
              ),
            );
            setAttachmentNotice(
              refused.length > 0
                ? refused
                    .map((entry) => `${entry.filename ?? "A file"}: ${entry.reason}`)
                    .join(" · ")
                : null,
            );
          } else if (event.type === "delta" && typeof event.text === "string") {
            append(event.text);
          } else if (event.type === "done" && typeof event.text === "string") {
            // With streaming off this is the first and only text to arrive.
            const finalText = event.text;
            setMessages((current) =>
              current.map((message) =>
                message.id === pendingId
                  ? { ...message, content: finalText, pending: false }
                  : message,
              ),
            );
          } else if (event.type === "error") {
            const code = typeof event.code === "string" ? event.code : "generation_failed";
            const message =
              typeof event.message === "string" ? event.message : "Generation failed.";
            setError({ message: ERROR_HELP[code] ?? message, code });
            setMessages((current) =>
              current.map((entry) =>
                entry.id === pendingId
                  ? { ...entry, pending: false, stoppedReason: code === "cancelled" ? "cancelled" : "error" }
                  : entry,
              ),
            );
          }
        }
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === pendingId ? { ...message, pending: false } : message,
        ),
      );

      // Only now, with the reply on screen: navigating mid-stream would remount
      // this component and throw away the tokens still arriving.
      if (createdConversation && !conversationId) {
        navigate({ conversation: createdConversation });
      } else {
        router.refresh();
      }
    } catch (failure) {
      const aborted = failure instanceof DOMException && failure.name === "AbortError";
      setMessages((current) =>
        current.map((message) =>
          message.id === pendingId
            ? { ...message, pending: false, stoppedReason: aborted ? "cancelled" : "error" }
            : message,
        ),
      );
      if (!aborted) {
        const code = failure instanceof StreamFailure ? (failure.code ?? "offline") : "offline";
        setError({
          message:
            failure instanceof StreamFailure
              ? failure.message
              : "Could not reach the local AI service.",
          code,
        });
      }
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function removeConversation(id: string) {
    await fetch(`/api/ai/conversations/${id}`, { method: "DELETE" }).catch(() => undefined);
    if (id === conversationId) navigate({ conversation: null });
    else router.refresh();
  }

  const contextLabel = useMemo(
    () => overview.settings.contextSize.toLocaleString(),
    [overview.settings.contextSize],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* History ------------------------------------------------------- */}
      <aside className="hidden lg:block">
        <div className="sticky top-4 space-y-2">
          <button
            type="button"
            onClick={() => navigate({ conversation: null })}
            className={cn(buttonClasses("secondary", "md"), "w-full justify-center")}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
            New chat
          </button>

          {conversations.length === 0 ? (
            <p className="px-1 pt-1 text-[11.5px] leading-relaxed text-faint">
              Conversations you start are saved here, in your own database.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((entry) => (
                <li key={entry.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => navigate({ conversation: entry.id })}
                    className={cn(
                      "w-full truncate rounded-md px-2 py-1.5 pr-7 text-left text-[12.5px] transition-colors",
                      entry.id === conversationId
                        ? "bg-[var(--bg-subtle)] text-fg"
                        : "text-muted hover:bg-[var(--bg-subtle)] hover:text-fg",
                    )}
                    title={entry.title}
                  >
                    {entry.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeConversation(entry.id)}
                    aria-label={`Delete ${entry.title}`}
                    className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-faint transition-colors hover:text-red-400 group-hover:block"
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Conversation --------------------------------------------------- */}
      <div className="min-w-0 space-y-3">
        <div className="rounded-xl border border-line bg-surface">
          {/* Status ---------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
              <Cpu className="h-3.5 w-3.5 text-faint" strokeWidth={1.75} />
              Local AI
            </span>

            <span className="flex items-center gap-1.5">
              <StatusDot state={displayState} />
              <span className="text-[12px] text-muted">{stateLabel(displayState)}</span>
            </span>

            <Detail label="Provider" value={mode === "agent" ? "Hermes" : "Ollama"} />
            <Detail label="Context" value={contextLabel} />
            {residentModel && residentModel.sizeVram > 0 ? (
              <Detail label="In memory" value={formatBytes(residentModel.sizeVram)} />
            ) : null}
            {projectContext ? (
              <Detail label="Project" value={projectContext.name} />
            ) : null}
            {projectContext?.git.branch ? (
              <span className="flex items-center gap-1 text-[11.5px] text-muted">
                <GitBranch className="h-3 w-3 text-faint" strokeWidth={1.75} />
                {projectContext.git.branch}
              </span>
            ) : null}
          </div>

          {/* Controls -------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <Select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={models.length === 0 || generating}
              aria-label="Model"
              className="w-auto min-w-44"
            >
              {models.length === 0 ? (
                <option value="">No models installed</option>
              ) : (
                models.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                    {entry.parameterSize ? ` · ${entry.parameterSize}` : ""}
                  </option>
                ))
              )}
            </Select>

            <Select
              value={projectId ?? ""}
              onChange={(event) => navigate({ project: event.target.value || null })}
              aria-label="Project"
              className="w-auto min-w-40"
              disabled={generating}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>

            <div
              className="ml-auto inline-flex rounded-md border border-line p-0.5"
              role="group"
              aria-label="Mode"
            >
              {(["chat", "agent"] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setMode(entry)}
                  disabled={generating}
                  className={cn(
                    "rounded px-2 py-1 text-[12px] font-medium capitalize transition-colors disabled:opacity-50",
                    mode === entry
                      ? "bg-[var(--bg-subtle)] text-fg"
                      : "text-muted hover:text-fg",
                  )}
                >
                  {entry}
                </button>
              ))}
            </div>
          </div>

          {/* Transcript ------------------------------------------------ */}
          {mode === "agent" ? (
            <AgentModePanel
              status={overview.hermes}
              enabled={overview.settings.agentEnabled}
              approvals={overview.approvals}
            />
          ) : (
            <>
              <div
                ref={transcriptRef}
                className="max-h-[52vh] min-h-64 overflow-y-auto px-4 py-4"
              >
                {messages.length === 0 ? (
                  <EmptyTranscript
                    state={status.state}
                    detail={status.detail}
                    projectName={projectContext?.name ?? null}
                  />
                ) : (
                  <ul className="space-y-4">
                    {messages.map((message) => (
                      <Bubble key={message.id} message={message} />
                    ))}
                  </ul>
                )}
              </div>

              {/* Composer ---------------------------------------------- */}
              <div className="border-t border-line p-3">
                {error ? (
                  <div className="mb-2 flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/5 px-2.5 py-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] text-fg">{error.message}</p>
                      {status.error ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-faint hover:text-muted">
                            Technical details
                          </summary>
                          <p className="mt-1 break-words font-mono text-[11px] text-faint">
                            {status.error}
                          </p>
                        </details>
                      ) : null}
                    </div>
                    {status.state !== "ready" ? (
                      <Button type="button" size="sm" onClick={startOllama} disabled={starting}>
                        <Play className="h-3 w-3" strokeWidth={1.75} />
                        {starting ? "Starting…" : "Start Ollama"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {attachmentNotice ? (
                  <p className="mb-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-1.5 text-[12px] text-amber-300">
                    {attachmentNotice}
                  </p>
                ) : null}

                {pickerOpen ? (
                  <div className="mb-2 rounded-md border border-line bg-[var(--bg-subtle)]">
                    <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
                      <p className="text-[11.5px] text-muted">
                        {projectFiles.length === 0
                          ? "This project has no uploaded files."
                          : `Attach up to ${MAX_ATTACHMENTS} files to the next message`}
                      </p>
                      <button
                        type="button"
                        onClick={() => setPickerOpen(false)}
                        aria-label="Close attachments"
                        className="rounded p-0.5 text-faint transition-colors hover:text-fg"
                      >
                        <X className="h-3 w-3" strokeWidth={2} />
                      </button>
                    </div>
                    {projectFiles.length === 0 ? (
                      <p className="px-2.5 py-2 text-[11.5px] leading-relaxed text-faint">
                        Add files from the project page, then attach them here.
                      </p>
                    ) : (
                      <ul className="max-h-44 overflow-y-auto py-1">
                        {projectFiles.map((file) => {
                          const checked = selectedFiles.includes(file.id);
                          return (
                            <li key={file.id}>
                              <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-[12.5px] transition-colors hover:bg-[var(--bg-hover)]">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={!checked && selectedFiles.length >= MAX_ATTACHMENTS}
                                  onChange={() =>
                                    setSelectedFiles((current) =>
                                      checked
                                        ? current.filter((id) => id !== file.id)
                                        : [...current, file.id],
                                    )
                                  }
                                  className="h-3 w-3 shrink-0 accent-[var(--accent)]"
                                />
                                <span className="min-w-0 flex-1 truncate text-fg">
                                  {file.filename}
                                </span>
                                <span className="shrink-0 text-[11px] text-faint">
                                  {formatBytes(file.size)}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}

                {selectedFiles.length > 0 ? (
                  <ul className="mb-2 flex flex-wrap gap-1.5">
                    {projectFiles
                      .filter((file) => selectedFiles.includes(file.id))
                      .map((file) => (
                        <li
                          key={file.id}
                          className="flex items-center gap-1 rounded-md border border-line bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[11.5px] text-muted"
                        >
                          <Paperclip className="h-3 w-3 text-faint" strokeWidth={1.75} />
                          <span className="max-w-40 truncate">{file.filename}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedFiles((current) =>
                                current.filter((id) => id !== file.id),
                              )
                            }
                            aria-label={`Remove ${file.filename}`}
                            className="rounded text-faint transition-colors hover:text-fg"
                          >
                            <X className="h-3 w-3" strokeWidth={2} />
                          </button>
                        </li>
                      ))}
                  </ul>
                ) : null}

                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPickerOpen((open) => !open)}
                    disabled={!projectId || generating}
                    aria-label="Attach files"
                    aria-expanded={pickerOpen}
                    title={
                      projectId
                        ? "Attach files from this project"
                        : "Select a project to attach its files"
                    }
                    className={cn(
                      "flex h-[2.75rem] w-9 shrink-0 items-center justify-center rounded-md border border-line text-faint transition-colors",
                      "hover:border-[var(--border-strong)] hover:text-fg disabled:opacity-40 disabled:hover:border-line disabled:hover:text-faint",
                      selectedFiles.length > 0 && "border-[var(--accent)] text-fg",
                    )}
                  >
                    <Paperclip className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    rows={2}
                    placeholder={
                      status.state === "ready"
                        ? projectContext
                          ? `Ask about ${projectContext.name}…`
                          : "Ask your local model…"
                        : "Local AI is not connected."
                    }
                    disabled={status.state !== "ready" || generating}
                    className="min-h-[2.75rem] w-full resize-y rounded-md border border-line bg-[var(--bg-subtle)] px-2.5 py-2 text-[13px] leading-relaxed text-fg placeholder:text-faint transition-colors hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)] disabled:opacity-50"
                  />
                  {generating ? (
                    <Button type="button" onClick={stop} size="lg" aria-label="Stop generating">
                      <Square className="h-3.5 w-3.5" strokeWidth={2} />
                      Stop
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="primary"
                      size="lg"
                      onClick={() => void send()}
                      disabled={!canSend}
                      aria-label="Send"
                    >
                      <ArrowUp className="h-3.5 w-3.5" strokeWidth={2} />
                      Send
                    </Button>
                  )}
                </div>

                <p className="mt-1.5 text-[11px] text-faint">
                  Runs entirely on this machine. Nothing is sent to a cloud service.
                  {projectContext
                    ? " The model is told the project's name, path and branch — and only the files you attach."
                    : ""}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Thrown for a non-2xx response so the catch below can carry its code. */
class StreamFailure extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1 text-[11.5px]">
      <span className="text-faint">{label}</span>
      <span className="max-w-40 truncate text-muted" title={value}>
        {value}
      </span>
    </span>
  );
}

function Bubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";

  return (
    <li className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[46rem] rounded-xl px-3 py-2 text-[13px] leading-relaxed",
          isUser
            ? "border border-line bg-[var(--bg-subtle)] text-fg"
            : "border border-transparent text-fg",
        )}
      >
        {message.attachments.length > 0 ? (
          <ul className="mb-1.5 flex flex-wrap gap-1">
            {message.attachments.map((file) => (
              <li
                key={file.id}
                className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted"
                title={file.truncated ? "Only the beginning of this file was sent" : undefined}
              >
                <Paperclip className="h-2.5 w-2.5 text-faint" strokeWidth={1.75} />
                <span className="max-w-40 truncate">{file.filename}</span>
                {file.truncated ? <span className="text-faint">· truncated</span> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {message.content ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : message.pending ? (
          <span className="inline-flex gap-1 py-1" aria-label="Thinking">
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-faint"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
        ) : null}

        {message.stoppedReason ? (
          <p className="mt-1 text-[11px] text-faint">
            {message.stoppedReason === "cancelled" ? "Stopped." : "This reply did not finish."}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function EmptyTranscript({
  state,
  detail,
  projectName,
}: {
  state: AiState;
  detail: string;
  projectName: string | null;
}) {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-1.5 text-center">
      <Cpu className="h-6 w-6 text-faint" strokeWidth={1.5} />
      <p className="text-[13px] font-medium text-fg">
        {state === "ready"
          ? projectName
            ? `Ask anything about ${projectName}`
            : "Ask your local model anything"
          : "Local AI is not connected"}
      </p>
      <p className="max-w-md text-[12px] leading-relaxed text-muted">{detail}</p>
    </div>
  );
}
