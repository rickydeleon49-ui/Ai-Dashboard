/**
 * The ownership-claim API route (SaaS Phase 1, step 9) against a real
 * Postgres-backed, real signed-in Auth.js session — not mocked. Lives
 * alongside auth.test.ts (same --conditions=react-server-free run, same
 * NODE_OPTIONS server-only stub; see that file's header comment) because
 * this route calls src/core/auth/session.ts, which dynamically imports
 * src/auth.ts, the same fragile import graph. SQLite-side coverage (the
 * actual import, double-claim rejection, source data untouched) lives in
 * tests/unit-pg/ownership-claim.test.ts instead — this file only exercises
 * what's specific to being a real HTTP route: auth and status codes.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup as cleanupPg, migrate as migratePg } from "../helpers/db.pg";
import { cleanup as cleanupSqlite, migrate as migrateSqlite, withLegacySqlite } from "../helpers/db";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";

type ClaimRoute = typeof import("../../src/app/api/ownership-claim/route");
let claimRoute: ClaimRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  // Both throwaway databases: the happy-path test below claims for real,
  // which reads SQLite (see src/core/ownership-claim/service.ts) — without
  // its own migrated throwaway database, that would fall through to
  // resolveDatabasePath()'s default and either touch a real dev database or
  // fail on an unmigrated one.
  await migratePg();
  await migrateSqlite();
  claimRoute = await import("../../src/app/api/ownership-claim/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
});

after(async () => {
  await cleanupPg();
  await cleanupSqlite();
});

/** Runs fn while capturing console.log lines, since that's where the magic link goes when no real mail server is configured. */
async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return [await fn(), lines];
  } finally {
    console.log = original;
  }
}

/** A minimal cookie jar: absorbs Set-Cookie from a response, replays as Cookie on the next request. */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    header(): string {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    absorb(response: Response): void {
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value === "") jar.delete(key);
        else jar.set(key, value);
      }
    },
  };
}

/** Signs in a fresh user via magic link and returns a Cookie header carrying a valid session. */
async function signIn(email: string): Promise<string> {
  const jar = cookieJar();

  const csrfResponse = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
  jar.absorb(csrfResponse);
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const signinBody = new URLSearchParams({ email, csrfToken, callbackUrl: "http://localhost/" });
  const [signinResponse, logs] = await withCapturedLogs(() =>
    handlers.POST(
      new NextRequest("http://localhost/api/auth/signin/nodemailer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
        body: signinBody.toString(),
      }),
    ),
  );
  jar.absorb(signinResponse);

  const magicLinkLine = logs.find((line) => line.includes(`magic link for ${email}`));
  const magicLink = magicLinkLine?.match(/(http:\S+)/)?.[1];
  if (!magicLink) throw new Error(`no magic link logged for ${email}: ${JSON.stringify(logs)}`);

  const callbackResponse = await handlers.GET(
    new NextRequest(magicLink, { headers: { cookie: jar.header() } }),
  );
  jar.absorb(callbackResponse);
  assert.equal(callbackResponse.status, 302, "sign-in callback should redirect on success");

  return jar.header();
}

