/**
 * AW.5 self-hosted mode, end to end: the built server (`next start`) with
 * AGENT_HOST_MODE=self-hosted on a throwaway database and operator file.
 *
 * 1. Forbidden environment combinations refuse to start (no browser).
 * 2. No operator file: every page is the "not set up" 503.
 * 3. Not signed in: pages redirect to /login, the API and event stream answer 401.
 * 4. Wrong password 401, then the rate limit 429.
 * 5. Phone-width browser sign-in lands on /agents without horizontal scroll.
 * 6. A 6-minute-old sign-in cannot decide an approval; a fresh one can.
 *
 * Uses its own server lifecycle rather than helpers.ts, which boots the
 * desktop-secret server.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright";
import {
  createOperatorRecord,
  writeOperatorFile,
} from "../../src/core/selfhost/operator-store";
import {
  OPERATOR_COOKIE,
  createOperatorSession,
} from "../../src/core/auth/operator";

const PASSWORD = "e2e correct horse battery";
const nextBin = require.resolve("next/dist/bin/next");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() =>
        port ? resolve(port) : reject(new Error("no free port")),
      );
    });
  });
}

/** Environment with every variable the mode forbids stripped out, then overrides applied. */
function baseEnv(
  dir: string,
  extra: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_")) delete env[key];
  }
  for (const key of [
    "AUTH_MODE",
    "DASHBOARD_PASSWORD",
    "DATABASE_URL",
    "DASHBOARD_LOCAL",
    "DESKTOP_INTERNAL_SECRET",
    "AGENT_HOST_ALLOW_LAN",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: "production",
    AGENT_HOST_MODE: "self-hosted",
    HOSTNAME: "127.0.0.1",
    DATABASE_PATH: path.join(dir, "selfhost.db"),
    UPLOADS_DIR: path.join(dir, "uploads"),
    OPERATOR_FILE: path.join(dir, "operator.json"),
    GITHUB_TOKEN: "",
    DASHBOARD_DISABLE_SCHEDULER: "1",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

type Server = { baseURL: string; child: ChildProcess; stop: () => void };

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function startServer(
  dir: string,
  extra: Record<string, string | undefined> = {},
): Promise<Server> {
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    { detached: true, env: baseEnv(dir, extra), stdio: "ignore" },
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) {
      killTree(child);
      throw new Error("self-hosted server did not start in time");
    }
    try {
      const res = await fetch(`${baseURL}/login`, { redirect: "manual" });
      if (res.status < 500 || res.status === 503) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { baseURL, child, stop: () => killTree(child) };
}

function cleanDir(dir: string): void {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch {
    // Windows may still hold the file for a moment.
  }
}

describe("forbidden configurations refuse to start", () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["AUTH_MODE=accounts", { AUTH_MODE: "accounts" }],
    ["DASHBOARD_PASSWORD", { DASHBOARD_PASSWORD: "some-long-password" }],
    ["DATABASE_URL", { DATABASE_URL: "postgres://user:pw@127.0.0.1:1/db" }],
    ["RAILWAY_ENVIRONMENT", { RAILWAY_ENVIRONMENT: "production" }],
    ["DASHBOARD_LOCAL=1", { DASHBOARD_LOCAL: "1" }],
    ["HOSTNAME=0.0.0.0", { HOSTNAME: "0.0.0.0" }],
    ["HOSTNAME=8.8.8.8", { HOSTNAME: "8.8.8.8" }],
    ["missing HOSTNAME", { HOSTNAME: undefined }],
  ];

  for (const [name, extra] of cases) {
    it(`${name}: exits non-zero with Invalid startup configuration`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "cc-selfhost-bad-"));
      try {
        const port = await freePort();
        // The real bind is always loopback; HOSTNAME in the environment is what is validated.
        const child = spawn(
          process.execPath,
          [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"],
          {
            detached: true,
            env: baseEnv(dir, extra),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout?.on("data", (d) => (output += String(d)));
        child.stderr?.on("data", (d) => (output += String(d)));
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            killTree(child);
            resolve(null);
          }, 60_000);
          child.on("exit", (c) => {
            clearTimeout(timer);
            resolve(c);
          });
        });
        assert.notEqual(code, null, `server kept running.\n${output}`);
        assert.notEqual(code, 0, output);
        assert.match(output, /Invalid startup configuration/);
      } finally {
        cleanDir(dir);
      }
    });
  }
});

describe("self-hosted without an operator file", () => {
  let dir = "";
  let server: Server;
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cc-selfhost-nofile-"));
    server = await startServer(dir);
  });
  after(() => {
    server?.stop();
    cleanDir(dir);
  });

  it("every page is the not-set-up 503", async () => {
    for (const p of ["/", "/agents", "/login"]) {
      const res = await fetch(`${server.baseURL}${p}`, { redirect: "manual" });
      assert.equal(res.status, 503, p);
      assert.match(await res.text(), /Operator sign-in is not set up/, p);
    }
  });
});

