import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { getAiSettings } from "@/core/ai/settings";
import { isLocalRuntime } from "@/core/ai/service";
import { LocalChatProvider } from "@/core/ai/local-provider";
import { aiLog } from "@/core/ai/logging";
import { isAiError } from "@/core/ai/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/ai/preload — put the default model into VRAM now.
 *
 * Only ever called deliberately: by the desktop shell at startup when the user
 * has ticked "preload", or from the Settings diagnostics. Loading an 11 GB
 * model is not something to do as a side effect of a page render.
 */
export async function POST() {
  ensureDatabaseReady();

  const settings = getAiSettings();
  if (!settings.enabled || !isLocalRuntime()) {
    return NextResponse.json({ error: "Local AI is not available here." }, { status: 409 });
  }

  const model = settings.defaultModel.trim();
  if (!model) {
    return NextResponse.json(
      { error: "Choose a default model before preloading." },
      { status: 422 },
    );
  }

  try {
    await LocalChatProvider.fromSettings(settings).preload(model, settings);
    return NextResponse.json({ ok: true, model });
  } catch (error) {
    const code = isAiError(error) ? error.code : "generation_failed";
    const message = isAiError(error) ? error.message : "Could not load that model.";
    aiLog("generation.error", { provider: "local", model, code, detail: message });
    return NextResponse.json({ error: message, code }, { status: 502 });
  }
}
