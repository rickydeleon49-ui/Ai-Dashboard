/**
 * Accounts-mode file access fail-closed integration tests.
 *
 * Verifies that in AUTH_MODE=accounts against Postgres:
 * - /api/projects/:id/files and all nested file operations are unavailable (fail-closed 404)
 * - Direct API calls (/api/files/:id) cannot reach SQLite
 * - File endpoints fail closed for:
 *   1. Unauthenticated users (401 at proxy, 404 at route)
 *   2. Workspace Owner (404)
 *   3. Workspace Admin (404)
 *   4. Workspace Member (404)
 *   5. Outsider (404)
 *   6. Unknown project (404)
 *   7. Direct nested-route access (/api/files/:id) (404)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";
process.env.AUTH_LOG_MAGIC_LINK = "true";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type ProjectFilesRoute = typeof import("../../src/app/api/projects/[id]/files/route");
type FileIdRoute = typeof import("../../src/app/api/files/[id]/route");
type WorkspacesRoute = typeof import("../../src/app/api/workspaces/route");
type InvitationsRoute = typeof import("../../src/app/api/workspaces/[id]/invitations/route");
type AcceptRoute = typeof import("../../src/app/api/invitations/accept/route");

let projectsRoute: ProjectsRoute;
let projectFilesRoute: ProjectFilesRoute;
let fileIdRoute: FileIdRoute;
let workspacesRoute: WorkspacesRoute;
let invitationsRoute: InvitationsRoute;
let acceptRoute: AcceptRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  await migrate();
  projectsRoute = await import("../../src/app/api/projects/route");
  projectFilesRoute = await import("../../src/app/api/projects/[id]/files/route");
  fileIdRoute = await import("../../src/app/api/files/[id]/route");
  workspacesRoute = await import("../../src/app/api/workspaces/route");
  invitationsRoute = await import("../../src/app/api/workspaces/[id]/invitations/route");
  acceptRoute = await import("../../src/app/api/invitations/accept/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
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
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

describe("Accounts-mode file access fail-closed integration", () => {
  it("fails closed (404) for unauthenticated requests to file routes", async () => {
    const unauthReq = apiRequest("GET", "/api/projects/prj_123/files");
    const getRes = await projectFilesRoute.GET(unauthReq, { params: Promise.resolve({ id: "prj_123" }) });
    assert.equal(getRes.status, 404);

    const postRes = await projectFilesRoute.POST(
      apiRequest("POST", "/api/projects/prj_123/files"),
      { params: Promise.resolve({ id: "prj_123" }) },
    );
    assert.equal(postRes.status, 404);

    const directRes = await fileIdRoute.GET(
      apiRequest("GET", "/api/files/file_123"),
      { params: Promise.resolve({ id: "file_123" }) },
    );
    assert.equal(directRes.status, 404);
  });

  it("fails closed (404) for Owner, Admin, Member, Outsider, and Unknown project", async () => {
    // 1. Owner sets up a team workspace and a project
    const ownerCookie = await signIn("files-owner@example.com");
    const wsRes = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", {
        cookie: ownerCookie,
        body: { name: "Files Security Team", slug: "files-security-team" },
      }),
    );
    assert.equal(wsRes.status, 201);
    const { workspace } = (await wsRes.json()) as { workspace: { id: string } };

    const prjRes = await projectsRoute.POST(
      apiRequest("POST", "/api/projects", {
        cookie: ownerCookie,
        headers: { "x-workspace-id": workspace.id },
        body: { name: "Protected Project" },
      }),
    );
    assert.equal(prjRes.status, 201);
    const { project } = (await prjRes.json()) as { project: { id: string } };

    // 2. Invite an Admin
    const adminCookie = await signIn("files-admin@example.com");
    const inviteAdminRes = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspace.id}/invitations`, {
        cookie: ownerCookie,
        body: { email: "files-admin@example.com", role: "admin" },
      }),
      { params: Promise.resolve({ id: workspace.id }) },
    );
    assert.equal(inviteAdminRes.status, 201);
    const { invitation: adminInv } = (await inviteAdminRes.json()) as { invitation: { token: string } };
    await acceptRoute.POST(
      apiRequest("POST", "/api/invitations/accept", {
        cookie: adminCookie,
        body: { token: adminInv.token },
      }),
    );

    // 3. Invite a Member
    const memberCookie = await signIn("files-member@example.com");
    const inviteMemberRes = await invitationsRoute.POST(
      apiRequest("POST", `/api/workspaces/${workspace.id}/invitations`, {
        cookie: ownerCookie,
        body: { email: "files-member@example.com", role: "member" },
      }),
      { params: Promise.resolve({ id: workspace.id }) },
    );
    assert.equal(inviteMemberRes.status, 201);
    const { invitation: memberInv } = (await inviteMemberRes.json()) as { invitation: { token: string } };
    await acceptRoute.POST(
      apiRequest("POST", "/api/invitations/accept", {
        cookie: memberCookie,
        body: { token: memberInv.token },
      }),
    );

    // 4. Create an outsider
    const outsiderCookie = await signIn("files-outsider@example.com");

    const rolesAndCookies = [
      { role: "owner", cookie: ownerCookie },
      { role: "admin", cookie: adminCookie },
      { role: "member", cookie: memberCookie },
      { role: "outsider", cookie: outsiderCookie },
    ];

    for (const { role, cookie } of rolesAndCookies) {
      // Test GET /api/projects/:id/files
      const getRes = await projectFilesRoute.GET(
        apiRequest("GET", `/api/projects/${project.id}/files`, {
          cookie,
          headers: { "x-workspace-id": workspace.id },
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(getRes.status, 404, `${role} must receive 404 for GET /api/projects/:id/files in accounts mode`);

      // Test POST /api/projects/:id/files
      const postRes = await projectFilesRoute.POST(
        apiRequest("POST", `/api/projects/${project.id}/files`, {
          cookie,
          headers: { "x-workspace-id": workspace.id },
        }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(postRes.status, 404, `${role} must receive 404 for POST /api/projects/:id/files in accounts mode`);
    }

    // 5. Unknown project
    const unknownRes = await projectFilesRoute.GET(
      apiRequest("GET", "/api/projects/prj_nonexistent/files", {
        cookie: ownerCookie,
        headers: { "x-workspace-id": workspace.id },
      }),
      { params: Promise.resolve({ id: "prj_nonexistent" }) },
    );
    assert.equal(unknownRes.status, 404, "unknown project must receive 404");

    // 6. Direct nested-route access (/api/files/:id)
    for (const { role, cookie } of rolesAndCookies) {
      const getFileRes = await fileIdRoute.GET(
        apiRequest("GET", "/api/files/file_secret_cross_boundary", { cookie }),
        { params: Promise.resolve({ id: "file_secret_cross_boundary" }) },
      );
      assert.equal(getFileRes.status, 404, `${role} must receive 404 on /api/files/:id`);

      const deleteFileRes = await fileIdRoute.DELETE(
        apiRequest("DELETE", "/api/files/file_secret_cross_boundary", { cookie }),
        { params: Promise.resolve({ id: "file_secret_cross_boundary" }) },
      );
      assert.equal(deleteFileRes.status, 404, `${role} must receive 404 on DELETE /api/files/:id`);
    }
  });
});
