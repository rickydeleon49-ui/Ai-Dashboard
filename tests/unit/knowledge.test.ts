/**
 * Knowledge documents against a throwaway SQLite database — desktop mode.
 * Workspace isolation (the reason a Postgres implementation exists at all)
 * is covered separately in tests/unit-pg/knowledge-repository.test.ts; this
 * file exercises the CRUD + search shape both implementations share.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import { SEARCH_PARITY_DOCUMENTS, SEARCH_PARITY_QUERIES } from "../helpers/markdown-fixtures";

let projectRepository: import("../../src/db/repositories/project-repository").ProjectRepository;
let knowledgeDocumentRepository: import(
  "../../src/db/repositories/knowledge-document-repository"
).KnowledgeDocumentRepository;
let projectId: string;

before(async () => {
  await migrate();
  ({ projectRepository, knowledgeDocumentRepository } = await import("../../src/db/repositories"));
  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Test Project" });
  projectId = project.id;
});

after(() => cleanup());

describe("knowledge documents (SQLite)", () => {
  it("creates a document with defaults", async () => {
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Onboarding notes",
    });
    assert.equal(doc.content, "");
    assert.equal(doc.category, null);
    assert.equal(doc.pinned, false);
  });

  it("updates title, content, category and pinned", async () => {
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Draft",
      content: "first draft",
    });

    const updated = await knowledgeDocumentRepository.update(LOCAL_WORKSPACE_ID, doc.id, {
      title: "Final",
      content: "final content",
      category: "runbooks",
      pinned: true,
    });
    assert.equal(updated?.title, "Final");
    assert.equal(updated?.content, "final content");
    assert.equal(updated?.category, "runbooks");
    assert.equal(updated?.pinned, true);
  });

  it("lists only documents for the given project, pinned first", async () => {
    const other = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Other Project" });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "Mine" });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId: other.id,
      title: "Not mine",
    });
    const pinned = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Pinned one",
      pinned: true,
    });

    const list = await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId);
    assert.ok(list.every((d) => d.title !== "Not mine"));
    assert.ok(list.some((d) => d.title === "Mine"));
    assert.equal(list[0]?.id, pinned.id);
  });

  it("filters by category", async () => {
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Runbook A",
      category: "runbooks",
    });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Design note",
      category: "design",
    });

    const runbooksOnly = await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId, {
      category: "runbooks",
    });
    assert.ok(runbooksOnly.every((d) => d.category === "runbooks"));
    assert.ok(runbooksOnly.some((d) => d.title === "Runbook A"));
  });

  it("search matches title, content, and category", async () => {
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Deploy steps",
      content: "run the release script",
      category: "ops",
    });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Unrelated",
      content: "nothing relevant here",
    });

    const byTitle = (await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, projectId, {
      search: "deploy",
    })).documents;
    assert.ok(byTitle.some((d) => d.title === "Deploy steps"));

    const byContent = (await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, projectId, {
      search: "release script",
    })).documents;
    assert.ok(byContent.some((d) => d.title === "Deploy steps"));

    const byCategory = (await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, projectId, {
      search: "ops",
    })).documents;
    assert.ok(byCategory.some((d) => d.title === "Deploy steps"));
  });

  it("delete removes the row; a second delete reports false", async () => {
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Temporary",
    });
    assert.equal(await knowledgeDocumentRepository.delete(LOCAL_WORKSPACE_ID, doc.id), true);
    assert.equal(await knowledgeDocumentRepository.delete(LOCAL_WORKSPACE_ID, doc.id), false);
    assert.equal(await knowledgeDocumentRepository.findById(LOCAL_WORKSPACE_ID, doc.id), null);
  });

  it("rejects a non-local workspace id", async () => {
    await assert.rejects(() => knowledgeDocumentRepository.list("some-other-workspace", projectId));
  });
});

describe("knowledge search over Markdown (SQLite, Release 2E.1)", () => {
  let searchProjectId: string;

  async function titlesFor(search: string, project = searchProjectId): Promise<string[]> {
    const found = (await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project, { search })).documents;
    return found.map((d) => d.title).sort();
  }

  before(async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Search parity" });
    searchProjectId = project.id;
    for (const doc of SEARCH_PARITY_DOCUMENTS) {
      await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId: searchProjectId, ...doc });
    }
  });

  for (const [query, expected] of SEARCH_PARITY_QUERIES) {
    it(`search ${JSON.stringify(query)} matches ${JSON.stringify(expected)}`, async () => {
      assert.deepEqual(await titlesFor(query), [...expected].sort());
    });
  }

  it("keeps the Markdown source byte-for-byte", async () => {
    const source = "# H\n\n<script>x</script> [l](javascript:1) ![i](https://e.example/i.png)\n";
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId: searchProjectId, title: "Source", content: source });
    assert.equal((await knowledgeDocumentRepository.findById(LOCAL_WORKSPACE_ID, doc.id))?.content, source);
  });

  it("updates the derived text with every change to title, category or content", async () => {
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId: searchProjectId,
      title: "Rename me",
      content: "alpha **bravo**",
    });
    assert.deepEqual(await titlesFor("alpha bravo"), ["Rename me"]);
    await knowledgeDocumentRepository.update(LOCAL_WORKSPACE_ID, doc.id, { content: "charlie" });
    assert.deepEqual(await titlesFor("alpha bravo"), []);
    assert.deepEqual(await titlesFor("charlie"), ["Rename me"]);
    await knowledgeDocumentRepository.update(LOCAL_WORKSPACE_ID, doc.id, { title: "Renamed doc", category: "zulu" });
    assert.deepEqual(await titlesFor("renamed doc zulu charlie"), ["Renamed doc"]);
    await knowledgeDocumentRepository.update(LOCAL_WORKSPACE_ID, doc.id, { category: null });
    assert.deepEqual(await titlesFor("zulu"), []);
  });

  it("backfills pre-2E.1 rows lazily, without touching the source or updated_at", async () => {
    const { db } = await import("../../src/db/client");
    const { knowledgeDocuments } = await import("../../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Legacy" });
    // Exactly what a pre-2E.1 build wrote: no derived columns at all.
    db.insert(knowledgeDocuments)
      .values({
        id: "kdoc_legacy_1",
        projectId: project.id,
        title: "Old note",
        content: "Written as **plain** text, see [docs](https://legacy-dest.example).",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      })
      .run();

    const before = db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, "kdoc_legacy_1")).get()!;
    assert.equal(before.searchText, null);
    assert.equal(before.searchIndexedAt, null);

    // A plain list does not write anything.
    await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, project.id);
    assert.equal(db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, "kdoc_legacy_1")).get()!.searchText, null);

    assert.deepEqual(await titlesFor("plain text, see docs", project.id), ["Old note"]);
    assert.deepEqual(await titlesFor("legacy-dest", project.id), []);

    const after = db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, "kdoc_legacy_1")).get()!;
    assert.equal(after.content, before.content);
    assert.equal(after.updatedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(after.searchIndexedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(after.searchText, "old note written as plain text, see docs.");
  });

  it("re-derives a row an older build edited after a rollback (stale search_indexed_at)", async () => {
    const { db } = await import("../../src/db/client");
    const { knowledgeDocuments } = await import("../../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Rollback" });
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId: project.id, title: "Doc", content: "original words" });
    // An older build updates content and updated_at but knows nothing of search_text.
    db.update(knowledgeDocuments)
      .set({ content: "replacement words", updatedAt: "2099-01-01T00:00:00.000Z" })
      .where(eq(knowledgeDocuments.id, doc.id))
      .run();
    assert.deepEqual(await titlesFor("original", project.id), []);
    assert.deepEqual(await titlesFor("replacement", project.id), ["Doc"]);
  });

  it("never searches another project's documents", async () => {
    const other = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Other search" });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId: other.id, title: "Elsewhere", content: "release" });
    assert.deepEqual(await titlesFor("release"), ["Deploy runbook"]);
  });
});

describe("review M2: bounded, resumable legacy search indexing (SQLite)", () => {
  type Db = typeof import("../../src/db/client").db;
  let db: Db;
  let kd: typeof import("../../src/db/schema").knowledgeDocuments;
  let budgets: typeof import("../../src/core/knowledge/search-index");
  let orm: typeof import("drizzle-orm");

  before(async () => {
    ({ db } = await import("../../src/db/client"));
    ({ knowledgeDocuments: kd } = await import("../../src/db/schema"));
    budgets = await import("../../src/core/knowledge/search-index");
    orm = await import("drizzle-orm");
  });

  /** Inserts rows exactly as a pre-2E.1 build wrote them: no derived columns. */
  function insertLegacy(projectId: string, rows: { id: string; title?: string; content: string; category?: string | null; pinned?: boolean }[]) {
    for (let i = 0; i < rows.length; i += 100) {
      db.insert(kd)
        .values(
          rows.slice(i, i + 100).map((row, j) => ({
            id: row.id,
            projectId,
            title: row.title ?? `Legacy ${row.id}`,
            content: row.content,
            category: row.category ?? null,
            pinned: row.pinned ?? false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: `2026-01-02T00:00:${String((i + j) % 60).padStart(2, "0")}.000Z`,
          })),
        )
        .run();
    }
  }

  function snapshot(projectId: string) {
    return db
      .select({ id: kd.id, title: kd.title, content: kd.content, category: kd.category, pinned: kd.pinned, createdAt: kd.createdAt, updatedAt: kd.updatedAt })
      .from(kd)
      .where(orm.eq(kd.projectId, projectId))
      .orderBy(kd.id)
      .all();
  }

  function freshIds(projectId: string): string[] {
    return db
      .select({ id: kd.id })
      .from(kd)
      .where(orm.and(orm.eq(kd.projectId, projectId), orm.sql`${kd.searchIndexedAt} IS ${kd.updatedAt}`, orm.isNotNull(kd.searchText)))
      .orderBy(kd.id)
      .all()
      .map((r) => r.id);
  }

  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);

  it("re-derives one row-budget batch per search, reports pending honestly, and finds a late match once complete", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 rows" });
    const rowIds = ids("m2rows", 60);
    insertLegacy(
      project.id,
      rowIds.map((id, i) => ({ id, content: i === 59 ? "the **needle-zeta** is here" : `filler ${i}` })),
    );
    const before = snapshot(project.id);
    const rounds: { indexedNow: number; pending: number; complete: boolean; titles: string[] }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "needle-zeta" });
      rounds.push({ ...result.index, titles: result.documents.map((d) => d.title) });
    }
    assert.equal(budgets.SEARCH_INDEX_BATCH_ROWS, 25);
    assert.deepEqual(rounds, [
      { indexedNow: 25, pending: 35, complete: false, titles: [] },
      { indexedNow: 25, pending: 10, complete: false, titles: [] },
      { indexedNow: 10, pending: 0, complete: true, titles: ["Legacy m2rows-0059"] },
      { indexedNow: 0, pending: 0, complete: true, titles: ["Legacy m2rows-0059"] },
    ]);
    assert.deepEqual(snapshot(project.id), before, "source, timestamps, pinning and categories are unchanged");
  });

  it("a non-matching search has exactly the same limits and never claims to be complete early", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 nonmatching" });
    insertLegacy(project.id, ids("m2none", 30).map((id) => ({ id, content: "nothing relevant" })));
    const first = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "absent-term" });
    assert.deepEqual(first, { documents: [], index: { complete: false, pending: 5, indexedNow: 25 } });
    assert.deepEqual(freshIds(project.id), ids("m2none", 25), "the first batch is the first 25 ids, nothing more");
    const second = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "absent-term" });
    assert.deepEqual(second, { documents: [], index: { complete: true, pending: 0, indexedNow: 5 } });
  });

  it("stops a batch at the byte budget, always making progress", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 bytes" });
    // 50,000 two-byte characters: 100,000 bytes each, so two fit in 256 KiB and three do not.
    const wide = String.fromCodePoint(0xe9).repeat(50_000);
    insertLegacy(project.id, ids("m2bytes", 5).map((id) => ({ id, content: wide })));
    const progress: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      progress.push((await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "x" })).index.indexedNow);
    }
    assert.ok(2 * 100_000 <= budgets.SEARCH_INDEX_BATCH_BYTES && 3 * 100_000 > budgets.SEARCH_INDEX_BATCH_BYTES);
    assert.deepEqual(progress, [2, 2, 1]);
    assert.deepEqual(
      budgets.chooseSearchIndexBatch([{ id: "huge", bytes: budgets.SEARCH_INDEX_BATCH_BYTES * 4 }, { id: "next", bytes: 1 }]),
      ["huge"],
      "an oversized first row is still taken alone",
    );
  });

  it("leaves other projects untouched", async () => {
    const a = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 iso A" });
    const b = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 iso B" });
    insertLegacy(a.id, ids("m2isoa", 3).map((id) => ({ id, content: "alpha" })));
    insertLegacy(b.id, ids("m2isob", 3).map((id) => ({ id, content: "alpha" })));
    const result = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, a.id, { search: "alpha" });
    assert.equal(result.documents.length, 3);
    assert.deepEqual(freshIds(b.id), [], "project B was not indexed by a search in A");
  });

  it("indexes new writes immediately, even while legacy rows are pending", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 new writes" });
    insertLegacy(project.id, ids("m2new", 40).map((id) => ({ id, content: "old" })));
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId: project.id, title: "Fresh note", content: "brand-new-term" });
    const result = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "brand-new-term" });
    assert.deepEqual(result.documents.map((d) => d.title), ["Fresh note"]);
    assert.equal(result.index.complete, false);
  });

  it("concurrent searches never redo the same rows, and a concurrent edit keeps correctly derived text", async () => {
    const { buildKnowledgeSearchText } = await import("../../src/core/knowledge/markdown");
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 concurrency" });
    const rowIds = ids("m2conc", 60);
    insertLegacy(project.id, rowIds.map((id) => ({ id, content: "original" })));
    const [one, , two] = await Promise.all([
      knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "zzz" }),
      knowledgeDocumentRepository.update(LOCAL_WORKSPACE_ID, rowIds[40]!, { content: "edited **while** indexing" }),
      knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "zzz" }),
    ]);
    const fresh = freshIds(project.id);
    assert.equal(one.index.indexedNow + two.index.indexedNow + 1, fresh.length, "every refreshed row was refreshed once");
    assert.equal(new Set(fresh).size, fresh.length);
    const edited = db.select().from(kd).where(orm.eq(kd.id, rowIds[40]!)).get()!;
    assert.equal(edited.searchText, buildKnowledgeSearchText(edited));
    assert.equal(edited.searchIndexedAt, edited.updatedAt);
  });

  it("the API reports the pending state; a plain listing has no index state", async () => {
    const route = await import("../../src/app/api/projects/[id]/knowledge/route");
    const { NextRequest } = await import("next/server");
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 api" });
    insertLegacy(project.id, ids("m2api", 30).map((id) => ({ id, content: "api words" })));
    const get = async (qs: string) => {
      const res = await route.GET(new NextRequest(`http://localhost/api/projects/${project.id}/knowledge${qs}`), {
        params: Promise.resolve({ id: project.id }),
      });
      return { status: res.status, body: (await res.json()) as { documents: unknown[]; searchIndex?: unknown } };
    };
    const first = await get("?search=api%20words");
    assert.equal(first.status, 200);
    assert.equal(first.body.documents.length, 25);
    assert.deepEqual(first.body.searchIndex, { complete: false, pending: 5 });
    const second = await get("?search=api%20words");
    assert.equal(second.body.documents.length, 30);
    assert.deepEqual(second.body.searchIndex, { complete: true, pending: 0 });
    const plain = await get("");
    assert.equal(plain.body.documents.length, 30);
    assert.equal("searchIndex" in plain.body, false);
  });

  it("counts categories in the database", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "M2 categories" });
    for (const category of ["ops", "ops", "ops", "docs", "docs", null, "zeta"]) {
      await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId: project.id, title: `c ${category}`, category });
    }
    assert.deepEqual(await knowledgeDocumentRepository.categoryCounts(LOCAL_WORKSPACE_ID, project.id), [
      { name: "ops", count: 3 },
      { name: "docs", count: 2 },
      { name: "zeta", count: 1 },
    ]);
  });
});

