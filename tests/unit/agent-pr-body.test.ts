import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPrBody, type PrBodyInput } from "../../src/core/agents/pr-body";
import type { RunOutcome } from "../../src/core/agents/orchestrator";

function makeOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status: "succeeded",
    facts: {
      implementerExitCode: 0,
      diffFiles: 2,
      excludedTouched: [],
      checks: [
        { name: "typecheck", exitCode: 0, timedOut: false },
        { name: "test:unit", exitCode: 0, timedOut: false },
      ],
      reviewVerdict: "approve",
    },
    missing: [],
    ...overrides,
  };
}

describe("buildPrBody", () => {
  it("builds a full body for a succeeded run", () => {
    const input: PrBodyInput = {
      title: "Round AW4-09: draft PR body builder",
      taskUrl: "https://github.com/example/repo/issues/101",
      implementer: "Antigravity (gemini-3.8-flash)",
      reviewer: "Codex (gpt-5)",
      outcome: makeOutcome(),
      changedFiles: ["src/core/agents/pr-body.ts", "tests/unit/agent-pr-body.test.ts"],
      agentSummary: "Implemented draft PR body builder pure function and test suite.",
      runUrl: "https://example.com/runs/run-42",
    };

    const body = buildPrBody(input);

    // Section headers in exact order
    const summaryIdx = body.indexOf("## Summary");
    const factsIdx = body.indexOf("## Facts");
    const filesIdx = body.indexOf("## Files");
    const notesIdx = body.indexOf("## Agent notes");
    const runIdx = body.indexOf("Run: https://example.com/runs/run-42");

    assert.ok(summaryIdx !== -1, "Summary section present");
    assert.ok(factsIdx !== -1, "Facts section present");
    assert.ok(filesIdx !== -1, "Files section present");
    assert.ok(notesIdx !== -1, "Agent notes section present");
    assert.ok(runIdx !== -1, "Run line present");

    assert.ok(summaryIdx < factsIdx, "Summary before Facts");
    assert.ok(factsIdx < filesIdx, "Facts before Files");
    assert.ok(filesIdx < notesIdx, "Files before Agent notes");
    assert.ok(notesIdx < runIdx, "Agent notes before Run");

    // Exact summary content
    assert.ok(
      body.includes("## Summary\n\nRound AW4-09: draft PR body builder\nTask: https://github.com/example/repo/issues/101"),
      "Summary contains title and task URL",
    );

    // Facts lines
    assert.ok(body.includes("- Status: succeeded"));
    assert.ok(body.includes("- Implementer: Antigravity (gemini-3.8-flash)"));
    assert.ok(body.includes("- Reviewer: Codex (gpt-5)"));
    assert.ok(body.includes("- Review verdict: approve"));
    assert.ok(body.includes("- Files changed: 2"));
    assert.ok(body.includes("- typecheck: passed"));
    assert.ok(body.includes("- test:unit: passed"));

    // Files lines
    assert.ok(body.includes("- `src/core/agents/pr-body.ts`"));
    assert.ok(body.includes("- `tests/unit/agent-pr-body.test.ts`"));

    // Agent notes
    assert.ok(body.includes("## Agent notes\n\n> Implemented draft PR body builder pure function and test suite."));

    // Final line
    assert.ok(body.endsWith("Run: https://example.com/runs/run-42\n"));

    // No trailing spaces on any line and LF line endings
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      assert.equal(line, line.trimEnd(), `Line ${i} has trailing spaces: ${JSON.stringify(line)}`);
    }
  });

  it("builds a failed run with failed + timed-out checks and excludedTouched", () => {
    const outcome: RunOutcome = {
      status: "failed",
      facts: {
        implementerExitCode: 1,
        diffFiles: 3,
        excludedTouched: [".env.production", "secrets/key.pem"],
        checks: [
          { name: "typecheck", exitCode: 0, timedOut: false },
          { name: "lint", exitCode: 2, timedOut: false },
          { name: "test:e2e", exitCode: null, timedOut: true },
        ],
        reviewVerdict: "request_changes",
        outOfScope: ["outside/scope.ts"],
      },
      rounds: { corrections: 2 },
      missing: ["checks failed", "excluded paths changed"],
    };

    const input: PrBodyInput = {
      title: "Fix critical regression",
      implementer: "Claude Code (sonnet-3.5)",
      reviewer: "Codex (gpt-5)",
      outcome,
      changedFiles: [".env.production", "secrets/key.pem", "src/core/auth.ts"],
    };

    const body = buildPrBody(input);

    assert.ok(body.includes("- Status: failed"));
    assert.ok(body.includes("- Implementer: Claude Code (sonnet-3.5)"));
    assert.ok(body.includes("- Reviewer: Codex (gpt-5)"));
    assert.ok(body.includes("- Review verdict: request_changes"));
    assert.ok(body.includes("- Files changed: 3"));
    assert.ok(body.includes("- typecheck: passed"));
    assert.ok(body.includes("- lint: failed (exit 2)"));
    assert.ok(body.includes("- test:e2e: timed out"));
    assert.ok(body.includes("- Excluded paths touched: .env.production, secrets/key.pem"));
    assert.ok(body.includes("- Out-of-scope paths: outside/scope.ts"));
    assert.ok(body.includes("- Correction rounds: 2"));

    // No trailing spaces
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      assert.equal(line, line.trimEnd(), `Line ${i} has trailing spaces`);
    }
  });

  it("omits reviewer and review verdict lines when null", () => {
    const outcome: RunOutcome = {
      status: "succeeded",
      facts: {
        implementerExitCode: 0,
        diffFiles: 1,
        excludedTouched: [],
        checks: [{ name: "typecheck", exitCode: 0, timedOut: false }],
        reviewVerdict: null,
      },
      missing: [],
    };

    const input: PrBodyInput = {
      title: "Single pass without reviewer",
      implementer: "Antigravity (gemini-3.8-flash)",
      reviewer: null,
      outcome,
      changedFiles: ["src/index.ts"],
    };

    const body = buildPrBody(input);

    assert.ok(!body.includes("Reviewer:"), "Reviewer line must be omitted when null");
    assert.ok(!body.includes("Review verdict:"), "Review verdict line must be omitted when null");
    assert.ok(body.includes("- Status: succeeded"));
    assert.ok(body.includes("- Implementer: Antigravity (gemini-3.8-flash)"));
    assert.ok(body.includes("- Files changed: 1"));
  });

  it("handles 60 files -> 50 + '… and 10 more'", () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/file-${i + 1}.ts`);
    const outcome = makeOutcome({
      facts: {
        implementerExitCode: 0,
        diffFiles: 60,
        excludedTouched: [],
        checks: [],
        reviewVerdict: "approve",
      },
    });

    const input: PrBodyInput = {
      title: "Massive refactor",
      implementer: "Antigravity (gemini-3.8-flash)",
      outcome,
      changedFiles: files,
    };

    const body = buildPrBody(input);

    // First 50 files should be present
    assert.ok(body.includes("- `src/file-1.ts`"), "file 1 present");
    assert.ok(body.includes("- `src/file-50.ts`"), "file 50 present");

    // File 51 must not be listed
    assert.ok(!body.includes("- `src/file-51.ts`"), "file 51 not listed");

    // Overflow line present with unicode ellipsis
    assert.ok(body.includes("- … and 10 more"), "overflow line present");
    assert.ok(body.includes("- Files changed: 60"), "files changed count is 60");
  });

  it("quotes agent text including a '# heading' line and keeps backticks as-is", () => {
    const summary = "Line 1\n# heading\nLine 3 with `const x = 1;` and backticks";
    const input: PrBodyInput = {
      title: "Quoting check",
      implementer: "Antigravity (gemini-3.8-flash)",
      outcome: makeOutcome(),
      changedFiles: ["src/index.ts"],
      agentSummary: summary,
    };

    const body = buildPrBody(input);

    assert.ok(body.includes("> Line 1\n> # heading\n> Line 3 with `const x = 1;` and backticks"));
    assert.ok(!body.includes("\n# heading\n"), "Heading must be quoted, not raw markdown heading");
  });

  it("cuts 5000-char agent text to 4000 + '…'", () => {
    const longSummary = "x".repeat(5000);
    const input: PrBodyInput = {
      title: "Truncation check",
      implementer: "Antigravity (gemini-3.8-flash)",
      outcome: makeOutcome(),
      changedFiles: ["src/index.ts"],
      agentSummary: longSummary,
    };

    const body = buildPrBody(input);

    const expectedCut = "> " + "x".repeat(4000) + "…";
    assert.ok(body.includes(expectedCut), "Text is cut to 4000 chars followed by ellipsis");
    assert.ok(!body.includes("x".repeat(4001)), "Must not contain 4001 consecutive x's");
  });

  it("omits Agent notes section when agentSummary is empty or whitespace", () => {
    for (const emptyVal of [null, undefined, "", "   ", "\n\n  \t "]) {
      const input: PrBodyInput = {
        title: "No notes check",
        implementer: "Antigravity (gemini-3.8-flash)",
        outcome: makeOutcome(),
        changedFiles: ["src/index.ts"],
        agentSummary: emptyVal,
      };

      const body = buildPrBody(input);
      assert.ok(!body.includes("## Agent notes"), `Agent notes section must be omitted for ${JSON.stringify(emptyVal)}`);
    }
  });

  it("omits taskUrl and runUrl when null or undefined", () => {
    const inputNull: PrBodyInput = {
      title: "No URLs check",
      taskUrl: null,
      runUrl: null,
      implementer: "Antigravity (gemini-3.8-flash)",
      outcome: makeOutcome(),
      changedFiles: ["src/index.ts"],
    };

    const bodyNull = buildPrBody(inputNull);
    assert.ok(!bodyNull.includes("Task:"), "Task: omitted when taskUrl is null");
    assert.ok(!bodyNull.includes("Run:"), "Run: omitted when runUrl is null");

    const inputUndefined: PrBodyInput = {
      title: "Undefined URLs check",
      implementer: "Antigravity (gemini-3.8-flash)",
      outcome: makeOutcome(),
      changedFiles: ["src/index.ts"],
    };

    const bodyUndefined = buildPrBody(inputUndefined);
    assert.ok(!bodyUndefined.includes("Task:"), "Task: omitted when taskUrl is undefined");
    assert.ok(!bodyUndefined.includes("Run:"), "Run: omitted when runUrl is undefined");
  });
});
