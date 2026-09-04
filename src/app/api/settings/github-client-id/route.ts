import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { deleteSetting, setSetting, SETTING_KEYS } from "@/core/settings/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  clientId: z
    .string()
    .trim()
    .min(1, "Paste the Client ID from your OAuth app")
    .max(128)
    // Formats have changed over time (Iv1., Ov23…), so this only rules out
    // obvious mistakes like a pasted URL or a whole secret block.
    .regex(/^[A-Za-z0-9._-]+$/, "That does not look like a Client ID"),
});

/** PUT — store the OAuth app client id. */
export async function PUT(request: Request) {
  ensureDatabaseReady();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid Client ID" },
      { status: 422 },
    );
  }

  setSetting(SETTING_KEYS.githubClientId, parsed.data.clientId);
  return NextResponse.json({ clientId: parsed.data.clientId });
}

/** DELETE — forget it, falling back to the environment if one is set. */
export async function DELETE() {
  ensureDatabaseReady();
  deleteSetting(SETTING_KEYS.githubClientId);
  return NextResponse.json({ ok: true });
}
