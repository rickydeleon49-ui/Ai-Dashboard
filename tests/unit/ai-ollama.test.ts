/**
 * The Ollama boundary.
 *
 * Everything here runs against an injected `fetch`, so the whole surface —
 * healthy, missing, cancelled, malformed, out of memory — is exercised without
 * Ollama installed and without a model on disk. That is the point of keeping
 * the client free of settings, database and process concerns.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNdjsonParser, NdjsonParseError } from "../../src/core/ai/ndjson";
import {
  OllamaClient,
  classifyError,
  normaliseEndpoint,
  parseLoaded,
  parseModels,
} from "../../src/core/ai/ollama-client";
import { AiError, type ChatEvent } from "../../src/core/ai/types";

const ENDPOINT = "http://127.0.0.1:11434";

/** A response whose body arrives in the given pieces. */
function streamed(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

function collect(events: ChatEvent[]) {
  return {
    text: events
      .filter((event): event is Extract<ChatEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join(""),
    error: events.find((event) => event.type === "error"),
    done: events.find((event) => event.type === "done"),
  };
}

describe("newline-delimited JSON", () => {
  it("holds a partial line until the rest of it arrives", () => {
    const parser = createNdjsonParser();
    assert.deepEqual(parser.push('{"a":'), []);
    assert.deepEqual(parser.push('1}\n'), [{ a: 1 }]);
  });

  it("returns every complete object in one chunk", () => {
    const parser = createNdjsonParser();
    assert.deepEqual(parser.push('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  });

  it("returns a trailing object that never got its newline", () => {
    const parser = createNdjsonParser();
    parser.push('{"a":1}');
    assert.deepEqual(parser.flush(), [{ a: 1 }]);
  });

  it("ignores blank lines", () => {
    const parser = createNdjsonParser();
    assert.deepEqual(parser.push('\n\n{"a":1}\n'), [{ a: 1 }]);
  });

  it("reports a line that is not JSON", () => {
    const parser = createNdjsonParser();
    assert.throws(() => parser.push("<html>oops</html>\n"), NdjsonParseError);
  });
});

describe("model parsing", () => {
  it("reads names and details from /api/tags", () => {
    const models = parseModels({
      models: [
        {
          name: "qwen3:8b",
          size: 5_200_000_000,
          modified_at: "2026-01-02T03:04:05Z",
          details: { parameter_size: "8.0B", quantization_level: "Q4_K_M", family: "qwen3" },
        },
      ],
    });

    assert.equal(models.length, 1);
    assert.deepEqual(models[0], {
      name: "qwen3:8b",
      size: 5_200_000_000,
      parameterSize: "8.0B",
      quantization: "Q4_K_M",
      family: "qwen3",
      modifiedAt: "2026-01-02T03:04:05Z",
    });
  });

  it("sorts alphabetically so the selector does not reshuffle", () => {
    const models = parseModels({
      models: [{ name: "qwen3:8b" }, { name: "gpt-oss:20b" }],
    });
    assert.deepEqual(models.map((model) => model.name), ["gpt-oss:20b", "qwen3:8b"]);
  });

  it("survives missing details rather than dropping the model", () => {
    const models = parseModels({ models: [{ name: "qwen3-64k:latest" }] });
    assert.equal(models[0]?.parameterSize, null);
    assert.equal(models[0]?.size, 0);
  });

  it("drops entries with no usable name", () => {
    assert.deepEqual(parseModels({ models: [{ size: 1 }, null, "x"] }), []);
  });

  it("returns nothing for a payload of the wrong shape", () => {
    assert.deepEqual(parseModels(null), []);
    assert.deepEqual(parseModels({ models: "nope" }), []);
  });

  it("reads resident models from /api/ps", () => {
    const loaded = parseLoaded({
      models: [{ name: "qwen3-64k:latest", size_vram: 11_000_000_000, expires_at: "2026-01-01T00:10:00Z" }],
    });
    assert.equal(loaded[0]?.sizeVram, 11_000_000_000);
    assert.equal(loaded[0]?.expiresAt, "2026-01-01T00:10:00Z");
  });
});

describe("endpoints", () => {
  it("drops a trailing slash so paths do not double up", () => {
    assert.equal(normaliseEndpoint("http://127.0.0.1:11434/"), ENDPOINT);
  });

  it("falls back to the default when given nothing", () => {
    assert.equal(normaliseEndpoint("   "), ENDPOINT);
  });
});

describe("failure classification", () => {
  it("calls a refused connection offline", () => {
    const error = classifyError(new Error("fetch failed: ECONNREFUSED"), "request");
    assert.equal(error.code, "offline");
  });

  it("calls an abort cancelled", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    assert.equal(classifyError(abort, "stream").code, "cancelled");
  });

  it("passes an already-classified error through untouched", () => {
    const original = new AiError("model_missing", "nope");
    assert.equal(classifyError(original, "request"), original);
  });
});

describe("health", () => {
  it("is reachable when /api/tags answers", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async (url) => {
        assert.equal(url, `${ENDPOINT}/api/tags`);
        return Response.json({ models: [] });
      },
    });
    assert.equal(await client.ping(), true);
  });

  it("is unreachable when nothing is listening", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () => {
        throw new Error("fetch failed");
      },
    });
    assert.equal(await client.ping(), false);
  });

  it("reports offline rather than throwing something unclassified", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    });
    await assert.rejects(() => client.listModels(), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, "offline");
      return true;
    });
  });

  it("treats an unreadable body as malformed", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () => new Response("<html>", { status: 200 }),
    });
    await assert.rejects(() => client.listModels(), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, "malformed");
      return true;
    });
  });
});

