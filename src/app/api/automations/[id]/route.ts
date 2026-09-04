import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { updateAutomation } from "@/core/automation/service";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  // A minute floor stops an interval that would hammer the API; a week ceiling
  // keeps the value meaningful rather than "effectively never".
  intervalMinutes: z.coerce.number().int().min(5).max(10_080).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabaseReady();

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid update" },
      { status: 422 },
    );
  }

  const automation = await updateAutomation((await params).id, parsed.data);
  if (!automation) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }
  return NextResponse.json({ automation });
}
