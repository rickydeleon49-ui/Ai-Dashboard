/**
 * Encryption of the GitHub token at rest.
 *
 * `SETTINGS_ENCRYPTION_KEY` is set before anything imports the settings
 * service, matching the desktop main process handing it to the forked server
 * once at boot — the module reads it as a top-level constant, so it has to be
 * in place before the module is loaded for the first time.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";

process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

let settingsStore: typeof import("../../src/core/settings/service");
let db: typeof import("../../src/db/client").db;
let settingsTable: typeof import("../../src/db/schema").settings;

before(async () => {
  await migrate();
  settingsStore = await import("../../src/core/settings/service");
  ({ db } = await import("../../src/db/client"));
  ({ settings: settingsTable } = await import("../../src/db/schema"));
});

after(() => cleanup());

/** The raw row value, bypassing getSetting's decryption. */
function rawValue(key: string): string | undefined {
  return db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()?.value;
}

describe("secret keys, with an encryption key available", () => {
  it("stores the GitHub token encrypted, not as the raw value", () => {
    settingsStore.setSetting(settingsStore.SETTING_KEYS.githubToken, "ghp_secret123");
    const raw = rawValue(settingsStore.SETTING_KEYS.githubToken);
    assert.ok(raw?.startsWith("enc:v1:"), `expected an encrypted envelope, got ${raw}`);
    assert.doesNotMatch(raw ?? "", /ghp_secret123/);
  });

  it("round-trips through getSetting", () => {
    settingsStore.setSetting(settingsStore.SETTING_KEYS.githubToken, "ghp_secret123");
    assert.equal(settingsStore.getSetting(settingsStore.SETTING_KEYS.githubToken), "ghp_secret123");
  });

  it("upgrades a pre-existing plaintext value on read, with no user action", () => {
    // Simulates a token written by a version of this app before encryption
    // existed: a plain insert, bypassing setSetting entirely.
    db.insert(settingsTable)
      .values({
        key: settingsStore.SETTING_KEYS.githubToken,
        value: "ghp_legacy_plaintext",
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: "ghp_legacy_plaintext" },
      })
      .run();

    assert.equal(
      settingsStore.getSetting(settingsStore.SETTING_KEYS.githubToken),
      "ghp_legacy_plaintext",
      "the legacy value must still be readable",
    );

    const raw = rawValue(settingsStore.SETTING_KEYS.githubToken);
    assert.ok(
      raw?.startsWith("enc:v1:"),
      "reading it once should have re-encrypted it in place",
    );
  });

  it("leaves non-secret keys untouched", () => {
    settingsStore.setSetting(settingsStore.SETTING_KEYS.githubClientId, "client-id-123");
    assert.equal(rawValue(settingsStore.SETTING_KEYS.githubClientId), "client-id-123");
    assert.equal(
      settingsStore.getSetting(settingsStore.SETTING_KEYS.githubClientId),
      "client-id-123",
    );
  });
});
