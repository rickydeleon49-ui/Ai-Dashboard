/**
 * Unit tests for the project policy core and its API route (AW4-01).
 *
 * Covers: schema bounds and refusals, round trip incl. an old-shape row,
 * argv[0] resolution at save time, `defaults` keeping other keys, toRunPolicy,
 * and GET/PUT/404/400 on /api/agent-projects/[id]/policy.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db";
import { agentProjectPolicies, projects } from "../../src/db/schema";
import {
  getPolicy,
  PolicyError,
  policySchema,
  savePolicy,
  toRunPolicy,
} from "../../src/core/agents/policy";
import type { ResolveResult } from "../../src/core/agents/resolve-executable";
import { DEFAULT_CHECK_TIMEOUT_SEC } from "../../src/core/agents/run-check";

let db: typeof import("../../src/db/client").db;
let policyRoute: typeof import("../../src/app/api/agent-projects/[id]/policy/route");

const originalEnv = {
  DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
  DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
  AUTH_MODE: process.env.AUTH_MODE,
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  DATABASE_URL: process.env.DATABASE_URL,
};

function enableDesktopEnv() {
  process.env.DASHBOARD_LOCAL = "1";
  process.env.DESKTOP_INTERNAL_SECRET = "test-internal-desktop-secret-xyz";
  delete process.env.AUTH_MODE;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.DATABASE_URL;
}

const NODE = process.execPath; // an absolute path that really exists
const fakeResolve = (command: string): ResolveResult =>
  command === "missing-tool"
    ? { ok: false, tried: ["/nowhere/missing-tool"] }
    : { ok: true, file: `/abs/${command}`, prefixArgs: [], source: command };

let n = 0;
function newProject(): string {
  const id = `prj-policy-${++n}`;
  db.insert(projects).values({ id, name: id, localPath: "H:/x" }).run();
  return id;
}
const rowOf = (id: string) =>
  db.select().from(agentProjectPolicies).where(eq(agentProjectPolicies.projectId, id)).get();

before(async () => {
  await migrate();
  ({ db } = await import("../../src/db/client"));
  policyRoute = await import("../../src/app/api/agent-projects/[id]/policy/route");
});

after(() => {
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  cleanup();
});

describe("policy schema", () => {
  const check = (over: Record<string, unknown> = {}) => ({ name: "lint", argv: ["npm", "run", "lint"], ...over });

  it("applies defaults", () => {
    const p = policySchema.parse({ checks: [check()] });
    assert.equal(p.checks[0]?.timeoutSec, DEFAULT_CHECK_TIMEOUT_SEC);
    assert.equal(p.checks[0]?.required, true);
    assert.deepEqual(p.excludedPaths, []);
    assert.deepEqual(p.dependencyLinks, []);
  });

  it("refuses duplicate check names, unknown keys and bad bounds", () => {
    assert.equal(policySchema.safeParse({ checks: [check(), check()] }).success, false);
    assert.equal(policySchema.safeParse({ checks: [check({ shell: true })] }).success, false);
    assert.equal(policySchema.safeParse({ checks: [check({ argv: [] })] }).success, false);
    assert.equal(policySchema.safeParse({ checks: [check({ argv: ["a".repeat(2001)] })] }).success, false);
    assert.equal(policySchema.safeParse({ checks: [check({ argv: Array(51).fill("a") })] }).success, false);
    assert.equal(policySchema.safeParse({ checks: [check({ timeoutSec: 0 })] }).success, false);
    assert.equal(policySchema.safeParse({ checks: [check({ timeoutSec: 3601 })] }).success, false);
    assert.equal(policySchema.safeParse({ checks: [check({ name: "has space" })] }).success, false);
    const many = Array.from({ length: 21 }, (_, i) => check({ name: `c${i}` }));
    assert.equal(policySchema.safeParse({ checks: many }).success, false);
  });

  it("refuses absolute paths and .. in excludedPaths", () => {
    for (const bad of ["/etc/**", "\\x", "C:/Windows", "a/../b", "..\\b", ""]) {
      assert.equal(policySchema.safeParse({ excludedPaths: [bad] }).success, false, bad);
    }
    assert.equal(policySchema.safeParse({ excludedPaths: Array(201).fill("a") }).success, false);
    assert.equal(policySchema.safeParse({ excludedPaths: ["a".repeat(501)] }).success, false);
    assert.equal(policySchema.safeParse({ excludedPaths: ["secrets/**", ".env*"] }).success, true);
  });

  it("refuses absolute paths and .. in dependencyLinks, and more than 20", () => {
    for (const bad of ["/abs", "C:\\x", "../up", "a/../b"]) {
      assert.equal(policySchema.safeParse({ dependencyLinks: [bad] }).success, false, bad);
    }
    assert.equal(policySchema.safeParse({ dependencyLinks: Array(21).fill("a") }).success, false);
    assert.equal(policySchema.safeParse({ dependencyLinks: ["node_modules", ".venv"] }).success, true);
  });
});

describe("getPolicy / savePolicy", () => {
  it("returns the empty default when there is no row", () => {
    assert.deepEqual(getPolicy(db, newProject()), { checks: [], excludedPaths: [], dependencyLinks: [] });
  });

  it("round trips and resolves argv[0] to an absolute path", () => {
    const id = newProject();
    const saved = savePolicy(
      db,
      id,
      {
        checks: [{ name: "unit", argv: ["npm", "test"], timeoutSec: 90, required: false }],
        excludedPaths: ["secrets/**"],
        dependencyLinks: ["node_modules"],
      },
      { resolve: fakeResolve },
    );
    assert.equal(saved.checks[0]?.argv[0], "/abs/npm");
    assert.deepEqual(getPolicy(db, id), saved);
    assert.equal(rowOf(id)?.testRestrictions, "[]");
    assert.deepEqual(JSON.parse(rowOf(id)?.defaults ?? ""), { dependencyLinks: ["node_modules"] });
  });

  it("resolves a real executable path with the default resolver and is idempotent", () => {
    const id = newProject();
    const first = savePolicy(db, id, { checks: [{ name: "node", argv: [NODE, "-v"] }] });
    assert.equal(first.checks[0]?.argv[0], NODE);
    const second = savePolicy(db, id, first);
    assert.deepEqual(second, first);
  });

  it("reads an old-shape row", () => {
    const id = newProject();
    db.insert(agentProjectPolicies)
      .values({
        projectId: id,
        checkCommands: JSON.stringify([
          { name: "ok", argv: [NODE, "-v"] },
          { name: "slow", argv: [NODE], timeoutSec: 5 },
        ]),
        excludedPaths: JSON.stringify(["secrets/**"]),
      })
      .run();
    const p = getPolicy(db, id);
    assert.equal(p.checks[0]?.required, true);
    assert.equal(p.checks[0]?.timeoutSec, DEFAULT_CHECK_TIMEOUT_SEC);
    assert.equal(p.checks[1]?.timeoutSec, 5);
    assert.deepEqual(p.dependencyLinks, []);
  });

  it("throws a clear error for a stored row that does not parse", () => {
    const id = newProject();
    db.insert(agentProjectPolicies).values({ projectId: id, checkCommands: "{not json" }).run();
    assert.throws(() => getPolicy(db, id), /check_commands is not valid JSON/);
    const id2 = newProject();
    db.insert(agentProjectPolicies)
      .values({ projectId: id2, excludedPaths: JSON.stringify(["/abs"]) })
      .run();
    assert.throws(() => getPolicy(db, id2), /relative/);
  });

  it("refuses the save when argv[0] cannot be resolved, naming the check, and writes nothing", () => {
    const id = newProject();
    assert.throws(
      () =>
        savePolicy(
          db,
          id,
          { checks: [{ name: "ok", argv: ["npm"] }, { name: "bad", argv: ["missing-tool", "x"] }] },
          { resolve: fakeResolve },
        ),
      (err: unknown) =>
        err instanceof PolicyError && /checks\.1\.argv\.0/.test(err.message) && /"bad"/.test(err.message),
    );
    assert.equal(rowOf(id), undefined);
  });

  it("refuses an invalid policy with a PolicyError", () => {
    assert.throws(
      () => savePolicy(db, newProject(), { excludedPaths: ["../x"] }, { resolve: fakeResolve }),
      PolicyError,
    );
  });

  it("keeps other keys in defaults and updates updated_at", () => {
    const id = newProject();
    db.insert(agentProjectPolicies)
      .values({
        projectId: id,
        defaults: JSON.stringify({ planner: "claude", dependencyLinks: ["old"] }),
        updatedAt: "2020-01-01T00:00:00.000Z",
      })
      .run();
    savePolicy(db, id, { dependencyLinks: [".venv"] }, { resolve: fakeResolve });
    const row = rowOf(id);
    assert.deepEqual(JSON.parse(row?.defaults ?? ""), { planner: "claude", dependencyLinks: [".venv"] });
    assert.notEqual(row?.updatedAt, "2020-01-01T00:00:00.000Z");
  });

  it("toRunPolicy carries required and timeouts for the orchestrator", () => {
    const rp = toRunPolicy(
      policySchema.parse({ checks: [{ name: "a", argv: ["x"], required: false }], excludedPaths: ["s/**"] }),
    );
    assert.deepEqual(rp, {
      checks: [{ name: "a", argv: ["x"], timeoutSec: DEFAULT_CHECK_TIMEOUT_SEC, required: false }],
      excludedPaths: ["s/**"],
      dependencyLinks: [],
    });
  });
});

describe("/api/agent-projects/[id]/policy", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const url = (id: string) => `http://localhost/api/agent-projects/${id}/policy`;
  const put = (id: string, body: unknown, raw?: string) =>
    policyRoute.PUT(
      new NextRequest(url(id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: raw ?? JSON.stringify(body),
      }),
      ctx(id),
    );

  it("404 with an empty body outside desktop mode", async () => {
    delete process.env.DASHBOARD_LOCAL;
    delete process.env.DESKTOP_INTERNAL_SECRET;
    const id = newProject();
    const g = await policyRoute.GET(new NextRequest(url(id)), ctx(id));
    assert.equal(g.status, 404);
    assert.equal(await g.text(), "");
    const p = await put(id, {});
    assert.equal(p.status, 404);
    assert.equal(rowOf(id), undefined);
  });

  it("404 for an unknown project", async () => {
    enableDesktopEnv();
    assert.equal((await policyRoute.GET(new NextRequest(url("nope")), ctx("nope"))).status, 404);
    assert.equal((await put("nope", {})).status, 404);
  });

  it("GET returns the empty default, PUT stores, GET returns it back", async () => {
    enableDesktopEnv();
    const id = newProject();
    const g1 = await policyRoute.GET(new NextRequest(url(id)), ctx(id));
    assert.equal(g1.status, 200);
    assert.deepEqual((await g1.json()).policy, { checks: [], excludedPaths: [], dependencyLinks: [] });

    const res = await put(id, {
      checks: [{ name: "node", argv: [NODE, "-v"], required: false }],
      excludedPaths: ["secrets/**"],
      dependencyLinks: ["node_modules"],
    });
    assert.equal(res.status, 200);
    const stored = (await res.json()).policy;
    assert.equal(stored.checks[0].argv[0], NODE);
    assert.equal(stored.checks[0].required, false);

    const g2 = await policyRoute.GET(new NextRequest(url(id)), ctx(id));
    assert.deepEqual((await g2.json()).policy, stored);
  });

  it("400 for invalid JSON, schema problems and unresolvable commands", async () => {
    enableDesktopEnv();
    const id = newProject();
    assert.equal((await put(id, null, "{nope")).status, 400);

    const bad = await put(id, { excludedPaths: ["/etc"] });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0);

    const unresolved = await put(id, { checks: [{ name: "x", argv: ["definitely-not-a-real-tool-aw4"] }] });
    assert.equal(unresolved.status, 400);
    assert.match((await unresolved.json()).error, /cannot find "definitely-not-a-real-tool-aw4"/);
    assert.equal(rowOf(id), undefined);
  });

  it("413 for an oversized body", async () => {
    enableDesktopEnv();
    const id = newProject();
    const res = await put(id, null, JSON.stringify({ excludedPaths: ["a".repeat(300 * 1024)] }));
    assert.equal(res.status, 413);
  });
});
