import assert from "node:assert/strict";
import test from "node:test";
import {
  type AppAdvisorEvent,
  type AppChatMessage,
  localDay,
  summarizeAppUsage,
} from "../../src/core/usage/app-usage";

test("localDay across a PT midnight (e.g. 2026-11-08T07:30:00Z is 2026-11-07 in PT)", () => {
  assert.equal(localDay("2026-11-08T07:30:00Z", "America/Los_Angeles"), "2026-11-07");
  assert.equal(localDay("2026-11-08T08:30:00Z", "America/Los_Angeles"), "2026-11-08");

  // Default timeZone is America/Los_Angeles
  assert.equal(localDay("2026-11-08T07:30:00Z"), "2026-11-07");
  assert.equal(localDay("2026-11-08T08:30:00Z"), "2026-11-08");
});

test("today vs last7Days boundaries (day 7 back excluded)", () => {
  const now = new Date("2026-11-08T20:00:00Z"); // 2026-11-08 in PT
  const messages: AppChatMessage[] = [
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 10,
      completionTokens: 5,
      createdAt: "2026-11-08T18:00:00Z", // Day 0 (today)
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 20,
      completionTokens: 15,
      createdAt: "2026-11-02T18:00:00Z", // Day 6 back (included in last7Days)
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 100,
      completionTokens: 50,
      createdAt: "2026-11-01T18:00:00Z", // Day 7 back (excluded)
    },
  ];
  const advisor: AppAdvisorEvent[] = [
    { ts: "2026-11-08T18:00:00Z", ok: true }, // today
    { ts: "2026-11-02T18:00:00Z", ok: true }, // day 6 back
    { ts: "2026-11-01T18:00:00Z", ok: true }, // day 7 back (excluded)
  ];

  const summary = summarizeAppUsage(messages, advisor, now);

  const localChat = summary.chat["local"]!;
  assert.equal(localChat.today.calls, 1);
  assert.equal(localChat.today.promptTokens, 10);
  assert.equal(localChat.today.completionTokens, 5);
  assert.equal(localChat.today.tokensUnknown, 0);

  assert.equal(localChat.last7Days.calls, 2);
  assert.equal(localChat.last7Days.promptTokens, 30);
  assert.equal(localChat.last7Days.completionTokens, 20);
  assert.equal(localChat.last7Days.tokensUnknown, 0);

  assert.equal(summary.advisor.today.calls, 1);
  assert.equal(summary.advisor.today.failed, 0);
  assert.equal(summary.advisor.last7Days.calls, 2);
  assert.equal(summary.advisor.last7Days.failed, 0);
});

test("user/system rows ignored", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const messages: AppChatMessage[] = [
    {
      provider: "local",
      role: "user",
      model: "llama3",
      promptTokens: 50,
      completionTokens: null,
      createdAt: "2026-11-08T15:00:00Z",
    },
    {
      provider: "local",
      role: "system",
      model: "llama3",
      promptTokens: 80,
      completionTokens: null,
      createdAt: "2026-11-08T15:01:00Z",
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 12,
      completionTokens: 24,
      createdAt: "2026-11-08T15:02:00Z",
    },
  ];

  const summary = summarizeAppUsage(messages, [], now);
  const localChat = summary.chat["local"]!;
  assert.equal(localChat.today.calls, 1);
  assert.equal(localChat.today.promptTokens, 12);
  assert.equal(localChat.today.completionTokens, 24);
  assert.equal(localChat.today.tokensUnknown, 0);
});

test("null tokens → tokensUnknown", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const messages: AppChatMessage[] = [
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: null,
      completionTokens: null,
      createdAt: "2026-11-08T15:00:00Z",
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 10,
      completionTokens: null,
      createdAt: "2026-11-08T15:01:00Z",
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 20,
      completionTokens: 30,
      createdAt: "2026-11-08T15:02:00Z",
    },
  ];

  const summary = summarizeAppUsage(messages, [], now);
  const localChat = summary.chat["local"]!;
  assert.equal(localChat.today.calls, 3);
  assert.equal(localChat.today.promptTokens, 30);
  assert.equal(localChat.today.completionTokens, 30);
  assert.equal(localChat.today.tokensUnknown, 2);
});

