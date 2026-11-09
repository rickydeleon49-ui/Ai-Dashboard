import type { NextRequest } from "next/server";
import { handleOperatorLogin } from "@/core/auth/operator-routes";

export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return handleOperatorLogin(request);
}
