import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  barLevel,
  clampPct,
  formatCompact,
  formatCountdown,
  formatRelative,
  formatUsd,
  pacePct,
  trendPct,
} from "../../src/lib/usage-format";

const now = new Date("2026-11-08T12:00:00Z");

describe("formatCompact", () => {
  it("shortens big numbers", () => {
    assert.equal(formatCompact(2_400_000_000), "2.4 B");
    assert.equal(formatCompact(851_234), "851 K");
    assert.equal(formatCompact(12_000_000), "12 M");
    assert.equal(formatCompact(1_000), "1 K");
    assert.equal(formatCompact(999), "999");
    assert.equal(formatCompact(0), "0");
  });
});

describe("formatUsd", () => {
  it("formats cents below 100 and whole dollars above", () => {
    assert.equal(formatUsd(4.5), "$4.50");
    assert.equal(formatUsd(95.4), "$95.40");
    assert.equal(formatUsd(1234.6), "$1,235");
  });
});

describe("formatRelative", () => {
  it("is relative to now", () => {
    assert.equal(formatRelative("2026-11-08T11:48:00Z", now), "12 min ago");
    assert.equal(formatRelative("2026-11-08T11:59:50Z", now), "just now");
    assert.equal(formatRelative("2026-11-08T09:00:00Z", now), "3 h ago");
    assert.equal(formatRelative("2026-11-05T12:00:00Z", now), "3 d ago");
    assert.equal(formatRelative(null, now), "never");
    assert.equal(formatRelative("junk", now), "unknown");
  });
});

describe("formatCountdown", () => {
  it("counts down to a reset", () => {
    assert.equal(formatCountdown("2026-11-08T14:10:00Z", now), "2 h 10 min");
    assert.equal(formatCountdown("2026-11-08T12:45:00Z", now), "45 min");
    assert.equal(formatCountdown("2026-11-08T14:00:00Z", now), "2 h");
    assert.equal(formatCountdown("2026-11-10T16:00:00Z", now), "2 d 4 h");
  });
  it("is null when unknown or passed", () => {
    assert.equal(formatCountdown(null, now), null);
    assert.equal(formatCountdown("2026-11-08T11:00:00Z", now), null);
  });
});

describe("trendPct", () => {
  it("compares to the previous period", () => {
    assert.equal(trendPct(150, 100), 50);
    assert.equal(trendPct(50, 100), -50);
    assert.equal(trendPct(10, 0), null);
  });
});

describe("barLevel", () => {
  it("uses amber at 75 and red at 90", () => {
    assert.equal(barLevel(74.9), "ok");
    assert.equal(barLevel(75), "warn");
    assert.equal(barLevel(89.9), "warn");
    assert.equal(barLevel(90), "danger");
  });
  it("clamps", () => {
    assert.equal(clampPct(140), 100);
    assert.equal(clampPct(-3), 0);
  });
});

describe("pacePct", () => {
  it("scales this week to seven days against last week (cost)", () => {
    assert.equal(pacePct({ tokens: 10, costUsd: 30, daysElapsed: 3 }, { tokens: 1000, costUsd: 100 }), 70);
  });
  it("falls back to tokens when cost is missing", () => {
    assert.equal(pacePct({ tokens: 300, costUsd: null, daysElapsed: 3 }, { tokens: 1000, costUsd: 100 }), 70);
  });
  it("is null without a baseline or elapsed days", () => {
    assert.equal(pacePct(null, { tokens: 1, costUsd: null }), null);
    assert.equal(pacePct({ tokens: 1, costUsd: null, daysElapsed: 0 }, { tokens: 1, costUsd: null }), null);
    assert.equal(pacePct({ tokens: 1, costUsd: null, daysElapsed: 2 }, { tokens: 0, costUsd: null }), null);
  });
});
