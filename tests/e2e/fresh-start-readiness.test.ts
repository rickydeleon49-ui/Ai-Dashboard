/**
 * Proves the fresh-start readiness fix at the HTTP level, against a real
 * `next start` production server and a completely untouched SQLite database
 * — the exact scenario a brand-new desktop or single-password install hits
 * on its very first request.
 *
 * This intentionally does NOT reuse `./helpers.ts`'s `start()`: that helper's
 * own `waitForServer()` retries every request below 500 for up to 90s, which
 * is correct for booting the rest of the e2e suite but would silently mask
 * exactly the bug this test exists to catch (see `tests/e2e/helpers.ts`'s
 * `waitForServer()` and the root-cause note in
 * `tests/unit/fresh-start-readiness.test.ts`). Everything below distinguishes
 * three states on purpose:
 *   1. not listening yet (raw TCP connect fails) — waited for below, but
 *      never by retrying an HTTP response;
 *   2. listening, but the first application request itself returned 500 —
 *      asserted against directly, with no retry, so this fails loudly rather
 *      than disappearing behind a wait loop;
 *   3. genuinely ready — the first request succeeds and renders real content.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let server: ChildProcess | null = null;
let root = "";
let baseURL = "";
let secret = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * State 1 only: waits for a raw TCP connection to succeed. Never issues an
 * HTTP request, so it cannot observe — and so can never mask — an
 * application-level 500 on whatever the first real request turns out to be.
 */
function waitForPortListening(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Server was not listening on port ${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), "cc-fresh-start-"));
  secret = crypto.randomBytes(32).toString("hex");
  const port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;

  // Never touched before — no earlier request, no earlier migration, no
  // earlier server run against this exact file.
  const databasePath = path.join(root, "never-opened.db");

  const nextBin = require.resolve("next/dist/bin/next");
  server = spawn(
    process.execPath,
    [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_PATH: databasePath,
        UPLOADS_DIR: path.join(root, "uploads"),
        DESKTOP_INTERNAL_SECRET: secret,
        DASHBOARD_LOCAL: "1",
        GITHUB_TOKEN: "",
        DASHBOARD_DISABLE_SCHEDULER: "1",
      },
      stdio: "ignore",
    },
  );
});

after(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server?.kill("SIGTERM");
    }
  }
  server = null;
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows may briefly retain the file handle.
    }
  }
});

describe("fresh-start readiness (real server, untouched database)", () => {
  it("state 1: refuses a connection before the process has started listening", async () => {
    const stillClosedPort = await freePort();
    await assert.rejects(
      () => waitForPortListening(stillClosedPort, 300),
      /was not listening/,
    );
  });

  it("state 3: the very first request to / succeeds, with no earlier request warming it up", async () => {
    const port = Number(new URL(baseURL).port);
    await waitForPortListening(port);

    // Exactly one request. No retry loop, no tolerance for a 500 — if the
    // fresh-start race regressed, this fails immediately with the real
    // status instead of quietly waiting for it to go away.
    const response = await fetch(`${baseURL}/`, {
      redirect: "manual",
      headers: { "x-dashboard-desktop-secret": secret },
    });

    assert.ok(
      response.status < 500,
      `state 2 detected: server is listening, but the first request to / returned ${response.status} — this is exactly the race the fresh-start readiness fix closes`,
    );
    assert.equal(response.status, 200);

    const body = await response.text();
    assert.match(body, /Command Center/);
    // A stale error digest page would not contain the dashboard's own chrome.
    assert.doesNotMatch(body, /Internal Server Error/i);
  });

  it("the required schema existed before that first repository query — a second, unrelated route also succeeds", async () => {
    // The dashboard page itself already queried projectRepository.stats()
    // during the request above; a distinct route exercising a different
    // repository confirms the whole schema is in place, not just the one
    // table the previous request happened to touch.
    const response = await fetch(`${baseURL}/api/projects`, {
      redirect: "manual",
      headers: { "x-dashboard-desktop-secret": secret },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { projects: unknown[] };
    assert.deepEqual(body.projects, []);
  });
});
