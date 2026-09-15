/**
 * The Knowledge base API routes (Phase 2, Release B) against a real
 * Postgres-backed, real signed-in Auth.js session — same shape as
 * `tasks-workspace-scoping.test.ts`: workspace isolation, role enforcement
 * (viewer reads, member writes), plus search/category filtering through
 * the route.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type KnowledgeRoute = typeof import("../../src/app/api/projects/[id]/knowledge/route");
type KnowledgeDocRoute = typeof import("../../src/app/api/projects/[id]/knowledge/[docId]/route");
type WorkspacesRoute = typeof import("../../src/app/api/workspaces/route");
type CurrentWorkspaceRoute = typeof import("../../src/app/api/workspaces/current/route");
type InvitationsRoute = typeof import("../../src/app/api/workspaces/[id]/invitations/route");
type AcceptRoute = typeof import("../../src/app/api/invitations/accept/route");

let projectsRoute: ProjectsRoute;
let knowledgeRoute: KnowledgeRoute;
let knowledgeDocRoute: KnowledgeDocRoute;
let workspacesRoute: WorkspacesRoute;
let currentWorkspaceRoute: CurrentWorkspaceRoute;
let invitationsRoute: InvitationsRoute;
let acceptRoute: AcceptRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  await migrate();
  projectsRoute = await import("../../src/app/api/projects/route");
  knowledgeRoute = await import("../../src/app/api/projects/[id]/knowledge/route");
  knowledgeDocRoute = await import("../../src/app/api/projects/[id]/knowledge/[docId]/route");
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

async function createProject(cookie: string, name: string) {
  const response = await projectsRoute.POST(apiRequest("POST", "/api/projects", { cookie, body: { name } }));
  assert.equal(response.status, 201, `create project "${name}" should succeed`);
  return ((await response.json()) as { project: { id: string } }).project;
}

async function createDocument(
  cookie: string,
  projectId: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const response = await knowledgeRoute.POST(
    apiRequest("POST", `/api/projects/${projectId}/knowledge`, { cookie, body: { title, ...extra } }),
    { params: Promise.resolve({ id: projectId }) },
  );
  assert.equal(response.status, 201, `create document "${title}" should succeed`);
  return ((await response.json()) as { document: { id: string; projectId: string } }).document;
}

describe("Knowledge base API: workspace scoping", () => {
  it("requires a session", async () => {
    assert.equal(
      (await knowledgeRoute.GET(apiRequest("GET", "/api/projects/x/knowledge"), {
        params: Promise.resolve({ id: "x" }),
      })).status,
      401,
    );
  });

  it("keeps two workspaces' documents fully isolated", async () => {
    const aliceCookie = await signIn("kb-scoping-alice@example.com");
    const bobCookie = await signIn("kb-scoping-bob@example.com");

    const aliceProject = await createProject(aliceCookie, "Alice's Project");
    const aliceDoc = await createDocument(aliceCookie, aliceProject.id, "Alice's Doc");

    const bobListsDocs = await knowledgeRoute.GET(
      apiRequest("GET", `/api/projects/${aliceProject.id}/knowledge`, { cookie: bobCookie }),
      { params: Promise.resolve({ id: aliceProject.id }) },
    );
    assert.equal(bobListsDocs.status, 404);

    const bobReadsDoc = await knowledgeDocRoute.GET(
      apiRequest("GET", `/api/projects/${aliceProject.id}/knowledge/${aliceDoc.id}`, { cookie: bobCookie }),
      { params: Promise.resolve({ id: aliceProject.id, docId: aliceDoc.id }) },
    );
    assert.equal(bobReadsDoc.status, 404);
  });

  it("a document reachable through the wrong project's URL is treated as absent", async () => {
    const cookie = await signIn("kb-scoping-cross-project@example.com");
    const projectA = await createProject(cookie, "Project A");
    const projectB = await createProject(cookie, "Project B");
    const docInA = await createDocument(cookie, projectA.id, "Doc in A");

    const response = await knowledgeDocRoute.GET(
      apiRequest("GET", `/api/projects/${projectB.id}/knowledge/${docInA.id}`, { cookie }),
      { params: Promise.resolve({ id: projectB.id, docId: docInA.id }) },
    );
    assert.equal(response.status, 404);
  });

  it("search and category filters work through the route", async () => {
    const cookie = await signIn("kb-search@example.com");
    const project = await createProject(cookie, "Search Project");
    await createDocument(cookie, project.id, "Deploy steps", {
      content: "run the release script",
      category: "ops",
    });
    await createDocument(cookie, project.id, "Unrelated", { content: "nothing here" });

    const bySearch = await knowledgeRoute.GET(
      apiRequest("GET", `/api/projects/${project.id}/knowledge?search=release`, { cookie }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(bySearch.status, 200);
    const { documents: bySearchDocs } = (await bySearch.json()) as { documents: { title: string }[] };
    assert.deepEqual(bySearchDocs.map((d) => d.title), ["Deploy steps"]);

    const byCategory = await knowledgeRoute.GET(
      apiRequest("GET", `/api/projects/${project.id}/knowledge?category=ops`, { cookie }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(byCategory.status, 200);
    const { documents: byCategoryDocs } = (await byCategory.json()) as { documents: { title: string }[] };
    assert.deepEqual(byCategoryDocs.map((d) => d.title), ["Deploy steps"]);
  });
});

describe("Knowledge base API: role enforcement", () => {
  it("a viewer can read but not create, update or delete a document", async () => {
    const ownerCookie = await signIn("role-kb-owner@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Role Test Knowledge" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };
    const ownerInWorkspace = `${ownerCookie}; cc-current-workspace=${workspace.id}`;
    const project = await createProject(ownerInWorkspace, "Owner's Project");
    const doc = await createDocument(ownerInWorkspace, project.id, "Owner's Doc");

    const viewerCookie = await joinWorkspaceAs("role-kb-viewer@example.com", workspace.id, "viewer", ownerCookie);

    assert.equal(
      (await knowledgeRoute.GET(apiRequest("GET", `/api/projects/${project.id}/knowledge`, { cookie: viewerCookie }), {
        params: Promise.resolve({ id: project.id }),
      })).status,
      200,
    );

    const createResponse = await knowledgeRoute.POST(
      apiRequest("POST", `/api/projects/${project.id}/knowledge`, { cookie: viewerCookie, body: { title: "Viewer's" } }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(createResponse.status, 403);

    const updateResponse = await knowledgeDocRoute.PATCH(
      apiRequest("PATCH", `/api/projects/${project.id}/knowledge/${doc.id}`, {
        cookie: viewerCookie,
        body: { title: "Renamed by viewer" },
      }),
      { params: Promise.resolve({ id: project.id, docId: doc.id }) },
    );
    assert.equal(updateResponse.status, 403);

    const deleteResponse = await knowledgeDocRoute.DELETE(
      apiRequest("DELETE", `/api/projects/${project.id}/knowledge/${doc.id}`, { cookie: viewerCookie }),
      { params: Promise.resolve({ id: project.id, docId: doc.id }) },
    );
    assert.equal(deleteResponse.status, 403);
  });

  it("a member can create, update and delete a document", async () => {
    const ownerCookie = await signIn("role-kb-member-owner@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Role Test Knowledge Member" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };

    const memberCookie = await joinWorkspaceAs("role-kb-member@example.com", workspace.id, "member", ownerCookie);

    const project = await createProject(memberCookie, "Member's Project");
    const doc = await createDocument(memberCookie, project.id, "Member's Doc");

    const updateResponse = await knowledgeDocRoute.PATCH(
      apiRequest("PATCH", `/api/projects/${project.id}/knowledge/${doc.id}`, {
        cookie: memberCookie,
        body: { pinned: true },
      }),
      { params: Promise.resolve({ id: project.id, docId: doc.id }) },
    );
    assert.equal(updateResponse.status, 200);
    assert.equal(((await updateResponse.json()) as { document: { pinned: boolean } }).document.pinned, true);

    const deleteResponse = await knowledgeDocRoute.DELETE(
      apiRequest("DELETE", `/api/projects/${project.id}/knowledge/${doc.id}`, { cookie: memberCookie }),
      { params: Promise.resolve({ id: project.id, docId: doc.id }) },
    );
    assert.equal(deleteResponse.status, 200);
  });
});
