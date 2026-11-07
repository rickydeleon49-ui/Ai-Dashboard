/**
 * Unit tests for the diff_patch run-page logic (AW1-15).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyPatchLine,
  deriveDiffPatch,
  patchLines,
  type UiEvent,
} from "../../src/components/agents/runs/logic";

function ev(seq: number, kind: string, payload: unknown): UiEvent {
  return { runId: "r1", seq, ts: "2026-11-06T00:00:00Z", stage: "diff", agent: "system", kind, payload };
}

describe("deriveDiffPatch", () => {
  it("returns null without a diff_patch event", () => {
    assert.equal(deriveDiffPatch([]), null);
    assert.equal(deriveDiffPatch([ev(1, "diff_summary", { files: [], totals: {} })]), null);
  });

  it("takes the latest event and validates defensively", () => {
    const events = [
      ev(1, "diff_patch", { files: [{ path: "old.ts", patch: "x", truncated: false }], truncated: false }),
      ev(2, "diff_patch", {
        files: [
          { path: "a.ts", patch: "diff --git a/a.ts b/a.ts\n+x\n", truncated: false },
          { path: "b.ts", oldPath: "c.ts", patch: "", truncated: true },
          { patch: "no path" },
          { path: "d.ts", patch: 5 },
          "junk",
          null,
        ],
        truncated: true,
      }),
    ];
    const view = deriveDiffPatch(events)!;
    assert.deepEqual(
      view.files.map((f) => f.path),
      ["a.ts", "b.ts"],
    );
    assert.equal(view.files[1]!.oldPath, "c.ts");
    assert.equal(view.files[1]!.truncated, true);
    assert.equal(view.truncated, true);
  });

  it("returns null for an oversized-event stub or a non-object payload", () => {
    assert.equal(deriveDiffPatch([ev(1, "diff_patch", { truncated: true, bytes: 9, preview: "x" })]), null);
    assert.equal(deriveDiffPatch([ev(1, "diff_patch", "text")]), null);
    assert.equal(deriveDiffPatch([ev(1, "diff_patch", null)]), null);
  });
});

describe("classifyPatchLine", () => {
  it("classifies add, del, hunk, meta and context lines", () => {
    assert.equal(classifyPatchLine("+added"), "add");
    assert.equal(classifyPatchLine("-removed"), "del");
    assert.equal(classifyPatchLine("@@ -1,2 +1,3 @@ fn"), "hunk");
    assert.equal(classifyPatchLine("diff --git a/x b/x"), "meta");
    assert.equal(classifyPatchLine("index 1234..5678 100644"), "meta");
    assert.equal(classifyPatchLine("--- a/x"), "meta");
    assert.equal(classifyPatchLine("+++ b/x"), "meta");
    assert.equal(classifyPatchLine("new file mode 100644"), "meta");
    assert.equal(classifyPatchLine("rename from a"), "meta");
    assert.equal(classifyPatchLine("\\ No newline at end of file"), "meta");
    assert.equal(classifyPatchLine(" context"), "ctx");
    assert.equal(classifyPatchLine(""), "ctx");
  });

  it("splits patch text into classified lines", () => {
    assert.deepEqual(patchLines(""), []);
    assert.deepEqual(patchLines("@@ -1 +1 @@\r\n-a\r\n+b\r\n c\r\n"), [
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", text: "-a" },
      { kind: "add", text: "+b" },
      { kind: "ctx", text: " c" },
    ]);
  });
});
