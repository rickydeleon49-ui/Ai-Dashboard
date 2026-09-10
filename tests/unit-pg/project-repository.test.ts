/**
 * PostgresProjectRepository, against real Postgres: proves two workspaces
 * never see each other's projects, tags or activity — the actual point of
 * porting this repository to Postgres, not just "does CRUD work". Behavior
 * parity with DrizzleProjectRepository (SQLite) is covered by the existing
 * tests/unit/projects.test.ts and tests/unit/archive.test.ts, which pass
 * unmodified against SQLite; this file only exercises what SQLite cannot
 * express at all — the workspace boundary.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let activityEvents: typeof import("../../src/db/schema.pg").activityEvents;
let workspaces: typeof import("../../src/core/workspaces/service");
let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, activityEvents } = await import("../../src/db/schema.pg"));
  workspaces = await import("../../src/core/workspaces/service");
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
});

after(() => cleanup());

let userCounter = 0;

/** Creates a throwaway user and a team workspace they own, returns the workspace id. */
async function makeWorkspace(name: string): Promise<string> {
  userCounter += 1;
  const userId = `user_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id: userId, email: `${userId}@example.com` });
  const ws = await workspaces.createTeamWorkspace(userId, name);
  return ws.id;
}

describe("PostgresProjectRepository: workspace isolation", () => {
  it("list() never returns another workspace's projects", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    await repo.create(wsA, { name: "A's project", source: "manual" });
    await repo.create(wsB, { name: "B's project", source: "manual" });

    const fromA = await repo.list(wsA);
    const fromB = await repo.list(wsB);

    assert.deepEqual(
      fromA.map((p) => p.name),
      ["A's project"],
    );
    assert.deepEqual(
      fromB.map((p) => p.name),
      ["B's project"],
    );
  });

  it("findById returns null for a real project id from a different workspace", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    const project = await repo.create(wsA, { name: "Secret", source: "manual" });

    // The project genuinely exists — just not reachable through wsB.
    assert.ok(await repo.findById(wsA, project.id));
    assert.equal(await repo.findById(wsB, project.id), null);
  });

  it("update and delete are no-ops from another workspace", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    const project = await repo.create(wsA, { name: "Original", source: "manual" });

    const updateFromB = await repo.update(wsB, project.id, { name: "Hijacked" });
    assert.equal(updateFromB, null);
    assert.equal((await repo.findById(wsA, project.id))?.name, "Original");

    const deleteFromB = await repo.delete(wsB, project.id);
    assert.equal(deleteFromB, false);
    assert.ok(await repo.findById(wsA, project.id), "the project must still exist");
  });

  it("two workspaces can each have their own tag with the same name", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    await repo.create(wsA, { name: "A1", source: "manual", tags: ["python"] });
    await repo.create(wsA, { name: "A2", source: "manual", tags: ["python"] });
    await repo.create(wsB, { name: "B1", source: "manual", tags: ["python"] });

    const tagsA = await repo.allTags(wsA);
    const tagsB = await repo.allTags(wsB);

    assert.deepEqual(tagsA, [{ name: "python", count: 2 }]);
    assert.deepEqual(tagsB, [{ name: "python", count: 1 }]);
  });

  it("a tag search in one workspace never matches a project in another", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    await repo.create(wsA, { name: "A project", source: "manual", tags: ["finance"] });
    await repo.create(wsB, { name: "B project", source: "manual", tags: ["finance"] });

    const found = await repo.list(wsA, { tag: "finance" });
    assert.deepEqual(
      found.map((p) => p.name),
      ["A project"],
    );
  });

  it("activity events are recorded under the acting workspace, not leaked to another", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    await repo.create(wsA, { name: "A project", source: "manual" });

    const rowsA = await db()
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.workspaceId, wsA));
    const rowsB = await db()
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.workspaceId, wsB));

    assert.ok(rowsA.some((r) => r.type === "project.created"));
    assert.equal(rowsB.length, 0);
  });

  it("stats() counts only the acting workspace's projects", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    await repo.create(wsA, { name: "A1", source: "github", status: "active" });
    await repo.create(wsA, { name: "A2", source: "manual", status: "active" });
    await repo.create(wsB, { name: "B1", source: "github", status: "active" });
    await repo.create(wsB, { name: "B2", source: "github", status: "active" });
    await repo.create(wsB, { name: "B3", source: "github", status: "active" });

    const statsA = await repo.stats(wsA);
    const statsB = await repo.stats(wsB);

    assert.equal(statsA.total, 2);
    assert.equal(statsB.total, 3);
  });

  it("listSummaries and findByExternalId also stay scoped", async () => {
    const repo = new PostgresProjectRepository();
    const wsA = await makeWorkspace("Workspace A");
    const wsB = await makeWorkspace("Workspace B");

    await repo.create(wsA, {
      name: "A project",
      source: "github",
      externalId: "12345",
    });
    await repo.create(wsB, {
      name: "B project",
      source: "github",
      externalId: "12345",
    });

    const summariesA = await repo.listSummaries(wsA);
    assert.deepEqual(
      summariesA.map((s) => s.name),
      ["A project"],
    );

    // Same external id, different workspaces — each finds only its own.
    const foundInA = await repo.findByExternalId(wsA, "github", "12345");
    const foundInB = await repo.findByExternalId(wsB, "github", "12345");
    assert.equal(foundInA?.name, "A project");
    assert.equal(foundInB?.name, "B project");
  });
});
