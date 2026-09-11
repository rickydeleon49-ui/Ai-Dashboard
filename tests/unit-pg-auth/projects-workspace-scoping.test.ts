/**
 * The actual Projects API routes (SaaS Phase 1, step 10) against a real
 * Postgres-backed, real signed-in Auth.js session — proving the routes
 * resolve the caller's real *current* workspace, not the SQLite-only
 * LOCAL_WORKSPACE_ID they were hardcoded to before this step. That bug
 * would have made the plan's required flow ("create a project in it")
 * silently no-op through the real UI/API in accounts mode: every read/
 * write would target a workspace_id of "local", which no real workspace
 * ever has. Lives alongside auth.test.ts (same --conditions=react-server-
 * free run, same NODE_OPTIONS server-only stub; see that file's header
 * comment) because these routes call src/core/workspaces/current-workspace.ts,
 * which dynamically imports src/auth.ts, the same fragile import graph.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type ProjectRoute = typeof import("../../src/app/api/projects/[id]/route");
type WorkspacesRoute = typeof import("../../src/app/api/workspaces/route");
type CurrentWorkspaceRoute = typeof import("../../src/app/api/workspaces/current/route");
type InvitationsRoute = typeof import("../../src/app/api/workspaces/[id]/invitations/route");
type AcceptRoute = typeof import("../../src/app/api/invitations/accept/route");
let projectsRoute: ProjectsRoute;
let projectRoute: ProjectRoute;
let workspacesRoute: WorkspacesRoute;
let currentWorkspaceRoute: CurrentWorkspaceRoute;
let invitationsRoute: InvitationsRoute;
let acceptRoute: AcceptRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  await migrate();
  projectsRoute = await import("../../src/app/api/projects/route");
  projectRoute = await import("../../src/app/api/projects/[id]/route");
  workspacesRoute = await import("../../src/app/api/workspaces/route");
  currentWorkspaceRoute = await import("../../src/app/api/workspaces/current/route");
  invitationsRoute = await import("../../src/app/api/workspaces/[id]/invitations/route");
  acceptRoute = await import("../../src/app/api/invitations/accept/route");
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

async function createProject(cookie: string, name: string) {
  const response = await projectsRoute.POST(apiRequest("POST", "/api/projects", { cookie, body: { name } }));
  assert.equal(response.status, 201, `create "${name}" should succeed`);
  return ((await response.json()) as { project: { id: string; name: string } }).project;
}

async function listProjects(cookie: string): Promise<{ id: string; name: string }[]> {
  const response = await projectsRoute.GET(apiRequest("GET", "/api/projects", { cookie }));
  assert.equal(response.status, 200);
  return ((await response.json()) as { projects: { id: string; name: string }[] }).projects;
}

describe("Projects API: workspace scoping (SaaS Phase 1, step 10)", () => {
  it("requires a session", async () => {
    assert.equal((await projectsRoute.GET(apiRequest("GET", "/api/projects"))).status, 401);
    assert.equal(
      (await projectsRoute.POST(apiRequest("POST", "/api/projects", { body: { name: "X" } }))).status,
      401,
    );
  });

  it("creates a project into the caller's current (personal) workspace, not LOCAL_WORKSPACE_ID", async () => {
    const cookie = await signIn("projects-scoping-basic@example.com");
    const project = await createProject(cookie, "Real Workspace Project");

    // The whole point of the fix: this must be findable again through the
    // same signed-in caller's own GET, proving it was written to a
    // workspace that caller actually belongs to.
    const found = await listProjects(cookie);
    assert.ok(found.some((p) => p.id === project.id));

    const getResponse = await projectRoute.GET(apiRequest("GET", `/api/projects/${project.id}`, { cookie }), {
      params: Promise.resolve({ id: project.id }),
    });
    assert.equal(getResponse.status, 200);
  });

  it("keeps two users' personal workspaces fully isolated", async () => {
    const aliceCookie = await signIn("projects-scoping-alice@example.com");
    const bobCookie = await signIn("projects-scoping-bob@example.com");

    const aliceProject = await createProject(aliceCookie, "Alice's Project");
    await createProject(bobCookie, "Bob's Project");

    const aliceProjects = await listProjects(aliceCookie);
    assert.ok(aliceProjects.some((p) => p.name === "Alice's Project"));
    assert.ok(!aliceProjects.some((p) => p.name === "Bob's Project"));

    // Bob cannot read Alice's project by id either.
    const bobReadsAlice = await projectRoute.GET(
      apiRequest("GET", `/api/projects/${aliceProject.id}`, { cookie: bobCookie }),
      { params: Promise.resolve({ id: aliceProject.id }) },
    );
    assert.equal(bobReadsAlice.status, 404);
  });

  it("follows a workspace switch: a project shows up only in the workspace it was created in", async () => {
    const cookie = await signIn("projects-scoping-switch@example.com");

    // Starts in the personal workspace by default.
    const personalProject = await createProject(cookie, "In Personal Workspace");
    const listResponse = await workspacesRoute.GET(apiRequest("GET", "/api/workspaces", { cookie }));
    const { workspaces } = (await listResponse.json()) as {
      workspaces: { id: string; kind: string }[];
    };
    const personalWorkspaceId = workspaces.find((w) => w.kind === "personal")?.id;
    assert.ok(personalWorkspaceId);

    // Create and switch to a team workspace.
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie, body: { name: "Team Workspace" } }),
    );
    const { workspace: teamWorkspace } = (await createWsResponse.json()) as {
      workspace: { id: string };
    };
    const switchToTeam = await currentWorkspaceRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", { cookie, body: { workspaceId: teamWorkspace.id } }),
    );
    assert.equal(switchToTeam.status, 200);
    const teamCookiePair = switchToTeam.headers.getSetCookie().join("; ").split(";")[0];
    const cookieInTeam = `${cookie}; ${teamCookiePair}`;

    const teamProject = await createProject(cookieInTeam, "In Team Workspace");

    const teamProjects = await listProjects(cookieInTeam);
    assert.ok(teamProjects.some((p) => p.id === teamProject.id));
    assert.ok(!teamProjects.some((p) => p.id === personalProject.id));

    // Switching back to the personal workspace sees the original project
    // again, and not the one just created in the team workspace.
    const switchBack = await currentWorkspaceRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", {
        cookie: cookieInTeam,
        body: { workspaceId: personalWorkspaceId },
      }),
    );
    assert.equal(switchBack.status, 200);
    const personalCookiePair = switchBack.headers.getSetCookie().join("; ").split(";")[0];
    const cookieBackInPersonal = `${cookie}; ${personalCookiePair}`;

    const personalProjects = await listProjects(cookieBackInPersonal);
    assert.ok(personalProjects.some((p) => p.id === personalProject.id));
    assert.ok(!personalProjects.some((p) => p.id === teamProject.id));
  });
});

describe("Projects API: role enforcement (requireRole, wired in for step 10)", () => {
  /** Signs `email` in, invites them into `workspaceId` at `role`, accepts, and switches to it. Returns their cookie. */
  async function joinWorkspaceAs(
    email: string,
    workspaceId: string,
    role: "admin" | "member" | "viewer",
    ownerCookie: string,
  ): Promise<string> {
    const inviteResponse = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
        cookie: ownerCookie,
        body: { email, role },
      }),
      { params: Promise.resolve({ id: workspaceId }) },
    );
    assert.equal(inviteResponse.status, 201, `inviting ${email} as ${role} should succeed`);
    const { token } = (await inviteResponse.json()) as { token: string };

    const cookie = await signIn(email);
    const acceptResponse = await acceptRoute.POST(apiRequest("POST", "/api/invitations/accept", { cookie, body: { token } }));
    assert.equal(acceptResponse.status, 200);

    const switchResponse = await currentWorkspaceRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", { cookie, body: { workspaceId } }),
    );
    assert.equal(switchResponse.status, 200);
    const cookiePair = switchResponse.headers.getSetCookie().join("; ").split(";")[0];
    return `${cookie}; ${cookiePair}`;
  }

  it("a viewer can read but not create, update or delete a project", async () => {
    const ownerCookie = await signIn("role-owner-viewer@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Role Test Viewer" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };
    const existing = await createProject(
      `${ownerCookie}; cc-current-workspace=${workspace.id}`,
      "Owner's Project",
    );

    const viewerCookie = await joinWorkspaceAs(
      "role-viewer@example.com",
      workspace.id,
      "viewer",
      ownerCookie,
    );

    // Can read.
    assert.equal(
      (await projectsRoute.GET(apiRequest("GET", "/api/projects", { cookie: viewerCookie }))).status,
      200,
    );

    // Cannot create.
    const createResponse = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", { cookie: viewerCookie, body: { name: "Viewer's Project" } }),
    );
    assert.equal(createResponse.status, 403);

    // Cannot update.
    const updateResponse = await projectRoute.PATCH(
      apiRequest("PATCH", `/api/projects/${existing.id}`, {
        cookie: viewerCookie,
        body: { name: "Renamed by viewer" },
      }),
      { params: Promise.resolve({ id: existing.id }) },
    );
    assert.equal(updateResponse.status, 403);

    // Cannot delete.
    const deleteResponse = await projectRoute.DELETE(
      apiRequest("DELETE", `/api/projects/${existing.id}`, { cookie: viewerCookie }),
      { params: Promise.resolve({ id: existing.id }) },
    );
    assert.equal(deleteResponse.status, 403);
  });

  it("a member can create, update and delete a project", async () => {
    const ownerCookie = await signIn("role-owner-member@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Role Test Member" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };

    const memberCookie = await joinWorkspaceAs(
      "role-member@example.com",
      workspace.id,
      "member",
      ownerCookie,
    );

    const created = await createProject(memberCookie, "Member's Project");

    const updateResponse = await projectRoute.PATCH(
      apiRequest("PATCH", `/api/projects/${created.id}`, {
        cookie: memberCookie,
        body: { name: "Renamed by member" },
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    assert.equal(updateResponse.status, 200);

    const deleteResponse = await projectRoute.DELETE(
      apiRequest("DELETE", `/api/projects/${created.id}`, { cookie: memberCookie }),
      { params: Promise.resolve({ id: created.id }) },
    );
    assert.equal(deleteResponse.status, 200);
  });
});
