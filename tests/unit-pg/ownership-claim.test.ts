/**
 * The ownership-claim flow (SaaS Phase 1, step 9), against real Postgres
 * *and* real SQLite at once — this is the one feature that genuinely
 * bridges both databases, so it needs both throwaway-db helpers imported
 * before any application module (see each helper's own header comment for
 * why that ordering matters).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup as cleanupPg, migrate as migratePg } from "../helpers/db.pg";
import { cleanup as cleanupSqlite, migrate as migrateSqlite } from "../helpers/db";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let ownershipClaims: typeof import("../../src/db/schema.pg").ownershipClaims;
let DrizzleProjectRepository: typeof import("../../src/db/repositories/drizzle-project-repository").DrizzleProjectRepository;
let PostgresProjectRepository: typeof import("../../src/db/repositories/postgres-project-repository").PostgresProjectRepository;
let LOCAL_WORKSPACE_ID: string;
let claimOwnership: typeof import("../../src/core/ownership-claim/service").claimOwnership;
let isAlreadyClaimed: typeof import("../../src/core/ownership-claim/service").isAlreadyClaimed;
let OwnershipClaimError: typeof import("../../src/core/ownership-claim/service").OwnershipClaimError;
let findPersonalWorkspace: typeof import("../../src/core/workspaces/service").findPersonalWorkspace;

before(async () => {
  await migratePg();
  await migrateSqlite();

  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, ownershipClaims } = await import("../../src/db/schema.pg"));
  ({ DrizzleProjectRepository } = await import(
    "../../src/db/repositories/drizzle-project-repository"
  ));
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ LOCAL_WORKSPACE_ID } = await import("../../src/db/repositories/project-repository"));
  ({ claimOwnership, isAlreadyClaimed, OwnershipClaimError } = await import(
    "../../src/core/ownership-claim/service"
  ));
  ({ findPersonalWorkspace } = await import("../../src/core/workspaces/service"));
});

after(async () => {
  await cleanupPg();
  await cleanupSqlite();
});

let userCounter = 0;

/** Inserts a throwaway Postgres user row and returns its id. */
async function makeUser(): Promise<string> {
  userCounter += 1;
  const id = `user_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id, email: `${id}@example.com` });
  return id;
}

const ORIGINAL_PASSWORD = process.env.DASHBOARD_PASSWORD;

beforeEach(async () => {
  await db().delete(ownershipClaims);
  delete process.env.DASHBOARD_PASSWORD;
});

after(() => {
  if (ORIGINAL_PASSWORD === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = ORIGINAL_PASSWORD;
});

/** Every legacy SQLite project, tags included, oldest and newest alike. */
async function legacyProjects() {
  return new DrizzleProjectRepository().list(LOCAL_WORKSPACE_ID, { includeArchived: true });
}

describe("claimOwnership", () => {
  it("rejects when the deployment has no DASHBOARD_PASSWORD configured", async () => {
    const userId = await makeUser();
    await assert.rejects(
      () => claimOwnership(userId, "anything"),
      (error: unknown) => {
        assert.ok(error instanceof OwnershipClaimError);
        assert.equal(error.reason, "not_available");
        return true;
      },
    );
  });

  it("rejects a wrong password without claiming anything", async () => {
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    const userId = await makeUser();

    await assert.rejects(
      () => claimOwnership(userId, "wrong-password"),
      (error: unknown) => {
        assert.ok(error instanceof OwnershipClaimError);
        assert.equal(error.reason, "invalid_password");
        return true;
      },
    );
    assert.equal(await isAlreadyClaimed(), false);
  });

  it("imports legacy SQLite projects and tags into the caller's personal workspace, leaving SQLite untouched", async () => {
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    const userId = await makeUser();

    const sqliteRepo = new DrizzleProjectRepository();
    await sqliteRepo.create(LOCAL_WORKSPACE_ID, {
      name: "Legacy Trading Agent",
      description: "Autonomous IBKR execution",
      source: "manual",
      type: "automation",
      status: "active",
      tags: ["python", "finance"],
      favorite: true,
    });
    await sqliteRepo.create(LOCAL_WORKSPACE_ID, {
      name: "Legacy Archived Thing",
      source: "manual",
      type: "software",
      status: "archived",
      archived: true,
      tags: ["python"],
    });
    const before = await legacyProjects();
    assert.equal(before.length, 2);

    const result = await claimOwnership(userId, "correct-horse-battery-staple");
    assert.equal(result.projectsImported, 2);

    const workspace = await findPersonalWorkspace(userId);
    assert.ok(workspace);
    assert.equal(result.workspaceId, workspace.id);

    const pgRepo = new PostgresProjectRepository();
    const imported = await pgRepo.list(workspace.id, { includeArchived: true });
    assert.deepEqual(
      imported.map((p) => p.name).sort(),
      ["Legacy Archived Thing", "Legacy Trading Agent"],
    );
    const tradingAgent = imported.find((p) => p.name === "Legacy Trading Agent");
    assert.deepEqual(tradingAgent?.tags.sort(), ["finance", "python"]);
    assert.equal(tradingAgent?.favorite, true);

    // The source data was only ever read, never mutated.
    const after = await legacyProjects();
    assert.deepEqual(before, after);

    assert.equal(await isAlreadyClaimed(), true);
  });

  it("rejects a second claim after the first succeeds, even from a different account", async () => {
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    const first = await makeUser();
    await claimOwnership(first, "correct-horse-battery-staple");

    const second = await makeUser();
    await assert.rejects(
      () => claimOwnership(second, "correct-horse-battery-staple"),
      (error: unknown) => {
        assert.ok(error instanceof OwnershipClaimError);
        assert.equal(error.reason, "already_claimed");
        return true;
      },
    );

    // The second account gets its own (empty) personal workspace, but never
    // a copy of the first account's imported data.
    const secondWorkspace = await findPersonalWorkspace(second);
    assert.ok(secondWorkspace);
    const pgRepo = new PostgresProjectRepository();
    assert.deepEqual(await pgRepo.list(secondWorkspace.id, { includeArchived: true }), []);
  });

  it("rejects a repeat claim by the same account that just succeeded", async () => {
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    const userId = await makeUser();
    await claimOwnership(userId, "correct-horse-battery-staple");

    await assert.rejects(
      () => claimOwnership(userId, "correct-horse-battery-staple"),
      (error: unknown) => {
        assert.ok(error instanceof OwnershipClaimError);
        assert.equal(error.reason, "already_claimed");
        return true;
      },
    );
  });
});
