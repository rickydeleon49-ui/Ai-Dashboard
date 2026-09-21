/**
 * PostgreSQL comment timestamps come from the database clock, truncated to
 * milliseconds, so horizontally scaled app instances can't drift the ordering,
 * and the cursor (which round-trips through a JavaScript Date) stays exact.
 *
 * No test here waits on a timer to make ordering work: ties are forced
 * directly, and ordering is checked against PostgreSQL's own ORDER BY.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let schema: typeof import("../../src/db/schema.pg");
let commentRepo: import("../../src/db/repositories/postgres-comment-repository").PostgresCommentRepository;
let sqlTag: typeof import("drizzle-orm").sql;

const WS = "ws-comment-ts";
const AUTHOR = "b1111111-1111-4111-8111-111111111111";
let taskId: string;

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  schema = await import("../../src/db/schema.pg");
  ({ sql: sqlTag } = await import("drizzle-orm"));
  const { PostgresCommentRepository } = await import("../../src/db/repositories/postgres-comment-repository");
  const { PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository");
  const { PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository");
  commentRepo = new PostgresCommentRepository();

  await db().insert(schema.users).values({ id: AUTHOR, name: "Author", email: "ts-author@example.test" });
  await db().insert(schema.workspaces).values({ id: WS, name: WS, slug: WS, kind: "team" });
  await db()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: WS, userId: AUTHOR, role: "member", status: "active" });
  const project = await new PostgresProjectRepository().create(WS, { name: "Timestamps" });
  taskId = (
    await new PostgresTaskRepository().create(WS, { projectId: project.id, title: "T" }, { actorUserId: AUTHOR })
  ).id;
});

after(() => cleanup());

/** Sub-millisecond remainder (in microseconds) of each timestamp column, straight from PostgreSQL. */
async function remainders(commentId: string) {
  const result = await db().execute<{ created: string; updated: string; deleted: string | null }>(sqlTag`
    SELECT (extract(microseconds FROM created_at)::bigint % 1000)::text AS created,
           (extract(microseconds FROM updated_at)::bigint % 1000)::text AS updated,
           (extract(microseconds FROM deleted_at)::bigint % 1000)::text AS deleted
      FROM task_comment WHERE id = ${commentId}`);
  return result.rows[0]!;
}

async function dbNowMs(): Promise<number> {
  const result = await db().execute<{ now: string }>(
    sqlTag`SELECT (extract(epoch FROM date_trunc('milliseconds', statement_timestamp())) * 1000)::bigint::text AS now`,
  );
  return Number(result.rows[0]!.now);
}

/** Captures the SQL text of every query sent while `fn` runs. */
async function captureSql<T>(fn: () => Promise<T>): Promise<[T, { text: string; values: unknown[] }[]]> {
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  const seen: { text: string; values: unknown[] }[] = [];
  proto.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; values?: unknown[] };
    if (typeof first === "string") seen.push({ text: first, values: (args[1] as unknown[]) ?? [] });
    else if (first && typeof first.text === "string") seen.push({ text: first.text, values: first.values ?? [] });
    return original.apply(this, args);
  };
  try {
    return [await fn(), seen];
  } finally {
    proto.query = original;
  }
}

