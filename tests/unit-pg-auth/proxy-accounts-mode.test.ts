/**
 * proxy.ts's AUTH_MODE=accounts branch, against a real Postgres-backed
 * Auth.js session — not a mock. Lives alongside auth.test.ts (same
 * --conditions=react-server-free run, same NODE_OPTIONS server-only stub;
 * see that file's header comment) because proxy.ts's accounts-mode branch
 * dynamically imports src/auth.ts, the same fragile import graph.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";

type Proxy = typeof import("../../src/proxy").proxy;
let proxy: Proxy;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  await migrate();
  ({ proxy } = await import("../../src/proxy"));
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
});

after(() => cleanup());

/** The keys these tests touch, restored after each one. */
const TOUCHED = ["AUTH_MODE", "DATABASE_URL"] as const;
const original = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;

function restoreEnv(): void {
  for (const key of TOUCHED) {
    if (original[key] === undefined) delete env[key];
    else env[key] = original[key];
  }
}

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

// Auth.js's own session lookup (getSession, inside its auth()-wrapper path)
// rebuilds a request URL from the incoming request's headers rather than
// using the request's own URL: Host, since a real browser or Next.js server
// always sets one but constructing a NextRequest directly in a test does
// not (without it, lookup resolves against "https://null/..." and silently
// finds nothing); and X-Forwarded-Proto, which it defaults to "https" when
// absent (safe for a real deployment behind a proxy that always sets it,
// but wrong for these plain-http local requests — with no explicit proto,
// session lookup would check the __Secure-prefixed cookie name and never
// find the plain one this app's http:// sign-in actually set).

function pageRequest(cookie?: string): InstanceType<typeof NextRequest> {
  return new NextRequest("http://localhost/", {
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(cookie ? { cookie } : {}),
    },
  });
}

function apiRequest(
  method: string,
  cookie?: string,
  headers: Record<string, string> = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest("http://localhost/api/projects", {
    method,
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  });
}

const stubEvent = {} as Parameters<Proxy>[1];

async function call(request: InstanceType<typeof NextRequest>): Promise<Response> {
  return proxy(request, stubEvent) as Promise<Response>;
}

describe("AUTH_MODE=accounts: not configured", () => {
  it("refuses to serve when DATABASE_URL is not set", async () => {
    env.AUTH_MODE = "accounts";
    delete env.DATABASE_URL;
    try {
      assert.equal((await call(pageRequest())).status, 503);
    } finally {
      restoreEnv();
    }
  });
});

describe("AUTH_MODE=accounts: session gating", () => {
  it("passes through Auth.js's own routes unauthenticated", async () => {
    env.AUTH_MODE = "accounts";
    try {
      const response = await call(
        new NextRequest("http://localhost/api/auth/session"),
      );
      assert.notEqual(response.status, 401);
      assert.notEqual(response.status, 302);
    } finally {
      restoreEnv();
    }
  });

  it("redirects an unauthenticated page load to sign-in", async () => {
    env.AUTH_MODE = "accounts";
    try {
      const response = await call(pageRequest());
      // NextResponse.redirect()'s default status (no override passed).
      assert.equal(response.status, 307);
      const location = response.headers.get("location") ?? "";
      assert.match(location, /\/api\/auth\/signin/);
      assert.match(location, /callbackUrl=/);
    } finally {
      restoreEnv();
    }
  });

  it("returns 401 JSON for an unauthenticated API call", async () => {
    env.AUTH_MODE = "accounts";
    try {
      const response = await call(apiRequest("GET"));
      assert.equal(response.status, 401);
      const body = (await response.json()) as { error?: string };
      assert.ok(body.error);
    } finally {
      restoreEnv();
    }
  });

  it("lets a signed-in session through to a page and to the API", async () => {
    const cookie = await signIn("proxy-accounts-page@example.com");
    env.AUTH_MODE = "accounts";
    try {
      assert.notEqual((await call(pageRequest(cookie))).status, 302);
      assert.notEqual((await call(apiRequest("GET", cookie))).status, 401);
    } finally {
      restoreEnv();
    }
  });

  it("still rejects a cross-site mutation even with a valid session", async () => {
    const cookie = await signIn("proxy-accounts-csrf@example.com");
    env.AUTH_MODE = "accounts";
    try {
      const response = await call(
        apiRequest("POST", cookie, { "sec-fetch-site": "cross-site" }),
      );
      assert.equal(response.status, 403);
    } finally {
      restoreEnv();
    }
  });

  it("allows a same-site mutation with a valid session", async () => {
    const cookie = await signIn("proxy-accounts-samesite@example.com");
    env.AUTH_MODE = "accounts";
    try {
      const response = await call(
        apiRequest("POST", cookie, { "sec-fetch-site": "same-origin" }),
      );
      assert.notEqual(response.status, 403);
      assert.notEqual(response.status, 401);
    } finally {
      restoreEnv();
    }
  });
});

describe("AUTH_MODE=accounts: route restriction (SaaS Phase 1, step 10)", () => {
  function requestFor(path: string, cookie: string): InstanceType<typeof NextRequest> {
    return new NextRequest(`http://localhost${path}`, {
      headers: { host: "localhost", "x-forwarded-proto": "http", cookie },
    });
  }

  it("allows Dashboard, Projects and Settings pages", async () => {
    const cookie = await signIn("proxy-accounts-allowed-pages@example.com");
    env.AUTH_MODE = "accounts";
    try {
      for (const path of ["/", "/projects", "/projects/new", "/favorites", "/settings"]) {
        const response = await call(requestFor(path, cookie));
        assert.notEqual(response.status, 404, `${path} should be reachable`);
      }
    } finally {
      restoreEnv();
    }
  });

  it("allows the supporting API routes", async () => {
    const cookie = await signIn("proxy-accounts-allowed-api@example.com");
    env.AUTH_MODE = "accounts";
    try {
      for (const path of ["/api/projects", "/api/workspaces", "/api/ownership-claim"]) {
        const response = await call(requestFor(path, cookie));
        assert.notEqual(response.status, 404, `${path} should be reachable`);
      }
    } finally {
      restoreEnv();
    }
  });

  it("404s every page outside Dashboard/Projects/Settings/Invite, even signed in", async () => {
    const cookie = await signIn("proxy-accounts-blocked-pages@example.com");
    env.AUTH_MODE = "accounts";
    try {
      for (const path of ["/ai", "/ai/chat", "/uploads", "/github", "/notes", "/tools"]) {
        const response = await call(requestFor(path, cookie));
        assert.equal(response.status, 404, `${path} should be blocked`);
      }
    } finally {
      restoreEnv();
    }
  });

  it("404s the underlying API routes for those domains too, not just their pages", async () => {
    const cookie = await signIn("proxy-accounts-blocked-api@example.com");
    env.AUTH_MODE = "accounts";
    try {
      for (const path of ["/api/ai/chat", "/api/automations", "/api/github/sync", "/api/prompts"]) {
        const response = await call(requestFor(path, cookie));
        assert.equal(response.status, 404, `${path} should be blocked`);
      }
    } finally {
      restoreEnv();
    }
  });

  it("blocks an unauthenticated caller with 401, not 404 — restriction never leaks ahead of auth", async () => {
    env.AUTH_MODE = "accounts";
    try {
      const response = await call(
        new NextRequest("http://localhost/notes", {
          headers: { host: "localhost", "x-forwarded-proto": "http" },
        }),
      );
      assert.notEqual(response.status, 404);
    } finally {
      restoreEnv();
    }
  });
});
