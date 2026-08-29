import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { syncRepositories } from "@/core/github/service";

export const dynamic = "force-dynamic";

/** POST /api/github/sync — pull repositories from the active provider. */
export async function POST() {
  ensureDatabaseReady();
  try {
    const result = await syncRepositories();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "GitHub sync failed unexpectedly",
      },
      { status: 502 },
    );
  }
}
