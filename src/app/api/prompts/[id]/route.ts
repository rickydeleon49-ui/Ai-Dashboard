import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { deletePrompt, findPrompt, updatePrompt } from "@/core/prompts/service";
import { promptUpdateSchema } from "@/core/prompts/schema";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  ensureDatabaseReady();
  const prompt = await findPrompt((await params).id);
  if (!prompt) {
    return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
  }
  return NextResponse.json({ prompt });
}

export async function PATCH(request: Request, { params }: Context) {
  ensureDatabaseReady();

  const parsed = promptUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid update" },
      { status: 422 },
    );
  }

  const prompt = await updatePrompt((await params).id, parsed.data);
  if (!prompt) {
    return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
  }
  return NextResponse.json({ prompt });
}

export async function DELETE(_request: Request, { params }: Context) {
  ensureDatabaseReady();
  const deleted = await deletePrompt((await params).id);
  if (!deleted) {
    return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
