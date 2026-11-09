/**
 * AW5-01: self-hosted mode detection, start-up refusals and bind addresses.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getAuthMode, isDesktopMode, isSelfHostedMode } from "../../src/lib/auth-mode";
import { validateBindAddress } from "../../src/core/selfhost/bind";
import { validateStartupConfig } from "../../src/core/selfhost/startup";

const KEYS = [
  "AGENT_HOST_MODE",
  "AUTH_MODE",
  "DATABASE_URL",
  "DASHBOARD_PASSWORD",
  "DASHBOARD_LOCAL",
  "DESKTOP_INTERNAL_SECRET",
] as const;
const env = process.env as Record<string, string | undefined>;
const original = Object.fromEntries(KEYS.map((k) => [k, env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete env[k];
    else env[k] = original[k];
  }
});

function clean(): void {
  for (const k of KEYS) delete env[k];
}

const SELF = { AGENT_HOST_MODE: "self-hosted" };

describe("isSelfHostedMode", () => {
  it("is true only for the exact value", () => {
    assert.equal(isSelfHostedMode({ AGENT_HOST_MODE: "self-hosted" }), true);
    for (const v of ["Self-Hosted", "self-hosted ", "true", "1", "", "selfhosted"]) {
      assert.equal(isSelfHostedMode({ AGENT_HOST_MODE: v }), false, v);
    }
    assert.equal(isSelfHostedMode({}), false);
  });
});

describe("validateStartupConfig (self-hosted)", () => {
  it("accepts a clean self-hosted env", () => {
    assert.equal(validateStartupConfig({ ...SELF }).valid, true);
  });

  it("refuses any AGENT_HOST_MODE value other than self-hosted", () => {
    for (const v of ["hosted", "Self-Hosted", "true", ""]) {
      const r = validateStartupConfig({ AGENT_HOST_MODE: v });
      assert.equal(r.valid, false, v);
      assert.match(r.error ?? "", /AGENT_HOST_MODE/);
    }
  });

  const refusals: Array<[string, Record<string, string>, RegExp]> = [
    ["AUTH_MODE=accounts", { AUTH_MODE: "accounts" }, /AUTH_MODE=accounts/],
    ["DATABASE_URL", { DATABASE_URL: "postgres://x/y" }, /DATABASE_URL/],
    ["DASHBOARD_PASSWORD", { DASHBOARD_PASSWORD: "pw" }, /DASHBOARD_PASSWORD/],
    ["RAILWAY_ENVIRONMENT", { RAILWAY_ENVIRONMENT: "production" }, /Railway.*RAILWAY_ENVIRONMENT/],
    ["RAILWAY_PROJECT_ID", { RAILWAY_PROJECT_ID: "x" }, /RAILWAY_PROJECT_ID/],
    ["DASHBOARD_LOCAL=1", { DASHBOARD_LOCAL: "1" }, /DASHBOARD_LOCAL/],
    ["DESKTOP_INTERNAL_SECRET", { DESKTOP_INTERNAL_SECRET: "s" }, /DESKTOP_INTERNAL_SECRET/],
  ];
  for (const [name, extra, re] of refusals) {
    it(`refuses ${name} with its own message`, () => {
      const r = validateStartupConfig({ ...SELF, ...extra });
      assert.equal(r.valid, false);
      assert.match(r.error ?? "", re);
    });
  }

  it("does not refuse unrelated AUTH_MODE values", () => {
    assert.equal(validateStartupConfig({ ...SELF, AUTH_MODE: "password" }).valid, true);
  });

  it("reads process.env by default", () => {
    clean();
    env.AGENT_HOST_MODE = "self-hosted";
    assert.equal(validateStartupConfig().valid, true);
    env.DATABASE_URL = "postgres://x/y";
    assert.equal(validateStartupConfig().valid, false);
  });
});

describe("validateStartupConfig (unchanged for other modes)", () => {
  it("keeps the desktop-local conflicts", () => {
    assert.equal(validateStartupConfig({ DASHBOARD_LOCAL: "1", DASHBOARD_PASSWORD: "p" }).valid, false);
    assert.equal(
      validateStartupConfig({ DESKTOP_INTERNAL_SECRET: "s", AUTH_MODE: "accounts" }).valid,
      false,
    );
    assert.equal(
      validateStartupConfig({ DASHBOARD_LOCAL: "1", DATABASE_URL: "postgres://x" }).valid,
      false,
    );
  });

  it("allows plain desktop, password and accounts setups", () => {
    assert.equal(validateStartupConfig({}).valid, true);
    assert.equal(validateStartupConfig({ DASHBOARD_LOCAL: "1", DESKTOP_INTERNAL_SECRET: "s" }).valid, true);
    assert.equal(validateStartupConfig({ DASHBOARD_PASSWORD: "p", RAILWAY_ENVIRONMENT: "x" }).valid, true);
    assert.equal(
      validateStartupConfig({ AUTH_MODE: "accounts", DATABASE_URL: "postgres://x" }).valid,
      true,
    );
  });
});

describe("getAuthMode precedence", () => {
  it("self-hosted wins over everything", () => {
    clean();
    env.AGENT_HOST_MODE = "self-hosted";
    assert.equal(getAuthMode(), "self-hosted");
    assert.equal(isDesktopMode(), false);
    env.AUTH_MODE = "accounts";
    env.DATABASE_URL = "postgres://x/y";
    env.DASHBOARD_PASSWORD = "pw";
    assert.equal(getAuthMode(), "self-hosted");
  });

  it("existing modes are unchanged", () => {
    clean();
    assert.equal(getAuthMode(), "desktop");
    assert.equal(isDesktopMode(), true);
    env.DASHBOARD_PASSWORD = "pw";
    assert.equal(getAuthMode(), "password");
    env.AUTH_MODE = "accounts";
    env.DATABASE_URL = "postgres://x/y";
    assert.equal(getAuthMode(), "accounts");
    env.AGENT_HOST_MODE = "other";
    assert.equal(getAuthMode(), "accounts");
  });
});

describe("validateBindAddress", () => {
  const always: string[] = ["127.0.0.1", "127.1.2.3", "::1", "localhost", "LOCALHOST", "[::1]", "::ffff:127.0.0.1"];
  const lanOnly: string[] = [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.5",
    "100.64.0.1",
    "100.127.255.254",
    "fd7a:115c:a1e0::1",
    "fd7a:115c:a1e0:ab12::5",
    "::ffff:10.0.0.1",
    "::ffff:192.168.0.9",
    "::ffff:a00:1",
  ];
  const never: string[] = [
    "",
    "   ",
    "0.0.0.0",
    "::",
    "0:0:0:0:0:0:0:0",
    "::ffff:0.0.0.0",
    "example.com",
    "my-laptop",
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "2001:db8::1",
    "fe80::1",
    "fd7a:115c:a1e1::1",
    "::ffff:8.8.8.8",
    "256.1.1.1",
    "10.0.0",
    "10.0.0.1.5",
    "1:2:3:4:5:6:7:8:9",
    "::1::2",
  ];

  it("allows loopback with or without allowLan", () => {
    for (const h of always) {
      assert.deepEqual(validateBindAddress(h, { allowLan: false }), { ok: true }, h);
      assert.deepEqual(validateBindAddress(h, { allowLan: true }), { ok: true }, h);
    }
  });

  it("allows private and Tailscale only with allowLan", () => {
    for (const h of lanOnly) {
      assert.deepEqual(validateBindAddress(h, { allowLan: true }), { ok: true }, h);
      const off = validateBindAddress(h, { allowLan: false });
      assert.equal(off.ok, false, h);
    }
  });

  it("always refuses wildcards, empties, hostnames and public addresses", () => {
    for (const h of never) {
      for (const allowLan of [false, true]) {
        const r = validateBindAddress(h, { allowLan });
        assert.equal(r.ok, false, `${h} allowLan=${allowLan}`);
        if (!r.ok) assert.ok(r.error.length > 0);
      }
    }
  });
});
