import "server-only";

import { runDueAutomations } from "./service";

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

const globalForScheduler = globalThis as unknown as {
  __automationTimer?: ReturnType<typeof setInterval>;
};

export function startScheduler(): void {
  // Module reloading in development would otherwise stack timers.
  if (globalForScheduler.__automationTimer) return;

  const tick = () => {
    void runDueAutomations().catch((error) => {
      // One bad run must never stop the schedule; the failure is already
      // recorded on the automation row by the runner.
      console.error("[automation] tick failed:", error);
    });
  };

  setTimeout(tick, FIRST_TICK_MS);
  globalForScheduler.__automationTimer = setInterval(tick, TICK_MS);

  // Nothing should be kept alive purely by this timer.
  globalForScheduler.__automationTimer.unref?.();
}
