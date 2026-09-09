/**
 * Hosted-mode access control.
 *
 * Two properties matter here: a public deployment must never serve the
 * dashboard without a password, and an authenticated browser session must not
 * be usable by another site. Basic credentials are ambient — the browser
 * attaches them by itself — so authentication alone does not give the second.
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";

type Middleware = typeof import("../../src/middleware").middleware;
let middleware: Middleware;
let NextRequest: typeof import("next/server").NextRequest;

const PASSWORD = "correct-horse-battery-staple";

before(async () => {
  ({ middleware } = await import("../../src/middleware"));
  ({ NextRequest } = await import("next/server"));
});

/** The keys these tests touch, restored after each one. */
const TOUCHED = ["DASHBOARD_LOCAL", "DASHBOARD_PASSWORD", "NODE_ENV"] as const;
const original = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

// NODE_ENV is declared read-only for application code; assigning it is exactly
// what these tests need to do, so they reach past the declaration rather than
// replacing process.env wholesale.
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  for (const key of TOUCHED) {
    if (original[key] === undefined) delete env[key];
    else env[key] = original[key];
  }
});

/** Puts the process into the hosted configuration. */
function hosted(password: string | null = PASSWORD): void {
  delete env.DASHBOARD_LOCAL;
  env.NODE_ENV = "production";
  if (password === null) delete env.DASHBOARD_PASSWORD;
  else env.DASHBOARD_PASSWORD = password;
}

/** Puts the process into the desktop configuration. */
function local(): void {
  delete env.DASHBOARD_PASSWORD;
  env.DASHBOARD_LOCAL = "1";
}

function request(
  method: string,
  headers: Record<string, string> = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest("http://dashboard.example/api/projects", {
    method,
    headers: { host: "dashboard.example", ...headers },
  });
}

const auth = { authorization: `Basic ${btoa(`user:${PASSWORD}`)}` };

describe("hosted mode authentication", () => {
  it("refuses to serve at all when no password is configured", () => {
    hosted(null);
    assert.equal(middleware(request("GET")).status, 503);
  });

  it("challenges an unauthenticated request", () => {
    hosted();
    const response = middleware(request("GET"));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Basic/);
  });

  it("rejects a wrong password", () => {
    hosted();
    const wrong = { authorization: `Basic ${btoa("user:nope")}` };
    assert.equal(middleware(request("GET", wrong)).status, 401);
  });

  it("allows a correct password", () => {
    hosted();
    assert.notEqual(middleware(request("GET", auth)).status, 401);
  });

  it("lets the desktop shell through without a password", () => {
    hosted(null);
    process.env.DASHBOARD_LOCAL = "1";
    assert.notEqual(middleware(request("GET")).status, 503);
  });
});

describe("cross-site request forgery", () => {
  it("blocks an authenticated mutation a browser reports as cross-site", () => {
    hosted();
    const response = middleware(
      request("POST", { ...auth, "sec-fetch-site": "cross-site" }),
    );
    assert.equal(response.status, 403, "a cross-site POST must not be accepted");
  });

  it("blocks one identified by a foreign Origin", () => {
    hosted();
    const response = middleware(
      request("POST", { ...auth, origin: "https://attacker.example" }),
    );
    assert.equal(response.status, 403);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`blocks cross-site ${method}`, () => {
      hosted();
      const response = middleware(
        request(method, { ...auth, "sec-fetch-site": "cross-site" }),
      );
      assert.equal(response.status, 403);
    });
  }

  it("allows the app's own requests", () => {
    hosted();
    const sameOrigin: Record<string, string>[] = [
      { "sec-fetch-site": "same-origin" },
      { origin: "http://dashboard.example" },
    ];
    for (const headers of sameOrigin) {
      const response = middleware(request("POST", { ...auth, ...headers }));
      assert.notEqual(response.status, 403, JSON.stringify(headers));
    }
  });

  it("does not block reads, which change nothing", () => {
    hosted();
    const response = middleware(
      request("GET", { ...auth, "sec-fetch-site": "cross-site" }),
    );
    assert.notEqual(response.status, 403);
  });

  it("still allows a non-browser client that supplied the password itself", () => {
    hosted();
    // No Origin and no Sec-Fetch-Site: nothing attached credentials ambiently,
    // so this is not the thing CSRF describes.
    assert.notEqual(middleware(request("POST", auth)).status, 403);
  });
});

describe("desktop mode cross-site protection", () => {
  // The desktop server has no password, but loopback binding is not an
  // authorization boundary: a page open in the same browser can still POST to
  // it. Unauthenticated is not the same as unprotected.
  it("blocks a cross-site mutation even though no password is required", () => {
    local();
    const response = middleware(
      request("POST", { "sec-fetch-site": "cross-site" }),
    );
    assert.equal(response.status, 403);
  });

  it("blocks one identified by a foreign Origin", () => {
    local();
    const response = middleware(
      request("POST", { origin: "https://attacker.example" }),
    );
    assert.equal(response.status, 403);
  });

  it("still allows the app's own requests", () => {
    local();
    const response = middleware(
      request("POST", { "sec-fetch-site": "same-origin" }),
    );
    assert.notEqual(response.status, 403);
  });

  it("does not block reads", () => {
    local();
    const response = middleware(
      request("GET", { "sec-fetch-site": "cross-site" }),
    );
    assert.notEqual(response.status, 403);
  });
});
