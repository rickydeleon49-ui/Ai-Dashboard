import "server-only";

import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { syncRepositories } from "@/core/github/service";
import { notify } from "./notifications";

/**
 * The catalogue of things the dashboard can do on a schedule.
 *
 * Adding an automation is one entry here — the scheduler, the settings screen
 * and the run history all read from this list, so nothing else needs touching.
 */

export interface TaskResult {
  status: "ok" | "skipped" | "failed";
  message: string;
}

export interface TaskDefinition {
  type: string;
  name: string;
  description: string;
  /** Sensible default cadence, in minutes. */
  defaultInterval: number;
  /** Whether it should be on for a fresh install. */
  defaultEnabled: boolean;
  run(config: Record<string, unknown>): Promise<TaskResult>;
}

/** Refreshes cached repository metadata from GitHub. */
const githubSync: TaskDefinition = {
  type: "github.sync",
  name: "Sync GitHub repositories",
  description:
    "Refreshes repository metadata and drops repositories you no longer have access to.",
  defaultInterval: 180,
  defaultEnabled: false,

  async run() {
    const result = await syncRepositories();

    // Nothing was connected, so nothing meaningful happened. Reporting this as
    // success would make the run history claim work that did not occur.
    if (!result.connection.connected) {
      return {
        status: "skipped",
        message: "GitHub is not connected, so there was nothing to sync.",
      };
    }

    const parts = [`${result.fetched} repositories`];
    if (result.created > 0) parts.push(`${result.created} new`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);

    if (result.created > 0 || result.removed > 0) {
      await notify({
        title: "GitHub sync found changes",
        body: parts.join(" · "),
        level: "info",
        href: "/github",
        source: githubSync.type,
      });
    }

    return { status: "ok", message: parts.join(" · ") };
  },
};

/** Flags active projects that have gone quiet. */
const staleProjects: TaskDefinition = {
  type: "projects.stale",
  name: "Flag stalled projects",
  description:
    "Notices projects still marked Active that have not been touched for a while.",
  defaultInterval: 1440,
  defaultEnabled: true,

  async run(config) {
    const days = Number(config.days) > 0 ? Number(config.days) : 21;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    const stalled = db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.status, "active"),
          eq(projects.archived, false),
          lt(projects.updatedAt, cutoff),
        ),
      )
      .orderBy(sql`${projects.updatedAt} asc`)
      .all();

    if (stalled.length === 0) {
      return { status: "ok", message: `No active project is older than ${days} days.` };
    }

    // One notification for the set rather than one per project: a dashboard
    // that buries you in alerts gets ignored, which defeats the purpose.
    const names = stalled.slice(0, 3).map((p) => p.name).join(", ");
    const extra = stalled.length > 3 ? ` and ${stalled.length - 3} more` : "";

    await notify({
      title: `${stalled.length} active ${stalled.length === 1 ? "project has" : "projects have"} gone quiet`,
      body: `${names}${extra} — untouched for over ${days} days.`,
      level: "warning",
      href: "/projects?status=active&sort=updated",
      source: staleProjects.type,
    });

    return {
      status: "ok",
      message: `${stalled.length} stalled: ${names}${extra}`,
    };
  },
};

export const TASKS: TaskDefinition[] = [githubSync, staleProjects];

export function findTask(type: string): TaskDefinition | undefined {
  return TASKS.find((task) => task.type === type);
}
