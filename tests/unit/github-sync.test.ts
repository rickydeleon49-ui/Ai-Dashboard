/**
 * GitHub sync cleanup.
 *
 * The bug these cover: `resolveProvider` falls back to demo data when a token
 * is rejected, so an expired credential made `syncRepositories` fetch the demo
 * set — and the cleanup pass then deleted every cached row not present in it.
 * A token quietly expiring wiped the real repository cache.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";

let db: typeof import("../../src/db/client").db;
let githubRepositories: typeof import("../../src/db/schema").githubRepositories;
let syncRepositories: typeof import("../../src/core/github/service").syncRepositories;
let invalidateConnectionCache: typeof import("../../src/core/github/service").invalidateConnectionCache;
let settings: typeof import("../../src/core/settings/service");

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  ({ githubRepositories } = await import("../../src/db/schema"));
  ({ syncRepositories, invalidateConnectionCache } = await import(
    "../../src/core/github/service"
  ));
  settings = await import("../../src/core/settings/service");
});

after(() => cleanup());

beforeEach(() => {
  db.delete(githubRepositories).run();
  delete process.env.GITHUB_TOKEN;
  settings.deleteSetting(settings.SETTING_KEYS.githubToken);
  invalidateConnectionCache();
});

/** A cached repository that a real, working token had previously returned. */
function seedRealRepository(externalId = "999001") {
  db.insert(githubRepositories)
    .values({
      id: `ghr_${externalId}`,
      externalId,
      name: "real-repo",
      fullName: "someone/real-repo",
      owner: "someone",
      description: "Cached from a working token",
      htmlUrl: "https://github.com/someone/real-repo",
      topics: "[]",
      isDemo: false,
    })
    .run();
}

function cachedIds(): string[] {
  return db
    .select({ externalId: githubRepositories.externalId })
    .from(githubRepositories)
    .all()
    .map((row) => row.externalId);
}

describe("syncRepositories cleanup", () => {
  it("keeps real cached repositories when the token is rejected", async () => {
    seedRealRepository();

    // A syntactically valid token that GitHub will reject. The provider probes
    // it, fails, and falls back to demo data — the exact path that used to
    // delete the row seeded above.
    settings.setSetting(settings.SETTING_KEYS.githubToken, "ghp_invalid_token_for_test");
    invalidateConnectionCache();

    const result = await syncRepositories();

    assert.equal(result.connection.connected, false, "the token should be rejected");
    assert.equal(result.pruned, false, "an unauthenticated sync must not prune");
    assert.equal(result.removed, 0);
    assert.ok(
      cachedIds().includes("999001"),
      "the real cached repository must survive a failed-token sync",
    );
  });

  it("marks rows written without a working credential as demo", async () => {
    const result = await syncRepositories();
    assert.equal(result.pruned, false);

    const rows = db.select().from(githubRepositories).all();
    assert.ok(rows.length > 0, "the demo provider should have produced rows");
    assert.ok(
      rows.every((row) => row.isDemo),
      "every row from an unauthenticated sync should be flagged as demo",
    );
  });

  it("leaves a real row untouched and unflagged alongside demo rows", async () => {
    seedRealRepository();
    await syncRepositories();

    const real = db.select().from(githubRepositories).all().find(
      (row) => row.externalId === "999001",
    );
    assert.ok(real, "the real row should still exist");
    assert.equal(real.isDemo, false, "a demo sync must not relabel a real row");
  });

  it("reports the reason the credential failed", async () => {
    settings.setSetting(settings.SETTING_KEYS.githubToken, "ghp_invalid_token_for_test");
    invalidateConnectionCache();

    const result = await syncRepositories();
    assert.equal(result.connection.mode, "demo");
    assert.match(
      result.connection.detail,
      /demo repositories/i,
      "the UI needs to be told it is looking at fallback data",
    );
  });
});
