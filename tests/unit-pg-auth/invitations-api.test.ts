/**
 * The invitation API (SaaS Phase 1, step 8) against a real Postgres-backed,
 * real signed-in Auth.js session — not mocked. Lives alongside
 * workspaces-api.test.ts (same --conditions=react-server-free run, same
 * NODE_OPTIONS server-only stub; see auth.test.ts's header comment) for
 * the same reason: these routes call src/core/auth/session.ts, which
 * dynamically imports src/auth.ts.
 *
 * This is also the closest thing this repo has to the phase's required
 * end-to-end flow: sign in as an owner, create a workspace, invite a real
 * second person by email, sign in as *them*, and confirm they land in the
 * workspace with the invited role — two independent sessions, not one
 * user acting twice.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";

type InvitationsRoute = typeof import("../../src/app/api/workspaces/[id]/invitations/route");
type InvitationRoute = typeof import(
  "../../src/app/api/workspaces/[id]/invitations/[invitationId]/route"
);
type AcceptRoute = typeof import("../../src/app/api/invitations/accept/route");
type WorkspacesRoute = typeof import("../../src/app/api/workspaces/route");
let invitationsRoute: InvitationsRoute;
let invitationRoute: InvitationRoute;
let acceptRoute: AcceptRoute;
let workspacesRoute: WorkspacesRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  await migrate();
  invitationsRoute = await import("../../src/app/api/workspaces/[id]/invitations/route");
  invitationRoute = await import(
    "../../src/app/api/workspaces/[id]/invitations/[invitationId]/route"
  );
  acceptRoute = await import("../../src/app/api/invitations/accept/route");
  workspacesRoute = await import("../../src/app/api/workspaces/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
});

after(() => cleanup());

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

/** Signs in and creates a team workspace, returning both the cookie and the workspace id. */
async function signInWithTeamWorkspace(
  email: string,
  workspaceName: string,
): Promise<{ cookie: string; workspaceId: string }> {
  const cookie = await signIn(email);
  const response = await workspacesRoute.POST(
    apiRequest("POST", "/api/workspaces", { cookie, body: { name: workspaceName } }),
  );
  const { workspace } = (await response.json()) as { workspace: { id: string } };
  return { cookie, workspaceId: workspace.id };
}

describe("invitation API: not configured", () => {
  it("refuses every route when DATABASE_URL is not set", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const ctx = { params: Promise.resolve({ id: "x" }) };
      assert.equal(
        (await invitationsRoute.GET(apiRequest("GET", "/api/workspaces/x/invitations"), ctx)).status,
        404,
      );
      assert.equal(
        (
          await invitationsRoute.POST(
            apiRequest("POST", "/api/workspaces/x/invitations", { body: { email: "a@b.com", role: "member" } }),
            ctx,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await invitationRoute.DELETE(apiRequest("DELETE", "/api/workspaces/x/invitations/y"), {
            params: Promise.resolve({ id: "x", invitationId: "y" }),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await acceptRoute.POST(
            apiRequest("POST", "/api/invitations/accept", { body: { token: "z" } }),
          )
        ).status,
        404,
      );
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});

describe("POST /api/workspaces/:id/invitations", () => {
  it("requires a session", async () => {
    const ctx = { params: Promise.resolve({ id: "x" }) };
    const response = await invitationsRoute.POST(
      apiRequest("POST", "/api/workspaces/x/invitations", { body: { email: "a@b.com", role: "member" } }),
      ctx,
    );
    assert.equal(response.status, 401);
  });

  it("rejects a member without admin/owner role", async () => {
    const { workspaceId } = await signInWithTeamWorkspace("invite-owner@example.com", "Acme");
    // A second, unrelated user is not even a member — the sharpest case of "not admin+".
    const outsiderCookie = await signIn("invite-outsider@example.com");
    const ctx = { params: Promise.resolve({ id: workspaceId }) };
    const response = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie: outsiderCookie,
        body: { email: "teammate@example.com", role: "member" },
      }),
      ctx,
    );
    assert.equal(response.status, 403);
  });

  it("rejects an invalid role and an invalid email", async () => {
    const { cookie, workspaceId } = await signInWithTeamWorkspace("invite-validate@example.com", "Acme");
    const ctx = { params: Promise.resolve({ id: workspaceId }) };

    const badRole = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie,
        body: { email: "teammate@example.com", role: "owner" },
      }),
      ctx,
    );
    assert.equal(badRole.status, 422);

    const badEmail = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie,
        body: { email: "not-an-email", role: "member" },
      }),
      ctx,
    );
    assert.equal(badEmail.status, 422);
  });

  it("creates an invitation, visible in the workspace's list", async () => {
    const { cookie, workspaceId } = await signInWithTeamWorkspace("invite-create@example.com", "Acme");
    const ctx = { params: Promise.resolve({ id: workspaceId }) };

    const createResponse = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie,
        body: { email: "teammate@example.com", role: "admin" },
      }),
      ctx,
    );
    assert.equal(createResponse.status, 201);
    const { invitation, token } = (await createResponse.json()) as {
      invitation: { email: string; role: string };
      token: string;
    };
    assert.equal(invitation.email, "teammate@example.com");
    assert.equal(invitation.role, "admin");
    assert.ok(token.length > 0);

    const listResponse = await invitationsRoute.GET(
      apiRequest("GET", `/api/workspaces/${workspaceId}/invitations`, { cookie }),
      ctx,
    );
    const { invitations } = (await listResponse.json()) as { invitations: { email: string }[] };
    assert.ok(invitations.some((i) => i.email === "teammate@example.com"));
  });
});

