/**
 * Encryption of the GitHub token when no encryption key is available: hosted
 * mode, `desktop:dev`, or a desktop install that has lost its key file.
 *
 * Deliberately a separate file from settings-secrets.test.ts: the encryption
 * key is read once as a top-level constant when the settings service module
 * loads, so "no key was ever set" has to mean a whole separate module
 * instance (Node's per-test-file process gives us that for free), not a
 * runtime toggle within one file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";

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

describe("secret keys, with no encryption key available", () => {
  it("stores the GitHub token as plaintext, same as before encryption existed", () => {
    settingsStore.setSetting(settingsStore.SETTING_KEYS.githubToken, "ghp_secret123");
    const raw = db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, settingsStore.SETTING_KEYS.githubToken))
      .get()?.value;
    assert.equal(raw, "ghp_secret123");
    assert.equal(
      settingsStore.getSetting(settingsStore.SETTING_KEYS.githubToken),
      "ghp_secret123",
    );
  });

  it("returns null for an encrypted value it has no key to open, rather than the ciphertext", () => {
    db.insert(settingsTable)
      .values({
        key: settingsStore.SETTING_KEYS.githubToken,
        // A syntactically valid envelope this process cannot possibly hold
        // the key for — the same situation as a desktop-encrypted database
        // read in hosted mode, or after the key file is lost.
        value: `enc:v1:${Buffer.alloc(40).toString("base64")}`,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: `enc:v1:${Buffer.alloc(40).toString("base64")}` },
      })
      .run();

    assert.equal(settingsStore.getSetting(settingsStore.SETTING_KEYS.githubToken), null);
  });
});
