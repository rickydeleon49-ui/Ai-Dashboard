import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";

let db: typeof import("../../src/db/client").db;
let schema: typeof import("../../src/db/schema");
let loadAppUsage: typeof import("../../src/core/usage/app-usage-source").loadAppUsage;

const NOW = new Date("2026-11-08T20:00:00.000Z");
const isoAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  schema = await import("../../src/db/schema");
  ({ loadAppUsage } = await import("../../src/core/usage/app-usage-source"));
});

after(() => cleanup());

beforeEach(() => {
  db.delete(schema.aiMessages).run();
  db.delete(schema.aiConversations).run();
  db.delete(schema.agentRunEvents).run();
  db.delete(schema.agentRuns).run();
  db.delete(schema.projects).run();
});

function conversation(id: string, provider: string) {
  db.insert(schema.aiConversations).values({ id, provider, mode: "chat" }).run();
}

function message(
  id: string,
  conversationId: string,
  role: string,
  createdAt: string,
  extra: { model?: string | null; promptTokens?: number | null; completionTokens?: number | null } = {},
) {
  db.insert(schema.aiMessages)
    .values({
      id,
      conversationId,
      role,
      createdAt,
      model: extra.model ?? null,
      promptTokens: extra.promptTokens ?? null,
      completionTokens: extra.completionTokens ?? null,
    })
    .run();
}

describe("loadAppUsage", () => {
  it("is empty on an empty database", () => {
    const s = loadAppUsage(NOW);
    assert.deepEqual(s.chat, {});
    assert.deepEqual(s.advisor, {
      today: { calls: 0, failed: 0 },
      last7Days: { calls: 0, failed: 0 },
    });
  });

  it("counts assistant replies per provider, ignores other roles and old rows", () => {
    conversation("c1", "local");
    conversation("c2", "hermes");
    message("m1", "c1", "assistant", isoAgo(1), { model: "qwen3:8b", promptTokens: 10, completionTokens: 5 });
    message("m2", "c1", "user", isoAgo(1), { promptTokens: 99, completionTokens: 99 });
    message("m3", "c1", "assistant", isoAgo(2), { model: "qwen3:8b" });
    message("m4", "c2", "assistant", isoAgo(30), { model: "hermes-3", promptTokens: 4, completionTokens: 6 });
    message("m5", "c2", "assistant", isoAgo(24 * 20), { model: "hermes-3", promptTokens: 1, completionTokens: 1 });

    const s = loadAppUsage(NOW);
    const local = s.chat["local"];
    assert.ok(local);
    assert.equal(local.today.calls, 2);
    assert.equal(local.last7Days.promptTokens, 10);
    assert.equal(local.last7Days.completionTokens, 5);
    assert.equal(local.last7Days.tokensUnknown, 1);
    assert.equal(local.byModel["qwen3:8b"]?.calls, 2);

    const hermes = s.chat["hermes"];
    assert.ok(hermes);
    assert.equal(hermes.last7Days.calls, 1);
    assert.equal(hermes.today.calls, 0);
    assert.equal(hermes.last7Days.promptTokens + hermes.last7Days.completionTokens, 10);
  });

  it("counts only final advisor events and reads ok from the payload", () => {
    db.insert(schema.projects).values({ id: "p1", name: "P" }).run();
    db.insert(schema.agentRuns).values({ id: "r1", projectId: "p1" }).run();
    const ev = (
      seq: number,
      ts: string,
      agent: string,
      kind: string,
      stage: string | null,
      payload: unknown,
    ) =>
      db
        .insert(schema.agentRunEvents)
        .values({ runId: "r1", seq, ts, agent, kind, stage, payload: JSON.stringify(payload) })
        .run();
    ev(1, isoAgo(1), "advisor", "advisor", "final", { ok: true, model: "m", summary: "x" });
    ev(2, isoAgo(2), "advisor", "advisor", "final", { ok: false, reason: "advisor timed out" });
    ev(3, isoAgo(3), "advisor", "advisor", "review", { ok: true });
    ev(4, isoAgo(4), "system", "warning", "final", { ok: false });
    ev(5, isoAgo(24 * 20), "advisor", "advisor", "final", { ok: true });

    const s = loadAppUsage(NOW);
    assert.deepEqual(s.advisor.today, { calls: 2, failed: 1 });
    assert.deepEqual(s.advisor.last7Days, { calls: 2, failed: 1 });
  });
});
