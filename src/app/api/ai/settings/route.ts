import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { aiSettingsUpdateSchema } from "@/core/ai/config";
import { getAiSettings, updateAiSettings } from "@/core/ai/settings";

export const dynamic = "force-dynamic";

/** GET /api/ai/settings — the stored local AI preferences. */
export async function GET() {
  ensureDatabaseReady();
  return NextResponse.json(
    { settings: getAiSettings() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** PATCH /api/ai/settings — change one or more of them. */
export async function PATCH(request: Request) {
  ensureDatabaseReady();

  const parsed = aiSettingsUpdateSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid settings" },
      { status: 422 },
    );
  }

  return NextResponse.json({ settings: updateAiSettings(parsed.data) });
}
