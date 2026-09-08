import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import { deleteConversation, findConversation } from "@/core/ai/conversations";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/ai/conversations/:id — one transcript. */
export async function GET(_request: Request, { params }: Context) {
  ensureDatabaseReady();
  const { id } = await params;
  const conversation = findConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }
  return NextResponse.json({ conversation }, { headers: { "Cache-Control": "no-store" } });
}

/** DELETE /api/ai/conversations/:id — forget it, messages included. */
export async function DELETE(_request: Request, { params }: Context) {
  ensureDatabaseReady();
  const { id } = await params;
  if (!deleteConversation(id)) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
