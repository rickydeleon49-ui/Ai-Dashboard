/**
 * Agent Workflow Control Center — Synthetic Demo Script (Release AW.1, AW1-14).
 *
 * Runs an end-to-end agent workflow in a completely isolated, disposable environment:
 * - Creates a temporary SQLite database in os.tmpdir() (refuses if DATABASE_PATH points elsewhere).
 * - Applies all pending Drizzle migrations.
 * - Configures isolated storage roots (workspaces, worktrees, run store).
 * - Creates a synthetic Git repository inside the workspace root.
 * - Submits a run request using the fake agent (scenario "success").
 * - Runs the runner/orchestrator until the run reaches a terminal status (timeout ~60s).
 * - Prints the stage timeline, event count, changed files, and final observed verdict.
 * - Cleans up the temporary directory unless --keep is passed.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

export interface DemoOptions {
  keep?: boolean;
  timeoutMs?: number;
  log?: (msg: string) => void;
  baseTempDir?: string;
}

export interface ChangedFileSummary {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface DemoResult {
  success: boolean;
  runId: string;
  status: string;
  eventsCount: number;
  tempDir: string;
  changedFiles: ChangedFileSummary[];
  outcome: Record<string, unknown> | null;
}

function isInside(child: string, parent: string): boolean {
  const normChild = nodePath.resolve(child);
  const normParent = nodePath.resolve(parent);
  const rel = nodePath.relative(normParent, normChild);
  return !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const log = options.log ?? console.log;
  const keep = options.keep ?? process.argv.includes("--keep");

  // 1. Safety check: refuse if DATABASE_PATH was already set pointing elsewhere
  if (process.env.DATABASE_PATH) {
    const existing = nodePath.resolve(process.env.DATABASE_PATH);
    if (!options.baseTempDir || !isInside(existing, options.baseTempDir)) {
      throw new Error(
        `Refusing to run demo: DATABASE_PATH points elsewhere than the demo temporary directory (${existing})`,
      );
    }
  }

  // 2. Create isolated temporary directory
  const tempDir = fs.realpathSync.native(
    fs.mkdtempSync(nodePath.join(options.baseTempDir ?? os.tmpdir(), "cc-agents-demo-")),
  );

  const prevEnv: Record<string, string | undefined> = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    UPLOADS_DIR: process.env.UPLOADS_DIR,
    DASHBOARD_LOCAL: process.env.DASHBOARD_LOCAL,
    DESKTOP_INTERNAL_SECRET: process.env.DESKTOP_INTERNAL_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
    AUTH_MODE: process.env.AUTH_MODE,
  };

  const dataDir = nodePath.join(tempDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = nodePath.join(dataDir, "demo.db");

  // Set environment for isolated run
  process.env.DATABASE_PATH = dbPath;
  process.env.UPLOADS_DIR = nodePath.join(tempDir, "uploads");
  process.env.DASHBOARD_LOCAL = "1";
  process.env.DESKTOP_INTERNAL_SECRET = crypto.randomBytes(16).toString("hex");
  delete process.env.DATABASE_URL;
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.AUTH_MODE;

  let runId = "";
  let finalStatus = "unknown";
  let eventsCount = 0;
  const changedFiles: ChangedFileSummary[] = [];
  let outcomeObj: Record<string, unknown> | null = null;
  let isSuccessful = false;

  try {
    // 3. Verify DATABASE_PATH safety after resolution
    const { resolveDatabasePath } = await import("@/db/path");
    const resolvedDb = resolveDatabasePath();
    if (!isInside(resolvedDb, tempDir)) {
      throw new Error(`Safety violation: resolved database path is outside temp dir: ${resolvedDb}`);
    }

    // 4. Verify desktop local availability
    const { isAgentRunsEnabled } = await import("@/core/agents/availability");
    if (!isAgentRunsEnabled()) {
      throw new Error("Agent runs are not enabled in this environment.");
    }

    // 5. Initialize database & run migrations
    log("Applying database migrations...");
    const { runMigrations } = await import("@/db/migrate");
    runMigrations();
    log("Migrations applied successfully.");

    // 6. Configure storage roots
    const workspaceRoot = nodePath.join(tempDir, "workspaces");
    const worktreeRoot = nodePath.join(tempDir, "agent-worktrees");
    const runStore = nodePath.join(tempDir, "agent-runs");

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.mkdirSync(nodePath.join(runStore, "runs"), { recursive: true });

    const { setWorkspaceRoots, setWorktreeRoot, setRunStore } = await import("@/core/agents/roots");
    const rRunStore = await setRunStore(runStore);
    if (!rRunStore.ok) throw new Error(`Failed to configure run store: ${rRunStore.reason}`);
    const rWorktree = await setWorktreeRoot(worktreeRoot);
    if (!rWorktree.ok) throw new Error(`Failed to configure worktree root: ${rWorktree.reason}`);
    const rRoots = await setWorkspaceRoots([workspaceRoot]);
    if (!rRoots.ok) throw new Error(`Failed to configure workspace roots: ${rRoots.reason}`);
    log("Configured workspace roots and worktree root in temp directory.");

    // 7. Create disposable synthetic Git project
    const repoPath = nodePath.join(workspaceRoot, "demo-project");
    fs.mkdirSync(repoPath, { recursive: true });

    function git(...args: string[]): void {
      execFileSync(
        "git",
        [
          "-c", "user.name=Demo Agent",
          "-c", "user.email=demo@agent-workflow.local",
          "-c", "init.defaultBranch=main",
          "-c", "core.autocrlf=false",
          ...args,
        ],
        { cwd: repoPath, stdio: "ignore" },
      );
    }

    git("init");
    fs.writeFileSync(
      nodePath.join(repoPath, "README.md"),
      "# Synthetic Demo Project\nThis is a temporary project for the agent demo.\n",
      "utf8",
    );
    git("add", ".");
    git("commit", "-m", "Initial commit");
    log(`Created synthetic Git repository at: ${repoPath}`);

    // 8. Register project and policy
    const { db } = await import("@/db/client");
    const {
      projects,
      agentProjectPolicies,
      agentRuns,
      agentRunIntents,
      agentRunEvents,
    } = await import("@/db/schema");
    const { asc, eq } = await import("drizzle-orm");

    const projectId = `prj-demo-${Date.now()}`;
    db.insert(projects)
      .values({
        id: projectId,
        name: "Agents Demo Project",
        localPath: repoPath,
      })
      .run();

    const checkName = "smoke";
    db.insert(agentProjectPolicies)
      .values({
        projectId,
        checkCommands: JSON.stringify([
          {
            name: checkName,
            argv: [process.execPath, "-e", "process.exit(0)"],
          },
        ]),
        excludedPaths: JSON.stringify(["secrets/**"]),
      })
      .run();

    // 9. Create start intent for a run using the FAKE agent (scenario "success")
    runId = `run-demo-${Date.now()}`;
    const request = {
      projectId,
      task: "Demo run: create fake-output.txt",
      roles: {
        implementer: {
          provider: "fake",
          model: "success",
        },
      },
      checks: [checkName],
    };

    db.insert(agentRuns)
      .values({
        id: runId,
        projectId,
        status: "queued",
        request: JSON.stringify(request),
      })
      .run();

    const intentId = `intent-demo-${Date.now()}`;
    db.insert(agentRunIntents)
      .values({
        id: intentId,
        runId,
        kind: "start",
        payload: JSON.stringify({}),
      })
      .run();

    log(`Created run intent: ${intentId} for run: ${runId}`);

    // 10. Run runner/orchestrator until terminal status
    const { createRunner } = await import("../runner/index");
    const { fakeAdapter } = await import("@/core/agents/adapters/fake");
    const { isTerminalStatus } = await import("@/core/agents/types");

    log("Starting runner...");
    const runner = createRunner({
      db,
      implementer: fakeAdapter,
      getStorage: async () => ({
        workspaceRoots: [workspaceRoot],
        worktreeRoot,
        runStore,
      }),
      orchestrator: {
        review: async () => ({
          verdict: "approve" as const,
          findings: [],
        }),
      },
      pollIntervalMs: 100,
      log: () => {},
    });

    await runner.start();

    const timeoutMs = options.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    let runRow = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();

    while (runRow && !isTerminalStatus(runRow.status)) {
      if (Date.now() > deadline) {
        await runner.shutdown();
        throw new Error(
          `Timed out after ${timeoutMs / 1000}s waiting for run ${runId} to reach a terminal status.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      runRow = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    }

    await runner.idle();
    await runner.shutdown();

    finalStatus = runRow?.status ?? "unknown";
    isSuccessful = finalStatus === "succeeded";

    // 11. Read events and print summary
    const events = db
      .select()
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, runId))
      .orderBy(asc(agentRunEvents.seq))
      .all();

    eventsCount = events.length;

    log("\n========================================================");
    log("              AGENT WORKFLOW DEMO SUMMARY               ");
    log("========================================================\n");

    // Stage timeline
    log("--- Stage Timeline ---");
    for (const e of events) {
      if (
        e.kind === "stage_started" ||
        e.kind === "stage_finished" ||
        e.kind === "status_changed"
      ) {
        let detail = "";
        try {
          const p = JSON.parse(e.payload);
          if (p.status) detail = `status=${p.status}`;
          else if (p.exitCode !== undefined) detail = `exitCode=${p.exitCode}`;
        } catch {}
        const detailStr = detail ? ` (${detail})` : "";
        log(`  [${e.ts}] stage: ${e.stage ?? "none"} -> ${e.kind}${detailStr}`);
      }
    }

    // Event count
    log(`\n--- Event Count ---`);
    log(`  Total events: ${events.length}`);
    const byAgent = new Map<string, number>();
    for (const e of events) {
      byAgent.set(e.agent, (byAgent.get(e.agent) ?? 0) + 1);
    }
    for (const [agent, count] of byAgent) {
      log(`  - ${agent}: ${count}`);
    }

    // Changed files
    log(`\n--- Changed Files ---`);
    const diffEvent = events.find((e) => e.kind === "diff_summary");
    if (diffEvent) {
      try {
        const diff = JSON.parse(diffEvent.payload);
        if (Array.isArray(diff.files)) {
          for (const f of diff.files) {
            changedFiles.push({
              path: f.path,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            });
            log(`  - ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`);
          }
          log(
            `  Total: ${diff.totals?.files ?? diff.files.length} file(s) changed, +${diff.totals?.additions ?? 0}/-${diff.totals?.deletions ?? 0}`,
          );
        }
      } catch {
        log("  (could not parse diff summary payload)");
      }
    } else {
      log("  (no diff summary event found)");
    }

    // Final verdict
    log(`\n--- Final Verdict ---`);
    log(`  Run Status: ${finalStatus}`);
    if (runRow?.outcome) {
      try {
        outcomeObj = JSON.parse(runRow.outcome);
        if (outcomeObj && typeof outcomeObj === "object") {
          const facts = outcomeObj.facts as Record<string, unknown> | undefined;
          if (facts) {
            log(`  Observed Facts:`);
            log(`    - Implementer exit code: ${facts.implementerExitCode}`);
            log(`    - Diff files: ${facts.diffFiles}`);
            const excluded = facts.excludedTouched as string[] | undefined;
            log(
              `    - Excluded touched: ${!excluded || excluded.length === 0 ? "none" : excluded.join(", ")}`,
            );
            log(`    - Reviewer verdict: ${facts.reviewVerdict}`);
            const checks = facts.checks as Array<{ name: string; exitCode: number; timedOut: boolean }> | undefined;
            if (Array.isArray(checks)) {
              for (const c of checks) {
                log(`    - Check '${c.name}': exit ${c.exitCode}${c.timedOut ? " (timed out)" : ""}`);
              }
            }
          }
          const missing = outcomeObj.missing as string[] | undefined;
          if (Array.isArray(missing) && missing.length > 0) {
            log(`  Missing facts: ${missing.join(", ")}`);
          }
        }
      } catch {}
    }
    log("\n========================================================\n");
  } finally {
    try {
      const { closeConnection } = await import("@/db/client");
      closeConnection();
    } catch {}

    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    if (!keep) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        log("Cleaned up temporary directory.");
      } catch (err) {
        log(`Warning: failed to clean up temporary directory ${tempDir}: ${String(err)}`);
      }
    } else {
      log(`[--keep] Preserved temporary directory at: ${tempDir}`);
    }
  }

  return {
    success: isSuccessful,
    runId,
    status: finalStatus,
    eventsCount,
    tempDir,
    changedFiles,
    outcome: outcomeObj,
  };
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  /(?:scripts[\\/])?agents-demo\.[cm]?[jt]s$/.test(process.argv[1]!);

if (isDirectRun) {
  runDemo()
    .then((result) => {
      process.exitCode = result.success ? 0 : 1;
    })
    .catch((err) => {
      console.error("Demo script failed:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
