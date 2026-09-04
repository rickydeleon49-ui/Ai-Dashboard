/**
 * Validation boundaries.
 *
 * The bug these cover: `projectUpdateSchema` was `projectCreateSchema.partial()`,
 * which keeps each field's `.default()`. A PATCH carrying a single key therefore
 * parsed into a full object with every other field at its default, and the
 * repository wrote them — so favouriting a GitHub project quietly reset its
 * source, type and status and emptied the metadata holding its GitHub linkage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectCreateSchema,
  projectUpdateSchema,
} from "../../src/core/projects/schema";

describe("projectUpdateSchema", () => {
  it("leaves out every key the caller did not send", () => {
    const parsed = projectUpdateSchema.parse({ favorite: true });

    assert.deepEqual(Object.keys(parsed), ["favorite"]);
    for (const field of ["source", "type", "status", "metadata", "tags"] as const) {
      assert.equal(
        parsed[field],
        undefined,
        `${field} must not be defaulted on a partial update`,
      );
    }
  });

  it("does not turn a partial update into a full object", () => {
    const parsed = projectUpdateSchema.parse({ archived: true });
    assert.deepEqual(parsed, { archived: true });
  });

  it("still validates the values it is given", () => {
    assert.throws(() => projectUpdateSchema.parse({ status: "not-a-status" }));
    assert.throws(() => projectUpdateSchema.parse({ source: "not-a-source" }));
    assert.equal(projectUpdateSchema.parse({ status: "paused" }).status, "paused");
  });

  it("normalises tags when they are sent, and omits them when they are not", () => {
    assert.deepEqual(
      projectUpdateSchema.parse({ tags: " Alpha, beta ,ALPHA" }).tags,
      ["alpha", "beta"],
    );
    assert.equal(projectUpdateSchema.parse({ name: "x" }).tags, undefined);
  });
});

describe("projectCreateSchema", () => {
  it("still applies defaults, because creation needs them", () => {
    const parsed = projectCreateSchema.parse({ name: "Fresh" });
    assert.equal(parsed.source, "manual");
    assert.equal(parsed.type, "software");
    assert.equal(parsed.status, "idea");
    assert.equal(parsed.favorite, false);
    assert.equal(parsed.archived, false);
    assert.deepEqual(parsed.tags, []);
    assert.deepEqual(parsed.metadata, {});
  });

  it("requires a name", () => {
    assert.throws(() => projectCreateSchema.parse({}));
    assert.throws(() => projectCreateSchema.parse({ name: "   " }));
  });

  it("keeps explicit values over defaults", () => {
    const parsed = projectCreateSchema.parse({
      name: "Explicit",
      source: "github",
      type: "ai",
      status: "active",
    });
    assert.equal(parsed.source, "github");
    assert.equal(parsed.type, "ai");
    assert.equal(parsed.status, "active");
  });
});
