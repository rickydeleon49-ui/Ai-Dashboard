/**
 * Unit tests for the agents demo script (AW1-14).
 *
 * Exercises the demo workflow:
 * - Refusal when DATABASE_PATH points outside the demo temporary directory.
 * - End-to-end execution to a terminal "succeeded" state with fake agent.
 * - Proper cleanup of temporary resources (and preservation with keep: true).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runDemo } from "../../scripts/agents-demo";

describe("agents-demo", () => {
  it("refuses if DATABASE_PATH points elsewhere than the temp dir it made", async () => {
    const fakeExternalDb = path.join(os.tmpdir(), "some-external-db.db");
    process.env.DATABASE_PATH = fakeExternalDb;
    try {
      await assert.rejects(
        async () => {
          await runDemo({ log: () => {} });
        },
        /Refusing to run demo: DATABASE_PATH points elsewhere/,
      );
    } finally {
      delete process.env.DATABASE_PATH;
    }
  });

  it("runs end-to-end to a terminal succeeded status and cleans up temp dir", async () => {
    delete process.env.DATABASE_PATH;
    const logs: string[] = [];
    const result = await runDemo({
      log: (msg) => logs.push(msg),
      timeoutMs: 30_000,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, "succeeded");
    assert.ok(result.eventsCount > 0, "must record events");
    assert.ok(
      result.changedFiles.some((f) => f.path === "fake-output.txt"),
      "must record changed fake-output.txt file",
    );
    assert.equal(
      fs.existsSync(result.tempDir),
      false,
      "temp dir must be cleaned up when keep is false",
    );
  });

  it("preserves temp dir when keep is true", async () => {
    delete process.env.DATABASE_PATH;
    let tempDirToClean: string | null = null;
    try {
      const result = await runDemo({
        keep: true,
        log: () => {},
        timeoutMs: 30_000,
      });

      tempDirToClean = result.tempDir;
      assert.equal(result.success, true);
      assert.equal(
        fs.existsSync(result.tempDir),
        true,
        "temp dir must exist when keep is true",
      );
    } finally {
      if (tempDirToClean && fs.existsSync(tempDirToClean)) {
        fs.rmSync(tempDirToClean, { recursive: true, force: true });
      }
    }
  });
});
