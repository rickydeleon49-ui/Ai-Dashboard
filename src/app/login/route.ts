import { NextResponse, type NextRequest } from "next/server";
import { isSelfHostedMode } from "@/lib/auth-mode";
import { renderLoginPage } from "@/core/auth/operator-routes";

export const dynamic = "force-dynamic";

/** Standalone page (not inside the app shell) so nothing from the dashboard renders before sign-in. */
export function GET(request: NextRequest) {
  if (!isSelfHostedMode())
    return new NextResponse("Not found.", { status: 404 });
  const params = request.nextUrl.searchParams;
  return renderLoginPage(params.get("reauth") === "1", params.get("next"));
}
