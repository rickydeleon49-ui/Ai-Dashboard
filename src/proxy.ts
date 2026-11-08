import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import type { NextAuthRequest } from "next-auth";
import { safeEqual } from "@/lib/safe-equal";
import { isAccountsMode } from "@/lib/auth-mode";

/**
 * Access control for the whole application.
 *
 * The dashboard has no user accounts — it is one person's tool — but it holds
 * project notes and can create, edit and delete everything through its API. Three
 * very different deployments have to be served:
 *
 *   Desktop   the bundled server binds 127.0.0.1 on a random port and is
 *             unreachable from outside the machine. Asking for a password there
 *             would be pure friction, so the desktop shell marks itself with
 *             DASHBOARD_LOCAL and is let through.
 *
 *   Hosted,   a Railway (or similar) deployment is reachable by anyone who finds
 *   single-   the URL. It requires DASHBOARD_PASSWORD — one shared secret, no
 *   password  per-user accounts.
 *
 *   Hosted,   AUTH_MODE=accounts opts into real per-user accounts (Auth.js
 *   accounts  sessions, workspaces) instead of the single shared password.
 *             Requires DATABASE_URL (Postgres) — see handleAccountsMode below.
 *
 * The default is deliberately fail-safe: a production deployment with no
 * password (or, in accounts mode, no database) configured serves a setup
 * notice instead of the dashboard. Forgetting to set it cannot silently
 * publish the library to the internet.
 */

const REALM = "Command Center";

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

