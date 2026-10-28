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
import { SEARCH_PARITY_DOCUMENTS, SEARCH_PARITY_QUERIES } from "../helpers/markdown-fixtures";

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

    const byContent = (await repo.search(workspaceId, projectId, { search: "release script" })).documents;
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

describe("PostgresKnowledgeDocumentRepository: Markdown search (Release 2E.1)", () => {
  async function titles(repo: InstanceType<typeof PostgresKnowledgeDocumentRepository>, workspaceId: string, projectId: string, search: string) {
    return (await repo.search(workspaceId, projectId, { search })).documents.map((d) => d.title).sort();
  }

  it("answers the shared parity corpus exactly as SQLite does", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Knowledge Parity");
    for (const doc of SEARCH_PARITY_DOCUMENTS) await repo.create(workspaceId, { projectId, ...doc });
    for (const [query, expected] of SEARCH_PARITY_QUERIES) {
      assert.deepEqual(await titles(repo, workspaceId, projectId, query), [...expected].sort(), `query ${JSON.stringify(query)}`);
    }
  });

  it("search never crosses workspaces, even for identical text", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const a = await makeWorkspaceWithProject("Knowledge Search A");
    const b = await makeWorkspaceWithProject("Knowledge Search B");
    await repo.create(a.workspaceId, { projectId: a.projectId, title: "Shared words A", content: "zebra crossing" });
    await repo.create(b.workspaceId, { projectId: b.projectId, title: "Shared words B", content: "zebra crossing" });
    assert.deepEqual(await titles(repo, a.workspaceId, a.projectId, "zebra"), ["Shared words A"]);
    // Asking for B's project from A's workspace finds nothing at all.
    assert.deepEqual(await titles(repo, a.workspaceId, b.projectId, "zebra"), []);
  });

  it("backfills pre-2E.1 rows lazily without touching the source or updated_at", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { knowledgeDocuments } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Knowledge Legacy");
    const updatedAt = new Date("2026-01-02T00:00:00.000Z");
    await db().insert(knowledgeDocuments).values({
      id: `kdoc_legacy_${Date.now()}`,
      workspaceId,
      projectId,
      title: "Old note",
      content: "Written as **plain** text, see [docs](https://legacy-dest.example).",
      updatedAt,
    });
    const [before] = await db().select().from(knowledgeDocuments).where(eq(knowledgeDocuments.projectId, projectId));
    assert.equal(before!.searchText, null);

    assert.deepEqual(await titles(repo, workspaceId, projectId, "plain text, see docs"), ["Old note"]);
    assert.deepEqual(await titles(repo, workspaceId, projectId, "legacy-dest"), []);

    const [after] = await db().select().from(knowledgeDocuments).where(eq(knowledgeDocuments.projectId, projectId));
    assert.equal(after!.content, before!.content);
    assert.equal(after!.updatedAt.toISOString(), updatedAt.toISOString());
    assert.equal(after!.searchIndexedAt?.toISOString(), updatedAt.toISOString());
    assert.equal(after!.searchText, "old note written as plain text, see docs.");
  });

  it("re-derives a row an older build edited after a rollback", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { knowledgeDocuments } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Knowledge Rollback");
    const doc = await repo.create(workspaceId, { projectId, title: "Doc", content: "original words" });
    await db()
      .update(knowledgeDocuments)
      .set({ content: "replacement words", updatedAt: new Date("2099-01-01T00:00:00.000Z") })
      .where(eq(knowledgeDocuments.id, doc.id));
    assert.deepEqual(await titles(repo, workspaceId, projectId, "original"), []);
    assert.deepEqual(await titles(repo, workspaceId, projectId, "replacement"), ["Doc"]);
  });

  it("concurrent partial updates leave search text matching the final row", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { knowledgeDocuments } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    const { buildKnowledgeSearchText } = await import("../../src/core/knowledge/markdown");
    const { workspaceId, projectId } = await makeWorkspaceWithProject("Knowledge Concurrency");
    const doc = await repo.create(workspaceId, { projectId, title: "Start title", content: "start content" });
    for (let round = 0; round < 10; round += 1) {
      await Promise.all([
        repo.update(workspaceId, doc.id, { title: `Title ${round}` }),
        repo.update(workspaceId, doc.id, { content: `content ${round}` }),
        repo.update(workspaceId, doc.id, { category: `cat${round}` }),
      ]);
    }
    const [row] = await db().select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, doc.id));
    assert.equal(row!.searchText, buildKnowledgeSearchText(row!));
    assert.equal(row!.searchIndexedAt?.toISOString(), row!.updatedAt.toISOString());
  });
});