describe("chat", () => {
  const request = {
    model: "qwen3:8b",
    messages: [{ role: "user" as const, content: "hello" }],
    contextSize: 8192,
    keepAlive: "10m",
    reasoningEffort: null,
  };

  it("streams deltas and finishes with the assembled text", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () =>
        streamed([
          '{"message":{"role":"assistant","content":"Hel"}}\n',
          '{"message":{"role":"assistant","content":"lo"}}\n',
          '{"done":true,"prompt_eval_count":9,"eval_count":2}\n',
        ]),
    });

    const events: ChatEvent[] = [];
    for await (const event of client.chat(request)) events.push(event);

    const { text, done } = collect(events);
    assert.equal(events[0]?.type, "start");
    assert.equal(text, "Hello");
    assert.equal(done?.type === "done" && done.text, "Hello");
    assert.equal(done?.type === "done" && done.promptTokens, 9);
    assert.equal(done?.type === "done" && done.completionTokens, 2);
  });

  it("sends num_ctx and keep_alive from the request", async () => {
    let body: Record<string, unknown> = {};
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return streamed(['{"done":true}\n']);
      },
    });

    for await (const _event of client.chat(request)) void _event;

    assert.deepEqual(body.options, { num_ctx: 8192 });
    assert.equal(body.keep_alive, "10m");
    assert.equal(body.stream, true);
    // Nothing is sent for a model that was not asked to reason harder.
    assert.equal("think" in body, false);
  });

  it("reports a model that is not installed", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: "model 'qwen9' not found, try pulling it first" }),
          { status: 404 },
        ),
    });

    const events: ChatEvent[] = [];
    for await (const event of client.chat(request)) events.push(event);

    assert.equal(collect(events).error?.type === "error" && collect(events).error?.code, "model_missing");
  });

  it("reports running out of memory as its own failure, not a generic one", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () =>
        new Response('{"error":"unable to allocate CUDA0 buffer"}', { status: 500 }),
    });

    const events: ChatEvent[] = [];
    for await (const event of client.chat(request)) events.push(event);
    const error = collect(events).error;
    assert.equal(error?.type === "error" && error.code, "out_of_memory");
  });

  it("reports an error object sent mid-stream", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () =>
        streamed([
          '{"message":{"content":"partial"}}\n',
          '{"error":"model runner has unexpectedly stopped"}\n',
        ]),
    });

    const events: ChatEvent[] = [];
    for await (const event of client.chat(request)) events.push(event);
    const { text, error } = collect(events);
    assert.equal(text, "partial");
    assert.ok(error);
  });

  it("ends as cancelled when the caller aborts", async () => {
    const controller = new AbortController();
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async (_url, init) => {
        // A real fetch rejects on abort; the fake has to behave the same way.
        if (init?.signal?.aborted) {
          const abort = new Error("The operation was aborted");
          abort.name = "AbortError";
          throw abort;
        }
        return streamed(['{"message":{"content":"hi"}}\n']);
      },
    });

    controller.abort();
    const events: ChatEvent[] = [];
    for await (const event of client.chat({ ...request, signal: controller.signal })) {
      events.push(event);
    }

    const error = collect(events).error;
    assert.equal(error?.type === "error" && error.code, "cancelled");
  });

  it("stops mid-stream when the caller aborts partway through", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(target) {
              target.enqueue(encoder.encode('{"message":{"content":"one"}}\n'));
              // Never closed: only the abort ends this.
              controller.signal.addEventListener("abort", () =>
                target.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            },
          }),
        ),
    });

    const events: ChatEvent[] = [];
    for await (const event of client.chat({ ...request, signal: controller.signal })) {
      events.push(event);
      if (event.type === "delta") controller.abort();
    }

    assert.equal(collect(events).text, "one");
    assert.equal(collect(events).error?.type === "error" && collect(events).error?.code, "cancelled");
  });

  it("reports a body that is not JSON as malformed", async () => {
    const client = new OllamaClient({
      endpoint: ENDPOINT,
      fetchImpl: async () => streamed(["not json at all\n"]),
    });

    const events: ChatEvent[] = [];
    for await (const event of client.chat(request)) events.push(event);
    const error = collect(events).error;
    assert.equal(error?.type === "error" && error.code, "malformed");
  });
});
