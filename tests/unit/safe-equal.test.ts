import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeEqual } from "../../src/lib/safe-equal";

describe("safeEqual timing-safe comparison", () => {
  it("returns true for identical strings", () => {
    assert.equal(safeEqual("test-secret-123456", "test-secret-123456"), true);
    assert.equal(safeEqual("", ""), true);
    assert.equal(
      safeEqual(
        "a-very-long-secret-key-that-spans-many-many-characters-for-testing-1234567890",
        "a-very-long-secret-key-that-spans-many-many-characters-for-testing-1234567890",
      ),
      true,
    );
  });

  it("returns false for different strings of the same length", () => {
    assert.equal(safeEqual("secretA123", "secretB123"), false);
    assert.equal(safeEqual("abcdef", "fedcba"), false);
  });

  it("returns false for strings of differing lengths without throwing or exposing secret", () => {
    assert.equal(safeEqual("short", "longer-secret-value"), false);
    assert.equal(safeEqual("longer-secret-value", "short"), false);
    assert.equal(safeEqual("", "non-empty"), false);
    assert.equal(safeEqual("non-empty", ""), false);
  });

  it("returns false when inputs are not strings", () => {
    // @ts-expect-error testing invalid inputs
    assert.equal(safeEqual(null, "test"), false);
    // @ts-expect-error testing invalid inputs
    assert.equal(safeEqual(undefined, undefined), false);
    // @ts-expect-error testing invalid inputs
    assert.equal(safeEqual("test", 12345), false);
  });
});