describe("review M2: bounded, resumable legacy search indexing (PostgreSQL)", () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);

  /** Inserts rows exactly as a pre-2E.1 build wrote them: no derived columns. */
  async function insertLegacy(workspaceId: string, projectId: string, rows: { id: string; content: string }[]) {
    const { knowledgeDocuments } = await import("../../src/db/schema.pg");
    for (let i = 0; i < rows.length; i += 100) {
      await db()
        .insert(knowledgeDocuments)
        .values(
          rows.slice(i, i + 100).map((row, j) => ({
            id: row.id,
            workspaceId,
            projectId,
            title: `Legacy ${row.id}`,
            content: row.content,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, (i + j) % 60)),
          })),
        );
    }
  }

  async function snapshot(projectId: string) {
    const { knowledgeDocuments: kd } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    return db()
      .select({ id: kd.id, workspaceId: kd.workspaceId, title: kd.title, content: kd.content, category: kd.category, pinned: kd.pinned, createdAt: kd.createdAt, updatedAt: kd.updatedAt })
      .from(kd)
      .where(eq(kd.projectId, projectId))
      .orderBy(kd.id);
  }

  async function freshIds(projectId: string): Promise<string[]> {
    const { knowledgeDocuments: kd } = await import("../../src/db/schema.pg");
    const { and, eq, isNotNull, sql } = await import("drizzle-orm");
    const rows = await db()
      .select({ id: kd.id })
      .from(kd)
      .where(and(eq(kd.projectId, projectId), isNotNull(kd.searchText), sql`${kd.searchIndexedAt} = ${kd.updatedAt}`))
      .orderBy(kd.id);
    return rows.map((r) => r.id);
  }

  it("re-derives one row-budget batch per search, reports pending honestly, and finds a late match once complete", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("M2 PG rows");
    const rowIds = ids(`pgrows${Date.now()}`, 60);
    await insertLegacy(workspaceId, projectId, rowIds.map((id, i) => ({ id, content: i === 59 ? "the **needle-zeta** is here" : `filler ${i}` })));
    const before = await snapshot(projectId);
    const rounds = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await repo.search(workspaceId, projectId, { search: "needle-zeta" });
      rounds.push({ ...result.index, count: result.documents.length });
    }
    assert.deepEqual(rounds, [
      { indexedNow: 25, pending: 35, complete: false, count: 0 },
      { indexedNow: 25, pending: 10, complete: false, count: 0 },
      { indexedNow: 10, pending: 0, complete: true, count: 1 },
      { indexedNow: 0, pending: 0, complete: true, count: 1 },
    ]);
    assert.deepEqual(await snapshot(projectId), before, "source, timestamps, pinning and categories are unchanged");
  });

  it("a non-matching search has the same limits, and the byte budget bounds a batch", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("M2 PG limits");
    const prefix = `pgnone${Date.now()}`;
    await insertLegacy(workspaceId, projectId, ids(prefix, 30).map((id) => ({ id, content: "nothing relevant" })));
    const first = await repo.search(workspaceId, projectId, { search: "absent-term" });
    assert.deepEqual(first, { documents: [], index: { complete: false, pending: 5, indexedNow: 25 } });
    assert.deepEqual(await freshIds(projectId), ids(prefix, 25));

    const wide = await makeWorkspaceWithProject("M2 PG bytes");
    const twoByte = String.fromCodePoint(0xe9).repeat(50_000);
    await insertLegacy(wide.workspaceId, wide.projectId, ids(`pgbytes${Date.now()}`, 5).map((id) => ({ id, content: twoByte })));
    const progress: number[] = [];
    for (let i = 0; i < 3; i += 1) progress.push((await repo.search(wide.workspaceId, wide.projectId, { search: "x" })).index.indexedNow);
    assert.deepEqual(progress, [2, 2, 1]);
  });

  it("never indexes or returns another workspace's rows", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const a = await makeWorkspaceWithProject("M2 PG iso A");
    const b = await makeWorkspaceWithProject("M2 PG iso B");
    await insertLegacy(a.workspaceId, a.projectId, ids(`pgisoa${Date.now()}`, 3).map((id) => ({ id, content: "alpha" })));
    await insertLegacy(b.workspaceId, b.projectId, ids(`pgisob${Date.now()}`, 3).map((id) => ({ id, content: "alpha" })));
    assert.equal((await repo.search(a.workspaceId, a.projectId, { search: "alpha" })).documents.length, 3);
    // A's workspace asking for B's project: nothing indexed, nothing returned.
    assert.deepEqual(await repo.search(a.workspaceId, b.projectId, { search: "alpha" }), {
      documents: [],
      index: { complete: true, pending: 0, indexedNow: 0 },
    });
    assert.deepEqual(await freshIds(b.projectId), []);
  });

  it("indexes new writes immediately while legacy rows are pending", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("M2 PG new writes");
    await insertLegacy(workspaceId, projectId, ids(`pgnew${Date.now()}`, 40).map((id) => ({ id, content: "old" })));
    await repo.create(workspaceId, { projectId, title: "Fresh note", content: "brand-new-term" });
    const result = await repo.search(workspaceId, projectId, { search: "brand-new-term" });
    assert.deepEqual(result.documents.map((d) => d.title), ["Fresh note"]);
    assert.equal(result.index.complete, false);
  });

  it("concurrent searches claim different rows (SKIP LOCKED) and a concurrent edit keeps correct text", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { buildKnowledgeSearchText } = await import("../../src/core/knowledge/markdown");
    const { knowledgeDocuments: kd } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    const { workspaceId, projectId } = await makeWorkspaceWithProject("M2 PG concurrency");
    const rowIds = ids(`pgconc${Date.now()}`, 120);
    await insertLegacy(workspaceId, projectId, rowIds.map((id) => ({ id, content: "original" })));

    const results = await Promise.all([
      repo.search(workspaceId, projectId, { search: "zzz" }),
      repo.search(workspaceId, projectId, { search: "zzz" }),
      repo.update(workspaceId, rowIds[3]!, { content: "edited **while** indexing" }),
      repo.search(workspaceId, projectId, { search: "zzz" }),
      repo.search(workspaceId, projectId, { search: "zzz" }),
    ]);
    const searches = [results[0], results[1], results[3], results[4]] as { index: { indexedNow: number } }[];
    for (const s of searches) assert.ok(s.index.indexedNow <= 25, `a search indexed ${s.index.indexedNow}`);
    const fresh = await freshIds(projectId);
    const indexed = searches.reduce((sum, s) => sum + s.index.indexedNow, 0);
    // No row was claimed by two searches (that would make `indexed` exceed the
    // fresh rows). The edited row is fresh either way: indexed by a search that
    // claimed it first and then rewritten by the edit, or written only by the edit.
    assert.ok(indexed <= fresh.length && fresh.length <= indexed + 1, `indexed ${indexed}, fresh ${fresh.length}`);

    const [edited] = await db().select().from(kd).where(eq(kd.id, rowIds[3]!));
    assert.equal(edited!.content, "edited **while** indexing");
    assert.equal(edited!.searchText, buildKnowledgeSearchText(edited!));
    assert.equal(edited!.searchIndexedAt?.toISOString(), edited!.updatedAt.toISOString());

    // Resumes to completion over later requests; nothing is left stale.
    let rounds = 0;
    while (!(await repo.search(workspaceId, projectId, { search: "zzz" })).index.complete) {
      rounds += 1;
      assert.ok(rounds < 10, "indexing must finish in a bounded number of requests");
    }
    assert.equal((await freshIds(projectId)).length, 120);
  });

  it("counts categories in the database, scoped to the workspace", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("M2 PG categories");
    for (const category of ["ops", "ops", "ops", "docs", "docs", null, "zeta"]) {
      await repo.create(workspaceId, { projectId, title: `c ${category}`, category });
    }
    assert.deepEqual(await repo.categoryCounts(workspaceId, projectId), [
      { name: "ops", count: 3 },
      { name: "docs", count: 2 },
      { name: "zeta", count: 1 },
    ]);
    const other = await makeWorkspaceWithProject("M2 PG categories other");
    assert.deepEqual(await repo.categoryCounts(other.workspaceId, projectId), []);
  });
});

