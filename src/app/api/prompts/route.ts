import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { createPrompt, listPrompts } from "@/core/prompts/service";
import { promptCreateSchema } from "@/core/prompts/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  ensureDatabaseReady();
  const url = new URL(request.url);
  return NextResponse.json({
    prompts: await listPrompts({
      search: url.searchParams.get("search") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      favorite: url.searchParams.get("favorite") === "1",
    }),
  });
}

export async function POST(request: Request) {
  ensureDatabaseReady();

  const parsed = promptCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid prompt" },
      { status: 422 },
    );
  }

  return NextResponse.json(
    { prompt: await createPrompt(parsed.data) },
    { status: 201 },
  );
}
