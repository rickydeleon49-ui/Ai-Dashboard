/**
 * Handlers behind /login, /api/operator/login and /api/operator/logout
 * (self-hosted mode only), plus the re-auth guard for sensitive actions.
 * Everything fails closed: outside self-hosted mode, or with no operator file,
 * these routes answer 404 / 503 and never set a cookie.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isSelfHostedMode } from "../../lib/auth-mode";
import { readOperatorFile, verifyPassword } from "../selfhost/operator-store";
import {
  LOGIN_FAILURES_GLOBAL,
  LOGIN_FAILURES_PER_IP,
  LOGIN_WINDOW_MS,
  OPERATOR_COOKIE,
  SESSION_LIFETIME_MS,
  clearOperatorCookieHeader,
  createOperatorSession,
  createRateLimiter,
  isRecentSignIn,
  operatorCookieHeader,
  safeNextPath,
  verifyOperatorSession,
} from "./operator";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const perIpLimiter = createRateLimiter(LOGIN_FAILURES_PER_IP, LOGIN_WINDOW_MS);
const globalLimiter = createRateLimiter(LOGIN_FAILURES_GLOBAL, LOGIN_WINDOW_MS);
const GLOBAL_KEY = "*";

const knownKeys = new Set<string>();

/** Test hook: forget all recorded failures. */
export function resetLoginLimits(): void {
  globalLimiter.reset(GLOBAL_KEY);
  for (const k of knownKeys) perIpLimiter.reset(k);
  knownKeys.clear();
}

/**
 * The nearest proxy appends to X-Forwarded-For, so the last entry is the least
 * spoofable. With no proxy the header is client-controlled, which is why a
 * global limit backs up the per-client one.
 */
function clientKey(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const last = xff.split(",").pop()?.trim();
    if (last) return last.slice(0, 64);
  }
  const real = request.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "unknown";
}

function json(
  body: unknown,
  status: number,
  extra: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE, ...extra },
  });
}

export async function handleOperatorLogin(
  request: NextRequest,
  now: number = Date.now(),
): Promise<NextResponse> {
  if (!isSelfHostedMode()) return json({ error: "not_found" }, 404);
  const record = readOperatorFile();
  if (!record) return json({ error: "not_configured" }, 503);

  const ip = clientKey(request);
  if (
    perIpLimiter.isLimited(ip, now) ||
    globalLimiter.isLimited(GLOBAL_KEY, now)
  ) {
    return json({ error: "too_many_attempts" }, 429, {
      "Retry-After": String(Math.ceil(LOGIN_WINDOW_MS / 1000)),
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const password = (body as { password?: unknown } | null)?.password;
  const next = (body as { next?: unknown } | null)?.next;

  const ok =
    typeof password === "string" &&
    password.length <= 1024 &&
    (await verifyPassword(password, record.passwordHash));
  if (!ok) {
    knownKeys.add(ip);
    perIpLimiter.recordFailure(ip, now);
    globalLimiter.recordFailure(GLOBAL_KEY, now);
    return json({ error: "invalid_credentials" }, 401);
  }

  const created = await createOperatorSession(now, record.sessionKey);
  if (!created) return json({ error: "not_configured" }, 503);
  perIpLimiter.reset(ip);
  return json(
    { ok: true, next: safeNextPath(typeof next === "string" ? next : null) },
    200,
    {
      "Set-Cookie": operatorCookieHeader(
        created.value,
        Math.floor(SESSION_LIFETIME_MS / 1000),
      ),
    },
  );
}

export function handleOperatorLogout(): NextResponse {
  if (!isSelfHostedMode()) return json({ error: "not_found" }, 404);
  return json({ ok: true }, 200, { "Set-Cookie": clearOperatorCookieHeader() });
}

/**
 * For approvals and other sensitive actions (AW5-05): null when the operator
 * entered the password within the last five minutes, else a 401 response.
 * Fails closed outside self-hosted mode too.
 */
export async function requireRecentSignIn(
  request: NextRequest,
  now: number = Date.now(),
): Promise<NextResponse | null> {
  if (isSelfHostedMode()) {
    const session = await verifyOperatorSession(
      request.cookies.get(OPERATOR_COOKIE)?.value,
      now,
    );
    if (session && isRecentSignIn(session, now)) return null;
  }
  return json({ error: "reauth_required" }, 401);
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderLoginPage(
  reauth: boolean,
  nextRaw: string | null,
): NextResponse {
  const next = safeNextPath(nextRaw);
  const heading = reauth ? "Sign in again" : "Sign in";
  const note = reauth
    ? "This action needs a recent sign-in. Enter your password again to continue."
    : "Enter the operator password set on this machine.";
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading} · Command Center</title>
<style>
  :root { color-scheme: dark light; }
  body { background:#08090b; color:#ededef; font:14px/1.6 ui-sans-serif,system-ui,sans-serif;
         display:grid; place-items:center; min-height:100dvh; margin:0; padding:24px; }
  main { width:100%; max-width:22rem; }
  h1 { font-size:1.05rem; margin:0 0 .5rem; }
  p { color:#8b8d98; margin:0 0 1rem; }
  input, button { font:inherit; width:100%; box-sizing:border-box; padding:.6rem .75rem; border-radius:6px; }
  input { background:#16191f; color:#ededef; border:1px solid rgba(255,255,255,.18); margin-bottom:.75rem; }
  button { background:#b9a7ff; color:#08090b; border:0; font-weight:600; cursor:pointer; }
  button[disabled] { opacity:.6; cursor:wait; }
  #err { color:#ff8a8a; min-height:1.4em; margin:.5rem 0 0; }
</style>
<main>
  <h1>${heading}</h1>
  <p>${note}</p>
  <form id="f" autocomplete="on">
    <input id="pw" type="password" name="password" autocomplete="current-password" required autofocus aria-label="Password">
    <button id="go" type="submit">${heading}</button>
    <p id="err" role="alert"></p>
  </form>
</main>
<script>
  var NEXT = ${JSON.stringify(next).replace(/</g, "\\u003c")};
  var f = document.getElementById("f"), pw = document.getElementById("pw");
  var go = document.getElementById("go"), err = document.getElementById("err");
  f.addEventListener("submit", function (e) {
    e.preventDefault();
    go.disabled = true; err.textContent = "";
    fetch("/api/operator/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: pw.value, next: NEXT })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { s: r.status, b: b }; });
    }).then(function (x) {
      if (x.s === 200 && x.b && x.b.ok) { window.location.assign(typeof x.b.next === "string" ? x.b.next : "/"); return; }
      err.textContent = x.s === 429 ? "Too many attempts. Wait a minute and try again." : "Sign-in failed.";
      go.disabled = false; pw.value = ""; pw.focus();
    }).catch(function () { err.textContent = "Sign-in failed."; go.disabled = false; });
  });
</script>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...NO_STORE,
      "X-Frame-Options": "DENY",
    },
  });
}