/** Shown when AUTH_MODE=accounts is set but DATABASE_URL is not. */
function accountsNotConfigured(): NextResponse {
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
  <h1>Command Center is not configured for hosted accounts</h1>
  <p><code>AUTH_MODE=accounts</code> is set, but <code>DATABASE_URL</code> is not —
     accounts mode needs a Postgres database to store users, sessions and
     workspaces.</p>
  <p>Set <code>DATABASE_URL</code> in your service variables and redeploy.</p>
</main>`;

  return new NextResponse(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Auth.js's own routes: sign-in, OAuth/email callbacks, session, sign-out. */
function isAuthRoute(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function unauthenticatedResponse(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const signInUrl = new URL("/api/auth/signin", request.url);
  signInUrl.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(signInUrl);
}

/**
 * Pages reachable at all under AUTH_MODE=accounts: Dashboard, Projects and
 * Favorites (a filtered view of the same, genuinely-ported Projects domain
 * — see PostgresProjectRepository), Settings, My Work, plus the
 * invitation-accept page accounts mode itself needs.
 * `/projects/:id/tasks` needs no separate entry — it already matches the
 * `/projects` prefix below. Milestones and tasks (Phase 2, Release A) are
 * workspace-scoped for real in accounts mode too, the same as Projects
 * (see PostgresMilestoneRepository/PostgresTaskRepository), so they're
 * ported here rather than hidden. Same story for `/projects/:id/knowledge`
 * (Phase 2, Release B — see PostgresKnowledgeDocumentRepository): no
 * separate entry needed, and no `/api/knowledge` entry below either,
 * since `/api/projects/:id/knowledge` already matches `/api/projects`.
 *
 * Everything else (AI workspace, uploads, prompts, automations, GitHub
 * sync, notes, notifications, integrations, tools) still reads and writes
 * SQLite-only tables that were never given a workspace_id column —
 * reachable here, every accounts-mode user would see one shared dataset
 * regardless of which workspace they're in. Hidden rather than exposed
 * half-scoped, per the plan's own framing; each gets genuinely ported in
 * a later phase.
 *
 * `/inbox` and `/api/inbox` are the Release 2C.6 collaboration inbox —
 * PostgreSQL-backed and scoped to (workspace, recipient) — and deliberately a
 * different namespace from the SQLite automation `/notifications` above,
 * which stays blocked here.
 *
 * `/calendar` and `/api/calendar` (Release 2D.1) read only tasks and
 * milestones, which are workspace-scoped in PostgreSQL like the rest of the
 * Projects domain.
 *
 * `/templates` and `/api/templates` (Release 2D.3) use PostgreSQL template
 * tables scoped by workspace_id, and create projects only in that workspace.
 */
const ACCOUNTS_MODE_ALLOWED_PAGES = [
  "/",
  "/projects",
  "/favorites",
  "/settings",
  "/invite",
  "/my-work",
  "/inbox",
  "/calendar",
  "/templates",
];

/** The API routes those pages need. Same reasoning as the page list above. */
const ACCOUNTS_MODE_ALLOWED_API_PATHS = [
  "/api/projects",
  "/api/workspaces",
  "/api/invitations",
  "/api/ownership-claim",
  "/api/tasks",
  "/api/my-work",
  "/api/inbox",
  "/api/calendar",
  "/api/templates",
];

/** True for an exact match or anything nested under it (e.g. `/projects/new`). */
function isAllowedInAccountsMode(pathname: string): boolean {
  // Project files are not yet workspace-scoped in accounts mode; block them outright.
  if (
    pathname.match(/^\/api\/projects\/[^/]+\/files(\/.*)?$/) ||
    pathname.match(/^\/api\/files(\/.*)?$/)
  ) {
    return false;
  }
  const allowed = pathname.startsWith("/api/")
    ? ACCOUNTS_MODE_ALLOWED_API_PATHS
    : ACCOUNTS_MODE_ALLOWED_PAGES;
  return allowed.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/** Shown for a page or API route this deployment doesn't expose in accounts mode. */
function notFoundInAccountsMode(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new NextResponse("Not found.", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * AUTH_MODE=accounts: gates page loads and API calls on an Auth.js session.
 *
 * `@/auth` is imported dynamically, inside this function, rather than at
 * module scope: proxy.ts's matcher covers every request in every mode, so a
 * static import would pull Auth.js (and this app's Postgres client) into
 * every build and every request regardless of mode — real cost for
 * desktop and single-password hosted deployments, which never use this
 * branch at all. It also sidesteps a test-harness-only crash: `tests/unit/`
 * runs under --conditions=react-server (to resolve `server-only` guards
 * elsewhere), and Auth.js's own import graph does not tolerate that flag —
 * see tests/unit-pg-auth/auth.test.ts's header comment. A static import
 * here would pull that crash into the desktop/SQLite regression suite,
 * which never sets AUTH_MODE=accounts and so should never pay for it.
 *
 * Authorization here is deliberately shallow — "is there a signed-in user
 * at all" — not "is this user allowed to do this". Real authorization is
 * workspace-scoped and lives in each route handler (see the plan's
 * requireRole() step); this is defense in depth, not the only check.
 */
async function handleAccountsMode(request: NextRequest, event: NextFetchEvent) {
  if (!process.env.DATABASE_URL) return accountsNotConfigured();

  const { auth } = await import("@/auth");
  // Declaring both parameters (matching NextAuthMiddleware's own signature)
  // disambiguates this from auth()'s route-handler overload, whose second
  // parameter is an incompatible { params } context rather than the fetch
  // event proxy.ts is called with.
  //
  // auth(callback) itself must be awaited here: because src/auth.ts passes
  // NextAuth() a config *factory* (the lazy form Step 2 needed to avoid
  // constructing the Postgres adapter at build time), next-auth's own
  // wrapper takes a different internal branch than the plain-config case
  // its docs example shows — one that resolves to the actual handler
  // asynchronously instead of returning it outright.
  const gate = await auth(async (req: NextAuthRequest, _event: NextFetchEvent) => {
    if (isAuthRoute(req.nextUrl.pathname)) {
      return MUTATING.has(req.method) && isCrossSite(req) ? forbidden() : NextResponse.next();
    }
    if (!req.auth) return unauthenticatedResponse(req);

    // Checked after authentication so an unauthenticated caller learns
    // nothing about which requests would otherwise have been accepted —
    // same reasoning as the CSRF check just below.
    if (!isAllowedInAccountsMode(req.nextUrl.pathname)) return notFoundInAccountsMode(req);

    if (MUTATING.has(req.method) && isCrossSite(req)) return forbidden();
    return NextResponse.next();
  });
  return gate(request, event);
}

export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const s = addr.trim().toLowerCase();
  if (s === "") return false;

  let host: string;
  if (s.startsWith("[")) {
    const closeIndex = s.indexOf("]");
    if (closeIndex === -1) return false;
    const remainder = s.slice(closeIndex + 1);
    if (remainder !== "" && !/^:\d{1,5}$/.test(remainder)) return false;
    host = s.slice(1, closeIndex);
  } else {
    const colonIndex = s.indexOf(":");
    if (colonIndex !== -1 && colonIndex === s.lastIndexOf(":")) {
      const port = s.slice(colonIndex + 1);
      if (!/^\d{1,5}$/.test(port)) return false;
      host = s.slice(0, colonIndex);
    } else {
      host = s;
    }
  }

  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host === "::ffff:127.0.0.1" ||
    host === "0:0:0:0:0:ffff:127.0.0.1"
  );
}

function desktopUnauthorized(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new NextResponse("Unauthorized.", {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

export function validateStartupConfig(): { valid: boolean; error?: string } {
  if (process.env.DASHBOARD_LOCAL === "1" || process.env.DESKTOP_INTERNAL_SECRET) {
    if (process.env.AUTH_MODE === "accounts" || Boolean(process.env.DATABASE_URL)) {
      return {
        valid: false,
        error: "Desktop local mode cannot be used with AUTH_MODE=accounts or DATABASE_URL.",
      };
    }
    if (Boolean(process.env.DASHBOARD_PASSWORD?.trim())) {
      return {
        valid: false,
        error: "Desktop local mode cannot be used with DASHBOARD_PASSWORD.",
      };
    }
  }
  return { valid: true };
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  // 1. Hosted accounts mode takes strict precedence over any local variables or secrets.
  if (process.env.AUTH_MODE === "accounts" || isAccountsMode()) {
    return handleAccountsMode(request, event);
  }

  // 2. Hosted single-password mode takes strict precedence over desktop local mode.
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (password) {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Basic ")) return unauthorized();

    let decoded: string;
    try {
      decoded = atob(header.slice("Basic ".length));
    } catch {
      return unauthorized();
    }

    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    if (!safeEqual(supplied, password)) return unauthorized();

    if (MUTATING.has(request.method) && isCrossSite(request)) return forbidden();
    return NextResponse.next();
  }

  // 3. Desktop shell mode authenticated via per-launch cryptographic secret.
  // Requires DESKTOP_INTERNAL_SECRET and constant-time match on x-dashboard-desktop-secret.
  // Rejects missing secrets, invalid secrets, and forwarded headers.
  const desktopSecret = process.env.DESKTOP_INTERNAL_SECRET?.trim();
  if (desktopSecret) {
    // Reject forwarded headers attempting to impersonate or leak from external proxy
    const xfh = request.headers.get("x-forwarded-host");
    if (xfh && !isLoopbackAddress(xfh)) {
      return desktopUnauthorized(request);
    }
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      for (const ip of xff.split(",")) {
        if (!isLoopbackAddress(ip)) return desktopUnauthorized(request);
      }
    }

    const provided = request.headers.get("x-dashboard-desktop-secret");
    if (!provided) {
      return desktopUnauthorized(request);
    }
    if (!safeEqual(provided, desktopSecret)) {
      return desktopUnauthorized(request);
    }

    if (MUTATING.has(request.method) && isCrossSite(request)) return forbidden();
    return NextResponse.next();
  }

  // 4. Local development without password or secret is allowed in dev mode only.
  if (process.env.NODE_ENV !== "production") return NextResponse.next();

  // 5. In production without accounts mode, password, or valid desktop secret: fail closed.
  return setupRequired();
}

export const config = {
  /*
   * Everything except Next's own static output. Pages and API routes are both
   * covered: gating only the UI would leave /api/projects wide open.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
