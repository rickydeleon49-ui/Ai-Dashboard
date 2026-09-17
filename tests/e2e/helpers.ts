/**
 * Boots a real production server against a throwaway database, then drives it
 * with Chromium.
 *
 * A production build rather than `next dev`: dev-mode compilation makes the
 * first hit on every route slow enough to look like a hang, and the goal is to
 * test what actually ships.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

import crypto from "node:crypto";

/*
 * Each test file runs in its own process, so a fixed port makes two files race
 * for it — the second to start fails, intermittently, in whichever file happens
 * to go second. Asking the OS for a free port removes the shared resource.
 */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

export let baseURL = "";

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let root = "";
let e2eSecret = "";

async function waitForServer(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseURL, {
        redirect: "manual",
        headers: { "x-dashboard-desktop-secret": e2eSecret },
      });
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

export async function start(): Promise<void> {
  root = mkdtempSync(path.join(tmpdir(), "cc-e2e-"));
  e2eSecret = crypto.randomBytes(32).toString("hex");

  const port = Number(process.env.E2E_PORT) || (await freePort());
  baseURL = `http://127.0.0.1:${port}`;

  /*
   * The Next binary is run directly rather than through `npx`.
   *
   * `npx` spawns the real server as a child of itself, so killing the handle
   * returned here left the server running. A leaked server keeps serving an
   * older build and then answers the next run, producing failures that look
   * like application bugs but are not. `detached` puts it in its own process
   * group so `stop()` can take the whole group down.
   */
  const nextBin = require.resolve("next/dist/bin/next");

  server = spawn(
    process.execPath,
    [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    {
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_PATH: path.join(root, "e2e.db"),
      UPLOADS_DIR: path.join(root, "uploads"),
      // Desktop launch secret authentication (Phase 2 hardening)
      DESKTOP_INTERNAL_SECRET: e2eSecret,
      DASHBOARD_LOCAL: "1",
      // Never let a developer's real token reach the test run.
      GITHUB_TOKEN: "",
      // Automations firing mid-run would change data underneath pages that
      // have already rendered, making failures depend on wall-clock timing.
      DASHBOARD_DISABLE_SCHEDULER: "1",
    },
    stdio: "ignore",
    },
  );

  await waitForServer();

  /*
   * The Playwright package and the browser on the machine can be different
   * builds, in which case Playwright looks for a revision directory that does
   * not exist and tells you to download browsers. PLAYWRIGHT_CHROMIUM_PATH (or
   * a chromium on PATH) points it at the one that is actually installed.
   */
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim() || undefined;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
}

export async function stop(): Promise<void> {
  await browser?.close();
  browser = null;

  // A negative pid signals the whole process group, so the server goes too.
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  server = null;

  if (root) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Ignore cleanup error if Windows process has not fully exited
    }
  }
}

export async function newPage(): Promise<Page> {
  if (!browser) throw new Error("start() must run first");
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      "x-dashboard-desktop-secret": e2eSecret,
    },
  });
  const page = await context.newPage();

  /*
   * Page errors are collected, not thrown.
   *
   * Throwing from this handler fires outside any test's call stack, so it
   * surfaces as an uncaughtException attributed to whichever hook happens to be
   * open — which reports the wrong test and can arrive after the run has moved
   * on. Tests read `pageErrors(page)` and assert on it instead.
   */
  const collected: string[] = [];
  errorsByPage.set(page, collected);
  page.on("pageerror", (error) => collected.push(error.message));

  return page;
}

const errorsByPage = new WeakMap<Page, string[]>();

/**
 * Runs a check in a brand-new browser context, then disposes of it.
 *
 * Some failures only appear on a cold cache: with chunks already cached the
 * page loads in a different order and the problem does not occur. Reusing one
 * page across a suite therefore hides them, so anything sensitive to a first
 * visit has to opt into a fresh context.
 */
export async function withFreshPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  if (!browser) throw new Error("start() must run first");
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const collected: string[] = [];
  errorsByPage.set(page, collected);
  page.on("pageerror", (error) => collected.push(error.message));

  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** Uncaught errors seen on this page so far. */
export function pageErrors(page: Page): string[] {
  return errorsByPage.get(page) ?? [];
}

export function clearPageErrors(page: Page): void {
  errorsByPage.get(page)?.splice(0);
}
