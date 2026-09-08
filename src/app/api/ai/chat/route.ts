import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { projectRepository } from "@/db/repositories";
import { AI_MODES } from "@/core/ai/types";
import type { ChatEvent, ChatMessage } from "@/core/ai/types";
import { getAiSettings, rememberLastProject } from "@/core/ai/settings";
import { isLocalRuntime, providerForMode } from "@/core/ai/service";
import { LocalChatProvider } from "@/core/ai/local-provider";
import { aiLog } from "@/core/ai/logging";
import {
  appendMessage,
  createConversation,
  findConversation,
  renameConversation,
  setConversationProject,
  titleFromMessage,
  toChatMessages,
} from "@/core/ai/conversations";
import { buildProjectContext, projectSystemPrompt } from "@/core/projects/context";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  message: z.string().trim().min(1, "Type a message first").max(100_000),
  model: z.string().trim().min(1, "Choose a model").max(200),
  mode: z.enum(AI_MODES).default("chat"),
  conversationId: z.string().trim().max(64).nullish(),
  projectId: z.string().trim().max(64).nullish(),
});

/** One NDJSON line per event — the same shape the provider yields. */
function encode(event: ChatEvent | { type: "conversation"; id: string; title: string }) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

/**
 * POST /api/ai/chat — send a message and stream the reply.
 *
 * The HTTP layer, not the model layer: it resolves the conversation, builds the
 * project context, forwards the provider's events to the browser as NDJSON, and
 * makes sure the transcript is written whichever way the generation ends —
 * finished, cancelled or failed. A reply the user watched arrive and then lost
 * on refresh would be worse than no history at all.
 */
export async function POST(request: Request) {
  ensureDatabaseReady();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 422 },
    );
  }
  const input = parsed.data;

  const settings = getAiSettings();
  if (!settings.enabled) {
    return NextResponse.json(
      { error: "Local AI is turned off in Settings.", code: "not_configured" },
      { status: 409 },
    );
  }
  if (!isLocalRuntime()) {
    return NextResponse.json(
      {
        error: "Local AI needs the desktop application — this copy runs on a server.",
        code: "unsupported",
      },
      { status: 409 },
    );
  }
  if (input.mode === "agent" && !settings.agentEnabled) {
    return NextResponse.json(
      { error: "Agent mode is not enabled in Settings.", code: "not_configured" },
      { status: 409 },
    );
  }

  // ---- Conversation ------------------------------------------------------

  const existing = input.conversationId ? findConversation(input.conversationId) : null;
  if (input.conversationId && !existing) {
    return NextResponse.json({ error: "That conversation no longer exists." }, { status: 404 });
  }

  const projectId = input.projectId?.trim() || existing?.projectId || null;
  const project = projectId ? await projectRepository.findById(projectId) : null;

  const conversation =
    existing ??
    createConversation({
      provider: input.mode === "agent" ? "hermes" : "local",
      mode: input.mode,
      model: input.model,
      projectId: project?.id ?? null,
      title: titleFromMessage(input.message),
    });

  if (existing) {
    // A conversation started with no project, then pointed at one, should keep
    // that choice rather than needing it re-picked on every message.
    if (project && existing.projectId !== project.id) {
      setConversationProject(existing.id, project.id);
    }
    if (existing.title === "New chat") renameConversation(existing.id, titleFromMessage(input.message));
  }

  rememberLastProject(project?.id ?? null);

  // ---- Messages ----------------------------------------------------------

  const history = existing ? toChatMessages(existing.messages) : [];
  appendMessage(conversation.id, { role: "user", content: input.message });

  const messages: ChatMessage[] = [];
  if (project) {
    const context = buildProjectContext(project);
    messages.push({ role: "system", content: projectSystemPrompt(context) });
    aiLog("project.context", {
      projectId: project.id,
      hasRepository: context.git.isRepository,
    });
  }
  messages.push(...history, { role: "user", content: input.message });

  // ---- Generation --------------------------------------------------------

  const provider = providerForMode(settings, input.mode);
  const controller = new AbortController();
  // A browser that navigates away or presses Stop aborts the request; that has
  // to reach Ollama, or it keeps generating into a socket nobody reads.
  request.signal.addEventListener("abort", () => controller.abort(), { once: true });

  const chatRequest = LocalChatProvider.requestFrom(settings, {
    model: input.model,
    messages,
    signal: controller.signal,
  });

  aiLog("generation.start", {
    provider: provider.id,
    model: input.model,
    messages: messages.length,
    characters: messages.reduce((total, message) => total + message.content.length, 0),
    projectId: project?.id,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(target) {
      let text = "";
      let finished = false;

      /** Writes the assistant turn exactly once, however the stream ended. */
      const persist = (reason: string | null, tokens?: {
        promptTokens: number | null;
        completionTokens: number | null;
        durationMs: number;
      }) => {
        if (finished) return;
        finished = true;
        if (!text && !reason) return;
        appendMessage(conversation.id, {
          role: "assistant",
          content: text,
          model: input.model,
          stoppedReason: reason,
          promptTokens: tokens?.promptTokens ?? null,
          completionTokens: tokens?.completionTokens ?? null,
          durationMs: tokens?.durationMs ?? null,
        });
      };

      /** Enqueueing into a stream the browser already dropped throws. */
      const send = (event: Parameters<typeof encode>[0]) => {
        try {
          target.enqueue(encode(event));
        } catch {
          // The reader is gone; keep consuming so the transcript still lands.
        }
      };

      send({ type: "conversation", id: conversation.id, title: conversation.title });

      try {
        for await (const event of provider.chat(chatRequest)) {
          if (event.type === "delta") {
            text += event.text;
            // With streaming off the reply still arrives in one piece at the
            // end; the deltas are simply not forwarded.
            if (settings.streaming) send(event);
            continue;
          }

          if (event.type === "done") {
            persist(null, {
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              durationMs: event.durationMs,
            });
            aiLog("generation.end", {
              provider: provider.id,
              model: input.model,
              durationMs: event.durationMs,
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              characters: event.text.length,
            });
            send({ ...event, text });
            continue;
          }

          if (event.type === "error") {
            persist(event.code === "cancelled" ? "cancelled" : "error");
            aiLog("generation.error", {
              provider: provider.id,
              model: input.model,
              code: event.code,
              detail: event.message,
            });
            send(event);
            continue;
          }

          send(event);
        }
      } catch (error) {
        // The provider contract is to yield errors, not throw them; this is the
        // belt-and-braces path so a bug there cannot lose the transcript.
        persist("error");
        aiLog("generation.error", {
          provider: provider.id,
          model: input.model,
          detail: error instanceof Error ? error.message : String(error),
        });
        send({
          type: "error",
          code: "generation_failed",
          message: "The reply stopped unexpectedly.",
        });
      } finally {
        persist("cancelled");
        try {
          target.close();
        } catch {
          // Already closed by the client going away.
        }
      }
    },

    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Streaming through a reverse proxy that buffers defeats the point.
      "X-Accel-Buffering": "no",
    },
  });
}
