/**
 * Auth.js against a real Postgres database: both providers are exposed, and
 * the magic-link provider actually completes a full sign-in → session →
 * sign-out cycle — not mocked, the real handlers this app ships, calling the
 * real Drizzle Postgres adapter.
 *
 * Calls `handlers.GET`/`POST` directly with constructed `Request` objects
 * rather than spawning a real Next server: these are exactly the functions
 * `src/app/api/auth/[...nextauth]/route.ts` hands to Next.js, so this is the
 * real request-handling code, just without the framework's own process
 * wrapped around it.
 *
 * Run without --conditions=react-server (unlike tests/unit/*.test.ts) — this
 * suite lives in its own directory specifically so it can skip that flag.
 * Auth.js's own import graph reaches into Next's client-side navigation
 * internals, which assume a normal React entry point; under
 * --conditions=react-server that resolves to the server-only React build
 * instead, which has no `createContext`, and the import throws before any
 * test body even runs.
 *
 * src/auth.ts also imports src/core/workspaces/service.ts (for its
 * events.createUser hook), which is guarded by `import "server-only"` —
 * normally resolved to a no-op by that same flag this suite can't use. Its
 * npm script (test:unit:pg:auth) instead preloads
 * tests/helpers/stub-server-only.cjs via NODE_OPTIONS to get the same
 * no-op outcome without the flag.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";

let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;

before(async () => {
  await migrate();
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

describe("Auth.js against real Postgres", () => {
  it("exposes both configured providers", async () => {
    const response = await handlers.GET(new NextRequest("http://localhost/api/auth/providers"));
    const body = (await response.json()) as Record<string, { type: string }>;
    assert.equal(body.github?.type, "oauth");
    assert.equal(body.nodemailer?.type, "email");
  });

  it("has no session before signing in", async () => {
    const response = await handlers.GET(new NextRequest("http://localhost/api/auth/session"));
    assert.equal(await response.json(), null);
  });

  it("completes a full sign-in → session → sign-out cycle via magic link", async () => {
    const jar = cookieJar();
    const email = "test@example.com";

    const csrfResponse = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
    jar.absorb(csrfResponse);
    const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

    const signinBody = new URLSearchParams({
      email,
      csrfToken,
      callbackUrl: "http://localhost/",
    });
    const [signinResponse, logs] = await withCapturedLogs(() =>
      handlers.POST(
        new NextRequest("http://localhost/api/auth/signin/nodemailer", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: jar.header(),
          },
          body: signinBody.toString(),
        }),
      ),
    );
    jar.absorb(signinResponse);
    assert.equal(signinResponse.status, 302);

    const magicLinkLine = logs.find((line) => line.includes(`magic link for ${email}`));
    assert.ok(magicLinkLine, `expected a logged magic link, got: ${JSON.stringify(logs)}`);
    const magicLink = magicLinkLine!.match(/(http:\S+)/)?.[1];
    assert.ok(magicLink, "could not extract a URL from the logged line");

    // "Clicking" the link.
    const callbackResponse = await handlers.GET(
      new NextRequest(magicLink!, { headers: { cookie: jar.header() } }),
    );
    jar.absorb(callbackResponse);
    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get("location"), "http://localhost/");

    // A second click (e.g. a reload, or the link opened twice) must not
    // succeed again — Auth.js deletes the token on first use, and a failed
    // verification still redirects (302) but to its error page rather than
    // the callback URL, so the location is what actually distinguishes them.
    const replayResponse = await handlers.GET(new NextRequest(magicLink!));
    assert.notEqual(
      replayResponse.headers.get("location"),
      "http://localhost/",
      "a consumed magic link must not sign in again",
    );

    const sessionResponse = await handlers.GET(
      new NextRequest("http://localhost/api/auth/session", { headers: { cookie: jar.header() } }),
    );
    const session = (await sessionResponse.json()) as { user?: { email?: string } };
    assert.equal(session.user?.email, email);

    // Sign out, with its own fresh CSRF token.
    const csrf2Response = await handlers.GET(
      new NextRequest("http://localhost/api/auth/csrf", { headers: { cookie: jar.header() } }),
    );
    jar.absorb(csrf2Response);
    const { csrfToken: csrfToken2 } = (await csrf2Response.json()) as { csrfToken: string };

    const signoutResponse = await handlers.POST(
      new NextRequest("http://localhost/api/auth/signout", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: jar.header(),
        },
        body: new URLSearchParams({ csrfToken: csrfToken2 }).toString(),
      }),
    );
    jar.absorb(signoutResponse);

    const sessionAfterResponse = await handlers.GET(
      new NextRequest("http://localhost/api/auth/session", { headers: { cookie: jar.header() } }),
    );
    assert.equal(await sessionAfterResponse.json(), null);
  });
});
