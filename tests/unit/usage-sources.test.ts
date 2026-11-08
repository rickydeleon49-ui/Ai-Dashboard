import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  MAX_FILE_BYTES,
  nodeUsageFs,
  readAntigravityWindows,
  readClaudeDaily,
  readClaudeWeeks,
  readCodexLimits,
  readCodexMac,
  readCodexWindows,
  readWindowsUpdated,
  type UsageFs,
} from "../../src/core/usage/sources";

let dir = "";

function put(rel: string, text: string) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-"));
  put(
    "claude-code-usage-daily.csv",
    "machine,date,model,input,output,cache_write,cache_read,total,replies,cost_usd\r\n" +
      "windows-pc,2026-11-08,claude-opus-5,1,2,3,4,100,8,1.5\r\n" +
      "mac,2026-11-08,claude-opus-5,1,2,3,4,50,2,\r\n" +
      "mac,not-a-date,claude-opus-5,1,2,3,4,50,2,1\r\n" +
      "mac,2026-11-08,claude-opus-5,1,2,3,4,xx,2,1\r\n",
  );
  put(
    "claude-code-usage-weekly.csv",
    "week_start,week_end,model,input,output,cache_write,cache_read,total,replies,sessions,total_change_vs_prev_week,total_change_pct,status,days_elapsed,cost_usd\n" +
      "2026-11-04 02:00 PT,2026-11-11 02:00 PT,ALL,0,0,0,0,900,10,2,,,in progress,4,9.5\n" +
      "2026-11-04 02:00 PT,2026-11-11 02:00 PT,claude-opus-5,0,0,0,0,900,10,2,,,in progress,4,9.5\n" +
      "2026-10-28 02:00 PT,2026-11-04 02:00 PT,ALL,0,0,0,0,500,5,1,,,complete,7,4\n",
  );
  put(
    "codex-usage-daily.csv",
    "date,model,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,responses\n" +
      "2026-11-08,gpt-6.1-sol,1,1,1,1,700,7\n",
  );
  put(
    "tools/windows-pc-codex-daily.csv",
    "machine,tool,date,model,input,output,cache_write,cache_read,total,replies,sessions\n" +
      "windows-pc,codex,2026-11-08,gpt-6-astra,0,0,0,0,300,3,1\n",
  );
  // Garbled: wrong header.
  put("tools/windows-pc-antigravity-daily.csv", "foo,bar\n1,2\n");
  put(
    "tools/windows-pc-codex-limits.csv",
    "snapshot_at,five_hour_used_pct,five_hour_window_min,five_hour_resets_at,weekly_used_pct,weekly_window_min,weekly_resets_at\n" +
      "2026-11-07T01:32:18.049Z,97,300,2026-11-07T05:37:52.000Z,22,10080,2026-11-13T19:01:18.000Z\n" +
      "2026-11-08T06:01:43.750Z,4,300,2026-11-08T10:59:08.000Z,83,10080,2026-11-13T19:01:18.000Z\n" +
      "garbage,1,1,,1,1,\n" +
      "2026-11-07T18:37:20.377Z,72,300,2026-11-07T21:46:06.000Z,65,10080,2026-11-13T19:01:18.000Z\n",
  );
  put(
    "machines/windows-pc-updated.txt",
    "updated\n2026-11-08T10:00:00.000Z\n2026-11-08T19:36:35.601Z\nnot a time\n",
  );
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("usage sources", () => {
  it("reads Claude daily rows, skipping bad rows and keeping unknown cost as null", () => {
    const r = readClaudeDaily(nodeUsageFs, dir);
    assert.equal(r.data.length, 2);
    assert.equal(r.data[0]?.tool, "claude-code");
    assert.equal(r.data[0]?.machine, "windows-pc");
    assert.equal(r.data[0]?.totalTokens, 100);
    assert.equal(r.data[0]?.costUsd, 1.5);
    assert.equal(r.data[1]?.costUsd, null);
    assert.ok(r.warnings.some((w) => w.includes("skipped 2 bad row")));
    assert.ok(r.mtime);
  });

  it("reads only the ALL weekly rows, oldest first", () => {
    const r = readClaudeWeeks(nodeUsageFs, dir);
    assert.equal(r.data.length, 2);
    assert.equal(r.data[0]?.weekStart, "2026-10-28 02:00 PT");
    assert.equal(r.data[1]?.status, "in progress");
    assert.equal(r.data[1]?.totalTokens, 900);
    assert.equal(r.data[1]?.costUsd, 9.5);
  });

  it("maps Mac Codex to machine mac and Windows Codex from its machine column", () => {
    const mac = readCodexMac(nodeUsageFs, dir);
    assert.equal(mac.data[0]?.machine, "mac");
    assert.equal(mac.data[0]?.totalTokens, 700);
    assert.equal(mac.data[0]?.replies, 7);
    assert.equal(mac.data[0]?.costUsd, null);
    const win = readCodexWindows(nodeUsageFs, dir);
    assert.equal(win.data[0]?.machine, "windows-pc");
    assert.equal(win.data[0]?.tool, "codex");
  });

  it("skips a file with an unknown header and warns", () => {
    const r = readAntigravityWindows(nodeUsageFs, dir);
    assert.deepEqual(r.data, []);
    assert.equal(r.mtime, null);
    assert.ok(r.warnings[0]?.includes("unknown header"));
  });

  it("warns on a missing file and never throws", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "usage-empty-"));
    try {
      const r = readClaudeDaily(nodeUsageFs, empty);
      assert.deepEqual(r.data, []);
      assert.ok(r.warnings[0]?.includes("not found"));
      assert.equal(readCodexLimits(nodeUsageFs, empty).data, null);
      assert.equal(readWindowsUpdated(nodeUsageFs, empty), null);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("warns when a file cannot be read or is too large", () => {
    const unreadable: UsageFs = {
      stat: () => ({ size: 10, mtimeMs: 0 }),
      readText: () => {
        throw new Error("EBUSY");
      },
    };
    const r1 = readClaudeDaily(unreadable, dir);
    assert.deepEqual(r1.data, []);
    assert.ok(r1.warnings[0]?.includes("could not be read"));

    const huge: UsageFs = {
      stat: () => ({ size: MAX_FILE_BYTES + 1, mtimeMs: 0 }),
      readText: () => {
        throw new Error("must not read");
      },
    };
    const r2 = readClaudeDaily(huge, dir);
    assert.ok(r2.warnings[0]?.includes("larger than"));
  });

  it("returns the newest limits row by snapshot time", () => {
    const r = readCodexLimits(nodeUsageFs, dir);
    assert.equal(r.data?.snapshotAt, "2026-11-08T06:01:43.750Z");
    assert.equal(r.data?.fiveHour.usedPct, 4);
    assert.equal(r.data?.weekly.usedPct, 83);
    assert.equal(r.data?.weekly.windowMin, 10080);
    assert.equal(r.data?.fiveHour.resetsAt, "2026-11-08T10:59:08.000Z");
    assert.ok(r.warnings.some((w) => w.includes("skipped 1 bad row")));
  });

  it("reads the newest Windows updated stamp", () => {
    assert.equal(readWindowsUpdated(nodeUsageFs, dir), "2026-11-08T19:36:35.601Z");
  });
});