test("per-provider split (local vs hermes)", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const messages: AppChatMessage[] = [
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 10,
      completionTokens: 20,
      createdAt: "2026-11-08T15:00:00Z",
    },
    {
      provider: "hermes",
      role: "assistant",
      model: "hermes-3",
      promptTokens: 30,
      completionTokens: 40,
      createdAt: "2026-11-08T15:01:00Z",
    },
  ];

  const summary = summarizeAppUsage(messages, [], now);
  assert.equal(summary.chat["local"]!.today.calls, 1);
  assert.equal(summary.chat["local"]!.today.promptTokens, 10);
  assert.equal(summary.chat["local"]!.today.completionTokens, 20);

  assert.equal(summary.chat["hermes"]!.today.calls, 1);
  assert.equal(summary.chat["hermes"]!.today.promptTokens, 30);
  assert.equal(summary.chat["hermes"]!.today.completionTokens, 40);
});

test('byModel incl. "unknown"', () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const messages: AppChatMessage[] = [
    {
      provider: "local",
      role: "assistant",
      model: "llama3.2",
      promptTokens: 10,
      completionTokens: 15,
      createdAt: "2026-11-08T15:00:00Z",
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3.2",
      promptTokens: 20,
      completionTokens: 25,
      createdAt: "2026-11-08T15:01:00Z",
    },
    {
      provider: "local",
      role: "assistant",
      model: null,
      promptTokens: null,
      completionTokens: null,
      createdAt: "2026-11-08T15:02:00Z",
    },
  ];

  const summary = summarizeAppUsage(messages, [], now);
  const byModel = summary.chat["local"]!.byModel;

  const llamaBucket = byModel["llama3.2"]!;
  assert.equal(llamaBucket.calls, 2);
  assert.equal(llamaBucket.promptTokens, 30);
  assert.equal(llamaBucket.completionTokens, 40);
  assert.equal(llamaBucket.tokensUnknown, 0);

  const unknownBucket = byModel["unknown"]!;
  assert.equal(unknownBucket.calls, 1);
  assert.equal(unknownBucket.promptTokens, 0);
  assert.equal(unknownBucket.completionTokens, 0);
  assert.equal(unknownBucket.tokensUnknown, 1);
});

test("bad and future timestamps skipped", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const messages: AppChatMessage[] = [
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 10,
      completionTokens: 10,
      createdAt: "invalid-iso-timestamp",
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 10,
      completionTokens: 10,
      createdAt: "2026-11-08T20:00:01Z", // Future
    },
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 15,
      completionTokens: 25,
      createdAt: "2026-11-08T19:59:59Z", // Valid past
    },
  ];
  const advisor: AppAdvisorEvent[] = [
    { ts: "not-a-timestamp", ok: true },
    { ts: "2026-11-08T20:05:00Z", ok: true }, // Future
    { ts: "2026-11-08T19:50:00Z", ok: true }, // Valid past
  ];

  const summary = summarizeAppUsage(messages, advisor, now);
  assert.equal(summary.chat["local"]!.today.calls, 1);
  assert.equal(summary.chat["local"]!.today.promptTokens, 15);
  assert.equal(summary.chat["local"]!.today.completionTokens, 25);

  assert.equal(summary.advisor.today.calls, 1);
  assert.equal(summary.advisor.today.failed, 0);
});

test("advisor ok/failed counts", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const advisor: AppAdvisorEvent[] = [
    { ts: "2026-11-08T14:00:00Z", ok: true },  // today ok
    { ts: "2026-11-08T15:00:00Z", ok: false }, // today failed
    { ts: "2026-11-07T12:00:00Z", ok: false }, // yesterday failed
  ];

  const summary = summarizeAppUsage([], advisor, now);
  assert.equal(summary.advisor.today.calls, 2);
  assert.equal(summary.advisor.today.failed, 1);

  assert.equal(summary.advisor.last7Days.calls, 3);
  assert.equal(summary.advisor.last7Days.failed, 2);
});

test("empty inputs → all zero", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const summary = summarizeAppUsage([], [], now);

  assert.deepEqual(summary.chat, {});
  assert.deepEqual(summary.advisor, {
    today: { calls: 0, failed: 0 },
    last7Days: { calls: 0, failed: 0 },
  });
});

test("inputs not mutated", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  const messages: AppChatMessage[] = [
    {
      provider: "local",
      role: "assistant",
      model: "llama3",
      promptTokens: 10,
      completionTokens: 20,
      createdAt: "2026-11-08T15:00:00Z",
    },
  ];
  const advisor: AppAdvisorEvent[] = [
    { ts: "2026-11-08T15:00:00Z", ok: false },
  ];

  const messagesCopy = JSON.parse(JSON.stringify(messages));
  const advisorCopy = JSON.parse(JSON.stringify(advisor));

  summarizeAppUsage(messages, advisor, now);

  assert.deepEqual(messages, messagesCopy);
  assert.deepEqual(advisor, advisorCopy);
});
