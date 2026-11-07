import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { isTerminalStatus } from "@/core/agents/types";
import { readSince, type StoredAgentEvent } from "@/core/agents/events";
import { getRun } from "@/core/agents/runs";
import { resolveAfterSeq } from "@/core/agents/sse";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function formatAgentEvent(event: StoredAgentEvent): string {
  return `id: ${event.seq}\nevent: agent-event\ndata: ${JSON.stringify(event)}\n\n`;
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort);
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const { id: runId } = await context.params;
  const initialRun = await getRun(db, runId);
  if (!initialRun) {
    return NextResponse.json({ error: "Agent run not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const startSeq = resolveAfterSeq(
    request.headers.get("last-event-id"),
    url.searchParams.get("after"),
  );

  const encoder = new TextEncoder();
  const pollIntervalMs = Number(process.env.AGENT_RUN_EVENTS_POLL_MS) || 500;
  const keepAliveIntervalMs =
    Number(process.env.AGENT_RUN_EVENTS_KEEP_ALIVE_MS) || 15_000;

  const stream = new ReadableStream({
    async start(controller) {
      let currentSeq = startSeq;
      let lastKeepAlive = Date.now();
      let isClosed = false;

      const safeEnqueue = (text: string): boolean => {
        if (isClosed || request.signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          isClosed = true;
          return false;
        }
      };

      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          try {
            controller.close();
          } catch {
            // Already closed or errored
          }
        }
      };

      try {
        while (!isClosed && !request.signal.aborted) {
          // Replay in pages of 500
          let hasMorePages = true;
          while (hasMorePages && !isClosed && !request.signal.aborted) {
            const events = await readSince(db, runId, currentSeq, 500);
            for (const event of events) {
              const formatted = formatAgentEvent(event);
              if (!safeEnqueue(formatted)) {
                return;
              }
              currentSeq = event.seq;
            }

            hasMorePages = events.length === 500;
          }

          if (isClosed || request.signal.aborted) break;

          // Check if run is terminal
          const currentRun = await getRun(db, runId);
          if (!currentRun) {
            // The run was deleted while the stream was open: nothing more will arrive.
            safeEnqueue('event: end\ndata: {"reason":"deleted"}\n\n');
            safeClose();
            return;
          }
          if (isTerminalStatus(currentRun.status)) {
            // Catch any trailing events that arrived before terminal status was observed
            const trailing = await readSince(db, runId, currentSeq, 500);
            for (const event of trailing) {
              const formatted = formatAgentEvent(event);
              if (!safeEnqueue(formatted)) {
                return;
              }
              currentSeq = event.seq;
            }

            if (trailing.length === 0) {
              safeEnqueue("event: end\ndata: {}\n\n");
              safeClose();
              return;
            }
          }

          // Keep-alive heartbeat
          const now = Date.now();
          if (now - lastKeepAlive >= keepAliveIntervalMs) {
            safeEnqueue(": keep-alive\n\n");
            lastKeepAlive = now;
          }

          // Poll delay
          await sleepWithAbort(pollIntervalMs, request.signal);
        }
      } finally {
        safeClose();
      }
    },
    cancel() {
      // Stream cancelled by consumer
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
