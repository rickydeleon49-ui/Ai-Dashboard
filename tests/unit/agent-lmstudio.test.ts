/**
 * Unit tests for LM Studio advisor adapter (Round AW3-06).
 *
 * Source of truth: docs/design/AW-agent-workflow-control-center.md §16.3 row 6.
 *
 * Verifies that:
 * 1. listLmStudioModels returns model IDs in order and strips trailing slashes to avoid double slashes.
 * 2. listLmStudioModels throws on non-2xx status, bad JSON, or timeout.
 * 3. runAdvisor picks the first model from listLmStudioModels when none is provided.
 * 4. runAdvisor sends temperature 0.2, max_tokens 400, and stream false in request body.
 * 5. runAdvisor returns trimmed summary content on success.
 * 6. runAdvisor never throws: offline (fetch rejection), HTTP 500, empty choices, or no loaded models return ok: false.
 * 7. runAdvisor returns "no model loaded in LM Studio" when model list is empty.
 * 8. runAdvisor and listLmStudioModels abort and return ok: false / reject on timeout.
 * 9. buildAdvisorMessages caps filesChanged at 50 (with 10 left out noted) and findings at 30.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAdvisorMessages,
  DEFAULT_LMSTUDIO_ENDPOINT,
  listLmStudioModels,
  normaliseEndpoint,
  runAdvisor,
  type AdvisorFacts,
  type FetchLike,
} from "../../src/core/agents/adapters/lmstudio";

interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

function createFakeFetch(
  handler: (call: RecordedCall) => Promise<Response> | Response,
): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

const sampleFacts: AdvisorFacts = {
  task: "Implement LM Studio advisor adapter",
  status: "succeeded",
  reviewVerdict: "approve",
  rounds: 1,
  filesChanged: [
    "src/core/agents/adapters/lmstudio.ts",
    "tests/unit/agent-lmstudio.test.ts",
  ],
  checks: [
    { name: "typecheck", passed: true },
    { name: "lint", passed: true },
  ],
  findings: [{ severity: "nit", title: "Minor comment typo" }],
};

describe("normaliseEndpoint", () => {
  it("uses default endpoint when empty or omitted", () => {
    assert.equal(normaliseEndpoint(), DEFAULT_LMSTUDIO_ENDPOINT);
    assert.equal(normaliseEndpoint(""), DEFAULT_LMSTUDIO_ENDPOINT);
    assert.equal(normaliseEndpoint("   "), DEFAULT_LMSTUDIO_ENDPOINT);
  });

  it("strips trailing slashes cleanly", () => {
    assert.equal(
      normaliseEndpoint("http://127.0.0.1:1234/"),
      "http://127.0.0.1:1234",
    );
    assert.equal(
      normaliseEndpoint("http://127.0.0.1:1234///"),
      "http://127.0.0.1:1234",
    );
    assert.equal(
      normaliseEndpoint("http://localhost:5678"),
      "http://localhost:5678",
    );
  });
});

describe("listLmStudioModels", () => {
  it("returns ids in order", async () => {
    const { fetchImpl, calls } = createFakeFetch(
      () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gemma-4-12b", object: "model" },
              { id: "qwen-2.5-coder", object: "model" },
              { id: "llama-3.3-70b", object: "model" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const models = await listLmStudioModels({
      endpoint: "http://127.0.0.1:1234",
      fetchImpl,
    });
    assert.deepEqual(models, [
      "gemma-4-12b",
      "qwen-2.5-coder",
      "llama-3.3-70b",
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://127.0.0.1:1234/v1/models");
    assert.equal(calls[0]!.method, "GET");
  });

  it("uses /v1/models with no double slash when endpoint ends with /", async () => {
    const { fetchImpl, calls } = createFakeFetch(
      () =>
        new Response(JSON.stringify({ data: [{ id: "model-1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const models = await listLmStudioModels({
      endpoint: "http://127.0.0.1:1234/",
      fetchImpl,
    });
    assert.deepEqual(models, ["model-1"]);
    assert.equal(calls[0]!.url, "http://127.0.0.1:1234/v1/models");
  });

  it("uses default endpoint when none provided", async () => {
    const { fetchImpl, calls } = createFakeFetch(
      () =>
        new Response(JSON.stringify({ data: [{ id: "default-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const models = await listLmStudioModels({ fetchImpl });
    assert.deepEqual(models, ["default-model"]);
    assert.equal(calls[0]!.url, `${DEFAULT_LMSTUDIO_ENDPOINT}/v1/models`);
  });

  it("throws on non-2xx status with short message", async () => {
    const { fetchImpl } = createFakeFetch(
      () => new Response("Internal Server Error", { status: 500 }),
    );

    await assert.rejects(
      () => listLmStudioModels({ fetchImpl }),
      (err: Error) => {
        assert.match(err.message, /HTTP 500/);
        assert.ok(err.message.length < 250);
        return true;
      },
    );
  });

  it("throws on bad JSON with short message", async () => {
    const { fetchImpl } = createFakeFetch(
      () => new Response("not a valid json payload {{{", { status: 200 }),
    );

    await assert.rejects(
      () => listLmStudioModels({ fetchImpl }),
      (err: Error) => {
        assert.match(err.message, /Failed to parse LM Studio response/);
        return true;
      },
    );
  });

  it("throws on malformed response missing data array", async () => {
    const { fetchImpl } = createFakeFetch(
      () =>
        new Response(JSON.stringify({ unexpected: "structure" }), {
          status: 200,
        }),
    );

    await assert.rejects(
      () => listLmStudioModels({ fetchImpl }),
      /missing data array/,
    );
  });

  it("times out when request exceeds timeoutMs", async () => {
    const neverResolvingFetch: FetchLike = (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };

    const start = Date.now();
    await assert.rejects(
      () =>
        listLmStudioModels({ fetchImpl: neverResolvingFetch, timeoutMs: 20 }),
      /timed out after 20ms/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 2000,
      `Expected quick timeout around 20ms, took ${elapsed}ms`,
    );
  });
});

describe("runAdvisor", () => {
  it("picks the first model when none given, sends temperature 0.2, max_tokens 400, stream false, and returns trimmed summary", async () => {
    const { fetchImpl, calls } = createFakeFetch((call) => {
      if (call.url.endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "gemma-4-12b" }, { id: "llama-3-8b" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (call.url.endsWith("/v1/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "   - All checks passed.\n- No blocking findings.\n- Clean run.   ",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await runAdvisor(sampleFacts, { fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.model, "gemma-4-12b");
      assert.equal(
        result.summary,
        "- All checks passed.\n- No blocking findings.\n- Clean run.",
      );
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "http://127.0.0.1:1234/v1/models");
    assert.equal(calls[1]!.url, "http://127.0.0.1:1234/v1/chat/completions");

    const reqBody = JSON.parse(calls[1]!.body!);
    assert.equal(reqBody.model, "gemma-4-12b");
    assert.equal(reqBody.temperature, 0.2);
    assert.equal(reqBody.max_tokens, 400);
    assert.equal(reqBody.stream, false);
    assert.equal(reqBody.messages.length, 2);
  });

  it("uses explicitly specified model without querying /v1/models", async () => {
    const { fetchImpl, calls } = createFakeFetch((call) => {
      if (call.url.endsWith("/v1/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Summary from explicit model." } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await runAdvisor(sampleFacts, {
      model: "custom-gemma-model",
      fetchImpl,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.model, "custom-gemma-model");
      assert.equal(result.summary, "Summary from explicit model.");
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://127.0.0.1:1234/v1/chat/completions");
  });

  it("offline (fetch rejects) → ok:false, no throw", async () => {
    const offlineFetch: FetchLike = () =>
      Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1234"));

    // When model not given (listLmStudioModels fails)
    const resNoModel = await runAdvisor(sampleFacts, {
      fetchImpl: offlineFetch,
    });
    assert.equal(resNoModel.ok, false);
    if (!resNoModel.ok) {
      assert.match(resNoModel.reason, /ECONNREFUSED/);
    }

    // When model is given (chat completions fails)
    const resWithModel = await runAdvisor(sampleFacts, {
      model: "custom-model",
      fetchImpl: offlineFetch,
    });
    assert.equal(resWithModel.ok, false);
    if (!resWithModel.ok) {
      assert.match(resWithModel.reason, /ECONNREFUSED/);
    }
  });

  it("HTTP 500 → ok:false", async () => {
    const { fetchImpl } = createFakeFetch(
      () =>
        new Response("Internal Server Error from upstream", { status: 500 }),
    );

    const result = await runAdvisor(sampleFacts, {
      model: "custom-model",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /HTTP 500/);
    }
  });

  it("empty choices → ok:false", async () => {
    const { fetchImpl } = createFakeFetch(
      () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await runAdvisor(sampleFacts, {
      model: "custom-model",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /empty/i);
    }
  });

  it("empty or missing summary → ok:false", async () => {
    const { fetchImpl } = createFakeFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "   \n\t  " } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await runAdvisor(sampleFacts, {
      model: "custom-model",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /empty summary/i);
    }
  });

  it("no models → the 'no model loaded' reason", async () => {
    const { fetchImpl } = createFakeFetch(
      () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await runAdvisor(sampleFacts, { fetchImpl });
    assert.deepEqual(result, {
      ok: false,
      reason: "no model loaded in LM Studio",
    });
  });

  it("timeout: a fetch that never resolves until aborted, timeoutMs 20 → ok:false within the test", async () => {
    const neverResolvingFetch: FetchLike = (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };

    const start = Date.now();
    const result = await runAdvisor(sampleFacts, {
      fetchImpl: neverResolvingFetch,
      model: "test-model",
      timeoutMs: 20,
    });
    const duration = Date.now() - start;

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /timed out after 20ms/i);
    }
    assert.ok(
      duration < 2000,
      `Expected quick timeout around 20ms, took ${duration}ms`,
    );
  });
});

describe("buildAdvisorMessages", () => {
  it("caps 60 files to 50 and mentions 10 left out", () => {
    const facts60Files: AdvisorFacts = {
      task: "Refactor project architecture",
      status: "succeeded",
      reviewVerdict: "approve",
      rounds: 2,
      filesChanged: Array.from(
        { length: 60 },
        (_, i) => `src/file-${i + 1}.ts`,
      ),
      checks: [{ name: "build", passed: true }],
      findings: [],
    };

    const messages = buildAdvisorMessages(facts60Files);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.role, "system");
    assert.equal(
      messages[0]!.content,
      "You are an advisor. Summarise this agent run for its owner in at most 6 short bullet points. You cannot change the outcome.",
    );

    assert.equal(messages[1]!.role, "user");
    const parsed = JSON.parse(messages[1]!.content);
    assert.equal(parsed.filesChanged.length, 50);
    assert.equal(parsed.filesChanged[0], "src/file-1.ts");
    assert.equal(parsed.filesChanged[49], "src/file-50.ts");
    assert.match(messages[1]!.content, /10 left out/);
  });

  it("caps 45 findings to 30 and mentions 15 left out", () => {
    const facts45Findings: AdvisorFacts = {
      ...sampleFacts,
      findings: Array.from({ length: 45 }, (_, i) => ({
        severity: "minor",
        title: `Finding ${i + 1}`,
      })),
    };

    const messages = buildAdvisorMessages(facts45Findings);
    const parsed = JSON.parse(messages[1]!.content);
    assert.equal(parsed.findings.length, 30);
    assert.match(messages[1]!.content, /15 left out/);
  });

  it("does not mention items left out when within limits", () => {
    const messages = buildAdvisorMessages(sampleFacts);
    const parsed = JSON.parse(messages[1]!.content);
    assert.equal(parsed.filesChanged.length, 2);
    assert.equal(parsed.findings.length, 1);
    assert.ok(!messages[1]!.content.includes("left out"));
  });
});

describe("advisor timeouts cover the response body", () => {
  function stalledBodyFetch(): FetchLike {
    return async (_input, init) => {
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      } as unknown as Response;
    };
  }

  it("runAdvisor returns a timeout result when the body stalls", async () => {
    const res = await runAdvisor(
      {
        task: "t",
        status: "succeeded",
        reviewVerdict: null,
        rounds: 1,
        filesChanged: [],
        checks: [],
        findings: [],
      },
      { model: "m", fetchImpl: stalledBodyFetch(), timeoutMs: 30 },
    );
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.reason, /timed out/);
  });

  it("listLmStudioModels rejects with a timeout when the body stalls", async () => {
    await assert.rejects(
      listLmStudioModels({ fetchImpl: stalledBodyFetch(), timeoutMs: 30 }),
      /timed out/,
    );
  });
});
