import "server-only";

import { runDueAutomations } from "./service";
import { isAccountsMode } from "@/lib/auth-mode";

/**
 * Drives automations while the application is running.
 *
 * A desktop app has no always-on server, so this is deliberately not cron. It
 * ticks while the app is open and, because due-ness is computed from
 * `lastRunAt` rather than a timer, whatever fell due while the app was closed
 * runs once shortly after it opens. For a dashboard you open regularly that is
 * the useful behaviour; it is not, and does not claim to be, background
 * execution.
 *
 * The first tick is delayed rather than immediate so that opening the app is
 * not competing with a GitHub sync for the first seconds of its life.
 */
const TICK_MS = 60_000;
const FIRST_TICK_MS = 15_000;

interface SchedulerState {
  initialTimeout: ReturnType<typeof setTimeout> | null;
  intervalTimer: ReturnType<typeof setInterval> | null;
  isRunning: boolean;
}

const globalForScheduler = globalThis as unknown as {
  __automationScheduler?: SchedulerState;
};

function getState(): SchedulerState {
  if (!globalForScheduler.__automationScheduler) {
    globalForScheduler.__automationScheduler = {
      initialTimeout: null,
      intervalTimer: null,
      isRunning: false,
    };
  }
  return globalForScheduler.__automationScheduler;
}

export function startScheduler(): void {
  /*
   * Do not run desktop-only SQLite schedulers or background work in accounts mode.
   * Also respect explicit DASHBOARD_DISABLE_SCHEDULER off switch.
   */
  if (isAccountsMode() || process.env.DASHBOARD_DISABLE_SCHEDULER === "1") return;

  const state = getState();
  // Module reloading in development or duplicate starts would otherwise stack timers.
  if (state.isRunning) return;

  state.isRunning = true;

  const tick = () => {
    // Prevent scheduler callbacks after shutdown
    if (!state.isRunning) return;
    void runDueAutomations().catch((error) => {
      if (!state.isRunning) return;
      // One bad run must never stop the schedule; the failure is already
      // recorded on the automation row by the runner.
      console.error("[automation] tick failed:", error);
    });
  };

  const initial = setTimeout(() => {
    state.initialTimeout = null;
    tick();
  }, FIRST_TICK_MS);
  initial.unref?.();
  state.initialTimeout = initial;

  const interval = setInterval(tick, TICK_MS);
  interval.unref?.();
  state.intervalTimer = interval;
}

/**
 * Idempotent stop operation for tests and orderly shutdown.
 * Clears both the initial delay timeout and the repeating interval,
 * and marks the scheduler as not running to reject any in-flight ticks.
 */
export function stopScheduler(): void {
  const state = getState();
  state.isRunning = false;

  if (state.initialTimeout) {
    clearTimeout(state.initialTimeout);
    state.initialTimeout = null;
  }
  if (state.intervalTimer) {
    clearInterval(state.intervalTimer);
    state.intervalTimer = null;
  }
}

/**
 * Idempotent reset for testing environments.
 */
export function resetSchedulerForTesting(): void {
  stopScheduler();
}

export function isSchedulerRunning(): boolean {
  return getState().isRunning;
}
