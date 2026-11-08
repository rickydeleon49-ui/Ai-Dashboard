import { NextResponse, type NextRequest } from "next/server";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import { clearUsageCache, loadUsageSnapshotCached } from "@/core/usage";
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
  return NextResponse.json(snapshot);
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
  return NextResponse.json({ success: true, folder: await getUsageFolder() });
}