describe("review C2: a stale non-NULL key never produces a match (PostgreSQL)", () => {
  const OLD_UPDATED = new Date("2026-03-01T00:00:00.000Z");
  const OLDER_BUILD_EDIT = new Date("2026-04-01T00:00:00.000Z");

  /** 60 never-indexed rows sorting first, then a row whose key is stale but non-NULL (see the SQLite copy). */
  async function seedStaleNonNull(workspaceId: string, projectId: string, prefix: string): Promise<string> {
    const { knowledgeDocuments: kd } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    const { buildKnowledgeSearchText } = await import("../../src/core/knowledge/markdown");
    await db()
      .insert(kd)
      .values(
        Array.from({ length: 60 }, (_, i) => ({
          id: `${prefix}-a${String(i).padStart(4, "0")}`,
          workspaceId,
          projectId,
          title: `Filler ${i}`,
          content: "filler words",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        })),
      );
    const lateId = `${prefix}-z-late`;
    const original = { title: "Late doc", category: null, content: "contains removedterm here" };
    await db().insert(kd).values({
      id: lateId,
      workspaceId,
      projectId,
      ...original,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: OLD_UPDATED,
      searchText: buildKnowledgeSearchText(original),
      searchIndexedAt: OLD_UPDATED,
    });
    await db().update(kd).set({ content: "contains replacementterm here", updatedAt: OLDER_BUILD_EDIT }).where(eq(kd.id, lateId));
    return lateId;
  }

  async function lateRow(id: string) {
    const { knowledgeDocuments: kd } = await import("../../src/db/schema.pg");
    const { eq } = await import("drizzle-orm");
    const [row] = await db().select().from(kd).where(eq(kd.id, id));
    return row!;
  }

  it("never returns the stale row for a removed term; the replacement matches once refreshed; pending stays honest", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { workspaceId, projectId } = await makeWorkspaceWithProject("C2 PG stale key");
    const lateId = await seedStaleNonNull(workspaceId, projectId, `c2pg${Date.now()}`);
    const before = await lateRow(lateId);
    assert.ok(before.searchText!.includes("removedterm"), "precondition: stale non-NULL key");

    const pendingReplacement = await repo.search(workspaceId, projectId, { search: "replacementterm" });
    assert.deepEqual(pendingReplacement.documents, [], "not found before it is refreshed");
    assert.deepEqual(pendingReplacement.index, { complete: false, pending: 36, indexedNow: 25 });

    const rounds = [];
    for (let i = 0; i < 2; i += 1) {
      const removed = await repo.search(workspaceId, projectId, { search: "removedterm" });
      rounds.push({ hits: removed.documents.length, ...removed.index });
    }
    assert.deepEqual(rounds, [
      { hits: 0, indexedNow: 25, pending: 11, complete: false },
      { hits: 0, indexedNow: 11, pending: 0, complete: true },
    ]);
    const replaced = await repo.search(workspaceId, projectId, { search: "replacementterm" });
    assert.deepEqual(replaced.documents.map((d) => d.id), [lateId]);

    const after = await lateRow(lateId);
    assert.equal(after.content, "contains replacementterm here");
    assert.equal(after.updatedAt.toISOString(), OLDER_BUILD_EDIT.toISOString());
    assert.equal(after.searchIndexedAt?.toISOString(), OLDER_BUILD_EDIT.toISOString());
  });

  it("another workspace's or project's stale key is neither returned nor indexed", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const mine = await makeWorkspaceWithProject("C2 PG iso mine");
    const theirs = await makeWorkspaceWithProject("C2 PG iso theirs");
    const theirLate = await seedStaleNonNull(theirs.workspaceId, theirs.projectId, `c2pgo${Date.now()}`);
    assert.deepEqual(await repo.search(mine.workspaceId, mine.projectId, { search: "removedterm" }), {
      documents: [],
      index: { complete: true, pending: 0, indexedNow: 0 },
    });
    // Naming their project from my workspace finds and indexes nothing.
    assert.deepEqual(await repo.search(mine.workspaceId, theirs.projectId, { search: "removedterm" }), {
      documents: [],
      index: { complete: true, pending: 0, indexedNow: 0 },
    });
    const row = await lateRow(theirLate);
    assert.notEqual(row.searchIndexedAt?.toISOString(), row.updatedAt.toISOString(), "still stale");
  });

  it("concurrent searches and a current-build edit of the stale row: the removed term never matches", async () => {
    const repo = new PostgresKnowledgeDocumentRepository();
    const { buildKnowledgeSearchText } = await import("../../src/core/knowledge/markdown");
    const { workspaceId, projectId } = await makeWorkspaceWithProject("C2 PG concurrency");
    const lateId = await seedStaleNonNull(workspaceId, projectId, `c2pgc${Date.now()}`);
    const results = await Promise.all([
      repo.search(workspaceId, projectId, { search: "removedterm" }),
      repo.update(workspaceId, lateId, { content: "now says thirdterm" }),
      repo.search(workspaceId, projectId, { search: "removedterm" }),
      repo.search(workspaceId, projectId, { search: "removedterm" }),
    ]);
    for (const i of [0, 2, 3]) assert.deepEqual((results[i] as { documents: unknown[] }).documents, [], `search ${i}`);
    const row = await lateRow(lateId);
    assert.equal(row.content, "now says thirdterm");
    assert.equal(row.searchText, buildKnowledgeSearchText(row));
    assert.equal(row.searchIndexedAt?.toISOString(), row.updatedAt.toISOString());
    assert.deepEqual((await repo.search(workspaceId, projectId, { search: "thirdterm" })).documents.map((d) => d.id), [lateId]);
  });
});
