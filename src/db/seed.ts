/**
 * Seeds a small, realistic starter library so a fresh install is explorable
 * rather than an empty admin panel. Safe to re-run: it exits if data exists.
 *
 * Run with `npm run db:seed` (or `npm run db:reset` to start clean).
 */
import { LOCAL_WORKSPACE_ID, projectRepository } from "./repositories";
import { runMigrations } from "./migrate";
import type { ProjectCreateInput } from "@/core/projects/types";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const SEED: ProjectCreateInput[] = [
  {
    name: "AI Dashboard",
    description:
      "This command center. Projects, GitHub hub, uploads and AI workflows in one place.",
    source: "manual",
    type: "ai",
    status: "active",
    tags: ["dashboard", "nextjs", "typescript"],
    projectUrl: null,
    notes:
      "Phase 1 shipped: shell, library, detail pages, search, filters, favorites.\nNext: GitHub OAuth, then uploads.",
    favorite: true,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(0),
    lastOpenedAt: daysAgo(0),
  },
  {
    name: "IBKR Trading Agent",
    description:
      "Autonomous trading agent on ib_async, using prompt caching to stay inside API rate limits.",
    source: "manual",
    type: "ai",
    status: "active",
    tags: ["trading", "agents", "python"],
    localPath: "~/code/ibkr-agent",
    notes: "Rate-limit-aware design is the constraint that shapes everything else.",
    favorite: true,
    createdAt: daysAgo(64),
    updatedAt: daysAgo(2),
    lastOpenedAt: daysAgo(1),
  },
  {
    name: "Stock Watcher PWA",
    description: "Installable price-watch PWA with push alerts. Deployed on Railway.",
    source: "manual",
    type: "website",
    status: "completed",
    tags: ["pwa", "railway", "finance"],
    projectUrl: "https://example.up.railway.app",
    createdAt: daysAgo(180),
    updatedAt: daysAgo(21),
    lastOpenedAt: daysAgo(12),
  },
  {
    name: "Pokemon Drop Monitor",
    description:
      "Manifest V3 Chrome extension that queues Pokemon Center drops and autofills checkout.",
    source: "manual",
    type: "automation",
    status: "paused",
    tags: ["chrome-extension", "manifest-v3", "automation"],
    createdAt: daysAgo(240),
    updatedAt: daysAgo(38),
  },
  {
    name: "Starfield Mod Tools",
    description: "Utilities for authoring, packing and validating Starfield mods.",
    source: "manual",
    type: "software",
    status: "planning",
    tags: ["starfield", "modding", "tooling"],
    createdAt: daysAgo(30),
    updatedAt: daysAgo(6),
  },
  {
    name: "Care Scheduling App",
    description:
      "Shift and visit scheduling for care teams, with conflict detection and coverage reports.",
    source: "manual",
    type: "work",
    status: "idea",
    tags: ["scheduling", "healthcare"],
    notes: "Start from the coverage report — that is the part nobody else does well.",
    createdAt: daysAgo(11),
    updatedAt: daysAgo(11),
  },
];

async function seed(): Promise<void> {
  runMigrations();

  const existing = await projectRepository.list(LOCAL_WORKSPACE_ID, { includeArchived: true, limit: 1 });
  if (existing.length > 0) {
    console.log("Database already has projects — skipping seed.");
    return;
  }

  for (const project of SEED) {
    await projectRepository.create(LOCAL_WORKSPACE_ID, project);
  }
  console.log(`Seeded ${SEED.length} projects.`);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
