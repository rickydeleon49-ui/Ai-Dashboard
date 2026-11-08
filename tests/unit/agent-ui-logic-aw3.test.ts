/**
 * Unit tests for Antigravity and advisor events formatting (AW3-07).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  eventPlainLines,
  eventsToTerminalText,
  type UiEvent,
} from "../../src/components/agents/runs/logic";

function ev(seq: number, agent: string, kind: string, payload: unknown, stage: string | null = null): UiEvent {
  return { runId: "r1", seq, ts: "2026-11-07T00:00:00Z", stage, agent, kind, payload };
}

describe("AW3-07 event formatting", () => {
  it("formats warning with deniedAction and displayName", () => {
    const event = ev(1, "implementer", "warning", {
      deniedAction: "run_command",
      displayName: "run bash",
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, ["[implementer] denied: run bash"]);
    const term = eventsToTerminalText([event]);
    assert.ok(term.includes("\x1b[33m[implementer] denied: run bash\x1b[0m\r\n"));
  });

  it("formats warning with deniedAction falling back to deniedAction when displayName is absent", () => {
    const event = ev(1, "implementer", "warning", {
      deniedAction: "run_command",
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, ["[implementer] denied: run_command"]);
    const term = eventsToTerminalText([event]);
    assert.ok(term.includes("\x1b[33m[implementer] denied: run_command\x1b[0m\r\n"));
  });

  it("formats plain warning without deniedAction unchanged", () => {
    const event = ev(1, "implementer", "warning", {
      message: "disk space low",
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, ["[implementer] warning: disk space low"]);
    const term = eventsToTerminalText([event]);
    assert.ok(term.includes("\x1b[33m[implementer] warning: disk space low\x1b[0m\r\n"));
  });

  it("formats monitor_stop event in red", () => {
    const event = ev(1, "system", "monitor_stop", {
      message: "disallowed shell access",
      tool: "run_command",
      reason: "forbidden",
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, ["[system] STOPPED by tool monitor: disallowed shell access"]);
    const term = eventsToTerminalText([event]);
    assert.ok(term.includes("\x1b[31m[system] STOPPED by tool monitor: disallowed shell access\x1b[0m\r\n"));
  });

  it("formats plugin_read event in yellow joining paths with comma", () => {
    const event = ev(1, "system", "plugin_read", {
      tool: "read_file",
      paths: ["skills/foo/SKILL.md", "skills/bar/SKILL.md"],
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, [
      "[system] plugin file read (allowed): skills/foo/SKILL.md, skills/bar/SKILL.md",
    ]);
    const term = eventsToTerminalText([event]);
    assert.ok(
      term.includes(
        "\x1b[33m[system] plugin file read (allowed): skills/foo/SKILL.md, skills/bar/SKILL.md\x1b[0m\r\n",
      ),
    );
  });

  it("formats continuation event in cyan without conversationId", () => {
    const event = ev(1, "system", "continuation", {
      stage: "implement",
      attempt: 2,
      of: 3,
      conversationId: "secret-conv-id-12345",
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, ["== continuing Antigravity (implement, attempt 2 of 3)"]);
    assert.equal(lines[0]!.includes("secret-conv-id-12345"), false);
    const term = eventsToTerminalText([event]);
    assert.ok(term.includes("\x1b[36m== continuing Antigravity (implement, attempt 2 of 3)\x1b[0m\r\n"));
    assert.equal(term.includes("secret-conv-id-12345"), false);
  });

  it("formats advisor event with ok: true in dim with indented summary lines", () => {
    const event = ev(1, "advisor", "advisor", {
      ok: true,
      model: "gemini-2.0-flash",
      summary: "First observation.\nSecond observation.",
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, [
      "[advisor] advisory only (gemini-2.0-flash):",
      "  First observation.",
      "  Second observation.",
    ]);
    assert.equal(lines[0]!, "[advisor] advisory only (gemini-2.0-flash):");
    assert.equal(lines[1]!, "  First observation.");
    assert.equal(lines[2]!, "  Second observation.");
    const term = eventsToTerminalText([event]);
    assert.ok(term.includes("\x1b[2m[advisor] advisory only (gemini-2.0-flash):\x1b[0m\r\n"));
    assert.ok(term.includes("\x1b[2m  First observation.\x1b[0m\r\n"));
    assert.ok(term.includes("\x1b[2m  Second observation.\x1b[0m\r\n"));
  });

  it("formats advisor event with ok: false in dim with reason", () => {
    const event = ev(1, "advisor", "advisor", {
      ok: false,
      reason: "rate limit exceeded",
    });
    const lines = eventPlainLines(event);
    assert.deepEqual(lines, ["[advisor] unavailable: rate limit exceeded"]);
    assert.equal(lines[0]!, "[advisor] unavailable: rate limit exceeded");
    const term = eventsToTerminalText([event]);
    assert.ok(term.includes("\x1b[2m[advisor] unavailable: rate limit exceeded\x1b[0m\r\n"));
  });
});
