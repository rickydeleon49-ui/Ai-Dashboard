import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { runAutomation } from "@/core/automation/service";

export const dynamic = "force-dynamic";

/** POST — run one automation now, regardless of its schedule. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabaseReady();
  const automation = await runAutomation((await params).id);
  if (!automation) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }
  return NextResponse.json({ automation });
}
