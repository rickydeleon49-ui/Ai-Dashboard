import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDatabaseReady } from "@/db/bootstrap";
import {
  deleteSetting,
  describeSecret,
  setSetting,
  SETTING_KEYS,
} from "@/core/settings/service";
import { invalidateConnectionCache } from "@/core/github/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, "Paste a token first")
    .max(512, "That does not look like a GitHub token"),
});

/** PUT /api/settings/github-token — store a personal access token. */
export async function PUT(request: Request) {
  ensureDatabaseReady();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid token" },
      { status: 422 },
    );
  }

  setSetting(SETTING_KEYS.githubToken, parsed.data.token);
  // A pasted token is not an OAuth one; do not let a stale origin claim it is.
  setSetting(SETTING_KEYS.githubTokenOrigin, "pat");
  // The next read must probe with the new credential, not a cached verdict.
  invalidateConnectionCache();

  // Only the hint goes back — never the token itself.
  return NextResponse.json({ status: describeSecret(SETTING_KEYS.githubToken) });
}

/** DELETE /api/settings/github-token — forget it. */
export async function DELETE() {
  ensureDatabaseReady();
  deleteSetting(SETTING_KEYS.githubToken);
  deleteSetting(SETTING_KEYS.githubTokenOrigin);
  invalidateConnectionCache();
  return NextResponse.json({ status: describeSecret(SETTING_KEYS.githubToken) });
}