describe("review C2: a stale non-NULL key never produces a match (SQLite)", () => {
  type Db = typeof import("../../src/db/client").db;
  let db: Db;
  let kd: typeof import("../../src/db/schema").knowledgeDocuments;
  let orm: typeof import("drizzle-orm");
  let buildKey: typeof import("../../src/core/knowledge/markdown").buildKnowledgeSearchText;

  before(async () => {
    ({ db } = await import("../../src/db/client"));
    ({ knowledgeDocuments: kd } = await import("../../src/db/schema"));
    orm = await import("drizzle-orm");
    ({ buildKnowledgeSearchText: buildKey } = await import("../../src/core/knowledge/markdown"));
  });

  const OLD_UPDATED = "2026-03-01T00:00:00.000Z";
  const OLDER_BUILD_EDIT = "2026-04-01T00:00:00.000Z";

  /**
   * 60 never-indexed rows that sort first, then `late`: indexed when it said
   * "removedterm", then edited by an older build to say "replacementterm" —
   * content and updated_at changed, search_text and search_indexed_at left
   * behind. So it is stale with a non-NULL key that still contains the old word.
   */
  function seedStaleNonNull(projectId: string, prefix: string): string {
    const legacy = Array.from({ length: 60 }, (_, i) => ({
      id: `${prefix}-a${String(i).padStart(4, "0")}`,
      projectId,
      title: `Filler ${i}`,
      content: "filler words",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    db.insert(kd).values(legacy).run();
    const lateId = `${prefix}-z-late`;
    const original = { title: "Late doc", category: null, content: "contains removedterm here" };
    db.insert(kd)
      .values({
        id: lateId,
        projectId,
        ...original,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: OLD_UPDATED,
        searchText: buildKey(original),
        searchIndexedAt: OLD_UPDATED,
      })
      .run();
    // The older build's edit.
    db.update(kd).set({ content: "contains replacementterm here", updatedAt: OLDER_BUILD_EDIT }).where(orm.eq(kd.id, lateId)).run();
    const row = db.select().from(kd).where(orm.eq(kd.id, lateId)).get()!;
    assert.ok(row.searchText!.includes("removedterm"), "precondition: the stale key still has the removed word");
    assert.notEqual(row.searchIndexedAt, row.updatedAt, "precondition: the row is stale");
    return lateId;
  }

  it("never returns the stale row for a removed term; the replacement term matches once refreshed; pending stays honest", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "C2 stale key" });
    const lateId = seedStaleNonNull(project.id, "c2s");
    const rounds = [];
    for (let i = 0; i < 3; i += 1) {
      const removed = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "removedterm" });
      rounds.push({ hits: removed.documents.map((d) => d.id), ...removed.index });
    }
    // 61 stale (60 NULL + 1 stale non-NULL): 25, 25, then the last 11.
    assert.deepEqual(rounds, [
      { hits: [], indexedNow: 25, pending: 36, complete: false },
      { hits: [], indexedNow: 25, pending: 11, complete: false },
      { hits: [], indexedNow: 11, pending: 0, complete: true },
    ]);
    const replaced = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "replacementterm" });
    assert.deepEqual(replaced.documents.map((d) => d.id), [lateId]);
    assert.deepEqual(replaced.index, { complete: true, pending: 0, indexedNow: 0 });

    const row = db.select().from(kd).where(orm.eq(kd.id, lateId)).get()!;
    assert.equal(row.content, "contains replacementterm here", "the source is what the older build wrote");
    assert.equal(row.updatedAt, OLDER_BUILD_EDIT, "updated_at is untouched by indexing");
    assert.equal(row.searchIndexedAt, OLDER_BUILD_EDIT);
    assert.ok(!row.searchText!.includes("removedterm"));
  });

  it("the replacement term is honestly pending, not found, before the stale row is refreshed", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "C2 replacement pending" });
    seedStaleNonNull(project.id, "c2p");
    const first = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "replacementterm" });
    assert.deepEqual(first.documents, []);
    assert.deepEqual(first.index, { complete: false, pending: 36, indexedNow: 25 });
  });

  it("the API never returns the stale row and reports the pending count", async () => {
    const route = await import("../../src/app/api/projects/[id]/knowledge/route");
    const { NextRequest } = await import("next/server");
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "C2 api" });
    seedStaleNonNull(project.id, "c2api");
    const res = await route.GET(new NextRequest(`http://localhost/api/projects/${project.id}/knowledge?search=removedterm`), {
      params: Promise.resolve({ id: project.id }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { documents: [], searchIndex: { complete: false, pending: 36 } });
  });

  it("a stale key in another project is neither returned nor indexed", async () => {
    const mine = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "C2 iso mine" });
    const other = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "C2 iso other" });
    const otherLate = seedStaleNonNull(other.id, "c2o");
    const result = await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, mine.id, { search: "removedterm" });
    assert.deepEqual(result, { documents: [], index: { complete: true, pending: 0, indexedNow: 0 } });
    const row = db.select().from(kd).where(orm.eq(kd.id, otherLate)).get()!;
    assert.notEqual(row.searchIndexedAt, row.updatedAt, "the other project's row is still stale");
  });

  it("a current-build edit of the stale row makes it fresh at once; the removed term still never matches", async () => {
    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "C2 edit" });
    const lateId = seedStaleNonNull(project.id, "c2e");
    const [removed, , edited] = await Promise.all([
      knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "removedterm" }),
      knowledgeDocumentRepository.update(LOCAL_WORKSPACE_ID, lateId, { content: "now says thirdterm" }),
      knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "thirdterm" }),
    ]);
    assert.deepEqual(removed.documents, []);
    assert.deepEqual(edited.documents.map((d) => d.id), [lateId]);
    const row = db.select().from(kd).where(orm.eq(kd.id, lateId)).get()!;
    assert.equal(row.searchText, buildKey(row));
    assert.equal(row.searchIndexedAt, row.updatedAt);
    assert.deepEqual((await knowledgeDocumentRepository.search(LOCAL_WORKSPACE_ID, project.id, { search: "removedterm" })).documents, []);
  });
});
