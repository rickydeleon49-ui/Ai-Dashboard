/**
 * AW5-02: operator sign-in for self-hosted mode (store, sessions, routes, proxy).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import React from "react";

if (
  typeof (React as { createContext?: unknown }).createContext !== "function"
) {
  (React as { createContext?: unknown }).createContext = () => ({
    Provider: ({ children }: { children: unknown }) => children,
    Consumer: ({ children }: { children: (val: unknown) => unknown }) =>
      children(null),
  });
}

import {
  clearOperatorCache,
  createOperatorRecord,
  readOperatorFile,
  resolveOperatorFile,
  validateNewPassword,
  verifyPassword,
  writeOperatorFile,
} from "../../src/core/selfhost/operator-store";
import {
  RECENT_SIGN_IN_MS,
  SESSION_LIFETIME_MS,
  clearOperatorCookieHeader,
  createOperatorSession,
  createRateLimiter,
  isRecentSignIn,
  operatorCookieHeader,
  safeNextPath,
  verifyOperatorSession,
} from "../../src/core/auth/operator";

const PASSWORD = "correct horse battery";
const env = process.env as Record<string, string | undefined>;
const TOUCHED = [
  "AGENT_HOST_MODE",
  "AUTH_MODE",
  "DATABASE_URL",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_LOCAL",
  "DESKTOP_INTERNAL_SECRET",
  "OPERATOR_FILE",
  "DATABASE_PATH",
  "NODE_ENV",
] as const;
const original = Object.fromEntries(TOUCHED.map((k) => [k, env[k]]));

let dir: string;
let file: string;
let key: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw5-02-"));
  file = path.join(dir, "operator.json");
  const record = await createOperatorRecord(PASSWORD);
  writeOperatorFile(file, record);
  key = record.sessionKey;
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of TOUCHED) delete env[k];
  env.AGENT_HOST_MODE = "self-hosted";
  env.OPERATOR_FILE = file;
  env.NODE_ENV = "production";
  clearOperatorCache();
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (original[k] === undefined) delete env[k];
    else env[k] = original[k];
  }
  clearOperatorCache();
});

describe("operator store", () => {
  it("round-trips and verifies the password", async () => {
    const record = readOperatorFile(file);
    assert.ok(record);
    assert.equal(record.version, 1);
    assert.match(record.passwordHash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(Buffer.from(record.sessionKey, "base64").length, 32);
    assert.equal(await verifyPassword(PASSWORD, record.passwordHash), true);
  });

  it("rejects a wrong password, empty input and a malformed hash", async () => {
    const record = readOperatorFile(file)!;
    assert.equal(
      await verifyPassword("wrong password!!", record.passwordHash),
      false,
    );
    assert.equal(await verifyPassword("", record.passwordHash), false);
    assert.equal(await verifyPassword(PASSWORD, "scrypt$1$1$1$AA$AA"), false);
    assert.equal(await verifyPassword(PASSWORD, "garbage"), false);
    assert.equal(
      await verifyPassword(
        PASSWORD,
        record.passwordHash.replace("$32768$", "$1073741824$"),
      ),
      false,
    );
  });

  it("uses a fresh random salt each time", async () => {
    const a = await createOperatorRecord(PASSWORD);
    const b = await createOperatorRecord(PASSWORD);
    assert.notEqual(a.passwordHash, b.passwordHash);
    assert.notEqual(a.sessionKey, b.sessionKey);
  });

  it("enforces the minimum password length", () => {
    assert.match(validateNewPassword("short") ?? "", /at least 12/);
    assert.equal(validateNewPassword("exactly12chr"), null);
  });

  it("writes mode 0600 on POSIX and leaves no temp files", () => {
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
    );
  });

  it("treats missing, empty and malformed files as not configured", () => {
    const bad = path.join(dir, "bad.json");
    assert.equal(readOperatorFile(path.join(dir, "missing.json")), null);
    const good = readOperatorFile(file)!;
    const cases: unknown[] = [
      "",
      "not json",
      "[]",
      {},
      { ...good, version: 2 },
      { ...good, passwordHash: "x" },
      { ...good, sessionKey: "AAAA" },
      { ...good, sessionKey: 5 },
    ];
    for (const c of cases) {
      fs.writeFileSync(bad, typeof c === "string" ? c : JSON.stringify(c));
      clearOperatorCache();
      assert.equal(readOperatorFile(bad), null, JSON.stringify(c));
    }
    fs.rmSync(bad);
  });

  it("picks up a rewritten file", async () => {
    const other = path.join(dir, "other.json");
    const first = await createOperatorRecord(PASSWORD);
    writeOperatorFile(other, first);
    assert.equal(readOperatorFile(other)?.sessionKey, first.sessionKey);
    const second = await createOperatorRecord(PASSWORD);
    writeOperatorFile(other, second);
    assert.equal(readOperatorFile(other)?.sessionKey, second.sessionKey);
  });

  it("defaults to operator.json next to the database", () => {
    delete env.OPERATOR_FILE;
    env.DATABASE_PATH = path.join(dir, "db", "dashboard.db");
    assert.equal(resolveOperatorFile(), path.join(dir, "db", "operator.json"));
    env.OPERATOR_FILE = file;
    assert.equal(resolveOperatorFile(), path.resolve(file));
  });
});

describe("operator sessions", () => {
  const T0 = 1_800_000_000_000;

  it("verifies a fresh cookie", async () => {
    const made = await createOperatorSession(T0, key);
    assert.ok(made);
    const session = await verifyOperatorSession(made.value, T0 + 1000, key);
    assert.deepEqual(session, made.session);
    assert.equal(session?.exp, T0 + SESSION_LIFETIME_MS);
  });

  it("expires after 12 hours", async () => {
    const made = (await createOperatorSession(T0, key))!;
    assert.ok(
      await verifyOperatorSession(
        made.value,
        T0 + SESSION_LIFETIME_MS - 1,
        key,
      ),
    );
    assert.equal(
      await verifyOperatorSession(made.value, T0 + SESSION_LIFETIME_MS, key),
      null,
    );
  });

  it("rejects tampered payloads and signatures", async () => {
    const made = (await createOperatorSession(T0, key))!;
    const [payload, mac] = made.value.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...made.session, exp: T0 + 10 * SESSION_LIFETIME_MS }),
    ).toString("base64url");
    const flipped = `${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
    for (const bad of [
      `${forged}.${mac}`,
      `${payload}.${flipped}`,
      `${payload}.`,
      `.${mac}`,
      payload,
      `${payload}.${mac}.x`,
      "",
      "a.b",
      `${payload}.${mac}`.toUpperCase(),
    ]) {
      assert.equal(
        await verifyOperatorSession(bad, T0 + 1000, key),
        null,
        bad.slice(0, 30),
      );
    }
    assert.equal(await verifyOperatorSession(undefined, T0, key), null);
    assert.equal(await verifyOperatorSession("x".repeat(5000), T0, key), null);
  });

  it("rejects a cookie signed with a rotated key", async () => {
    const made = (await createOperatorSession(T0, key))!;
    const rotated = (await createOperatorRecord(PASSWORD)).sessionKey;
    assert.equal(
      await verifyOperatorSession(made.value, T0 + 1, rotated),
      null,
    );
    assert.ok(await verifyOperatorSession(made.value, T0 + 1, key));
  });

  it("rotating the password in the file invalidates old cookies", async () => {
    const made = (await createOperatorSession(T0, key))!;
    assert.ok(await verifyOperatorSession(made.value, T0 + 1));
    writeOperatorFile(file, await createOperatorRecord(PASSWORD));
    assert.equal(await verifyOperatorSession(made.value, T0 + 1), null);
    // restore the shared fixture
    const record = await createOperatorRecord(PASSWORD);
    writeOperatorFile(file, record);
    key = record.sessionKey;
  });

  it("fails closed with no key", async () => {
    assert.equal(await createOperatorSession(T0, null), null);
    const made = (await createOperatorSession(T0, key))!;
    assert.equal(await verifyOperatorSession(made.value, T0, null), null);
    assert.equal(await verifyOperatorSession(made.value, T0, "bad-key"), null);
  });

  it("rejects structurally valid but oversized lifetimes", async () => {
    const keyBytes = Buffer.from(key, "base64");
    const { createHmac } = await import("node:crypto");
    const body = Buffer.from(
      JSON.stringify({
        sid: "x",
        iat: T0,
        authAt: T0,
        exp: T0 + 2 * SESSION_LIFETIME_MS,
      }),
    ).toString("base64url");
    const mac = createHmac("sha256", keyBytes).update(body).digest("base64url");
    assert.equal(
      await verifyOperatorSession(`${body}.${mac}`, T0 + 1, key),
      null,
    );
  });

  it("recent sign-in window is 5 minutes", async () => {
    const made = (await createOperatorSession(T0, key))!;
    assert.equal(isRecentSignIn(made.session, T0 + RECENT_SIGN_IN_MS), true);
    assert.equal(
      isRecentSignIn(made.session, T0 + RECENT_SIGN_IN_MS + 1),
      false,
    );
    assert.equal(isRecentSignIn(null, T0), false);
    assert.equal(
      isRecentSignIn({ ...made.session, authAt: T0 + 3_600_000 }, T0),
      false,
    );
  });

  it("cookie attributes are HttpOnly, Secure, SameSite=Strict, Path=/", () => {
    const header = operatorCookieHeader("v", 100);
    for (const part of [
      "cc_operator=v",
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Max-Age=100",
    ]) {
      assert.ok(header.includes(part), part);
    }
    assert.match(clearOperatorCookieHeader(), /Max-Age=0/);
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin relative paths", () => {
    assert.equal(safeNextPath("/agents/runs?x=1"), "/agents/runs?x=1");
    assert.equal(safeNextPath("/"), "/");
  });
  it("rejects everything else", () => {
    for (const bad of [
      "//evil.example",
      "https://evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil",
      "",
      null,
      undefined,
      "/a\nb",
      "/login",
      "/api/operator/login",
    ]) {
      const out = safeNextPath(bad as string);
      assert.equal(out, "/", String(bad));
    }
    assert.equal(safeNextPath("/%2F%2Fevil"), "/%2F%2Fevil"); // stays a path on this origin
  });
});

describe("rate limiter", () => {
  it("limits after max failures within the window and recovers", () => {
    const rl = createRateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.isLimited("ip", 1000 + i), false);
      rl.recordFailure("ip", 1000 + i);
    }
    assert.equal(rl.isLimited("ip", 2000), true);
    assert.equal(rl.isLimited("other", 2000), false);
    assert.equal(rl.isLimited("ip", 61_005), false);
    rl.recordFailure("ip", 62_000);
    rl.reset("ip");
    assert.equal(rl.isLimited("ip", 62_001), false);
  });
});

type Mods = {
  routes: typeof import("../../src/core/auth/operator-routes");
  proxy: typeof import("../../src/proxy");
  next: typeof import("next/server");
};
let mods: Mods;

before(async () => {
  mods = {
    routes: await import("../../src/core/auth/operator-routes"),
    proxy: await import("../../src/proxy"),
    next: await import("next/server"),
  };
});

function req(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): InstanceType<Mods["next"]["NextRequest"]> {
  return new mods.next.NextRequest(url, {
    method,
    headers: { host: "localhost:3000", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const stub = {} as Parameters<Mods["proxy"]["proxy"]>[1];
const run = (r: ReturnType<typeof req>) =>
  mods.proxy.proxy(r, stub) as Promise<Response>;
const ORIGIN = "http://localhost:3000";

async function cookieFor(now = Date.now()): Promise<string> {
  const made = (await createOperatorSession(
    now,
    readOperatorFile(file)!.sessionKey,
  ))!;
  return `cc_operator=${made.value}`;
}

describe("proxy (self-hosted)", () => {
  it("redirects an unauthenticated page request to /login with next", async () => {
    const res = await run(req("GET", `${ORIGIN}/agents/runs?tab=1`));
    assert.equal(res.status, 307);
    const loc = new URL(res.headers.get("location")!);
    assert.equal(loc.pathname, "/login");
    assert.equal(loc.searchParams.get("next"), "/agents/runs?tab=1");
  });

  it("returns 401 JSON for API routes and the event stream", async () => {
    for (const url of [
      `${ORIGIN}/api/projects`,
      `${ORIGIN}/api/agent-runs/abc/events`,
    ]) {
      const res = await run(req("GET", url));
      assert.equal(res.status, 401, url);
      assert.deepEqual(await res.json(), { error: "sign_in_required" });
    }
    const post = await run(req("POST", `${ORIGIN}/api/projects`));
    assert.equal(post.status, 401);
  });

  it("rejects tampered, expired and garbage cookies", async () => {
    const good = await cookieFor();
    const tampered = `${good.slice(0, -3)}AAA`;
    const expired = await cookieFor(Date.now() - SESSION_LIFETIME_MS - 1000);
    for (const c of [tampered, expired, "cc_operator=junk", "other=1"]) {
      const res = await run(
        req("GET", `${ORIGIN}/api/projects`, { cookie: c }),
      );
      assert.equal(res.status, 401, c.slice(0, 25));
    }
  });

  it("lets a valid session through to pages, API and the event stream", async () => {
    const cookie = await cookieFor();
    for (const url of [
      `${ORIGIN}/`,
      `${ORIGIN}/api/projects`,
      `${ORIGIN}/api/agent-runs/abc/events`,
    ]) {
      const res = await run(req("GET", url, { cookie }));
      assert.equal(res.status, 200, url);
      assert.equal(res.headers.get("x-middleware-next"), "1");
    }
  });

  it("keeps the login page and login call open, nothing else", async () => {
    assert.equal(
      (await run(req("GET", `${ORIGIN}/login`))).headers.get(
        "x-middleware-next",
      ),
      "1",
    );
    assert.equal(
      (
        await run(
          req("POST", `${ORIGIN}/api/operator/login`, {}, { password: "x" }),
        )
      ).headers.get("x-middleware-next"),
      "1",
    );
    // Not open: other methods/paths, logout without a session.
    assert.equal((await run(req("POST", `${ORIGIN}/login`))).status, 307);
    assert.equal(
      (await run(req("GET", `${ORIGIN}/api/operator/login`))).status,
      401,
    );
    assert.equal(
      (await run(req("POST", `${ORIGIN}/api/operator/logout`))).status,
      401,
    );
    assert.equal((await run(req("GET", `${ORIGIN}/login/extra`))).status, 307);
    assert.equal(
      (await run(req("GET", `${ORIGIN}/api/operator/loginx`))).status,
      401,
    );
  });

  it("returns 503 everywhere, including /login, when not configured", async () => {
    env.OPERATOR_FILE = path.join(dir, "absent.json");
    for (const [m, u] of [
      ["GET", `${ORIGIN}/login`],
      ["POST", `${ORIGIN}/api/operator/login`],
      ["GET", `${ORIGIN}/api/projects`],
      ["GET", `${ORIGIN}/`],
    ] as const) {
      const res = await run(
        req(m, u, {}, m === "POST" ? { password: PASSWORD } : undefined),
      );
      assert.equal(res.status, 503, u);
    }
    const page = await run(req("GET", `${ORIGIN}/`));
    assert.match(await page.text(), /npm run operator:password/);
  });

  it("keeps the cross-site check on mutating requests", async () => {
    const cookie = await cookieFor();
    const res = await run(
      req("POST", `${ORIGIN}/api/projects`, {
        cookie,
        "sec-fetch-site": "cross-site",
      }),
    );
    assert.equal(res.status, 403);
    const login = await run(
      req(
        "POST",
        `${ORIGIN}/api/operator/login`,
        { origin: "https://evil.example" },
        { password: PASSWORD },
      ),
    );
    assert.equal(login.status, 403);
  });

  it("a malformed operator file is treated as not configured", async () => {
    const bad = path.join(dir, "malformed.json");
    fs.writeFileSync(bad, "{ nope");
    env.OPERATOR_FILE = bad;
    assert.equal((await run(req("GET", `${ORIGIN}/api/projects`))).status, 503);
  });
});

describe("requireRecentSignIn", () => {
  it("passes within five minutes, demands re-auth after", async () => {
    const now = Date.now();
    const cookie = await cookieFor(now - 60_000);
    const ok = await mods.routes.requireRecentSignIn(
      req("POST", `${ORIGIN}/x`, { cookie }),
      now,
    );
    assert.equal(ok, null);

    const old = await cookieFor(now - RECENT_SIGN_IN_MS - 1000);
    const res = await mods.routes.requireRecentSignIn(
      req("POST", `${ORIGIN}/x`, { cookie: old }),
      now,
    );
    assert.equal(res?.status, 401);
    assert.deepEqual(await res!.json(), { error: "reauth_required" });
  });

  it("refuses with no cookie, and outside self-hosted mode", async () => {
    const none = await mods.routes.requireRecentSignIn(
      req("POST", `${ORIGIN}/x`),
    );
    assert.equal(none?.status, 401);
    const cookie = await cookieFor();
    delete env.AGENT_HOST_MODE;
    const off = await mods.routes.requireRecentSignIn(
      req("POST", `${ORIGIN}/x`, { cookie }),
    );
    assert.equal(off?.status, 401);
  });
});

describe("login and logout routes", () => {
  const login = (
    password: unknown,
    headers: Record<string, string> = {},
    extra: object = {},
  ) =>
    mods.routes.handleOperatorLogin(
      req("POST", `${ORIGIN}/api/operator/login`, headers, {
        password,
        ...extra,
      }),
    );

  beforeEach(() => mods.routes.resetLoginLimits());

  it("signs in with the right password and sets a hardened cookie", async () => {
    const res = await login(PASSWORD, {}, { next: "/agents" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, next: "/agents" });
    const set = res.headers.get("set-cookie") ?? "";
    for (const part of [
      "cc_operator=",
      "HttpOnly",
      "Secure",
      "SameSite=strict",
      "Path=/",
    ]) {
      assert.ok(set.toLowerCase().includes(part.toLowerCase()), part);
    }
    const value = /cc_operator=([^;]+)/.exec(set)![1]!;
    const session = await verifyOperatorSession(decodeURIComponent(value));
    assert.ok(session);
    assert.equal(isRecentSignIn(session), true);
  });

  it("refuses an open-redirect next", async () => {
    const res = await login(PASSWORD, {}, { next: "//evil.example" });
    assert.equal((await res.json()).next, "/");
  });

  it("gives a generic 401 and no cookie for a wrong password or bad body", async () => {
    for (const pw of ["wrong password!!", "", 5, null, undefined]) {
      const res = await login(pw);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "invalid_credentials" });
      assert.equal(res.headers.get("set-cookie"), null);
    }
    mods.routes.resetLoginLimits();
    const bad = await mods.routes.handleOperatorLogin(
      new mods.next.NextRequest(`${ORIGIN}/api/operator/login`, {
        method: "POST",
        body: "not json",
      }),
    );
    assert.equal(bad.status, 400);
  });

  it("limits to 5 failures per client per minute, even for the right password", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const res = await mods.routes.handleOperatorLogin(
        req("POST", `${ORIGIN}/api/operator/login`, headers, {
          password: "wrong password!!",
        }),
        now + i,
      );
      assert.equal(res.status, 401);
    }
    const blocked = await mods.routes.handleOperatorLogin(
      req("POST", `${ORIGIN}/api/operator/login`, headers, {
        password: PASSWORD,
      }),
      now + 10,
    );
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("set-cookie"), null);
    assert.ok(blocked.headers.get("retry-after"));
    // A different client is unaffected.
    const other = await login(PASSWORD, { "x-forwarded-for": "198.51.100.2" });
    assert.equal(other.status, 200);
    // And the window passes.
    const later = await mods.routes.handleOperatorLogin(
      req("POST", `${ORIGIN}/api/operator/login`, headers, {
        password: PASSWORD,
      }),
      now + 61_000,
    );
    assert.equal(later.status, 200);
  });

  it("a rotating spoofed client address still hits the global limit", async () => {
    const now = Date.now();
    let blocked = 0;
    for (let i = 0; i < 25; i++) {
      const res = await mods.routes.handleOperatorLogin(
        req(
          "POST",
          `${ORIGIN}/api/operator/login`,
          { "x-forwarded-for": `10.9.9.${i}` },
          { password: "wrong password!!" },
        ),
        now + i,
      );
      if (res.status === 429) blocked++;
    }
    assert.ok(blocked >= 5);
  });

  it("answers 503 when unconfigured and 404 outside self-hosted mode", async () => {
    env.OPERATOR_FILE = path.join(dir, "absent.json");
    assert.equal((await login(PASSWORD)).status, 503);
    env.OPERATOR_FILE = file;
    delete env.AGENT_HOST_MODE;
    assert.equal((await login(PASSWORD)).status, 404);
    assert.equal(mods.routes.handleOperatorLogout().status, 404);
  });

  it("logout clears the cookie", () => {
    const res = mods.routes.handleOperatorLogout();
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get("set-cookie") ?? "",
      /cc_operator=;.*Max-Age=0/,
    );
  });
});

describe("login page", () => {
  it("renders sign-in wording, and 'sign in again' for reauth", async () => {
    const plain = await (
      await import("../../src/app/login/route")
    ).GET(req("GET", `${ORIGIN}/login`) as never);
    const again = await (
      await import("../../src/app/login/route")
    ).GET(req("GET", `${ORIGIN}/login?reauth=1&next=/agents`) as never);
    assert.match(await plain.text(), /Sign in/);
    const html = await again.text();
    assert.match(html, /Sign in again/);
    assert.match(html, /var NEXT = "\/agents"/);
  });

  it("neutralises a hostile next and 404s outside self-hosted mode", async () => {
    const { GET } = await import("../../src/app/login/route");
    const html = await (
      await GET(req("GET", `${ORIGIN}/login?next=//evil.example`) as never)
    ).text();
    assert.match(html, /var NEXT = "\/";/);
    delete env.AGENT_HOST_MODE;
    assert.equal(
      (await GET(req("GET", `${ORIGIN}/login`) as never)).status,
      404,
    );
  });
});
