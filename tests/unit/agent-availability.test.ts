/**
 * Unit tests for the desktop-only availability check (isAgentRunsEnabled).
 *
 * §2.2: Launching CLIs against filesystem paths is remote code execution if reachable
 * by anyone else. This check must fail closed under any configuration other than pure
 * local desktop mode.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAccountsModeEnv,
  isAgentRunsEnabled,
  isDesktopModeEnv,
  isPasswordModeEnv,
} from "../../src/core/agents/availability";

describe("isAgentRunsEnabled", () => {
  const validDesktopEnv = {
    DASHBOARD_LOCAL: "1",
    DESKTOP_INTERNAL_SECRET: "random-per-launch-secret-xyz",
  };

  it("returns true only for the full desktop local environment", () => {
    assert.equal(isAgentRunsEnabled(validDesktopEnv), true);
  });

  it("returns false when DASHBOARD_LOCAL is missing or not '1'", () => {
    const invalidLocalValues = [undefined, "0", "true", "yes", "", "2"];

    for (const val of invalidLocalValues) {
      const env = { ...validDesktopEnv, DASHBOARD_LOCAL: val };
      assert.equal(
        isAgentRunsEnabled(env),
        false,
        `expected false when DASHBOARD_LOCAL is ${JSON.stringify(val)}`,
      );
    }
  });

  it("returns false when DESKTOP_INTERNAL_SECRET is missing, empty, or whitespace", () => {
    const invalidSecrets = [
      undefined,
      "",
      " ",
      "   ",
      "\t",
      "\n",
      " \t \n ",
    ];

    for (const secret of invalidSecrets) {
      const env = { ...validDesktopEnv, DESKTOP_INTERNAL_SECRET: secret };
      assert.equal(
        isAgentRunsEnabled(env),
        false,
        `expected false when DESKTOP_INTERNAL_SECRET is ${JSON.stringify(secret)}`,
      );
    }
  });

  it("returns false when DATABASE_URL is configured (even if other conditions hold)", () => {
    const postgresEnv = {
      ...validDesktopEnv,
      DATABASE_URL: "postgresql://postgres:secret@localhost:5432/dashboard",
    };
    assert.equal(isAgentRunsEnabled(postgresEnv), false);

    const sqliteEnv = {
      ...validDesktopEnv,
      DATABASE_URL: "file:data/dashboard.db",
    };
    assert.equal(isAgentRunsEnabled(sqliteEnv), false);
  });

  it("returns false when AUTH_MODE=accounts is configured", () => {
    // Accounts mode with DATABASE_URL
    const fullAccountsEnv = {
      ...validDesktopEnv,
      AUTH_MODE: "accounts",
      DATABASE_URL: "postgresql://localhost:5432/dashboard",
    };
    assert.equal(isAgentRunsEnabled(fullAccountsEnv), false);

    // Accounts mode even without DATABASE_URL (fails closed)
    const partialAccountsEnv = {
      ...validDesktopEnv,
      AUTH_MODE: "accounts",
    };
    assert.equal(isAgentRunsEnabled(partialAccountsEnv), false);
  });

  it("returns false when DASHBOARD_PASSWORD is configured", () => {
    const passwordEnv = {
      ...validDesktopEnv,
      DASHBOARD_PASSWORD: "my-secret-admin-password",
    };
    assert.equal(isAgentRunsEnabled(passwordEnv), false);
  });

  it("returns false for an empty environment object", () => {
    assert.equal(isAgentRunsEnabled({}), false);
  });

  it("does not mutate process.env or the env it is given", () => {
    // process.env is an exotic object, so compare plain copies. Report only the
    // changed key names: printing the environment on failure would leak secrets.
    const before = { ...process.env };
    const hosted = {
      DASHBOARD_LOCAL: "1",
      AUTH_MODE: "accounts",
      DATABASE_URL: "postgres://db",
      DASHBOARD_PASSWORD: "secret",
      DESKTOP_INTERNAL_SECRET: "abc",
    };
    const hostedCopy = { ...hosted };
    const desktopCopy = { ...validDesktopEnv };

    isAgentRunsEnabled(validDesktopEnv);
    isAgentRunsEnabled({});
    isAgentRunsEnabled(hosted);
    isAgentRunsEnabled();

    const after = { ...process.env };
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => before[key] !== after[key],
    );
    assert.deepEqual(changed, [], "process.env keys changed");
    assert.deepEqual(hosted, hostedCopy);
    assert.deepEqual(validDesktopEnv, desktopCopy);
  });
});

describe("parametric auth-mode helpers", () => {
  it("detects accounts mode with explicit env", () => {
    assert.equal(
      isAccountsModeEnv({ AUTH_MODE: "accounts", DATABASE_URL: "postgres://localhost" }),
      true,
    );
    assert.equal(isAccountsModeEnv({ AUTH_MODE: "accounts" }), false);
    assert.equal(isAccountsModeEnv({ DATABASE_URL: "postgres://localhost" }), false);
    assert.equal(isAccountsModeEnv({}), false);
  });

  it("detects password mode with explicit env", () => {
    assert.equal(isPasswordModeEnv({ DASHBOARD_PASSWORD: "secret" }), true);
    assert.equal(
      isPasswordModeEnv({ AUTH_MODE: "accounts", DASHBOARD_PASSWORD: "secret" }),
      false,
    );
    assert.equal(isPasswordModeEnv({ DASHBOARD_PASSWORD: "   " }), false);
    assert.equal(isPasswordModeEnv({}), false);
  });

  it("detects desktop mode with explicit env", () => {
    assert.equal(isDesktopModeEnv({}), true);
    assert.equal(isDesktopModeEnv({ DASHBOARD_LOCAL: "1" }), true);
    assert.equal(
      isDesktopModeEnv({ AUTH_MODE: "accounts", DATABASE_URL: "postgres://" }),
      false,
    );
    assert.equal(isDesktopModeEnv({ DASHBOARD_PASSWORD: "secret" }), false);
  });
});
