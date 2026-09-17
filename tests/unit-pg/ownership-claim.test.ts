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
import { cleanup as cleanupSqlite, migrate as migrateSqlite, withLegacySqlite } from "../helpers/db";
import { eq } from "drizzle-orm";

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
  await withLegacySqlite(async () => {
    const { db: sqliteDb } = await import("../../src/db/client");
    const { projects: sqliteProjects, projectTags: sqliteProjectTags } = await import(
      "../../src/db/schema"
    );
    sqliteDb.delete(sqliteProjectTags).run();
    sqliteDb.delete(sqliteProjects).run();
  });
});

after(() => {
  if (ORIGINAL_PASSWORD === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = ORIGINAL_PASSWORD;
});

/** Every legacy SQLite project, tags included, oldest and newest alike. */
async function legacyProjects() {
  return withLegacySqlite(() =>
    new DrizzleProjectRepository().list(LOCAL_WORKSPACE_ID, { includeArchived: true })
  );
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

    await withLegacySqlite(async () => {
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

  it("resumes safely after a halfway failure and does not duplicate projects", async () => {
    process.env.DASHBOARD_PASSWORD = "correct-horse-battery-staple";
    const userId = await makeUser();

    await withLegacySqlite(async () => {
      const sqliteRepo = new DrizzleProjectRepository();
      await sqliteRepo.create(LOCAL_WORKSPACE_ID, {
        name: "Project Alpha",
        source: "manual",
        type: "software",
        status: "active",
      });
      await sqliteRepo.create(LOCAL_WORKSPACE_ID, {
        name: "Project Beta",
        source: "manual",
        type: "software",
        status: "active",
      });
      await sqliteRepo.create(LOCAL_WORKSPACE_ID, {
        name: "Project Gamma",
        source: "manual",
        type: "software",
        status: "active",
      });
    });

    const originalCreate = PostgresProjectRepository.prototype.create;
    let createCount = 0;

    // Simulate failure on the 2nd project
    PostgresProjectRepository.prototype.create = async function (...args) {
      createCount += 1;
      if (createCount === 2) {
        throw new Error("Simulated database failure on project 2");
      }
      return originalCreate.apply(this, args);
    };

    try {
      await assert.rejects(
        () => claimOwnership(userId, "correct-horse-battery-staple"),
        /Simulated database failure on project 2/,
      );
    } finally {
      PostgresProjectRepository.prototype.create = originalCreate;
    }

    // Verify claim state is partially_completed, not poisoning future attempts
    const [partialClaim] = await db()
      .select()
      .from(ownershipClaims)
      .where(eq(ownershipClaims.id, "singleton"));
    assert.ok(partialClaim);
    assert.equal(partialClaim.status, "partially_completed");
    assert.equal(partialClaim.projectsImported, 1);
    assert.equal((partialClaim.importedProjectIds as string[]).length, 1);
    assert.match(partialClaim.lastError ?? "", /Simulated database failure on project 2/);
    assert.equal(await isAlreadyClaimed(), false, "Partial claim must not be considered already claimed");

    // Retry the claim: should succeed and import remaining items without duplicating Project Alpha
    const retryResult = await claimOwnership(userId, "correct-horse-battery-staple");
    assert.equal(retryResult.projectsImported, 3);

    const [completedClaim] = await db()
      .select()
      .from(ownershipClaims)
      .where(eq(ownershipClaims.id, "singleton"));
    assert.equal(completedClaim?.status, "completed");
    assert.equal(completedClaim?.projectsImported, 3);
    assert.equal((completedClaim?.importedProjectIds as string[]).length, 3);
    assert.equal(completedClaim?.lastError, null);
    assert.equal(await isAlreadyClaimed(), true);

    const workspace = await findPersonalWorkspace(userId);
    assert.ok(workspace);
    const pgRepo = new PostgresProjectRepository();
    const importedProjects = await pgRepo.list(workspace.id, { includeArchived: true });
    assert.equal(importedProjects.length, 3, "Must not duplicate already imported projects");
    assert.deepEqual(
      importedProjects.map((p) => p.name).sort(),
      ["Project Alpha", "Project Beta", "Project Gamma"],
    );
  });

  describe("fault-injection crash-idempotency across all failure points", () => {
    async function setupLegacyProjects() {
      await withLegacySqlite(async () => {
        // Clear SQLite projects
        const sqliteRepo = new DrizzleProjectRepository();
        const existing = await sqliteRepo.list(LOCAL_WORKSPACE_ID, { includeArchived: true });
        for (const p of existing) {
          await sqliteRepo.delete(LOCAL_WORKSPACE_ID, p.id);
        }
        await sqliteRepo.create(LOCAL_WORKSPACE_ID, { name: "Prj One", source: "manual" });
        await sqliteRepo.create(LOCAL_WORKSPACE_ID, { name: "Prj Two", source: "manual" });
      });
    }

    it("survives failure before target creation", async () => {
      process.env.DASHBOARD_PASSWORD = "test-pw";
      const userId = await makeUser();
      await setupLegacyProjects();

      let failed = false;
      await assert.rejects(
        () =>
          claimOwnership(userId, "test-pw", {
            beforeTargetCreation: async (p) => {
              if (p.name === "Prj Two" && !failed) {
                failed = true;
                throw new Error("crash before target creation");
              }
            },
          }),
        /crash before target creation/,
      );

      // Retry to completion
      const retryResult = await claimOwnership(userId, "test-pw");
      assert.equal(retryResult.projectsImported, 2);

      const workspace = await findPersonalWorkspace(userId);
      assert.ok(workspace);
      const pgRepo = new PostgresProjectRepository();
      const list = await pgRepo.list(workspace.id);
      assert.equal(list.length, 2, "Retrying must produce exactly one copy of every project");
    });

    it("survives failure immediately after target creation but before checkpointing", async () => {
      process.env.DASHBOARD_PASSWORD = "test-pw";
      const userId = await makeUser();
      await setupLegacyProjects();

      let failed = false;
      await assert.rejects(
        () =>
          claimOwnership(userId, "test-pw", {
            afterTargetCreationBeforeCheckpoint: async (p) => {
              if (p.name === "Prj Two" && !failed) {
                failed = true;
                throw new Error("crash after target creation before checkpoint");
              }
            },
          }),
        /crash after target creation before checkpoint/,
      );

      // Since transaction rolled back, Prj Two was not committed and not checkpointed.
      // Retry should produce exactly 2 projects.
      const retryResult = await claimOwnership(userId, "test-pw");
      assert.equal(retryResult.projectsImported, 2);

      const workspace = await findPersonalWorkspace(userId);
      assert.ok(workspace);
      const pgRepo = new PostgresProjectRepository();
      const list = await pgRepo.list(workspace.id);
      assert.equal(list.length, 2, "Retrying must produce exactly one copy of every project");
    });

    it("survives failure during checkpoint persistence", async () => {
      process.env.DASHBOARD_PASSWORD = "test-pw";
      const userId = await makeUser();
      await setupLegacyProjects();

      let failed = false;
      await assert.rejects(
        () =>
          claimOwnership(userId, "test-pw", {
            duringCheckpointPersistence: async (p) => {
              if (p.name === "Prj Two" && !failed) {
                failed = true;
                throw new Error("crash during checkpoint persistence");
              }
            },
          }),
        /crash during checkpoint persistence/,
      );

      const retryResult = await claimOwnership(userId, "test-pw");
      assert.equal(retryResult.projectsImported, 2);

      const workspace = await findPersonalWorkspace(userId);
      assert.ok(workspace);
      const pgRepo = new PostgresProjectRepository();
      const list = await pgRepo.list(workspace.id);
      assert.equal(list.length, 2, "Retrying must produce exactly one copy of every project");
    });

    it("survives failure after checkpointing", async () => {
      process.env.DASHBOARD_PASSWORD = "test-pw";
      const userId = await makeUser();
      await setupLegacyProjects();

      let failed = false;
      await assert.rejects(
        () =>
          claimOwnership(userId, "test-pw", {
            afterCheckpointing: async (p) => {
              if (p.name === "Prj One" && !failed) {
                failed = true;
                throw new Error("crash after checkpointing Prj One");
              }
            },
          }),
        /crash after checkpointing Prj One/,
      );

      const retryResult = await claimOwnership(userId, "test-pw");
      assert.equal(retryResult.projectsImported, 2);

      const workspace = await findPersonalWorkspace(userId);
      assert.ok(workspace);
      const pgRepo = new PostgresProjectRepository();
      const list = await pgRepo.list(workspace.id);
      assert.equal(list.length, 2, "Retrying must produce exactly one copy of every project");
    });

    it("survives failure during final completion update", async () => {
      process.env.DASHBOARD_PASSWORD = "test-pw";
      const userId = await makeUser();
      await setupLegacyProjects();

      let failed = false;
      await assert.rejects(
        () =>
          claimOwnership(userId, "test-pw", {
            duringFinalCompletionUpdate: async () => {
              if (!failed) {
                failed = true;
                throw new Error("crash during final completion update");
              }
            },
          }),
        /crash during final completion update/,
      );

      const retryResult = await claimOwnership(userId, "test-pw");
      assert.equal(retryResult.projectsImported, 2);

      const workspace = await findPersonalWorkspace(userId);
      assert.ok(workspace);
      const pgRepo = new PostgresProjectRepository();
      const list = await pgRepo.list(workspace.id);
      assert.equal(list.length, 2, "Retrying must produce exactly one copy of every project");
      assert.equal(await isAlreadyClaimed(), true);
    });
  });

  describe("binding retries to original claimant", () => {
    it("proves another account with correct password cannot resume, inspect, or redirect a partial claim", async () => {
      process.env.DASHBOARD_PASSWORD = "super-secret-password";
      const claimantA = await makeUser();
      const claimantB = await makeUser();

      await withLegacySqlite(async () => {
        const sqliteRepo = new DrizzleProjectRepository();
        const existing = await sqliteRepo.list(LOCAL_WORKSPACE_ID, { includeArchived: true });
        for (const p of existing) {
          await sqliteRepo.delete(LOCAL_WORKSPACE_ID, p.id);
        }
        await sqliteRepo.create(LOCAL_WORKSPACE_ID, { name: "Alpha", source: "manual" });
        await sqliteRepo.create(LOCAL_WORKSPACE_ID, { name: "Beta", source: "manual" });
      });

      // Claimant A starts the claim, but fails halfway through
      await assert.rejects(
        () =>
          claimOwnership(claimantA, "super-secret-password", {
            afterCheckpointing: async (p) => {
              if (p.name === "Alpha") throw new Error("Halfway interruption");
            },
          }),
        /Halfway interruption/,
      );

      // Verify claim is in partially_completed state owned by claimantA
      const [claimRow] = await db()
        .select()
        .from(ownershipClaims)
        .where(eq(ownershipClaims.id, "singleton"));
      assert.ok(claimRow);
      assert.equal(claimRow.status, "partially_completed");
      assert.equal(claimRow.claimedBy, claimantA);

      // Claimant B, possessing the correct legacy password, attempts to resume or claim
      await assert.rejects(
        () => claimOwnership(claimantB, "super-secret-password"),
        (err: unknown) => {
          assert.ok(err instanceof OwnershipClaimError);
          assert.equal(err.reason, "claimant_mismatch");
          return true;
        },
      );

      // Ensure Claimant B never received Claimant A's workspace or projects
      const workspaceB = await findPersonalWorkspace(claimantB);
      assert.ok(workspaceB);
      assert.notEqual(workspaceB.id, claimRow.workspaceId);
      const pgRepo = new PostgresProjectRepository();
      assert.deepEqual(await pgRepo.list(workspaceB.id), []);

      // Original claimant A can resume successfully
      const resumed = await claimOwnership(claimantA, "super-secret-password");
      assert.equal(resumed.projectsImported, 2);
      assert.equal(resumed.workspaceId, claimRow.workspaceId);
    });

    it("rejects resume if claimant no longer owns the target workspace", async () => {
      const { workspaceMembers } = await import("../../src/db/schema.pg");
      const { and } = await import("drizzle-orm");
      process.env.DASHBOARD_PASSWORD = "pw";
      const claimant = await makeUser();

      await withLegacySqlite(async () => {
        const sqliteRepo = new DrizzleProjectRepository();
        const existing = await sqliteRepo.list(LOCAL_WORKSPACE_ID, { includeArchived: true });
        for (const p of existing) {
          await sqliteRepo.delete(LOCAL_WORKSPACE_ID, p.id);
        }
        await sqliteRepo.create(LOCAL_WORKSPACE_ID, { name: "Solo", source: "manual" });
      });

      // Fail midway to leave partial claim
      await assert.rejects(
        () =>
          claimOwnership(claimant, "pw", {
            afterCheckpointing: async () => {
              throw new Error("Midway fail");
            },
          }),
        /Midway fail/,
      );

      const [claimRow] = await db()
        .select()
        .from(ownershipClaims)
        .where(eq(ownershipClaims.id, "singleton"));
      assert.ok(claimRow);

      // Add a second owner so demoting claimant does not violate the last-owner trigger
      const coOwnerId = await makeUser();
      await db().insert(workspaceMembers).values({
        workspaceId: claimRow.workspaceId,
        userId: coOwnerId,
        role: "owner",
      });

      // Remove claimant's owner role (simulate membership revocation)
      await db()
        .update(workspaceMembers)
        .set({ role: "member" })
        .where(
          and(
            eq(workspaceMembers.workspaceId, claimRow.workspaceId),
            eq(workspaceMembers.userId, claimant),
          ),
        );

      await assert.rejects(
        () => claimOwnership(claimant, "pw"),
        (err: unknown) => {
          assert.ok(err instanceof OwnershipClaimError);
          assert.equal(err.reason, "workspace_not_owned");
          return true;
        },
      );
    });
  });
});
