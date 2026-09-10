import "server-only";

import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import type { NextAuthRequest, Session } from "next-auth";

/**
 * True once hosted multi-user mode is actually usable. A route guarded by
 * proxy.ts's AUTH_MODE=accounts gate could still be reached without it in
 * a misconfigured deployment (AUTH_MODE unset) or in desktop/single-
 * password hosted mode, where DATABASE_URL is never set at all — this is
 * the route-level half of "never trust proxy.ts alone".
 */
export function accountsModeEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** What a route should return when accountsModeEnabled() is false. */
export function accountsModeDisabledResponse(): NextResponse {
  return NextResponse.json(
    { error: "Hosted accounts are not enabled on this deployment." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Resolves the signed-in user's session for a route handler, hosted
 * multi-user mode only (AUTH_MODE=accounts).
 *
 * Deliberately built on the same auth(callback) wrapper proxy.ts's
 * handleAccountsMode uses (see its own header comment), rather than the
 * simpler zero-argument `await auth()` form the Server Components example
 * in Auth.js's docs shows: that form reads cookies through
 * `next/headers()`'s ambient request context, which Next's real server
 * populates before calling a route handler but a test calling the
 * exported handler function directly does not — this reads the session
 * from the request object explicitly instead, so it works identically
 * either way. `@/auth` is imported dynamically for the same reason
 * proxy.ts imports it dynamically: this module is only ever reached from
 * accounts-mode routes, but importing it eagerly would still pull Auth.js
 * into builds that never use it.
 */
export async function sessionFromRequest(request: NextRequest): Promise<Session | null> {
  const { auth } = await import("@/auth");
  let session: Session | null = null;
  const handler = await auth(async (req: NextAuthRequest, _event: NextFetchEvent) => {
    session = req.auth;
  });
  await handler(request, {} as NextFetchEvent);
  return session;
}
