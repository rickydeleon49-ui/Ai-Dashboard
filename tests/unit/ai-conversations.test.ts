/**
 * Conversation persistence.
 *
 * A reply the user watched arrive and then lost on reload would be worse than
 * no history at all, so the transcript rules are pinned down here: ordering,
 * cascade on delete, and what is replayed back to the model.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";

let conversations: typeof import("../../src/core/ai/conversations");
let db: typeof import("../../src/db/client").db;
let schema: typeof import("../../src/db/schema");

before(async () => {
  await migrate();
  conversations = await import("../../src/core/ai/conversations");
  ({ db } = await import("../../src/db/client"));
  schema = await import("../../src/db/schema");
});

after(() => cleanup());

beforeEach(() => {
  db.delete(schema.aiMessages).run();
  db.delete(schema.aiConversations).run();
});

function start(title?: string) {
  return conversations.createConversation({
    provider: "local",
    mode: "chat",
    model: "qwen3:8b",
    projectId: null,
    title,
  });
}

describe("conversations", () => {
  it("names itself from the first message", () => {
    assert.equal(conversations.titleFromMessage("Explain this repo\nsecond line"), "Explain this repo");
    assert.equal(conversations.titleFromMessage("   "), "New chat");
    assert.equal(conversations.titleFromMessage("x".repeat(200)).length, 58);
  });

  it("stores messages in the order they were sent", () => {
    const conversation = start();
    conversations.appendMessage(conversation.id, { role: "user", content: "one" });
    conversations.appendMessage(conversation.id, { role: "assistant", content: "two" });
    conversations.appendMessage(conversation.id, { role: "user", content: "three" });

    const stored = conversations.findConversation(conversation.id);
    assert.deepEqual(stored?.messages.map((message) => message.content), ["one", "two", "three"]);
  });

  it("records why a reply stopped", () => {
    const conversation = start();
    conversations.appendMessage(conversation.id, {
      role: "assistant",
      content: "half an ans",
      stoppedReason: "cancelled",
    });

    const stored = conversations.findConversation(conversation.id);
    assert.equal(stored?.messages[0]?.stoppedReason, "cancelled");
  });

  it("lists the most recently used conversation first", async () => {
    const first = start("first");
    const second = start("second");
    // Timestamps are millisecond-resolution, so three rows written in the same
    // tick would tie and the assertion would be about nothing.
    await new Promise((resolve) => setTimeout(resolve, 5));
    conversations.appendMessage(first.id, { role: "user", content: "later" });

    assert.deepEqual(
      conversations.listConversations().map((entry) => entry.title),
      ["first", "second"],
    );
    assert.ok(second);
  });

  it("deletes its messages with it", () => {
    const conversation = start();
    conversations.appendMessage(conversation.id, { role: "user", content: "hello" });

    assert.equal(conversations.deleteConversation(conversation.id), true);
    assert.equal(conversations.findConversation(conversation.id), null);
    assert.equal(db.select().from(schema.aiMessages).all().length, 0);
  });

  it("reports deleting something that is not there", () => {
    assert.equal(conversations.deleteConversation("conv_missing"), false);
  });

  it("replays user and assistant turns but not stored system prompts", () => {
    const conversation = start();
    conversations.appendMessage(conversation.id, { role: "system", content: "stale context" });
    conversations.appendMessage(conversation.id, { role: "user", content: "hello" });
    conversations.appendMessage(conversation.id, { role: "assistant", content: "" });
    conversations.appendMessage(conversation.id, { role: "assistant", content: "hi" });

    const stored = conversations.findConversation(conversation.id);
    assert.deepEqual(conversations.toChatMessages(stored?.messages ?? []), [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("tracks which project a conversation belongs to", () => {
    const conversation = start();
    conversations.setConversationProject(conversation.id, null);
    assert.equal(conversations.findConversation(conversation.id)?.projectId, null);
  });
});
