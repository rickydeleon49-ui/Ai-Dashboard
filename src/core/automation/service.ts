import "server-only";

import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { activityEvents, automations } from "@/db/schema";
import type { AutomationRow } from "@/db/schema";
import { createId } from "@/lib/ids";
import { findTask, TASKS, type TaskDefinition } from "./tasks";
import { notify } from "./notifications";

export interface Automation extends AutomationRow {
  /** Definition metadata, joined for display. Absent if the task was removed. */
  definition: Pick<TaskDefinition, "name" | "description"> | null;
  config: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Creates rows for any task that does not have one yet.
 *
 * The catalogue lives in code and the schedule lives in the database, so a task
 * added in a later version needs a row before it can be enabled. Doing it here,
 * on read, means no migration is required when the catalogue grows.
 */
export function ensureAutomationRows(): void {
  for (const task of TASKS) {
    const existing = db
      .select()
      .from(automations)
      .where(eq(automations.type, task.type))
      .get();
    if (existing) continue;

    db.insert(automations)
      .values({
        id: createId("aut"),
        type: task.type,
        enabled: task.defaultEnabled,
        intervalMinutes: task.defaultInterval,
        config: "{}",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
  }
}

export async function listAutomations(): Promise<Automation[]> {
  ensureAutomationRows();

  const rows = db.select().from(automations).orderBy(asc(automations.type)).all();

  return rows.map((row) => {
    const task = findTask(row.type);
    return {
      ...row,
      definition: task ? { name: task.name, description: task.description } : null,
    };
  });
}

export async function updateAutomation(
  id: string,
  patch: { enabled?: boolean; intervalMinutes?: number },
): Promise<Automation | null> {
  const existing = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!existing) return null;

  db.update(automations)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(automations.id, id))
    .run();

  const updated = db.select().from(automations).where(eq(automations.id, id)).get()!;
  const task = findTask(updated.type);
  return {
    ...updated,
    definition: task ? { name: task.name, description: task.description } : null,
  };
}

/** True when an automation is enabled and its interval has elapsed. */
function isDue(row: AutomationRow, at: number): boolean {
  if (!row.enabled) return false;
  if (!row.lastRunAt) return true;
  return at - new Date(row.lastRunAt).getTime() >= row.intervalMinutes * 60_000;
}

/**
 * Runs one automation and records the outcome.
 *
 * A failing task must not take the scheduler down with it, so the error is
 * captured onto the row and surfaced as a notification rather than thrown.
 */
export async function runAutomation(id: string): Promise<Automation | null> {
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!row) return null;

  const task = findTask(row.type);
  const at = nowIso();

  if (!task) {
    db.update(automations)
      .set({
        lastRunAt: at,
        lastStatus: "failed",
        lastMessage: `No task registered for "${row.type}"`,
        updatedAt: at,
      })
      .where(eq(automations.id, id))
      .run();
    return listOne(id);
  }

  let status: "ok" | "skipped" | "failed";
  let message: string;

  try {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      config = {};
    }

    const result = await task.run(config);
    status = result.status;
    message = result.message;
  } catch (error) {
    status = "failed";
    message = error instanceof Error ? error.message : "The task threw an error";

    await notify({
      title: `${task.name} failed`,
      body: message,
      level: "warning",
      href: "/ai/workflows",
      source: task.type,
    });
  }

  db.update(automations)
    .set({ lastRunAt: at, lastStatus: status, lastMessage: message, updatedAt: at })
    .where(eq(automations.id, id))
    .run();

  db.insert(activityEvents)
    .values({
      id: createId("act"),
      projectId: null,
      type: "automation.run",
      message: `${task.name}: ${message}`,
      metadata: JSON.stringify({ type: task.type, status }),
      createdAt: at,
    })
    .run();

  return listOne(id);
}

function listOne(id: string): Automation | null {
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!row) return null;
  const task = findTask(row.type);
  return {
    ...row,
    definition: task ? { name: task.name, description: task.description } : null,
  };
}

/**
 * Runs everything currently due.
 *
 * Sequential rather than parallel: these talk to the same SQLite file and the
 * same rate-limited API, and finishing a minute sooner is worth nothing here.
 */
export async function runDueAutomations(): Promise<number> {
  ensureAutomationRows();

  const at = Date.now();
  const due = db
    .select()
    .from(automations)
    .all()
    .filter((row) => isDue(row, at));

  for (const row of due) {
    await runAutomation(row.id);

    /*
     * Hand the event loop back between automations.
     *
     * better-sqlite3 is synchronous, so a task's queries block the single
     * thread that is also serving requests. Running several back to back
     * monopolises it for as long as they all take, which stalls responses that
     * are mid-flight. Yielding bounds that to one automation at a time.
     */
    await new Promise((resolve) => setImmediate(resolve));
  }

  return due.length;
}
