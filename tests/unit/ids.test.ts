/**
 * Identifier ordering.
 *
 * These ids are not decorative: `findConversation` and `listConversations` both
 * order on the id to break a tie between rows written in the same millisecond,
 * and a synchronous SQLite write is far quicker than a millisecond, so that tie
 * is the normal case rather than an edge one. The ordering has to come from the
 * id itself, because there is nothing else to sort by at that resolution.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createId, slugify } from "../../src/lib/ids";

describe("createId", () => {
  it("sorts in creation order even within one millisecond", () => {
    // Tight enough that most of these share a timestamp, which is the whole
    // point: with a random-only suffix this failed on almost every run.
    const ids = Array.from({ length: 500 }, () => createId("msg"));

    assert.deepEqual(ids, [...ids].sort(), "ids must sort in the order created");
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  });

  it("still sorts correctly across a millisecond boundary", async () => {
    const before = createId();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const after = createId();

    assert.ok(before < after, `${before} should sort before ${after}`);
  });

  it("keeps the prefix separate from the sortable part", () => {
    const id = createId("file");
    assert.match(id, /^file_[0-9a-z]+$/);
    // Two prefixed ids compare on everything after the shared prefix.
    assert.ok(createId("file") > id);
  });

  it("is URL-safe, so an id can go straight into a route", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = createId("conv");
      assert.equal(encodeURIComponent(id), id);
    }
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    assert.equal(slugify("Starfield Mod Tools"), "starfield-mod-tools");
  });

  it("trims the hyphens it would otherwise leave at the ends", () => {
    assert.equal(slugify("  !Hello, World!  "), "hello-world");
  });
});