async function pageAll(limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await commentRepo.list(WS, taskId, { limit, ...(cursor ? { cursor } : {}) });
    ids.push(...page.comments.map((c) => c.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

async function orderedByDatabase(): Promise<string[]> {
  const result = await db().execute<{ id: string }>(
    sqlTag`SELECT id FROM task_comment WHERE workspace_id = ${WS} AND task_id = ${taskId} ORDER BY created_at, id`,
  );
  return result.rows.map((r) => r.id);
}

describe("PostgreSQL comment timestamps", () => {
  it("persists created, updated, and deleted timestamps with no sub-millisecond remainder", async () => {
    const comment = await commentRepo.create(WS, taskId, { body: "precision" }, { actorUserId: AUTHOR });
    await commentRepo.update(WS, taskId, comment.id, { body: "precision v2" }, { actorUserId: AUTHOR });
    await commentRepo.delete(WS, taskId, comment.id, { actorUserId: AUTHOR });
    assert.deepEqual(await remainders(comment.id), { created: "0", updated: "0", deleted: "0" });
  });

  it("takes created and updated timestamps from the database expression, not the app clock", async () => {
    const before = await dbNowMs();
    const [comment, createSql] = await captureSql(() =>
      commentRepo.create(WS, taskId, { body: "db clock" }, { actorUserId: AUTHOR }),
    );
    const afterCreate = await dbNowMs();

    const insert = createSql.find((q) => /insert into "task_comment"/i.test(q.text));
    assert.ok(insert, "the comment INSERT was captured");
    assert.match(insert.text, /date_trunc\('milliseconds', statement_timestamp\(\) AT TIME ZONE 'UTC'\)/);
    assert.ok(!insert.values.some((v) => v instanceof Date), "no app-clock Date is bound as a parameter");

    const created = Date.parse(comment.createdAt);
    assert.equal(comment.createdAt, comment.updatedAt, "one statement stamps both columns identically");
    assert.ok(created >= before && created <= afterCreate, "created_at falls inside the database clock bracket");

    const [updated, updateSql] = await captureSql(() =>
      commentRepo.update(WS, taskId, comment.id, { body: "db clock v2" }, { actorUserId: AUTHOR }),
    );
    const update = updateSql.find((q) => /update "task_comment"/i.test(q.text));
    assert.ok(update, "the comment UPDATE was captured");
    assert.match(update.text, /statement_timestamp\(\)/);
    assert.ok(!update.values.some((v) => v instanceof Date), "no app-clock Date is bound on update");
    assert.ok(updated);
    assert.ok(Date.parse(updated.updatedAt) >= created, "updated_at never precedes created_at");

    const [, deleteSql] = await captureSql(() =>
      commentRepo.delete(WS, taskId, comment.id, { actorUserId: AUTHOR }),
    );
    const del = deleteSql.find((q) => /update "task_comment"/i.test(q.text));
    assert.ok(del, "the soft-delete UPDATE was captured");
    assert.match(del.text, /statement_timestamp\(\)/);
    assert.ok(!del.values.some((v) => v instanceof Date), "no app-clock Date is bound on delete");
  });

  it("orders equal-millisecond comments deterministically by id and paginates them exactly", async () => {
    const tied = new Date("2030-01-01T00:00:00.123Z");
    const ids = Array.from({ length: 7 }, () => crypto.randomUUID());
    await db()
      .insert(schema.taskComments)
      .values(ids.map((id) => ({ id, workspaceId: WS, taskId, authorId: AUTHOR, body: `tied ${id}`, createdAt: tied, updatedAt: tied })));

    const expected = await orderedByDatabase();
    const tiedById = await db().execute<{ id: string }>(
      sqlTag`SELECT id FROM task_comment WHERE task_id = ${taskId} AND created_at = ${tied.toISOString()}::timestamp ORDER BY id`,
    );
    const listed = (await commentRepo.list(WS, taskId, { limit: 100 })).comments.map((c) => c.id);
    assert.deepEqual(
      listed.filter((id) => ids.includes(id)),
      tiedById.rows.map((r) => r.id),
      "rows sharing a millisecond come back in id order",
    );

    for (const pageSize of [1, 2, 3]) {
      const seen = await pageAll(pageSize);
      assert.equal(new Set(seen).size, seen.length, `no duplicates at page size ${pageSize}`);
      assert.deepEqual(seen, expected, `no skips and database order at page size ${pageSize}`);
    }
  });

  it("stays stable under concurrent comment creation", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        commentRepo.create(WS, taskId, { body: `concurrent ${i}` }, { actorUserId: AUTHOR }),
      ),
    );
    const created = results.map((r) => {
      assert.equal(r.status, "fulfilled");
      return (r as PromiseFulfilledResult<{ id: string }>).value.id;
    });

    for (const id of created) {
      const rem = await remainders(id);
      assert.equal(rem.created, "0");
      assert.equal(rem.updated, "0");
    }

    const expected = await orderedByDatabase();
    const first = await pageAll(3);
    const second = await pageAll(4);
    assert.deepEqual(first, expected, "cursor paging matches database order");
    assert.deepEqual(second, expected, "a different page size yields the same sequence");
    for (const id of created) assert.ok(first.includes(id), "every concurrent comment is returned");
    assert.equal(new Set(first).size, first.length, "no duplicates");
  });
});
