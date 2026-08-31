import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureDatabaseReady } from "@/db/bootstrap";
import {
  isDeviceFlowConfigured,
  pollDeviceFlow,
  startDeviceFlow,
} from "@/core/github/device-flow";
import { describeSecret, setSetting, SETTING_KEYS } from "@/core/settings/service";
import { invalidateConnectionCache } from "@/core/github/service";

export const dynamic = "force-dynamic";

/** GET — is Connect with GitHub available on this install? */
export async function GET() {
  return NextResponse.json({ configured: isDeviceFlowConfigured() });
}

const pollSchema = z.object({ deviceCode: z.string().min(1) });

/**
 * POST — start a device authorization, or poll one already in progress.
 *
 * One route with two shapes rather than two routes: they are halves of a single
 * conversation, and splitting them would only spread that conversation across
 * files.
 */
export async function POST(request: Request) {
  ensureDatabaseReady();

  const body = await request.json().catch(() => ({}));
  const polling = pollSchema.safeParse(body);

  if (!polling.success) {
    try {
      return NextResponse.json(await startDeviceFlow());
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not start" },
        { status: 502 },
      );
    }
  }

  const result = await pollDeviceFlow(polling.data.deviceCode);

  if (result.status === "authorized") {
    setSetting(SETTING_KEYS.githubToken, result.accessToken);
    setSetting(SETTING_KEYS.githubTokenOrigin, "oauth");
    invalidateConnectionCache();

    // The token itself never goes back to the browser — only its hint.
    return NextResponse.json({
      status: "authorized",
      secret: describeSecret(SETTING_KEYS.githubToken),
    });
  }

  return NextResponse.json(result);
}