describe("DELETE /api/workspaces/:id/invitations/:invitationId", () => {
  it("revokes, and the token stops working", async () => {
    const { cookie, workspaceId } = await signInWithTeamWorkspace("invite-revoke@example.com", "Acme");
    const ctx = { params: Promise.resolve({ id: workspaceId }) };

    const createResponse = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie,
        body: { email: "revoke-target@example.com", role: "member" },
      }),
      ctx,
    );
    const { invitation, token } = (await createResponse.json()) as {
      invitation: { id: string };
      token: string;
    };

    const revokeResponse = await invitationRoute.DELETE(
      apiRequest("DELETE", `/api/workspaces/${workspaceId}/invitations/${invitation.id}`, { cookie }),
      { params: Promise.resolve({ id: workspaceId, invitationId: invitation.id }) },
    );
    assert.equal(revokeResponse.status, 200);

    const inviteeCookie = await signIn("revoke-target@example.com");
    const acceptResponse = await acceptRoute.POST(
      apiRequest("POST", "/api/invitations/accept", { cookie: inviteeCookie, body: { token } }),
    );
    assert.equal(acceptResponse.status, 410);
  });
});

describe("POST /api/invitations/accept — full two-session flow", () => {
  it("requires a session", async () => {
    const response = await acceptRoute.POST(
      apiRequest("POST", "/api/invitations/accept", { body: { token: "irrelevant" } }),
    );
    assert.equal(response.status, 401);
  });

  it("lets the invited teammate — a distinct real session — join at the invited role", async () => {
    const { cookie: ownerCookie, workspaceId } = await signInWithTeamWorkspace(
      "flow-owner@example.com",
      "Flow Co",
    );
    const ctx = { params: Promise.resolve({ id: workspaceId }) };

    const createResponse = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie: ownerCookie,
        body: { email: "flow-teammate@example.com", role: "member" },
      }),
      ctx,
    );
    const { token } = (await createResponse.json()) as { token: string };

    // A genuinely separate sign-in — the point of this test.
    const teammateCookie = await signIn("flow-teammate@example.com");
    const acceptResponse = await acceptRoute.POST(
      apiRequest("POST", "/api/invitations/accept", { cookie: teammateCookie, body: { token } }),
    );
    assert.equal(acceptResponse.status, 200);
    const { membership } = (await acceptResponse.json()) as { membership: { role: string } };
    assert.equal(membership.role, "member");

    // The teammate's own workspace list now includes it — not the owner's,
    // the invited person's own session.
    const listResponse = await workspacesRoute.GET(
      apiRequest("GET", "/api/workspaces", { cookie: teammateCookie }),
    );
    const { workspaces } = (await listResponse.json()) as {
      workspaces: { id: string; role: string }[];
    };
    const joined = workspaces.find((w) => w.id === workspaceId);
    assert.equal(joined?.role, "member");
  });

  it("rejects acceptance by a signed-in user whose email does not match the invite", async () => {
    const { cookie: ownerCookie, workspaceId } = await signInWithTeamWorkspace(
      "mismatch-owner@example.com",
      "Acme",
    );
    const ctx = { params: Promise.resolve({ id: workspaceId }) };
    const createResponse = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie: ownerCookie,
        body: { email: "intended-recipient@example.com", role: "member" },
      }),
      ctx,
    );
    const { token } = (await createResponse.json()) as { token: string };

    const wrongPersonCookie = await signIn("someone-else@example.com");
    const acceptResponse = await acceptRoute.POST(
      apiRequest("POST", "/api/invitations/accept", { cookie: wrongPersonCookie, body: { token } }),
    );
    assert.equal(acceptResponse.status, 403);
  });
});
