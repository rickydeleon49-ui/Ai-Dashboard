/**
 * The workspace management API (SaaS Phase 1, step 7) against a real
 * Postgres-backed, real signed-in Auth.js session — not mocked. Lives
 * alongside auth.test.ts (same --conditions=react-server-free run, same
 * NODE_OPTIONS server-only stub; see that file's header comment) because
 * these routes call src/core/auth/session.ts, which dynamically imports
 * src/auth.ts, the same fragile import graph.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";

type WorkspacesRoute = typeof import("../../src/app/api/workspaces/route");
type CurrentRoute = typeof import("../../src/app/api/workspaces/current/route");
let workspacesRoute: WorkspacesRoute;
let currentRoute: CurrentRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  await migrate();
  workspacesRoute = await import("../../src/app/api/workspaces/route");
  currentRoute = await import("../../src/app/api/workspaces/current/route");
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

describe("workspace management API: not configured", () => {
  it("refuses every route when DATABASE_URL is not set", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.equal((await workspacesRoute.GET(apiRequest("GET", "/api/workspaces"))).status, 404);
      assert.equal(
        (await workspacesRoute.POST(apiRequest("POST", "/api/workspaces", { body: { name: "X" } })))
          .status,
        404,
      );
      assert.equal(
        (
          await currentRoute.PUT(
            apiRequest("PUT", "/api/workspaces/current", { body: { workspaceId: "x" } }),
          )
        ).status,
        404,
      );
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});

describe("GET /api/workspaces", () => {
  it("requires a session", async () => {
    const response = await workspacesRoute.GET(apiRequest("GET", "/api/workspaces"));
    assert.equal(response.status, 401);
  });

  it("lists the signed-in user's personal workspace", async () => {
    const cookie = await signIn("workspaces-list@example.com");
    const response = await workspacesRoute.GET(apiRequest("GET", "/api/workspaces", { cookie }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { workspaces: { kind: string; role: string }[] };
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0]?.kind, "personal");
    assert.equal(body.workspaces[0]?.role, "owner");
  });
});

describe("POST /api/workspaces", () => {
  it("requires a session", async () => {
    const response = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { body: { name: "Acme" } }),
    );
    assert.equal(response.status, 401);
  });

  it("rejects an empty name", async () => {
    const cookie = await signIn("workspaces-create-invalid@example.com");
    const response = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie, body: { name: "   " } }),
    );
    assert.equal(response.status, 422);
  });

  it("creates a team workspace owned by the caller, then lists it", async () => {
    const cookie = await signIn("workspaces-create@example.com");
    const createResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie, body: { name: "Acme Corp" } }),
    );
    assert.equal(createResponse.status, 201);
    const { workspace } = (await createResponse.json()) as { workspace: { id: string; kind: string } };
    assert.equal(workspace.kind, "team");

    const listResponse = await workspacesRoute.GET(
      apiRequest("GET", "/api/workspaces", { cookie }),
    );
    const { workspaces } = (await listResponse.json()) as { workspaces: { id: string }[] };
    assert.ok(workspaces.some((w) => w.id === workspace.id));
  });
});

describe("PUT /api/workspaces/current", () => {
  it("requires a session", async () => {
    const response = await currentRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", { body: { workspaceId: "does-not-matter" } }),
    );
    assert.equal(response.status, 401);
  });

  it("switches to a workspace the caller belongs to, setting a cookie", async () => {
    const cookie = await signIn("workspaces-switch@example.com");
    const createResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie, body: { name: "Switch Target" } }),
    );
    const { workspace } = (await createResponse.json()) as { workspace: { id: string } };

    const switchResponse = await currentRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", { cookie, body: { workspaceId: workspace.id } }),
    );
    assert.equal(switchResponse.status, 200);
    const setCookie = switchResponse.headers.getSetCookie().join(" ");
    assert.match(setCookie, /cc-current-workspace/);
    assert.match(setCookie, new RegExp(workspace.id));
  });

  it("rejects switching to a workspace the caller does not belong to", async () => {
    const ownerCookie = await signIn("workspaces-switch-owner@example.com");
    const createResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Not Yours" } }),
    );
    const { workspace } = (await createResponse.json()) as { workspace: { id: string } };

    const outsiderCookie = await signIn("workspaces-switch-outsider@example.com");
    const switchResponse = await currentRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", {
        cookie: outsiderCookie,
        body: { workspaceId: workspace.id },
      }),
    );
    assert.equal(switchResponse.status, 403);
  });
});
