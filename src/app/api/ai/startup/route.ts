import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { getAiSettings } from "@/core/ai/settings";
import { isLocalRuntime } from "@/core/ai/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/startup — what the desktop shell needs to decide about Ollama.
 *
 * The shell has no database of its own, and giving it one would mean two
 * copies of every preference. It asks this once, immediately after the bundled
 * server comes up, and acts on the answer.
 *
 * Deliberately narrow: an endpoint, two booleans and a model tag. No secrets,
 * no paths, and nothing that could be mistaken for a command.
 */
export async function GET() {
  ensureDatabaseReady();
  const settings = getAiSettings();

  return NextResponse.json(
    {
      enabled: settings.enabled && isLocalRuntime(),
      autoStart: settings.autoStart,
      endpoint: settings.endpoint,
      preloadModel: settings.preloadModel,
      // Only a saved default is preloaded. "Whichever model is first" is not a
      // choice the user made, and it could be the 20 GB one.
      model: settings.defaultModel.trim(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
