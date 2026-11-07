/**
 * Unit tests for the round switcher logic (AW2-07b).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveChecks, deriveDiff, deriveReview, type UiEvent } from "../../src/components/agents/runs/logic";
import {
  availableRounds,
  checksForRound,
  derivePlan,
  diffForRound,
  diffPatchForRound,
  findingsBySeverity,
  reviewForRound,
  roundOf,
  selectedRound,
} from "../../src/components/agents/runs/rounds-logic";
import { severityClass } from "../../src/core/agents/severity";
import { severityClass as orchestratorSeverityClass } from "../../src/core/agents/orchestrator";

function ev(seq: number, kind: string, payload: unknown): UiEvent {
  return { runId: "r1", seq, ts: "2026-11-07T00:00:00Z", stage: null, agent: "system", kind, payload };
}
const diff = (seq: number, round: number | undefined, files: number) =>
  ev(seq, "diff_summary", {
    ...(round === undefined ? {} : { round }),
    files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts`, status: "modified", additions: 1, deletions: 0 })),
    totals: { files, additions: files, deletions: 0 },
  });
const check = (seq: number, round: number | undefined, name: string, exitCode: number) =>
  ev(seq, "check_result", { ...(round === undefined ? {} : { round }), name, exitCode, timedOut: false, output: "" });
const review = (seq: number, round: number | undefined, verdict: string, findings: unknown[] = []) =>
  ev(seq, "review", { ...(round === undefined ? {} : { round }), verdict, findings });

describe("roundOf / availableRounds", () => {
  it("treats legacy events as round 0", () => {
    const events = [diff(1, undefined, 1), check(2, undefined, "lint", 0), review(3, undefined, "approve")];
    assert.equal(roundOf(events[0]!), 0);
    assert.deepEqual(availableRounds(events), [0]);
    assert.deepEqual(availableRounds([]), [0]);
  });

  it("falls back to 0 for bad round values", () => {
    for (const bad of [-1, 4, 1.5, "2", null, NaN, undefined, {}]) {
      assert.equal(roundOf(ev(1, "output", { round: bad })), 0, String(bad));
    }
    assert.equal(roundOf(ev(1, "output", "text")), 0);
    assert.equal(roundOf(ev(1, "output", null)), 0);
    assert.equal(roundOf(ev(1, "output", [1])), 0);
    assert.equal(roundOf(ev(1, "output", { round: 3 })), 3);
  });

  it("returns sorted distinct rounds", () => {
    const events = [diff(1, 2, 1), diff(2, 0, 1), diff(3, 1, 1), diff(4, 2, 1)];
    assert.deepEqual(availableRounds(events), [0, 1, 2]);
  });
});

describe("round-scoped derivations", () => {
  const legacy = [diff(1, undefined, 2), check(2, undefined, "lint", 0), review(3, undefined, "approve")];

  it("legacy events: round 0 derivations equal the unscoped ones", () => {
    assert.deepEqual(diffForRound(legacy, 0), deriveDiff(legacy));
    assert.deepEqual(checksForRound(legacy, 0), deriveChecks(legacy));
    assert.deepEqual(reviewForRound(legacy, 0), deriveReview(legacy));
    assert.equal(diffPatchForRound(legacy, 0), null);
  });

  const multi = [
    diff(1, 0, 1),
    check(2, 0, "lint", 1),
    review(3, 0, "request_changes"),
    diff(4, 1, 2),
    check(5, 1, "lint", 0),
    check(6, 1, "test", 0),
    review(7, 1, "approve"),
    ev(8, "diff_patch", { round: 1, files: [{ path: "a.ts", patch: "+x" }] }),
  ];

  it("picks the data of the chosen round", () => {
    assert.equal(diffForRound(multi, 0)?.totals.files, 1);
    assert.equal(diffForRound(multi, 1)?.totals.files, 2);
    assert.deepEqual(checksForRound(multi, 0).map((c) => c.name), ["lint"]);
    assert.deepEqual(checksForRound(multi, 1).map((c) => c.name), ["lint", "test"]);
    assert.equal(reviewForRound(multi, 0)?.verdict, "request_changes");
    assert.equal(reviewForRound(multi, 1)?.verdict, "approve");
    assert.equal(diffPatchForRound(multi, 0), null);
    assert.equal(diffPatchForRound(multi, 1)?.files[0]?.path, "a.ts");
    assert.equal(diffForRound(multi, 2), null);
    assert.equal(reviewForRound(multi, 3), null);
  });

  it("the latest event of a round wins", () => {
    const events = [diff(1, 1, 1), diff(2, 1, 5), review(3, 1, "request_changes"), review(4, 1, "approve")];
    assert.equal(diffForRound(events, 1)?.totals.files, 5);
    assert.equal(reviewForRound(events, 1)?.verdict, "approve");
  });
});

describe("derivePlan", () => {
  it("reads the plan output event", () => {
    const events = [
      ev(1, "output", { text: "hi" }),
      ev(2, "output", {
        kind: "plan",
        round: 0,
        plan: { task: "Do it", scope_paths: ["src/a.ts", 5], acceptance: ["works"], checks: ["lint"] },
      }),
    ];
    assert.deepEqual(derivePlan(events), {
      task: "Do it",
      scopePaths: ["src/a.ts"],
      acceptance: ["works"],
      checks: ["lint"],
    });
  });

  it("is null without a plan event", () => {
    assert.equal(derivePlan([]), null);
    assert.equal(derivePlan([ev(1, "output", { kind: "other" }), ev(2, "output", "x")]), null);
    assert.equal(derivePlan([ev(1, "output", { kind: "plan", plan: "nope" })]), null);
  });
});

describe("findingsBySeverity", () => {
  const f = (severity: string, actionable = true) => ({ severity, message: severity, actionable });

  it("groups and counts by class", () => {
    const r = { verdict: "request_changes", findings: [f("P1"), f("P2"), f("P3"), f("P1", false), f("P3")] };
    const g = findingsBySeverity(r);
    assert.deepEqual(g.counts, { blocking: 2, major: 1, minor: 2 });
    assert.equal(g.groups.blocking[1]?.actionable, false);
    assert.deepEqual(findingsBySeverity({ verdict: "approve", findings: [] }).counts, { blocking: 0, major: 0, minor: 0 });
  });

  it("shares the severity mapping with the orchestrator", () => {
    assert.equal(severityClass("P1"), "blocking");
    assert.equal(severityClass("P2"), "major");
    assert.equal(severityClass("P3"), "minor");
    assert.equal(orchestratorSeverityClass, severityClass);
  });
});

describe("selectedRound", () => {
  it("follows the latest round unless a valid pick exists", () => {
    assert.equal(selectedRound([0], null), 0);
    assert.equal(selectedRound([0, 1, 2], null), 2);
    assert.equal(selectedRound([0, 1, 2], 1), 1);
    assert.equal(selectedRound([0, 1], 3), 1);
  });
});
