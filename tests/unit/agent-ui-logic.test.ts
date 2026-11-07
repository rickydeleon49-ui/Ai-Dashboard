/**
 * Unit tests for the pure run-page logic (AW1-13).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptEvent,
  deriveChecks,
  deriveDiff,
  deriveStatus,
  deriveTimeline,
  diffToText,
  emptyStreamState,
  eventPlainLines,
  eventsToPlainText,
  eventsToTerminalText,
  eventsUrl,
  filterByAgent,
  MAX_UI_EVENTS,
  parseCheckNames,
  parseEventData,
  parseOutcome,
  verdictFacts,
  type UiEvent,
} from "../../src/components/agents/runs/logic";

function ev(seq: number, agent: string, kind: string, payload: unknown, stage: string | null = null): UiEvent {
  return { runId: "r1", seq, ts: "2026-11-06T00:00:00Z", stage, agent, kind, payload };
}

describe("parseEventData", () => {
  it("parses a stored event and rejects junk", () => {
    const e = parseEventData(JSON.stringify(ev(3, "system", "warning", { message: "x" })));
    assert.equal(e?.seq, 3);
    assert.equal(parseEventData("not json"), null);
    assert.equal(parseEventData(JSON.stringify({ seq: 0, kind: "output", agent: "system" })), null);
    assert.equal(parseEventData(JSON.stringify({ seq: 1, kind: 5, agent: "system" })), null);
  });
});

describe("acceptEvent (dedupe / reconnect)", () => {
  it("discards seq <= lastSeen and keeps order", () => {
    let s = emptyStreamState;
    s = acceptEvent(s, ev(1, "system", "output", { text: "a" }));
    s = acceptEvent(s, ev(2, "system", "output", { text: "b" }));
    const before = s;
    s = acceptEvent(s, ev(2, "system", "output", { text: "dup" }));
    s = acceptEvent(s, ev(1, "system", "output", { text: "old" }));
    assert.equal(s, before);
    assert.equal(s.lastSeen, 2);
    // replay after reconnect: 1..4 re-sent, only 3 and 4 are new
    for (const n of [1, 2, 3, 4]) s = acceptEvent(s, ev(n, "system", "output", { text: String(n) }));
    assert.deepEqual(s.events.map((e) => e.seq), [1, 2, 3, 4]);
  });

  it("bounds the number of kept events", () => {
    let s = emptyStreamState;
    for (let i = 1; i <= MAX_UI_EVENTS + 10; i++) s = acceptEvent(s, ev(i, "system", "output", { text: "x" }));
    assert.equal(s.events.length, MAX_UI_EVENTS);
    assert.equal(s.events[0]?.seq, 11);
    assert.equal(s.lastSeen, MAX_UI_EVENTS + 10);
  });

  it("builds the resume url from lastSeen", () => {
    assert.equal(eventsUrl("a b", 0), "/api/agent-runs/a%20b/events");
    assert.equal(eventsUrl("r1", 7), "/api/agent-runs/r1/events?after=7");
  });
});

describe("filterByAgent", () => {
  it("filters by agent and passes all through", () => {
    const events = [ev(1, "implementer", "output", {}), ev(2, "checks", "check_result", {}), ev(3, "implementer", "output", {})];
    assert.equal(filterByAgent(events, "all").length, 3);
    assert.deepEqual(filterByAgent(events, "implementer").map((e) => e.seq), [1, 3]);
    assert.equal(filterByAgent(events, "reviewer").length, 0);
  });
});

describe("event formatting", () => {
  it("formats output text lines with the agent tag", () => {
    assert.deepEqual(eventPlainLines(ev(1, "implementer", "output", { stream: "stdout", text: "a\r\nb\n" })), [
      "[implementer] a",
      "[implementer] b",
    ]);
  });

  it("formats status, checks, diff and errors", () => {
    assert.deepEqual(eventPlainLines(ev(1, "system", "status_changed", { status: "checking", stage: "checks" })), [
      "-- status: checking (checks)",
    ]);
    const check = eventPlainLines(ev(2, "checks", "check_result", { name: "lint", exitCode: 1, timedOut: false, output: "bad\nworse" }));
    assert.deepEqual(check, ["[checks] check lint: exit 1", "  bad", "  worse"]);
    assert.deepEqual(eventPlainLines(ev(3, "checks", "check_result", { name: "t", exitCode: null, timedOut: true, output: "" })), [
      "[checks] check t: timed out",
    ]);
    assert.deepEqual(eventPlainLines(ev(4, "system", "diff_summary", { totals: { files: 2, additions: 5, deletions: 1 } })), [
      "[system] diff: 2 file(s), +5 -1",
    ]);
    assert.deepEqual(eventPlainLines(ev(5, "system", "error", { message: "boom" })), ["[system] ERROR: boom"]);
  });

  it("truncates long tool payloads to one line", () => {
    const line = eventPlainLines(ev(1, "implementer", "tool_call", { name: "Read", input: { path: "x".repeat(500) } }))[0] ?? "";
    assert.ok(line.length < 260);
    assert.ok(!line.includes("\n"));
  });

  it("terminal text strips escape/control bytes from payload text and ends lines with CRLF", () => {
    const text = eventsToTerminalText([ev(1, "implementer", "output", { text: "hi\x1b[2J\x07there" })]);
    assert.ok(!text.includes("\x1b[2J"));
    assert.ok(!text.includes("\x07"));
    assert.ok(text.includes("hi[2Jthere"));
    assert.ok(text.endsWith("\r\n"));
  });

  it("terminal text strips C1 controls (8-bit CSI/OSC)", () => {
    const text = eventsToTerminalText([ev(1, "implementer", "output", { text: "a\u009b2Jb\u009d0;x\u009cc" })]);
    assert.ok(!/[\u0080-\u009f]/.test(text));
    assert.ok(text.includes("a2Jb0;xc"));
  });

  it("plain text keeps only the last N lines", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i + 1, "system", "output", { text: `l${i}` }));
    const text = eventsToPlainText(events, 3);
    assert.deepEqual(text.split("\n"), ["[system] l7", "[system] l8", "[system] l9"]);
  });
});

describe("derived views", () => {
  it("derives the timeline", () => {
    const events = [
      ev(1, "system", "stage_started", {}, "inspect"),
      ev(2, "system", "stage_finished", {}, "inspect"),
      ev(3, "system", "status_changed", { status: "implementing" }, "implement"),
    ];
    const t = Object.fromEntries(deriveTimeline(events).map((x) => [x.stage, x.state]));
    assert.equal(t.inspect, "done");
    assert.equal(t.plan, "done");
    assert.equal(t.implement, "running");
    assert.equal(t.checks, "pending");
  });

  it("derives status, checks and diff", () => {
    const events = [
      ev(1, "system", "status_changed", { status: "checking" }),
      ev(2, "checks", "check_result", { name: "lint", exitCode: 0, timedOut: false, durationMs: 5, output: "ok" }),
      ev(3, "system", "diff_summary", {
        files: [{ path: "a.ts", status: "modified", additions: 2, deletions: 1, binary: false, outOfScope: false, excluded: false }],
        totals: { files: 1, additions: 2, deletions: 1 },
      }),
      ev(4, "system", "status_changed", { status: "reviewing" }),
    ];
    assert.equal(deriveStatus(events), "reviewing");
    assert.equal(deriveChecks(events)[0]?.name, "lint");
    const diff = deriveDiff(events);
    assert.ok(diff);
    assert.match(diffToText(diff), /^M {2}a\.ts {2}\(\+2 -1\)/);
  });
});

describe("verdict", () => {
  const outcome = parseOutcome({
    status: "failed",
    facts: {
      implementerExitCode: 0,
      diffFiles: 2,
      excludedTouched: [],
      checks: [{ name: "lint", exitCode: 0, timedOut: false }, { name: "test", exitCode: 1, timedOut: false }],
      reviewVerdict: "request_changes",
    },
    missing: ["x"],
  });

  it("reports the three facts", () => {
    assert.ok(outcome);
    const facts = verdictFacts(outcome, ["lint", "test"]);
    assert.deepEqual(facts.map((f) => f.ok), [true, false, false]);
    assert.match(facts[1]?.detail ?? "", /test/);
  });

  it("rejects malformed outcomes and parses check names", () => {
    assert.equal(parseOutcome(null), null);
    assert.equal(parseOutcome({ status: "failed" }), null);
    assert.deepEqual(parseCheckNames(" lint, typecheck lint\ntest "), ["lint", "typecheck", "test"]);
  });
});
