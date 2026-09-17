/**
 * Hosted-mode, desktop-mode, and accounts-mode proxy access control.
 *
 * Requirements verified:
 * - Hosted mode requires password; fails closed without it.
 * - Desktop mode requires cryptographically random launch secret (DESKTOP_INTERNAL_SECRET).
 * - Requests without the secret or with invalid secret are rejected (401).
 * - DASHBOARD_LOCAL=1 alone does not bypass authentication.
 * - Leaked/forwarded non-loopback headers are rejected.
 * - Accounts mode and password mode take strict precedence over local variables/secrets.
 * - CSRF protections on mutating requests.
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import React from "react";

if (typeof (React as { createContext?: unknown }).createContext !== "function") {
  (React as { createContext?: unknown }).createContext = () => ({
    Provider: ({ children }: { children: unknown }) => children,
    Consumer: ({ children }: { children: (val: unknown) => unknown }) => children(null),
  });
}

type ProxyModule = typeof import("../../src/proxy");
let proxyModule: ProxyModule;
let NextRequest: typeof import("next/server").NextRequest;

const PASSWORD = "correct-horse-battery-staple";
const DESKTOP_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

before(async () => {
  proxyModule = await import("../../src/proxy");
  ({ NextRequest } = await import("next/server"));
});

const TOUCHED = [
  "DASHBOARD_LOCAL",
  "DASHBOARD_PASSWORD",
  "DESKTOP_INTERNAL_SECRET",
  "AUTH_MODE",
  "DATABASE_URL",
  "NODE_ENV",
] as const;

const original = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  for (const key of TOUCHED) {
    if (original[key] === undefined) delete env[key];
    else env[key] = original[key];
  }
});

function hosted(password: string | null = PASSWORD): void {
  delete env.DASHBOARD_LOCAL;
  delete env.DESKTOP_INTERNAL_SECRET;
  delete env.AUTH_MODE;
  delete env.DATABASE_URL;
  env.NODE_ENV = "production";
  if (password === null) delete env.DASHBOARD_PASSWORD;
  else env.DASHBOARD_PASSWORD = password;
}

function desktop(secret: string | null = DESKTOP_SECRET): void {
  delete env.DASHBOARD_PASSWORD;
  delete env.AUTH_MODE;
  delete env.DATABASE_URL;
  env.NODE_ENV = "production";
  env.DASHBOARD_LOCAL = "1";
  if (secret === null) delete env.DESKTOP_INTERNAL_SECRET;
  else env.DESKTOP_INTERNAL_SECRET = secret;
}

function request(
  method: string,
  url = "http://localhost:3000/api/projects",
  headers: Record<string, string> = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest(url, {
    method,
    headers: { host: "localhost:3000", ...headers },
  });
}

async function call(
  method: string,
  headers: Record<string, string> = {},
  url = "http://localhost:3000/api/projects",
): Promise<Response> {
  const stubEvent = {} as Parameters<ProxyModule["proxy"]>[1];
  return proxyModule.proxy(request(method, url, headers), stubEvent) as Promise<Response>;
}

const auth = { authorization: `Basic ${btoa(`user:${PASSWORD}`)}` };
const desktopHeader = { "x-dashboard-desktop-secret": DESKTOP_SECRET };

describe("hosted mode authentication", () => {
  it("refuses to serve at all when no password is configured", async () => {
    hosted(null);
    assert.equal((await call("GET")).status, 503);
  });

  it("challenges an unauthenticated request", async () => {
    hosted();
    const response = await call("GET");
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Basic/);
  });

  it("rejects a wrong password", async () => {
    hosted();
    const wrong = { authorization: `Basic ${btoa("user:nope")}` };
    assert.equal((await call("GET", wrong)).status, 401);
  });

  it("allows a correct password", async () => {
    hosted();
    assert.notEqual((await call("GET", auth)).status, 401);
  });
});

describe("desktop mode cryptographic launch secret authentication", () => {
  it("allows requests with the valid launch secret", async () => {
    desktop();
    const response = await call("GET", desktopHeader);
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 503);
  });

  it("rejects requests missing the desktop secret with 401", async () => {
    desktop();
    const response = await call("GET");
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Unauthorized.");
  });

  it("rejects requests with an invalid desktop secret with 401", async () => {
    desktop();
    const invalidHeader = { "x-dashboard-desktop-secret": "wrong-secret-value-00000000000000" };
    const response = await call("GET", invalidHeader);
    assert.equal(response.status, 401);
  });

  it("rejects DASHBOARD_LOCAL=1 alone in production without the launch secret", async () => {
    desktop(null); // DASHBOARD_LOCAL=1 is set, but no DESKTOP_INTERNAL_SECRET
    const response = await call("GET");
    // Fails closed as setupRequired() 503
    assert.equal(response.status, 503);
  });

  it("rejects requests with leaked/external forwarded host header", async () => {
    desktop();
    const leakedHeaders = {
      ...desktopHeader,
      "x-forwarded-host": "attacker-proxy.example.com",
    };
    const response = await call("GET", leakedHeaders);
    assert.equal(response.status, 401);
  });

  it("rejects requests with leaked/external forwarded for header", async () => {
    desktop();
    const leakedHeaders = {
      ...desktopHeader,
      "x-forwarded-for": "203.0.113.195",
    };
    const response = await call("GET", leakedHeaders);
    assert.equal(response.status, 401);
  });

  it("blocks cross-site mutations in desktop mode even with valid secret", async () => {
    desktop();
    const response = await call("POST", {
      ...desktopHeader,
      "sec-fetch-site": "cross-site",
    });
    assert.equal(response.status, 403);
  });

  it("blocks foreign origin mutations in desktop mode even with valid secret", async () => {
    desktop();
    const response = await call("POST", {
      ...desktopHeader,
      origin: "https://attacker.example",
    });
    assert.equal(response.status, 403);
  });

  it("allows same-origin mutations in desktop mode with valid secret", async () => {
    desktop();
    const response = await call("POST", {
      ...desktopHeader,
      "sec-fetch-site": "same-origin",
    });
    assert.notEqual(response.status, 403);
  });
});

describe("precedence: accounts and password mode take precedence over local bypass", () => {
  it("password mode takes strict precedence over leftover DASHBOARD_LOCAL=1", async () => {
    hosted(PASSWORD);
    env.DASHBOARD_LOCAL = "1";
    env.DESKTOP_INTERNAL_SECRET = DESKTOP_SECRET;

    // Unauthenticated request must receive 401 Basic auth, NOT desktop access
    const unauthResponse = await call("GET");
    assert.equal(unauthResponse.status, 401);
    assert.match(unauthResponse.headers.get("www-authenticate") ?? "", /^Basic/);

    // Supplying desktop secret alone must NOT bypass password mode
    const secretOnlyResponse = await call("GET", desktopHeader);
    assert.equal(secretOnlyResponse.status, 401);
    assert.match(secretOnlyResponse.headers.get("www-authenticate") ?? "", /^Basic/);

    // Supplying valid password succeeds
    const authResponse = await call("GET", auth);
    assert.notEqual(authResponse.status, 401);
  });

  it("accounts mode takes strict precedence over leftover DASHBOARD_LOCAL=1", async () => {
    env.AUTH_MODE = "accounts";
    env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
    env.DASHBOARD_LOCAL = "1";
    env.DESKTOP_INTERNAL_SECRET = DESKTOP_SECRET;

    // Unauthenticated API request fails closed with 401 Authentication required
    const response = await call("GET", desktopHeader);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Authentication required.");
  });

  it("validateStartupConfig detects conflicting DASHBOARD_LOCAL and hosted variables", () => {
    env.DASHBOARD_LOCAL = "1";
    env.DASHBOARD_PASSWORD = PASSWORD;
    assert.equal(proxyModule.validateStartupConfig().valid, false);

    delete env.DASHBOARD_PASSWORD;
    env.AUTH_MODE = "accounts";
    env.DATABASE_URL = "postgres://localhost/test";
    assert.equal(proxyModule.validateStartupConfig().valid, false);

    delete env.AUTH_MODE;
    delete env.DATABASE_URL;
    assert.equal(proxyModule.validateStartupConfig().valid, true);
  });
});

describe("cross-site request forgery in hosted password mode", () => {
  it("blocks an authenticated mutation a browser reports as cross-site", async () => {
    hosted();
    const response = await call("POST", { ...auth, "sec-fetch-site": "cross-site" });
    assert.equal(response.status, 403);
  });

  it("blocks foreign origin mutations in hosted password mode", async () => {
    hosted();
    const response = await call("POST", { ...auth, origin: "https://attacker.example" });
    assert.equal(response.status, 403);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`blocks cross-site ${method}`, async () => {
      hosted();
      const response = await call(method, { ...auth, "sec-fetch-site": "cross-site" });
      assert.equal(response.status, 403);
    });
  }

  it("allows same origin requests", async () => {
    hosted();
    const response = await call("POST", { ...auth, "sec-fetch-site": "same-origin" });
    assert.notEqual(response.status, 403);
  });

  it("does not block reads", async () => {
    hosted();
    const response = await call("GET", { ...auth, "sec-fetch-site": "cross-site" });
    assert.notEqual(response.status, 403);
  });
});
