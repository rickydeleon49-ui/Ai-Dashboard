import { NextResponse, type NextRequest } from "next/server";
import { isAgentRunsEnabled } from "@/core/agents/availability";
import {
  getAgentStorageSettings,
  inspectRootStatus,
  setRunStore,
  setWorkspaceRoots,
  setWorktreeRoot,
} from "@/core/agents/roots";
import { getProviderProbes } from "@/core/agents/provider-probes";
import { ensureDatabaseReady } from "@/db/bootstrap";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  ensureDatabaseReady();

  const storage = await getAgentStorageSettings();
  const rootsStatus = storage.workspaceRoots.map((r) => inspectRootStatus(r));
  const worktreeStatus = inspectRootStatus(storage.worktreeRoot);
  const runStoreStatus = inspectRootStatus(storage.runStore);
  const providers = await getProviderProbes();

  return NextResponse.json({
    storage,
    statuses: {
      workspaceRoots: rootsStatus,
      worktreeRoot: worktreeStatus,
      runStore: runStoreStatus,
    },
    providers,
  });
}

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

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const { workspaceRoots, worktreeRoot, runStore } = body as {
    workspaceRoots?: unknown;
    worktreeRoot?: unknown;
    runStore?: unknown;
  };

  if (workspaceRoots !== undefined) {
    if (
      !Array.isArray(workspaceRoots) ||
      !workspaceRoots.every((r) => typeof r === "string")
    ) {
      return NextResponse.json(
        { error: "workspaceRoots must be an array of string paths" },
        { status: 400 },
      );
    }
    const res = await setWorkspaceRoots(workspaceRoots);
    if (!res.ok) {
      return NextResponse.json({ error: res.reason }, { status: 400 });
    }
  }

  if (worktreeRoot !== undefined) {
    if (typeof worktreeRoot !== "string" || worktreeRoot.trim() === "") {
      return NextResponse.json(
        { error: "worktreeRoot must be a non-empty string path" },
        { status: 400 },
      );
    }
    const res = await setWorktreeRoot(worktreeRoot);
    if (!res.ok) {
      return NextResponse.json({ error: res.reason }, { status: 400 });
    }
  }

  if (runStore !== undefined) {
    if (typeof runStore !== "string" || runStore.trim() === "") {
      return NextResponse.json(
        { error: "runStore must be a non-empty string path" },
        { status: 400 },
      );
    }
    const res = await setRunStore(runStore);
    if (!res.ok) {
      return NextResponse.json({ error: res.reason }, { status: 400 });
    }
  }

  const storage = await getAgentStorageSettings();
  const rootsStatus = storage.workspaceRoots.map((r) => inspectRootStatus(r));
  const worktreeStatus = inspectRootStatus(storage.worktreeRoot);
  const runStoreStatus = inspectRootStatus(storage.runStore);
  const providers = await getProviderProbes();

  return NextResponse.json({
    success: true,
    storage,
    statuses: {
      workspaceRoots: rootsStatus,
      worktreeRoot: worktreeStatus,
      runStore: runStoreStatus,
    },
    providers,
  });
}
