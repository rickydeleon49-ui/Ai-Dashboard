import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  startScheduler,
  stopScheduler,
  resetSchedulerForTesting,
  isSchedulerRunning,
} from "../../src/core/automation/scheduler";

describe("Automation Scheduler Lifecycle", () => {
  beforeEach(() => {
    resetSchedulerForTesting();
  });

  afterEach(() => {
    stopScheduler();
  });

  it("starts the scheduler and tracks running state", () => {
    assert.equal(isSchedulerRunning(), false);
    startScheduler();
    assert.equal(isSchedulerRunning(), true);
  });

  it("is idempotent when startScheduler is called multiple times", () => {
    startScheduler();
    assert.equal(isSchedulerRunning(), true);
    // Calling start again should be a no-op
    startScheduler();
    assert.equal(isSchedulerRunning(), true);
  });

  it("stops the scheduler cleanly and updates running state", () => {
    startScheduler();
    assert.equal(isSchedulerRunning(), true);
    stopScheduler();
    assert.equal(isSchedulerRunning(), false);
  });

  it("is idempotent on repeated stopScheduler calls", () => {
    startScheduler();
    stopScheduler();
    assert.equal(isSchedulerRunning(), false);
    // Repeated stops must not throw or alter state negatively
    stopScheduler();
    stopScheduler();
    assert.equal(isSchedulerRunning(), false);
  });

  it("resetSchedulerForTesting stops any running timers", () => {
    startScheduler();
    assert.equal(isSchedulerRunning(), true);
    resetSchedulerForTesting();
    assert.equal(isSchedulerRunning(), false);
  });

  it("prevents scheduler callbacks after shutdown", async () => {
    startScheduler();
    assert.equal(isSchedulerRunning(), true);

    // Stop before ticks occur
    stopScheduler();
    assert.equal(isSchedulerRunning(), false);

    // Verify state remains stopped and no uncaught exceptions or ticks happen
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isSchedulerRunning(), false);
  });
});
