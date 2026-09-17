import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TASK_LOCK_TIMEOUT_MS,
  MAX_TASK_LOCK_TIMEOUT_MS,
  MIN_TASK_LOCK_TIMEOUT_MS,
  parseTaskLockTimeoutMs,
} from "../../src/db/repositories/postgres-task-repository";

describe("parseTaskLockTimeoutMs validation", () => {
  it("uses default when value is unset", () => {
    assert.equal(parseTaskLockTimeoutMs(undefined), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(null), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(""), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("   "), DEFAULT_TASK_LOCK_TIMEOUT_MS);
  });

  it("accepts valid positive integer values within supported range", () => {
    assert.equal(parseTaskLockTimeoutMs("5000"), 5000);
    assert.equal(parseTaskLockTimeoutMs(5000), 5000);
    assert.equal(parseTaskLockTimeoutMs("1"), MIN_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(1), MIN_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("60000"), MAX_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(60000), MAX_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("  2500  "), 2500);
  });

  it("rejects zero and falls back to default", () => {
    assert.equal(parseTaskLockTimeoutMs("0"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(0), DEFAULT_TASK_LOCK_TIMEOUT_MS);
  });

  it("rejects negative values and falls back to default", () => {
    assert.equal(parseTaskLockTimeoutMs("-1"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("-5000"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(-5000), DEFAULT_TASK_LOCK_TIMEOUT_MS);
  });

  it("rejects nonnumeric values and falls back to default", () => {
    assert.equal(parseTaskLockTimeoutMs("abc"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("10s"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("true"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("0x10"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("1e4"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(NaN), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(Infinity), DEFAULT_TASK_LOCK_TIMEOUT_MS);
  });

  it("rejects decimal values and falls back to default", () => {
    assert.equal(parseTaskLockTimeoutMs("15.5"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("100.0"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(15.5), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("0.5"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
  });

  it("rejects excessively large values and falls back to default", () => {
    assert.equal(parseTaskLockTimeoutMs("60001"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs("999999999"), DEFAULT_TASK_LOCK_TIMEOUT_MS);
    assert.equal(parseTaskLockTimeoutMs(1000000), DEFAULT_TASK_LOCK_TIMEOUT_MS);
  });
});
describe("acquireWorkspaceLock timeout lifecycle and error handling", () => {
  const { acquireWorkspaceLock } = require("../../src/db/repositories/postgres-task-repository");
  const { TaskLockTimeoutError } = require("../../src/core/tasks/errors");

  it("sets validated lock_timeout, acquires lock, and resets timeout to DEFAULT after acquisition", async () => {
    const executed: string[] = [];
    const mockTx = {
      execute: async (statement: any) => {
        const text = statement?.queryChunks
          ? statement.queryChunks.map((c: any) => (typeof c === "string" ? c : c?.value ?? "")).join("")
          : String(statement?.text ?? statement);
        executed.push(text);
      },
    };

    await acquireWorkspaceLock(mockTx, "ws-test-1", 4500);

    assert.equal(executed.length, 3);
    assert.match(executed[0]!, /SET LOCAL lock_timeout = '4500ms'/);
    assert.match(executed[1]!, /pg_advisory_xact_lock/);
    assert.match(executed[2]!, /SET LOCAL lock_timeout = DEFAULT/);
  });

  it("reads and parses TASK_LOCK_TIMEOUT_MS from environment if timeout parameter omitted", async () => {
    const origEnv = process.env.TASK_LOCK_TIMEOUT_MS;
    try {
      process.env.TASK_LOCK_TIMEOUT_MS = "3000";
      const executed: string[] = [];
      const mockTx = {
        execute: async (statement: any) => {
          const text = statement?.queryChunks
            ? statement.queryChunks.map((c: any) => (typeof c === "string" ? c : c?.value ?? "")).join("")
            : String(statement?.text ?? statement);
          executed.push(text);
        },
      };

      await acquireWorkspaceLock(mockTx, "ws-test-2");

      assert.match(executed[0]!, /SET LOCAL lock_timeout = '3000ms'/);
      assert.match(executed[2]!, /SET LOCAL lock_timeout = DEFAULT/);
    } finally {
      if (origEnv === undefined) delete process.env.TASK_LOCK_TIMEOUT_MS;
      else process.env.TASK_LOCK_TIMEOUT_MS = origEnv;
    }
  });

  it("translates PostgreSQL 55P03 lock timeout to TaskLockTimeoutError", async () => {
    const mockTx = {
      execute: async (statement: any) => {
        const text = String(statement?.text ?? statement);
        if (text.includes("pg_advisory_xact_lock") || statement?.queryChunks) {
          const err: any = new Error("canceling statement due to lock timeout");
          err.code = "55P03";
          throw err;
        }
      },
    };

    await assert.rejects(
      () => acquireWorkspaceLock(mockTx, "ws-timeout-test", 1000),
      (err: any) => {
        assert.ok(err instanceof TaskLockTimeoutError);
        assert.match(err.message, /timed out waiting for workspace lock/);
        return true;
      },
    );
  });

  it("re-throws unexpected database errors unchanged", async () => {
    const mockTx = {
      execute: async (statement: any) => {
        const text = String(statement?.text ?? statement);
        if (text.includes("pg_advisory_xact_lock") || statement?.queryChunks) {
          throw new Error("connection terminated unexpectedly");
        }
      },
    };

    await assert.rejects(
      () => acquireWorkspaceLock(mockTx, "ws-err-test", 1000),
      (err: any) => {
        assert.equal(err instanceof TaskLockTimeoutError, false);
        assert.equal(err.message, "connection terminated unexpectedly");
        return true;
      },
    );
  });
});
