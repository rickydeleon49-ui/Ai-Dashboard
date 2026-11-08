import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  addDays,
  dayInZone,
  summarizeUsage,
  type SourceFreshness,
} from "../../src/core/usage/summary";
import { loadUsageSnapshot, loadUsageSnapshotCached, clearUsageCache } from "../../src/core/usage";
import type {
  ClaudeWeek,
  CodexLimitsSnapshot,
  UsageRow,
} from "../../src/core/usage/sources";

function row(p: Partial<UsageRow>): UsageRow {
  return {
    tool: "claude-code",
    machine: "mac",
    date: "2026-11-08",
    model: "m1",
    totalTokens: 10,
    replies: 1,
    costUsd: null,
    ...p,
  };
}

// 2026-11-08 20:00 UTC = 12:00 PST on 2026-11-08.
const NOW = new Date("2026-11-08T20:00:00Z");

describe("usage summary maths", () => {
  it("computes the day in the time zone and date arithmetic", () => {
    assert.equal(dayInZone(new Date("2026-11-08T05:00:00Z"), "America/Los_Angeles"), "2026-11-07");
    assert.equal(dayInZone(NOW, "America/Los_Angeles"), "2026-11-08");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  });

  it("splits today, last 7 days and previous 7 days", () => {
    const rows = [
      row({ date: "2026-11-08", totalTokens: 100, replies: 2, costUsd: 1 }),
      row({ date: "2026-11-02", totalTokens: 50, replies: 1, costUsd: 0.5 }), // day -6, in
      row({ date: "2026-11-01", totalTokens: 30, replies: 1, costUsd: 0.25 }), // day -7, previous
      row({ date: "2026-10-26", totalTokens: 20, replies: 1, costUsd: 0.25 }), // day -13, previous
      row({ date: "2026-10-25", totalTokens: 999 }), // day -14, outside both
      row({ date: "2026-11-09", totalTokens: 999 }), // future, ignored
    ];
    const s = summarizeUsage(rows, [], null, NOW);
    const c = s.tools.find((t) => t.tool === "claude-code")!;
    assert.deepEqual(c.today, { tokens: 100, replies: 2, costUsd: 1 });
    assert.deepEqual(c.last7Days, { tokens: 150, replies: 3, costUsd: 1.5 });
    assert.deepEqual(c.previous7Days, { tokens: 50, replies: 2, costUsd: 0.5 });
  });

  it("returns cost null when no row has a cost, and sums known costs otherwise", () => {
    const rows = [
      row({ tool: "codex", totalTokens: 5 }),
      row({ tool: "claude-code", totalTokens: 5, costUsd: null }),
      row({ tool: "claude-code", totalTokens: 5, costUsd: 2 }),
    ];
    const s = summarizeUsage(rows, [], null, NOW);
    assert.equal(s.tools.find((t) => t.tool === "codex")!.today.costUsd, null);
    assert.equal(s.tools.find((t) => t.tool === "claude-code")!.today.costUsd, 2);
    const agy = s.tools.find((t) => t.tool === "antigravity")!;
    assert.equal(agy.hasData, false);
    assert.equal(agy.today.tokens, 0);
  });

  it("groups by machine (7 days) and ranks top models (30 days)", () => {
    const rows = [
      row({ machine: "mac", totalTokens: 10, model: "a" }),
      row({ machine: "windows-pc", totalTokens: 90, model: "b" }),
      row({ machine: "mac", date: "2026-10-15", totalTokens: 500, model: "old" }), // 24 days ago
      row({ machine: "mac", date: "2026-10-01", totalTokens: 5000, model: "ancient" }),
    ];
    const c = summarizeUsage(rows, [], null, NOW).tools[0]!;
    assert.deepEqual(
      c.byMachine.map((m) => [m.machine, m.tokens]),
      [
        ["windows-pc", 90],
        ["mac", 10],
      ],
    );
    assert.deepEqual(
      c.topModels.map((m) => m.model),
      ["old", "b", "a"],
    );
  });

  it("uses the newest two ALL weeks for Claude this week vs last week", () => {
    const week = (start: string, total: number, status: string): ClaudeWeek => ({
      weekStart: start,
      weekEnd: "x",
      totalTokens: total,
      replies: 1,
      costUsd: total / 100,
      status,
      daysElapsed: 3,
    });
    const weeks = [
      week("2026-11-04 02:00 PT", 900, "in progress"),
      week("2026-10-21 02:00 PT", 100, "complete"),
      week("2026-10-28 02:00 PT", 500, "complete"),
    ];
    const s = summarizeUsage([], weeks, null, NOW);
    const c = s.tools[0]!;
    assert.equal(c.thisWeek?.tokens, 900);
    assert.equal(c.thisWeek?.status, "in progress");
    assert.equal(c.lastWeek?.tokens, 500);
    assert.equal(s.tools[1]!.thisWeek, null);
  });

  it("flags Codex limits stale when older than the window or past the reset", () => {
    const limits = (snapshotAt: string, fiveReset: string): CodexLimitsSnapshot => ({
      snapshotAt,
      fiveHour: { usedPct: 4, windowMin: 300, resetsAt: fiveReset },
      weekly: { usedPct: 83, windowMin: 10080, resetsAt: "2026-11-13T19:01:18.000Z" },
    });
    const fresh = summarizeUsage([], [], limits("2026-11-08T19:00:00Z", "2026-11-08T23:00:00Z"), NOW);
    assert.equal(fresh.codexLimits?.stale, false);
    assert.equal(fresh.codexLimits?.fiveHour.usedPct, 4);

    const old = summarizeUsage([], [], limits("2026-11-08T06:01:43Z", "2026-11-08T23:00:00Z"), NOW);
    assert.equal(old.codexLimits?.fiveHour.stale, true);
    assert.equal(old.codexLimits?.weekly.stale, false);
    assert.equal(old.codexLimits?.stale, true);

    const passed = summarizeUsage([], [], limits("2026-11-08T19:50:00Z", "2026-11-08T19:55:00Z"), NOW);
    assert.equal(passed.codexLimits?.fiveHour.stale, true);

    assert.equal(summarizeUsage([], [], null, NOW).codexLimits, null);
  });

  it("flags a source stale after 24 hours or when it has no timestamp", () => {
    const sources: SourceFreshness[] = [
      { tool: "claude-code", file: "a", updatedAt: "2026-11-08T19:00:00Z" },
      { tool: "codex", file: "b", updatedAt: "2026-11-06T19:00:00Z" },
    ];
    const s = summarizeUsage([], [], null, NOW, "America/Los_Angeles", sources);
    assert.equal(s.tools[0]!.stale, false);
    assert.equal(s.tools[0]!.updatedAt, "2026-11-08T19:00:00Z");
    assert.equal(s.tools[1]!.stale, true);
    assert.equal(s.tools[2]!.stale, true);
    assert.equal(s.tools[2]!.updatedAt, null);
  });
});

