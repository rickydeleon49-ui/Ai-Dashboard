/**
 * The Workspace Members API (Release 2C.1) against a real Postgres-backed,
 * real signed-in Auth.js session — not mocked.
 *
 * Covers:
 * - accounts mode disabled (404)
 * - unauthenticated callers (401)
 * - full role matrix across all endpoints:
 *   owner, admin, member, viewer, suspended member, removed member, outsider
 * - cross-workspace attempts and tenant isolation
 * - admin-to-owner escalation prevention
 * - last-active-owner protection (409)
 * - query parameter validation (422) and body validation (422)
 * - pagination bounds and search through API
 * - response-shape allowlist: safe user-summary only
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";

type MembersRoute = typeof import("../../src/app/api/workspaces/[id]/members/route");
type MemberRoute = typeof import("../../src/app/api/workspaces/[id]/members/[userId]/route");
type WorkspacesRoute = typeof import("../../src/app/api/workspaces/route");

let membersRoute: MembersRoute;
let memberRoute: MemberRoute;
let workspacesRoute: WorkspacesRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let getPgDb: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;

before(async () => {
  await migrate();
  membersRoute = await import("../../src/app/api/workspaces/[id]/members/route");
  memberRoute = await import("../../src/app/api/workspaces/[id]/members/[userId]/route");
  workspacesRoute = await import("../../src/app/api/workspaces/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb } = await import("../../src/db/pg-client"));
  ({ users, workspaceMembers } = await import("../../src/db/schema.pg"));
});

after(() => cleanup());

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

async function getUserIdByEmail(email: string): Promise<string> {
  const db = getPgDb();
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!u) throw new Error(`User not found: ${email}`);
  return u.id;
}

async function signInWithTeamWorkspace(
  email: string,
  workspaceName: string,
): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await signIn(email);
  const response = await workspacesRoute.POST(
    apiRequest("POST", "/api/workspaces", { cookie, body: { name: workspaceName } }),
  );
  const { workspace } = (await response.json()) as { workspace: { id: string } };
  const userId = await getUserIdByEmail(email);
  return { cookie, workspaceId: workspace.id, userId };
}

describe("Members API: not configured (accounts mode disabled)", () => {
  it("refuses GET, PATCH, and DELETE when DATABASE_URL is not set", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const getRes = await membersRoute.GET(
        apiRequest("GET", "/api/workspaces/x/members"),
        { params: Promise.resolve({ id: "x" }) },
      );
      assert.equal(getRes.status, 404);

      const patchRes = await memberRoute.PATCH(
        apiRequest("PATCH", "/api/workspaces/x/members/y", { body: { role: "admin" } }),
        { params: Promise.resolve({ id: "x", userId: "y" }) },
      );
      assert.equal(patchRes.status, 404);

      const delRes = await memberRoute.DELETE(
        apiRequest("DELETE", "/api/workspaces/x/members/y"),
        { params: Promise.resolve({ id: "x", userId: "y" }) },
      );
      assert.equal(delRes.status, 404);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});

describe("Members API: unauthenticated requests", () => {
  it("rejects unauthenticated GET, PATCH, and DELETE with 401", async () => {
    const getRes = await membersRoute.GET(
      apiRequest("GET", "/api/workspaces/ws_fake/members"),
      { params: Promise.resolve({ id: "ws_fake" }) },
    );
    assert.equal(getRes.status, 401);

    const patchRes = await memberRoute.PATCH(
      apiRequest("PATCH", "/api/workspaces/ws_fake/members/u_fake", { body: { role: "admin" } }),
      { params: Promise.resolve({ id: "ws_fake", userId: "u_fake" }) },
    );
    assert.equal(patchRes.status, 401);

    const delRes = await memberRoute.DELETE(
      apiRequest("DELETE", "/api/workspaces/ws_fake/members/u_fake"),
      { params: Promise.resolve({ id: "ws_fake", userId: "u_fake" }) },
    );
    assert.equal(delRes.status, 401);
  });
});

describe("Members API: GET /api/workspaces/[id]/members full role matrix & visibility", () => {
  let wsId: string;
  let ownerCookie: string;
  let adminCookie: string;
  let memberCookie: string;
  let viewerCookie: string;
  let suspendedCookie: string;
  let removedCookie: string;
  let outsiderCookie: string;

  before(async () => {
    const ts = Date.now();
    const owner = await signInWithTeamWorkspace(`owner_${ts}@example.com`, "Matrix Co");
    wsId = owner.workspaceId;
    ownerCookie = owner.cookie;

    adminCookie = await signIn(`admin_${ts}@example.com`);
    const adminId = await getUserIdByEmail(`admin_${ts}@example.com`);

    memberCookie = await signIn(`member_${ts}@example.com`);
    const memberId = await getUserIdByEmail(`member_${ts}@example.com`);

    viewerCookie = await signIn(`viewer_${ts}@example.com`);
    const viewerId = await getUserIdByEmail(`viewer_${ts}@example.com`);

    suspendedCookie = await signIn(`suspended_${ts}@example.com`);
    const suspendedId = await getUserIdByEmail(`suspended_${ts}@example.com`);

    removedCookie = await signIn(`removed_${ts}@example.com`);
    const removedId = await getUserIdByEmail(`removed_${ts}@example.com`);

    const outsider = await signInWithTeamWorkspace(`outsider_${ts}@example.com`, "Other Co");
    outsiderCookie = outsider.cookie;

    const db = getPgDb();
    await db.insert(workspaceMembers).values([
      { workspaceId: wsId, userId: adminId, role: "admin", status: "active" },
      { workspaceId: wsId, userId: memberId, role: "member", status: "active" },
      { workspaceId: wsId, userId: viewerId, role: "viewer", status: "active" },
      { workspaceId: wsId, userId: suspendedId, role: "member", status: "suspended" },
      { workspaceId: wsId, userId: removedId, role: "viewer", status: "removed" },
    ]);
  });

  it("allows owner, admin, member, and viewer to access directory", async () => {
    const ctx = { params: Promise.resolve({ id: wsId }) };

    const ownerRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: ownerCookie }), ctx);
    assert.equal(ownerRes.status, 200);

    const adminRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: adminCookie }), ctx);
    assert.equal(adminRes.status, 200);

    const memberRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: memberCookie }), ctx);
    assert.equal(memberRes.status, 200);

    const viewerRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: viewerCookie }), ctx);
    assert.equal(viewerRes.status, 200);
  });

  it("rejects suspended and removed members with 403 inactive_member", async () => {
    const ctx = { params: Promise.resolve({ id: wsId }) };

    const suspendedRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: suspendedCookie }), ctx);
    assert.equal(suspendedRes.status, 403);
    const suspendedBody = await suspendedRes.json();
    assert.match(suspendedBody.error, /not active|suspended|inactive/i);

    const removedRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: removedCookie }), ctx);
    assert.equal(removedRes.status, 403);
  });

  it("rejects outsider and unknown workspace with 403 not_a_member", async () => {
    const ctx = { params: Promise.resolve({ id: wsId }) };
    const outsiderRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: outsiderCookie }), ctx);
    assert.equal(outsiderRes.status, 403);

    const unknownCtx = { params: Promise.resolve({ id: "ws_nonexistent_999" }) };
    const unknownRes = await membersRoute.GET(apiRequest("GET", "/api/workspaces/ws_nonexistent_999/members", { cookie: ownerCookie }), unknownCtx);
    assert.equal(unknownRes.status, 403);
  });

  it("enforces directory visibility: non-admins see only active; requesting non-active returns 403", async () => {
    const ctx = { params: Promise.resolve({ id: wsId }) };

    // Viewer default: active only (4 active members: owner, admin, member, viewer)
    const viewerDefaultRes = await membersRoute.GET(apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: viewerCookie }), ctx);
    const viewerDefault = await viewerDefaultRes.json();
    assert.equal(viewerDefault.members.length, 4);
    assert.equal(viewerDefault.members.every((m: { status: string }) => m.status === "active"), true);

    // Viewer requesting non-active status: 403
    const viewerFilterRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?status=suspended`, { cookie: viewerCookie }),
      ctx,
    );
    assert.equal(viewerFilterRes.status, 403);

    // Member requesting status=all: 403
    const memberAllRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?status=all`, { cookie: memberCookie }),
      ctx,
    );
    assert.equal(memberAllRes.status, 403);

    // Admin requesting status=all: 200 (all 6 members)
    const adminAllRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?status=all`, { cookie: adminCookie }),
      ctx,
    );
    assert.equal(adminAllRes.status, 200);
    const adminAll = await adminAllRes.json();
    assert.equal(adminAll.members.length, 6);

    // Owner requesting status=suspended: 200 (1 suspended member)
    const ownerSuspendedRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?status=suspended`, { cookie: ownerCookie }),
      ctx,
    );
    assert.equal(ownerSuspendedRes.status, 200);
    const ownerSuspended = await ownerSuspendedRes.json();
    assert.equal(ownerSuspended.members.length, 1);
    assert.equal(ownerSuspended.members[0].status, "suspended");
  });

  it("validates query parameters with 422 on invalid values", async () => {
    const ctx = { params: Promise.resolve({ id: wsId }) };

    const badStatusRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?status=invalid_status`, { cookie: ownerCookie }),
      ctx,
    );
    assert.equal(badStatusRes.status, 422);

    const badLimitRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?limit=-5`, { cookie: ownerCookie }),
      ctx,
    );
    assert.equal(badLimitRes.status, 422);

    const badOffsetRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?offset=-1`, { cookie: ownerCookie }),
      ctx,
    );
    assert.equal(badOffsetRes.status, 422);
  });

  it("supports search and pagination envelope", async () => {
    const ctx = { params: Promise.resolve({ id: wsId }) };

    const pageRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?limit=2&offset=1`, { cookie: ownerCookie }),
      ctx,
    );
    assert.equal(pageRes.status, 200);
    const pageData = await pageRes.json();
    assert.equal(pageData.limit, 2);
    assert.equal(pageData.offset, 1);
    assert.equal(pageData.members.length, 2);
    assert.equal(pageData.total, 4); // 4 active members total

    const searchRes = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members?search=admin`, { cookie: ownerCookie }),
      ctx,
    );
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.members.length, 1);
    assert.match(searchData.members[0].email, /admin/);
  });

  it("enforces safe user summary allowlist (no credentials, sessions, tokens, or accounts)", async () => {
    const ctx = { params: Promise.resolve({ id: wsId }) };
    const res = await membersRoute.GET(
      apiRequest("GET", `/api/workspaces/${wsId}/members`, { cookie: ownerCookie }),
      ctx,
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    for (const member of data.members) {
      const keys = Object.keys(member);
      assert.deepEqual(
        keys.sort(),
        ["email", "id", "image", "joinedAt", "name", "role", "status"].sort(),
      );
      assert.equal("password" in member, false);
      assert.equal("hashedPassword" in member, false);
      assert.equal("emailVerified" in member, false);
      assert.equal("token" in member, false);
      assert.equal("accounts" in member, false);
      assert.equal("sessions" in member, false);
    }
  });
});

describe("Members API: PATCH & DELETE full authorization matrix and invariants", () => {
  let wsAId: string;
  let wsBId: string;
  let ownerACookie: string;
  let adminACookie: string;
  let memberACookie: string;
  let viewerACookie: string;
  let suspendedACookie: string;
  let removedACookie: string;
  let ownerAId: string;
  let adminAId: string;
  let memberAId: string;
  let viewerAId: string;
  let suspendedAId: string;
  let removedAId: string;

  let ownerBCookie: string;
  let memberBId: string;

  before(async () => {
    const ts = Date.now();
    const ownerA = await signInWithTeamWorkspace(`patch_owner_a_${ts}@example.com`, "Patch Co A");
    wsAId = ownerA.workspaceId;
    ownerACookie = ownerA.cookie;
    ownerAId = ownerA.userId;

    adminACookie = await signIn(`patch_admin_a_${ts}@example.com`);
    adminAId = await getUserIdByEmail(`patch_admin_a_${ts}@example.com`);

    memberACookie = await signIn(`patch_member_a_${ts}@example.com`);
    memberAId = await getUserIdByEmail(`patch_member_a_${ts}@example.com`);

    viewerACookie = await signIn(`patch_viewer_a_${ts}@example.com`);
    viewerAId = await getUserIdByEmail(`patch_viewer_a_${ts}@example.com`);

    suspendedACookie = await signIn(`patch_suspended_a_${ts}@example.com`);
    suspendedAId = await getUserIdByEmail(`patch_suspended_a_${ts}@example.com`);

    removedACookie = await signIn(`patch_removed_a_${ts}@example.com`);
    removedAId = await getUserIdByEmail(`patch_removed_a_${ts}@example.com`);

    const ownerB = await signInWithTeamWorkspace(`patch_owner_b_${ts}@example.com`, "Patch Co B");
    wsBId = ownerB.workspaceId;
    ownerBCookie = ownerB.cookie;

    await signIn(`patch_member_b_${ts}@example.com`);
    memberBId = await getUserIdByEmail(`patch_member_b_${ts}@example.com`);

    const db = getPgDb();
    await db.insert(workspaceMembers).values([
      { workspaceId: wsAId, userId: adminAId, role: "admin", status: "active" },
      { workspaceId: wsAId, userId: memberAId, role: "member", status: "active" },
      { workspaceId: wsAId, userId: viewerAId, role: "viewer", status: "active" },
      { workspaceId: wsAId, userId: suspendedAId, role: "member", status: "suspended" },
      { workspaceId: wsAId, userId: removedAId, role: "viewer", status: "removed" },
      { workspaceId: wsBId, userId: memberBId, role: "member", status: "active" },
    ]);
  });

  it("rejects PATCH from member, viewer, suspended, removed, outsider with 403", async () => {
    const ctx = { params: Promise.resolve({ id: wsAId, userId: memberAId }) };

    // Member caller -> 403 insufficient_role
    const mRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: memberACookie, body: { role: "viewer" } }), ctx);
    assert.equal(mRes.status, 403);

    // Viewer caller -> 403 insufficient_role
    const vRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: viewerACookie, body: { role: "viewer" } }), ctx);
    assert.equal(vRes.status, 403);

    // Suspended caller -> 403 inactive_member
    const sRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: suspendedACookie, body: { role: "viewer" } }), ctx);
    assert.equal(sRes.status, 403);

    // Removed caller -> 403 inactive_member
    const rRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: removedACookie, body: { role: "viewer" } }), ctx);
    assert.equal(rRes.status, 403);

    // Outsider (ownerB) trying to modify member in wsA -> 403 not_a_member
    const oRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: ownerBCookie, body: { role: "viewer" } }), ctx);
    assert.equal(oRes.status, 403);
  });

  it("rejects DELETE from member, viewer, suspended, removed, outsider with 403", async () => {
    const ctx = { params: Promise.resolve({ id: wsAId, userId: viewerAId }) };

    const mRes = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: memberACookie }), ctx);
    assert.equal(mRes.status, 403);

    const vRes = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: viewerACookie }), ctx);
    assert.equal(vRes.status, 403);

    const sRes = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: suspendedACookie }), ctx);
    assert.equal(sRes.status, 403);

    const rRes = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: removedACookie }), ctx);
    assert.equal(rRes.status, 403);

    const oRes = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: ownerBCookie }), ctx);
    assert.equal(oRes.status, 403);
  });

  it("returns 404 when target user is not a member of this workspace (or cross-workspace target)", async () => {
    // Nonexistent target
    const unknownCtx = { params: Promise.resolve({ id: wsAId, userId: "usr_nonexistent_999" }) };
    const patchUnknown = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/usr_nonexistent_999`, { cookie: ownerACookie, body: { role: "admin" } }), unknownCtx);
    assert.equal(patchUnknown.status, 404);

    const delUnknown = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/usr_nonexistent_999`, { cookie: ownerACookie }), unknownCtx);
    assert.equal(delUnknown.status, 404);

    // Cross-workspace target: memberB belongs to wsB, caller targets them in wsA
    const crossCtx = { params: Promise.resolve({ id: wsAId, userId: memberBId }) };
    const patchCross = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberBId}`, { cookie: adminACookie, body: { role: "viewer" } }), crossCtx);
    assert.equal(patchCross.status, 404);

    const delCross = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${memberBId}`, { cookie: adminACookie }), crossCtx);
    assert.equal(delCross.status, 404);
  });

  it("enforces admin restrictions: cannot modify/remove owners or admins, cannot grant admin or owner", async () => {
    const ownerCtx = { params: Promise.resolve({ id: wsAId, userId: ownerAId }) };

    // Admin tries to change owner's role -> 403
    const patchOwnerRole = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${ownerAId}`, { cookie: adminACookie, body: { role: "member" } }), ownerCtx);
    assert.equal(patchOwnerRole.status, 403);

    // Admin tries to suspend owner -> 403
    const patchOwnerStatus = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${ownerAId}`, { cookie: adminACookie, body: { status: "suspended" } }), ownerCtx);
    assert.equal(patchOwnerStatus.status, 403);

    // Admin tries to remove owner -> 403
    const delOwner = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${ownerAId}`, { cookie: adminACookie }), ownerCtx);
    assert.equal(delOwner.status, 403);

    // Create a second admin to test admin-modifying-admin
    const db = getPgDb();
    const ts = Date.now();
    await signIn(`admin2_${ts}@example.com`);
    const admin2Id = await getUserIdByEmail(`admin2_${ts}@example.com`);
    await db.insert(workspaceMembers).values({ workspaceId: wsAId, userId: admin2Id, role: "admin", status: "active" });
    const admin2Ctx = { params: Promise.resolve({ id: wsAId, userId: admin2Id }) };

    // Admin tries to modify another admin -> 403
    const patchAdmin2 = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${admin2Id}`, { cookie: adminACookie, body: { role: "member" } }), admin2Ctx);
    assert.equal(patchAdmin2.status, 403);

    // Admin tries to remove another admin -> 403
    const delAdmin2 = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${admin2Id}`, { cookie: adminACookie }), admin2Ctx);
    assert.equal(delAdmin2.status, 403);

    // Admin tries to grant owner role to a member -> 403
    const memberCtx = { params: Promise.resolve({ id: wsAId, userId: memberAId }) };
    const grantOwner = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: adminACookie, body: { role: "owner" } }), memberCtx);
    assert.equal(grantOwner.status, 403);

    // Admin tries to grant admin role to a member -> 403
    const grantAdmin = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: adminACookie, body: { role: "admin" } }), memberCtx);
    assert.equal(grantAdmin.status, 403);
  });

  it("allows admin to modify and remove members and viewers, and reinstate suspended members", async () => {
    const memberCtx = { params: Promise.resolve({ id: wsAId, userId: memberAId }) };

    // 1. Admin demotes member to viewer
    const demoteRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: adminACookie, body: { role: "viewer" } }), memberCtx);
    assert.equal(demoteRes.status, 200);
    const demoted = await demoteRes.json();
    assert.equal(demoted.member.role, "viewer");

    // 2. Admin suspends member
    const suspendRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: adminACookie, body: { status: "suspended" } }), memberCtx);
    assert.equal(suspendRes.status, 200);
    const suspended = await suspendRes.json();
    assert.equal(suspended.member.status, "suspended");

    // 3. Admin reinstates member (suspended -> active)
    const reinstateRes = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: adminACookie, body: { status: "active" } }), memberCtx);
    assert.equal(reinstateRes.status, 200);
    const reinstated = await reinstateRes.json();
    assert.equal(reinstated.member.status, "active");

    // 4. Admin removes member (soft removal)
    const delRes = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${memberAId}`, { cookie: adminACookie }), memberCtx);
    assert.equal(delRes.status, 200);

    // Verify row still exists with status = 'removed'
    const db = getPgDb();
    const [row] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, wsAId), eq(workspaceMembers.userId, memberAId)));
    assert.ok(row);
    assert.equal(row.status, "removed");
  });

  it("allows owner to grant admin and owner roles, and modify any member", async () => {
    const viewerCtx = { params: Promise.resolve({ id: wsAId, userId: viewerAId }) };

    // Owner promotes viewer to admin
    const promoteAdmin = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: ownerACookie, body: { role: "admin" } }), viewerCtx);
    assert.equal(promoteAdmin.status, 200);
    assert.equal((await promoteAdmin.json()).member.role, "admin");

    // Owner promotes to owner
    const promoteOwner = await memberRoute.PATCH(apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: ownerACookie, body: { role: "owner" } }), viewerCtx);
    assert.equal(promoteOwner.status, 200);
    assert.equal((await promoteOwner.json()).member.role, "owner");

    // Owner removes the newly promoted co-owner (succeeds because ownerA is still active owner)
    const delCoOwner = await memberRoute.DELETE(apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${viewerAId}`, { cookie: ownerACookie }), viewerCtx);
    assert.equal(delCoOwner.status, 200);
  });

  it("rejects self-suspend, self-remove, and self-demote for owner and admin with 403", async () => {
    const ownerSelfCtx = { params: Promise.resolve({ id: wsAId, userId: ownerAId }) };

    // Owner self-demote -> 403
    const ownerDemote = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${ownerAId}`, {
        cookie: ownerACookie,
        body: { role: "admin" },
      }),
      ownerSelfCtx,
    );
    assert.equal(ownerDemote.status, 403);
    assert.match((await ownerDemote.json()).error, /can't change your own membership/i);

    // Owner self-suspend -> 403
    const ownerSuspend = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${ownerAId}`, {
        cookie: ownerACookie,
        body: { status: "suspended" },
      }),
      ownerSelfCtx,
    );
    assert.equal(ownerSuspend.status, 403);
    assert.match((await ownerSuspend.json()).error, /can't change your own membership/i);

    // Owner self-remove -> 403
    const ownerRemove = await memberRoute.DELETE(
      apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${ownerAId}`, {
        cookie: ownerACookie,
      }),
      ownerSelfCtx,
    );
    assert.equal(ownerRemove.status, 403);
    assert.match((await ownerRemove.json()).error, /can't change your own membership/i);

    // Add a second active owner to wsA and confirm owner self-action is STILL rejected with 403
    const db = getPgDb();
    const ts = Date.now();
    await signIn(`co_owner_${ts}@example.com`);
    const coOwnerId = await getUserIdByEmail(`co_owner_${ts}@example.com`);
    await db.insert(workspaceMembers).values({
      workspaceId: wsAId,
      userId: coOwnerId,
      role: "owner",
      status: "active",
    });

    const ownerSelfWithCoOwner = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${ownerAId}`, {
        cookie: ownerACookie,
        body: { status: "suspended" },
      }),
      ownerSelfCtx,
    );
    assert.equal(ownerSelfWithCoOwner.status, 403);
    assert.match((await ownerSelfWithCoOwner.json()).error, /can't change your own membership/i);

    // Admin self-demote -> 403
    const adminSelfCtx = { params: Promise.resolve({ id: wsAId, userId: adminAId }) };
    const adminDemote = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${adminAId}`, {
        cookie: adminACookie,
        body: { role: "viewer" },
      }),
      adminSelfCtx,
    );
    assert.equal(adminDemote.status, 403);
    assert.match((await adminDemote.json()).error, /can't change your own membership/i);

    // Admin self-suspend -> 403
    const adminSuspend = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${adminAId}`, {
        cookie: adminACookie,
        body: { status: "suspended" },
      }),
      adminSelfCtx,
    );
    assert.equal(adminSuspend.status, 403);
    assert.match((await adminSuspend.json()).error, /can't change your own membership/i);

    // Admin self-remove -> 403
    const adminRemove = await memberRoute.DELETE(
      apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${adminAId}`, {
        cookie: adminACookie,
      }),
      adminSelfCtx,
    );
    assert.equal(adminRemove.status, 403);
    assert.match((await adminRemove.json()).error, /can't change your own membership/i);
  });

  it("enforces status transition invariants through the API: forbidden transitions return 409 or 422", async () => {
    const removedCtx = { params: Promise.resolve({ id: wsAId, userId: removedAId }) };

    // 1. removed -> active is rejected with 409 ("Removed members must be re-invited.")
    const reactivateRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${removedAId}`, {
        cookie: ownerACookie,
        body: { status: "active" },
      }),
      removedCtx,
    );
    assert.equal(reactivateRes.status, 409);
    assert.match((await reactivateRes.json()).error, /Removed members must be re-invited/i);

    // 2. removed -> suspended is rejected with 409
    const suspendRemovedRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${removedAId}`, {
        cookie: ownerACookie,
        body: { status: "suspended" },
      }),
      removedCtx,
    );
    assert.equal(suspendRemovedRes.status, 409);
    assert.match((await suspendRemovedRes.json()).error, /Removed members must be re-invited/i);

    // 3. role change on removed member is rejected with 409
    const roleChangeRemovedRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${removedAId}`, {
        cookie: ownerACookie,
        body: { role: "admin" },
      }),
      removedCtx,
    );
    assert.equal(roleChangeRemovedRes.status, 409);
    assert.match((await roleChangeRemovedRes.json()).error, /Removed members must be re-invited/i);

    // 4. DELETE on an already removed member is rejected with 409
    const deleteRemovedRes = await memberRoute.DELETE(
      apiRequest("DELETE", `/api/workspaces/${wsAId}/members/${removedAId}`, {
        cookie: ownerACookie,
      }),
      removedCtx,
    );
    assert.equal(deleteRemovedRes.status, 409);
    assert.match((await deleteRemovedRes.json()).error, /Removed members must be re-invited/i);

    // 5. Allowed transitions through the API: active -> suspended, suspended -> active, suspended -> removed
    const ts2 = Date.now();
    await signIn(`trans_member_${ts2}@example.com`);
    const transMemberId = await getUserIdByEmail(`trans_member_${ts2}@example.com`);
    const db = getPgDb();
    await db.insert(workspaceMembers).values({
      workspaceId: wsAId,
      userId: transMemberId,
      role: "member",
      status: "active",
    });

    const memberCtx = { params: Promise.resolve({ id: wsAId, userId: transMemberId }) };

    // active -> suspended
    const suspendRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${transMemberId}`, {
        cookie: ownerACookie,
        body: { status: "suspended" },
      }),
      memberCtx,
    );
    assert.equal(suspendRes.status, 200);
    assert.equal((await suspendRes.json()).member.status, "suspended");

    // suspended -> active (reinstate)
    const reinstateRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${transMemberId}`, {
        cookie: ownerACookie,
        body: { status: "active" },
      }),
      memberCtx,
    );
    assert.equal(reinstateRes.status, 200);
    assert.equal((await reinstateRes.json()).member.status, "active");

    // active -> removed
    const removeRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${transMemberId}`, {
        cookie: ownerACookie,
        body: { status: "removed" },
      }),
      memberCtx,
    );
    assert.equal(removeRes.status, 200);
    assert.equal((await removeRes.json()).member.status, "removed");
  });

  it("enforces last active owner protection with 409 conflict under concurrent demotion", async () => {
    // Create a dedicated workspace with two owners
    const ts = Date.now();
    const o1 = await signInWithTeamWorkspace(`last_owner_1_${ts}@example.com`, "Last Owner Co");
    const o2Cookie = await signIn(`last_owner_2_${ts}@example.com`);
    const o2Id = await getUserIdByEmail(`last_owner_2_${ts}@example.com`);

    const db = getPgDb();
    await db.insert(workspaceMembers).values({
      workspaceId: o1.workspaceId,
      userId: o2Id,
      role: "owner",
      status: "active",
    });

    const { Client } = await import("pg");
    const c1 = new Client({ connectionString: process.env.DATABASE_URL });
    await c1.connect();

    try {
      // 1. Client 1 (representing owner 1) begins transaction and demotes owner 2 to member
      await c1.query("BEGIN");
      await c1.query(
        "UPDATE workspace_member SET role = 'member' WHERE workspace_id = $1 AND user_id = $2",
        [o1.workspaceId, o2Id],
      );

      // 2. Concurrently, an API request with owner 2's session calls PATCH to demote owner 1 to member.
      // It executes inside memberRoute.PATCH, which calls updateMember with row lock + workspace lock.
      // It will block on the workspace lock held by c1's trigger.
      const o1Ctx = { params: Promise.resolve({ id: o1.workspaceId, userId: o1.userId }) };
      const demotePromise = memberRoute.PATCH(
        apiRequest("PATCH", `/api/workspaces/${o1.workspaceId}/members/${o1.userId}`, {
          cookie: o2Cookie,
          body: { role: "member" },
        }),
        o1Ctx,
      );

      // Give API request time to reach the database and block
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 3. Client 1 commits: owner 2 is now a member, leaving owner 1 as the sole active owner!
      await c1.query("COMMIT");

      // 4. The API request unblocks and attempts to demote owner 1.
      // Since owner 1 is now the sole remaining owner, the database trigger fires!
      // The API route catches LastOwnerError and returns 409 Conflict.
      const demoteRes = await demotePromise;
      assert.equal(demoteRes.status, 409);
      assert.match((await demoteRes.json()).error, /at least one owner/i);
    } finally {
      await c1.end();
    }
  });

  it("validates PATCH body: rejects invalid role, invalid status, status='invited', and empty body with 422", async () => {
    const targetCtx = { params: Promise.resolve({ id: wsAId, userId: adminAId }) };

    // status='invited' is explicitly forbidden
    const invitedRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${adminAId}`, {
        cookie: ownerACookie,
        body: { status: "invited" },
      }),
      targetCtx,
    );
    assert.equal(invitedRes.status, 422);

    // invalid status
    const badStatusRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${adminAId}`, {
        cookie: ownerACookie,
        body: { status: "unknown" },
      }),
      targetCtx,
    );
    assert.equal(badStatusRes.status, 422);

    // invalid role
    const badRoleRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${adminAId}`, {
        cookie: ownerACookie,
        body: { role: "superadmin" },
      }),
      targetCtx,
    );
    assert.equal(badRoleRes.status, 422);

    // empty body
    const emptyRes = await memberRoute.PATCH(
      apiRequest("PATCH", `/api/workspaces/${wsAId}/members/${adminAId}`, {
        cookie: ownerACookie,
        body: {},
      }),
      targetCtx,
    );
    assert.equal(emptyRes.status, 422);
  });
});
