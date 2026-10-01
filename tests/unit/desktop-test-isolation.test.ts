/**
 * Desktop test isolation:
 * Proves that `DESKTOP_TEST_USER_DATA` relocates the desktop profile only in a
 * test run from a checkout, that a packaged build can never be redirected by
 * it, and that a desktop test which forgot to isolate itself refuses to start
 * instead of falling back to the real profile.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

const { resolveTestUserDataOverride } = require("../../desktop/main.js") as {
  resolveTestUserDataOverride: (options: {
    env: Record<string, string | undefined>;
    isPackaged: boolean;
    isTestEnv: boolean;
  }) => { dir?: string; error?: string } | null;
};

const tempProfile = path.resolve("tmp", "cc-desktop-profile");

describe("desktop test user-data override", () => {
  it("relocates userData in a test run from a checkout", () => {
    const result = resolveTestUserDataOverride({
      env: { DESKTOP_TEST_MODE: "1", DESKTOP_TEST_USER_DATA: tempProfile },
      isPackaged: false,
      isTestEnv: true,
    });
    assert.deepEqual(result, { dir: tempProfile });
  });

  it("is ignored by a packaged build, whatever the environment says", () => {
    for (const env of [
      { DESKTOP_TEST_MODE: "1", DESKTOP_TEST_USER_DATA: tempProfile },
      { NODE_ENV: "test", DESKTOP_TEST_USER_DATA: tempProfile },
      { DESKTOP_TEST_USER_DATA: tempProfile },
      { DESKTOP_TEST_MODE: "1" },
    ]) {
      for (const isTestEnv of [true, false]) {
        assert.equal(
          resolveTestUserDataOverride({ env, isPackaged: true, isTestEnv }),
          null,
          `packaged build must not honour ${JSON.stringify(env)}`,
        );
      }
    }
  });

  it("is ignored outside a test run", () => {
    const result = resolveTestUserDataOverride({
      env: { DESKTOP_TEST_USER_DATA: tempProfile },
      isPackaged: false,
      isTestEnv: false,
    });
    assert.equal(result, null);
  });

  it("refuses a desktop test that did not isolate its profile", () => {
    const result = resolveTestUserDataOverride({
      env: { DESKTOP_TEST_MODE: "1" },
      isPackaged: false,
      isTestEnv: true,
    });
    assert.match(result?.error ?? "", /refusing to use the real profile/);
  });

  it("refuses a relative path rather than resolving it against the working directory", () => {
    const result = resolveTestUserDataOverride({
      env: { DESKTOP_TEST_MODE: "1", DESKTOP_TEST_USER_DATA: "relative/profile" },
      isPackaged: false,
      isTestEnv: true,
    });
    assert.match(result?.error ?? "", /absolute path/);
  });

  it("leaves ordinary development launches alone", () => {
    const result = resolveTestUserDataOverride({ env: {}, isPackaged: false, isTestEnv: false });
    assert.equal(result, null);
  });
});
