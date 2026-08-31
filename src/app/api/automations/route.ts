import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { listAutomations } from "@/core/automation/service";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureDatabaseReady();
  return NextResponse.json({ automations: await listAutomations() });
}
