/**
 * Unit tests for agent run inline comments pure logic (AW2-07a).
 *
 * Covers:
 * - newFileLineNumbers: unified patch line numbers, hunk header parsing,
 *   header/meta/removed line handling, no-newline markers, malformed headers, empty patch
 * - groupComments: partitioning into general vs per-file (file-level and line-level), input order preservation
 * - parseCommentList: defensive validation, dropping malformed items without throwing
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newFileLineNumbers,
  groupComments,
  parseCommentList,
  type RunComment,
} from "../../src/components/agents/runs/comments-logic";

describe("newFileLineNumbers", () => {
  it("returns empty array for an empty patch", () => {
    assert.deepEqual(newFileLineNumbers([]), []);
  });

  it("assigns correct line numbers for a two-hunk patch", () => {
    const patchLines = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1234567..89abcdef 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,4 +10,5 @@ function init()",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      "\\ No newline at end of file",
      "@@ -20,3 +30,4 @@ function update()",
      "+const d = 5;",
      "-const e = 6;",
      " const f = 7;",
      "+const g = 8;",
    ];

    const result = newFileLineNumbers(patchLines);

    assert.deepEqual(result, [
      null, // diff --git
      null, // index
      null, // ---
      null, // +++
      null, // @@ hunk 1 @@
      10, // context "const a = 1;"
      null, // removed "-const b = 2;"
      11, // added "+const b = 3;"
      12, // context "const c = 4;"
      null, // \ No newline at end of file
      null, // @@ hunk 2 @@
      30, // added "+const d = 5;"
      null, // removed "-const e = 6;"
      31, // context "const f = 7;"
      32, // added "+const g = 8;"
    ]);
  });

  it("handles malformed hunk header and resets on next valid header", () => {
    const patchLines = [
      "@@ -invalid-hunk-header @@",
      "+added line 1",
      " context line 1",
      "-removed line 1",
      "@@ -1,2 +50,2 @@ valid",
      " context line 2",
      "+added line 2",
    ];

    const result = newFileLineNumbers(patchLines);

    assert.deepEqual(result, [
      null, // malformed hunk header
      null, // added line under malformed header -> null
      null, // context line under malformed header -> null
      null, // removed line -> null
      null, // valid hunk header -> null
      50, // context line under valid header -> 50
      51, // added line under valid header -> 51
    ]);
  });

  it("handles hunk headers without length parameters", () => {
    const patchLines = [
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "@@ -0,0 +1,2 @@",
      "+line 1",
      "+line 2",
    ];

    const result = newFileLineNumbers(patchLines);

    assert.deepEqual(result, [
      null, // hunk 1
      null, // removed
      1, // added
      null, // hunk 2
      1, // added
      2, // added
    ]);
  });
});

describe("groupComments", () => {
  it("returns empty structures for empty comments list", () => {
    const result = groupComments([]);
    assert.deepEqual(result.general, []);
    assert.equal(result.byFile.size, 0);
  });

  it("correctly buckets comments into general, file-level and line-level while keeping order", () => {
    const c1: RunComment = {
      id: "c1",
      round: 0,
      file: null,
      line: null,
      body: "General comment 1",
      createdAt: "2026-11-07T10:00:00Z",
    };
    const c2: RunComment = {
      id: "c2",
      round: 0,
      file: "src/a.ts",
      line: null,
      body: "File-level comment on a.ts",
      createdAt: "2026-11-07T10:01:00Z",
    };
    const c3: RunComment = {
      id: "c3",
      round: 0,
      file: "src/a.ts",
      line: 10,
      body: "Line 10 comment 1",
      createdAt: "2026-11-07T10:02:00Z",
    };
    const c4: RunComment = {
      id: "c4",
      round: 0,
      file: "src/a.ts",
      line: 10,
      body: "Line 10 comment 2",
      createdAt: "2026-11-07T10:03:00Z",
    };
    const c5: RunComment = {
      id: "c5",
      round: 0,
      file: "src/a.ts",
      line: 25,
      body: "Line 25 comment",
      createdAt: "2026-11-07T10:04:00Z",
    };
    const c6: RunComment = {
      id: "c6",
      round: 0,
      file: "src/b.ts",
      line: 5,
      body: "Line 5 comment on b.ts",
      createdAt: "2026-11-07T10:05:00Z",
    };
    const c7: RunComment = {
      id: "c7",
      round: 0,
      file: null,
      line: null,
      body: "General comment 2",
      createdAt: "2026-11-07T10:06:00Z",
    };

    const comments = [c1, c2, c3, c4, c5, c6, c7];
    const grouped = groupComments(comments);

    // General comments in order
    assert.deepEqual(grouped.general, [c1, c7]);

    // byFile buckets
    assert.equal(grouped.byFile.size, 2);
    assert.ok(grouped.byFile.has("src/a.ts"));
    assert.ok(grouped.byFile.has("src/b.ts"));

    const aMap = grouped.byFile.get("src/a.ts")!;
    assert.deepEqual(aMap.get("file"), [c2]);
    assert.deepEqual(aMap.get(10), [c3, c4]);
    assert.deepEqual(aMap.get(25), [c5]);

    const bMap = grouped.byFile.get("src/b.ts")!;
    assert.deepEqual(bMap.get(5), [c6]);
  });
});

describe("parseCommentList", () => {
  it("parses valid comment list from array", () => {
    const raw = [
      {
        id: "c1",
        round: 0,
        file: "src/foo.ts",
        line: 12,
        body: "fix this",
        createdAt: "2026-11-07T10:00:00Z",
      },
      {
        id: "c2",
        round: 1,
        file: null,
        line: null,
        body: "whole run note",
        created_at: "2026-11-07T10:05:00Z",
      },
    ];

    const result = parseCommentList(raw);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      id: "c1",
      round: 0,
      file: "src/foo.ts",
      line: 12,
      body: "fix this",
      createdAt: "2026-11-07T10:00:00Z",
    });
    assert.deepEqual(result[1], {
      id: "c2",
      round: 1,
      file: null,
      line: null,
      body: "whole run note",
      createdAt: "2026-11-07T10:05:00Z",
    });
  });

  it("parses comment list wrapped in { comments: [...] }", () => {
    const raw = {
      comments: [
        {
          id: "c1",
          round: 0,
          file: "src/foo.ts",
          line: 5,
          body: "note",
          createdAt: "2026-11-07T10:00:00Z",
        },
      ],
    };

    const result = parseCommentList(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, "c1");
  });

  it("defensively drops malformed items and never throws", () => {
    const mixed = [
      null,
      undefined,
      "not an object",
      123,
      [],
      {},
      // missing id
      { round: 0, body: "test", createdAt: "2026-11-07" },
      // id empty string
      { id: "  ", round: 0, body: "test", createdAt: "2026-11-07" },
      // round not an integer
      { id: "c1", round: 1.5, body: "test", createdAt: "2026-11-07" },
      // round negative
      { id: "c2", round: -1, body: "test", createdAt: "2026-11-07" },
      // missing body
      { id: "c3", round: 0, createdAt: "2026-11-07" },
      // empty body
      { id: "c4", round: 0, body: "", createdAt: "2026-11-07" },
      // missing createdAt
      { id: "c5", round: 0, body: "valid body" },
      // line specified without file
      { id: "c6", round: 0, line: 10, body: "test", createdAt: "2026-11-07" },
      // line < 1
      { id: "c7", round: 0, file: "a.ts", line: 0, body: "test", createdAt: "2026-11-07" },
      // line non-integer
      { id: "c8", round: 0, file: "a.ts", line: 3.14, body: "test", createdAt: "2026-11-07" },
      // invalid file type
      { id: "c9", round: 0, file: 1234, body: "test", createdAt: "2026-11-07" },
      // GOOD ITEM 1
      {
        id: "good-1",
        round: 0,
        file: "src/app.ts",
        line: 42,
        body: "looks good",
        createdAt: "2026-11-07T12:00:00Z",
      },
      // GOOD ITEM 2
      {
        id: "good-2",
        round: 2,
        file: null,
        line: null,
        body: "run level note",
        createdAt: "2026-11-07T12:01:00Z",
      },
    ];

    const result = parseCommentList(mixed);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.id, "good-1");
    assert.equal(result[1]!.id, "good-2");
  });

  it("returns empty array for invalid inputs without throwing", () => {
    assert.deepEqual(parseCommentList(null), []);
    assert.deepEqual(parseCommentList(undefined), []);
    assert.deepEqual(parseCommentList("bad json string"), []);
    assert.deepEqual(parseCommentList(12345), []);
    assert.deepEqual(parseCommentList({ notComments: [1, 2, 3] }), []);
  });
});

describe("newFileLineNumbers inside a hunk", () => {
  it("treats '--- ' and '+++ ' lines inside a hunk as removed and added content", () => {
    const lines = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "--- old dashes", "+++ new pluses", " ctx"];
    assert.deepEqual(newFileLineNumbers(lines), [null, null, null, null, null, 1, 2]);
  });
});