/** Builds a request carrying the headers Auth.js's session lookup needs — see proxy-accounts-mode.test.ts's header comment for why both are required. */
function apiRequest(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

const ORIGINAL_PASSWORD = process.env.DASHBOARD_PASSWORD;
after(() => {
  if (ORIGINAL_PASSWORD === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = ORIGINAL_PASSWORD;
});

describe("POST /api/ownership-claim: not configured", () => {
  it("refuses when DATABASE_URL is not set", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const response = await claimRoute.POST(
        apiRequest("POST", "/api/ownership-claim", { body: { password: "x" } }),
      );
      assert.equal(response.status, 404);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});

describe("POST /api/ownership-claim", () => {
  it("requires a session", async () => {
    const response = await claimRoute.POST(
      apiRequest("POST", "/api/ownership-claim", { body: { password: "x" } }),
    );
    assert.equal(response.status, 401);
  });

  it("rejects an empty password", async () => {
    const cookie = await signIn("claim-empty-password@example.com");
    const response = await claimRoute.POST(
      apiRequest("POST", "/api/ownership-claim", { cookie, body: { password: "" } }),
    );
    assert.equal(response.status, 422);
  });

  it("returns 404 when this deployment has no DASHBOARD_PASSWORD configured", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const cookie = await signIn("claim-not-available@example.com");
    const response = await claimRoute.POST(
      apiRequest("POST", "/api/ownership-claim", { cookie, body: { password: "anything" } }),
    );
    assert.equal(response.status, 404);
  });

  it("returns 401 for a session that supplies the wrong password", async () => {
    process.env.DASHBOARD_PASSWORD = "the-real-password";
    const cookie = await signIn("claim-wrong-password@example.com");
    const response = await claimRoute.POST(
      apiRequest("POST", "/api/ownership-claim", { cookie, body: { password: "nope" } }),
    );
    assert.equal(response.status, 401);
  });

  it("claims successfully with a valid session and the right password, then rejects a second attempt", async () => {
    process.env.DASHBOARD_PASSWORD = "the-real-password";
    const cookie = await signIn("claim-success@example.com");

    // Seed a legacy SQLite project to prove the API route actually migrates from the intended legacy database
    await withLegacySqlite(async () => {
      const { DrizzleProjectRepository } = await import(
        "../../src/db/repositories/drizzle-project-repository"
      );
      const { LOCAL_WORKSPACE_ID } = await import(
        "../../src/db/repositories/project-repository"
      );
      await new DrizzleProjectRepository().create(LOCAL_WORKSPACE_ID, {
        name: "Legacy SQLite App Via API",
        source: "manual",
      });
    });

    const first = await claimRoute.POST(
      apiRequest("POST", "/api/ownership-claim", { cookie, body: { password: "the-real-password" } }),
    );
    assert.equal(first.status, 200);
    const body = (await first.json()) as { workspaceId: string; projectsImported: number };
    assert.ok(body.workspaceId);
    assert.equal(body.projectsImported, 1);

    // Verify exception is unavailable after claim completion: ordinary access is refused
    const { db: sqliteDb } = await import("../../src/db/client");
    const { projects } = await import("../../src/db/schema");
    assert.throws(
      () => sqliteDb.select().from(projects).all(),
      /SQLite connection refused/,
    );

    const second = await claimRoute.POST(
      apiRequest("POST", "/api/ownership-claim", { cookie, body: { password: "the-real-password" } }),
    );
    assert.equal(second.status, 409);
  });

  it("returns 403 and does not return workspaceId when another authenticated account tries to resume a partial claim", async () => {
    process.env.DASHBOARD_PASSWORD = "the-real-password";
    const { getPgDb } = await import("../../src/db/pg-client");
    const { ownershipClaims, users, workspaces, workspaceMembers } = await import("../../src/db/schema.pg");

    const db = getPgDb();
    await db.delete(ownershipClaims);

    // Setup an incomplete claim belonging to User A
    const userA = "user_victim_a";
    const wsA = "ws_victim_a";
    await db.insert(users).values({ id: userA, email: "user_a@example.com" }).onConflictDoNothing();
    await db.insert(workspaces).values({ id: wsA, name: "Victim WS", slug: "victim-ws", kind: "personal", createdBy: userA }).onConflictDoNothing();
    await db.insert(workspaceMembers).values({ workspaceId: wsA, userId: userA, role: "owner" }).onConflictDoNothing();

    await db.insert(ownershipClaims).values({
      id: "singleton",
      claimedBy: userA,
      workspaceId: wsA,
      status: "partially_completed",
      projectsImported: 1,
      importedProjectIds: ["prj_1"],
      claimedAt: new Date(),
      updatedAt: new Date(),
    });

    // Attacker User B signs in with valid credentials and supplies correct DASHBOARD_PASSWORD
    const cookieB = await signIn("attacker-b@example.com");
    const res = await claimRoute.POST(
      apiRequest("POST", "/api/ownership-claim", { cookie: cookieB, body: { password: "the-real-password" } }),
    );

    assert.equal(res.status, 403, "Must return 403 Forbidden for claimant mismatch");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.workspaceId, undefined, "Must NOT return another user's workspace identifier");
    assert.match(String(body.error), /original claimant/i);
  });
});
