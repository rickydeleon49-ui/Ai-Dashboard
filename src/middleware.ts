import { NextResponse, type NextRequest } from "next/server";

/**
 * Access control for the whole application.
 *
 * The dashboard has no user accounts — it is one person's tool — but it holds
 * project notes and can create, edit and delete everything through its API. Two
 * very different deployments have to be served:
 *
 *   Desktop  the bundled server binds 127.0.0.1 on a random port and is
 *            unreachable from outside the machine. Asking for a password there
 *            would be pure friction, so the desktop shell marks itself with
 *            DASHBOARD_LOCAL and is let through.
 *
 *   Hosted   a Railway (or similar) deployment is reachable by anyone who finds
 *            the URL. It requires DASHBOARD_PASSWORD.
 *
 * The default is deliberately fail-safe: a production deployment with no
 * password configured serves a setup notice instead of the dashboard. Forgetting
 * to set it cannot silently publish the library to the internet.
 */

const REALM = "Command Center";

/** Compares two strings in time independent of how early they differ. */
function safeEqual(a: string, b: string): boolean {
  // Lengths are compared through the accumulator too, so an early length
  // mismatch does not shortcut the loop.
  let mismatch = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Shown when a public deployment has no password set. */
function setupRequired(): NextResponse {
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configuration required</title>
<style>
  body { background:#08090b; color:#ededef; font:14px/1.6 ui-sans-serif,system-ui,sans-serif;
         display:grid; place-items:center; min-height:100dvh; margin:0; padding:24px; }
  main { max-width:34rem; }
  h1 { font-size:1.05rem; margin:0 0 .75rem; }
  p { color:#8b8d98; margin:0 0 .75rem; }
  code { background:#16191f; border:1px solid rgba(255,255,255,.1); border-radius:4px;
         padding:.15em .4em; font-family:ui-monospace,monospace; font-size:.9em; color:#b9a7ff; }
</style>
<main>
  <h1>Command Center is not configured for public access</h1>
  <p>This deployment is reachable over the network, so it will not serve the
     dashboard until a password is set.</p>
  <p>Set <code>DASHBOARD_PASSWORD</code> in your service variables and redeploy.
     You will then be prompted for it in the browser.</p>
  <p>The desktop application is unaffected — it runs on your own machine and
     needs no password.</p>
</main>`;

  return new NextResponse(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Methods that can change something and therefore need CSRF protection. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Rejects state-changing requests that a browser tells us came from elsewhere.
 *
 * Basic auth credentials are *ambient*: once the browser has them it attaches
 * them automatically, including to requests another site causes. A form on an
 * attacker's page posting to /api/projects would therefore arrive fully
 * authenticated. A JSON content-type would normally force a preflight and be
 * blocked, but a form with `enctype="text/plain"` is a simple request that
 * sends no preflight, and `request.json()` parses the body regardless of its
 * content type — so the JSON API is reachable that way.
 *
 * Only positively cross-site requests are rejected. A client with no Origin and
 * no Sec-Fetch-Site is not a browser, so it had to supply the password itself
 * and is not what CSRF describes; refusing those would break scripts for no
 * security gain.
 */
function isCrossSite(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "cross-site" || site === "same-site";

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    // An unparseable Origin is not something to trust.
    return true;
  }
}

function forbidden(): NextResponse {
  return new NextResponse("Cross-site requests are not allowed.", {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

export function middleware(request: NextRequest) {
  // The desktop shell sets this when it forks the bundled server. That server
  // listens on 127.0.0.1 only, so nothing off the machine can reach it directly —
  // but loopback binding is not an authorization boundary. A malicious page open
  // in the same browser can still issue a cross-site request to localhost, so
  // mutating requests get the same cross-site rejection hosted mode uses below.
  if (process.env.DASHBOARD_LOCAL === "1") {
    if (MUTATING.has(request.method) && isCrossSite(request)) return forbidden();
    return NextResponse.next();
  }

  // Local development is equally unreachable and should not need a password.
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) return setupRequired();

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return unauthorized();
  }

  // Any username is accepted; the password is the secret. Browsers require a
  // username field, and inventing a second credential adds nothing here.
  const supplied = decoded.slice(decoded.indexOf(":") + 1);
  if (!safeEqual(supplied, password)) return unauthorized();

  // Checked after authentication so an unauthenticated caller learns nothing
  // about which requests would otherwise have been accepted.
  if (MUTATING.has(request.method) && isCrossSite(request)) return forbidden();

  return NextResponse.next();
}

export const config = {
  /*
   * Everything except Next's own static output. Pages and API routes are both
   * covered: gating only the UI would leave /api/projects wide open.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
