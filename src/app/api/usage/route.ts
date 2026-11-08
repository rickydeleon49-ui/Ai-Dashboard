import { NextResponse, type NextRequest } from "next/server";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { clearUsageCache, loadUsageSnapshotCached } from "@/core/usage";
import type { AppUsageSummary } from "@/core/usage/app-usage";
import { loadAppUsage } from "@/core/usage/app-usage-source";
import { getUsageFolder, setUsageFolder } from "@/core/usage/settings";
import { ensureDatabaseReady } from "@/db/bootstrap";

export const dynamic = "force-dynamic";

/** Usage for every AI tool, from the tracker files. Desktop local mode only. */
export async function GET(_request: NextRequest) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const folder = await getUsageFolder();
  const snapshot = loadUsageSnapshotCached({ folder, now: new Date() });
  const { app, warning } = loadAppUsageCached(new Date());
  return NextResponse.json({
    ...snapshot,
    app,
    warnings: warning ? [...snapshot.warnings, warning] : snapshot.warnings,
  });
}

const APP_USAGE_CACHE_MS = 60_000;
type AppUsageResult = { app: AppUsageSummary | null; warning: string | null };
let appCache: { at: number; value: AppUsageResult } | null = null;

/** The app's own usage, cached for 60 s like the tracker files. Never throws. */
function loadAppUsageCached(now: Date): AppUsageResult {
  const nowMs = now.getTime();
  if (appCache && nowMs - appCache.at >= 0 && nowMs - appCache.at < APP_USAGE_CACHE_MS) {
    return appCache.value;
  }
  let value: AppUsageResult;
  try {
    value = { app: loadAppUsage(now), warning: null };
  } catch {
    value = { app: null, warning: "The app's own usage could not be read." };
  }
  appCache = { at: nowMs, value };
  return value;
}

/** Change the folder the tracker files are read from (absolute path). */
export async function PATCH(request: NextRequest) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const folder =
    typeof body === "object" && body !== null
      ? (body as { folder?: unknown }).folder
      : undefined;
  if (typeof folder !== "string") {
    return NextResponse.json({ error: "folder must be a string path" }, { status: 400 });
  }
  const res = await setUsageFolder(folder);
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }
  clearUsageCache();
  appCache = null;
  return NextResponse.json({ success: true, folder: await getUsageFolder() });
}