describe("loadUsageSnapshot", () => {
  it("wires readers and summary through an injected fs and never throws", () => {
    const files = new Map<string, string>([
      [
        "/u/claude-code-usage-daily.csv",
        "machine,date,model,input,output,cache_write,cache_read,total,replies,cost_usd\n" +
          "mac,2026-11-08,claude-opus-5,0,0,0,0,100,2,3.5\n",
      ],
    ]);
    const mtime = Date.parse("2026-11-08T19:30:00Z");
    const fakeFs = {
      stat: (p: string) => {
        const k = p.replace(/\\/g, "/");
        const t = files.get(k);
        return t === undefined ? null : { size: t.length, mtimeMs: mtime };
      },
      readText: (p: string) => files.get(p.replace(/\\/g, "/")) ?? "",
    };
    const snap = loadUsageSnapshot({ folder: "/u", now: NOW, fs: fakeFs });
    const c = snap.tools[0]!;
    assert.equal(c.today.tokens, 100);
    assert.equal(c.today.costUsd, 3.5);
    assert.equal(c.stale, false);
    assert.equal(snap.folder, "/u");
    assert.ok(snap.warnings.length >= 4, "missing files are reported as warnings");
    assert.equal(snap.codexLimits, null);
  });

  it("caches for the ttl and reloads after it", () => {
    clearUsageCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
    try {
      const a = loadUsageSnapshotCached({ folder: dir, now: NOW });
      const b = loadUsageSnapshotCached({ folder: dir, now: new Date(NOW.getTime() + 30_000) });
      assert.equal(a, b);
      const c = loadUsageSnapshotCached({ folder: dir, now: new Date(NOW.getTime() + 61_000) });
      assert.notEqual(a, c);
    } finally {
      clearUsageCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
