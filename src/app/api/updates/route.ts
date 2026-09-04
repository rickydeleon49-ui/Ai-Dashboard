import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { checkForUpdate } from "@/core/updates/service";

export const dynamic = "force-dynamic";

/** GET /api/updates — is a newer release available? */
export async function GET() {
  ensureDatabaseReady();
  return NextResponse.json(await checkForUpdate());
}