describe("self-hosted with an operator password", () => {
  let dir = "";
  let sessionKey = "";
  let server: Server;
  let browser: Browser | null = null;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cc-selfhost-"));
    // The store's own write function, not the TTY CLI.
    const record = await createOperatorRecord(PASSWORD);
    writeOperatorFile(path.join(dir, "operator.json"), record);
    sessionKey = record.sessionKey;
    server = await startServer(dir);
  });
  after(async () => {
    await browser?.close();
    server?.stop();
    cleanDir(dir);
  });

  const login = (password: string, ip?: string) =>
    fetch(`${server.baseURL}/api/operator/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ip ? { "X-Forwarded-For": ip } : {}),
      },
      body: JSON.stringify({ password }),
    });

  it("not signed in: pages redirect, API and event stream answer 401", async () => {
    const page = await fetch(`${server.baseURL}/agents`, {
      redirect: "manual",
    });
    assert.ok([302, 307, 308].includes(page.status), `status ${page.status}`);
    const location = new URL(
      page.headers.get("location") ?? "",
      server.baseURL,
    );
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), "/agents");
    for (const p of ["/api/agent-runs", "/api/agent-runs/run_nope/events"]) {
      const res = await fetch(`${server.baseURL}${p}`, { redirect: "manual" });
      assert.equal(res.status, 401, p);
      assert.deepEqual(await res.json(), { error: "sign_in_required" }, p);
    }
  });

  it("wrong password is 401, then the fifth failure locks out with 429", async () => {
    const ip = "10.9.9.9";
    for (let i = 0; i < 5; i++) {
      const res = await login("definitely the wrong one", ip);
      assert.equal(res.status, 401, `attempt ${i + 1}`);
    }
    assert.equal((await login("definitely the wrong one", ip)).status, 429);
    // Even the right password is refused while locked out.
    assert.equal((await login(PASSWORD, ip)).status, 429);
  });

  it("phone width: sign in, land on /agents, no horizontal scroll", async () => {
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim() || undefined;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    const context = await browser.newContext({
      baseURL: server.baseURL,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto("/login?next=%2Fagents");
    await page.fill("#pw", PASSWORD);
    await page.click("#go");
    await page.waitForLoadState("load");
    await page.waitForTimeout(500);

    /*
     * The cookie is Secure but the test talks plain http://127.0.0.1. Chromium
     * normally accepts it for loopback; if this build drops it, the cookie is
     * taken from a direct login call and injected into the context instead.
     */
    const hasCookie = (await context.cookies()).some(
      (c) => c.name === OPERATOR_COOKIE,
    );
    if (!hasCookie || new URL(page.url()).pathname === "/login") {
      const res = await login(PASSWORD, "10.9.9.10");
      assert.equal(res.status, 200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      const value = new RegExp(`${OPERATOR_COOKIE}=([^;]+)`).exec(
        setCookie,
      )?.[1];
      assert.ok(value, "login response set the operator cookie");
      await context.addCookies([
        { name: OPERATOR_COOKIE, value, url: server.baseURL, httpOnly: true },
      ]);
      await page.goto("/agents");
    }
    await page.waitForURL(/\/agents/);
    assert.equal(new URL(page.url()).pathname, "/agents");
    await page.waitForLoadState("networkidle");
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    assert.ok(width <= 390, `page is ${width}px wide at a 390px viewport`);
    await context.close();
  });

  it("stale sign-in cannot decide an approval; a fresh one can", async () => {
    const dbFile = path.join(dir, "selfhost.db");
    const seed = new Database(dbFile);
    try {
      seed
        .prepare("INSERT INTO projects (id, name, local_path) VALUES (?, ?, ?)")
        .run("prj_selfhost", "Selfhost e2e", dir);
      seed
        .prepare(
          "INSERT INTO agent_run (id, project_id, status, stage, request, outcome, ended_at) VALUES (?, ?, 'succeeded', 'final', '{}', '{}', datetime('now'))",
        )
        .run("run_selfhost", "prj_selfhost");
      for (const id of ["appr_stale", "appr_fresh"]) {
        seed
          .prepare(
            "INSERT INTO agent_run_approval (id, run_id, kind, status, target) VALUES (?, 'run_selfhost', 'push', 'pending', '{}')",
          )
          .run(id);
      }
    } finally {
      seed.close();
    }
    const statusOf = (id: string): string => {
      const d = new Database(dbFile, { readonly: true });
      try {
        return (
          d
            .prepare("SELECT status FROM agent_run_approval WHERE id = ?")
            .get(id) as {
            status: string;
          }
        ).status;
      } finally {
        d.close();
      }
    };
    const decide = (id: string, cookie: string) =>
      fetch(`${server.baseURL}/api/agent-runs/run_selfhost/approvals/${id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${OPERATOR_COOKIE}=${cookie}`,
        },
        body: JSON.stringify({ decision: "approve" }),
      });

    // Signed with the operator's own key, as if the password was entered 6 minutes ago.
    const stale = await createOperatorSession(
      Date.now() - 6 * 60_000,
      sessionKey,
    );
    assert.ok(stale);
    const denied = await decide("appr_stale", stale.value);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "reauth_required" });
    assert.equal(statusOf("appr_stale"), "pending");

    const fresh = await createOperatorSession(Date.now(), sessionKey);
    assert.ok(fresh);
    const accepted = await decide("appr_fresh", fresh.value);
    assert.equal(accepted.status, 202, await accepted.text());
    assert.equal(statusOf("appr_fresh"), "approved");
    assert.equal(statusOf("appr_stale"), "pending");
  });
});
