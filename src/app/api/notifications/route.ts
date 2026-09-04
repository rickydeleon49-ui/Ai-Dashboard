import { NextResponse } from "next/server";
import { ensureDatabaseReady } from "@/db/bootstrap";
import {
  clearNotifications,
  listNotifications,
  markAllRead,
  unreadCount,
} from "@/core/automation/notifications";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureDatabaseReady();
  const [items, unread] = await Promise.all([listNotifications(), unreadCount()]);
  return NextResponse.json({ notifications: items, unread });
}

/** POST — mark everything read. */
export async function POST() {
  ensureDatabaseReady();
  await markAllRead();
  return NextResponse.json({ ok: true });
}

/** DELETE — clear the list entirely. */
export async function DELETE() {
  ensureDatabaseReady();
  await clearNotifications();
  return NextResponse.json({ ok: true });
}
