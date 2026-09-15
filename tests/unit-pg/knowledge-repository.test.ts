/**
 * PostgresKnowledgeDocumentRepository, against real Postgres: proves two
 * workspaces never see each other's documents — the point of the Postgres
 * implementation existing at all, not just "does CRUD work" (behavior
 * parity with the SQLite implementation is covered by
 * tests/unit/knowledge.test.ts, which exercises the same CRUD + search
 * shape against a throwaway SQLite database).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaces: typeof import("../../src/core/workspaces/service");
let PostgresProjectRepository: typeof import(
  "../../src/db/repositories/postgres-project-repository"
).PostgresProjectRepository;
let PostgresKnowledgeDocumentRepository: typeof import(
  "../../src/db/repositories/postgres-knowledge-document-repository"
).PostgresKnowledgeDocumentRepository;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users } = await import("../../src/db/schema.pg"));
  workspaces = await import("../../src/core/workspaces/service");
  ({ PostgresProjectRepository } = await import(
    "../../src/db/repositories/postgres-project-repository"
  ));
  ({ PostgresKnowledgeDocumentRepository } = await import(
    "../../src/db/repositories/postgres-knowledge-document-repository"
  ));
});

after(() => cleanup());

let userCounter = 0;

/** Creates a throwaway user, a team workspace they own, and one project in it. */
async function makeWorkspaceWithProject(
  name: string,
): Promise<{ workspaceId: string; projectId: string }> {
  userCounter += 1;
  const userId = `user_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id: userId, email: `${userId}@example.com` });
  const ws = await workspaces.createTeamWorkspace(userId, name);
  const projects = new PostgresProjectRepository();
  const project = await projects.create(ws.id, { name: `${name} project`, source: "manual" });
  return { workspaceId: ws.id, projectId: project.id };
}

describe("PostgresKnowledgeDocumentRepository: CRUD + workspace isolation", () => {
  it("creates a document and reads it back", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Knowledge CRUD");

    const created = await repo.create(workspaceId, {
      projectId,
      title: "Onboarding notes",
      content: "Start here",
      category: "onboarding",
    });
    assert.equal(created.title, "Onboarding notes");
    assert.equal(created.pinned, false);

    const found = await repo.findById(workspaceId, created.id);
    assert.equal(found?.content, "Start here");
  });

  it("list() never returns another workspace's documents", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const a = await makeWorkspaceWithProject("Knowledge Isolation A");
    const b = await makeWorkspaceWithProject("Knowledge Isolation B");

    await repo.create(a.workspaceId, { projectId: a.projectId, title: "A doc" });
    await repo.create(b.workspaceId, { projectId: b.projectId, title: "B doc" });

    const fromA = await repo.list(a.workspaceId, a.projectId);
    assert.deepEqual(
      fromA.map((d) => d.title),
      ["A doc"],
    );
  });

  it("search matches title, content and category, scoped to the workspace", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Knowledge Search");

    await repo.create(workspaceId, {
      projectId,
      title: "Deploy steps",
      content: "run the release script",
      category: "ops",
    });
    await repo.create(workspaceId, { projectId, title: "Unrelated", content: "nothing here" });

    const byContent = await repo.list(workspaceId, projectId, { search: "release script" });
    assert.deepEqual(
      byContent.map((d) => d.title),
      ["Deploy steps"],
    );

    const byCategory = await repo.list(workspaceId, projectId, { category: "ops" });
    assert.deepEqual(
      byCategory.map((d) => d.title),
      ["Deploy steps"],
    );
  });

  it("update and delete are no-ops from another workspace", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const a = await makeWorkspaceWithProject("Knowledge Hijack A");
    const b = await makeWorkspaceWithProject("Knowledge Hijack B");

    const doc = await repo.create(a.workspaceId, { projectId: a.projectId, title: "Original" });

    assert.equal(await repo.update(b.workspaceId, doc.id, { title: "Hijacked" }), null);
    assert.equal((await repo.findById(a.workspaceId, doc.id))?.title, "Original");

    assert.equal(await repo.delete(b.workspaceId, doc.id), false);
    assert.ok(await repo.findById(a.workspaceId, doc.id));
  });

  it("pinned documents sort first, then by most recently updated", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Knowledge Pinned Order");

    await repo.create(workspaceId, { projectId, title: "First" });
    const pinned = await repo.create(workspaceId, { projectId, title: "Pinned", pinned: true });
    await repo.create(workspaceId, { projectId, title: "Second" });

    const list = await repo.list(workspaceId, projectId);
    assert.equal(list[0]?.id, pinned.id);
  });
});
