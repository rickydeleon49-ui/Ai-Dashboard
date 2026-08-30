/**
 * Prepares the Next standalone output for packaging.
 *
 * `next build` with `output: "standalone"` emits a server plus a pruned
 * node_modules, but deliberately leaves out static assets — they are normally
 * served by a CDN. A desktop app has no CDN, so they are copied in here.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/*
 * Run the build from here rather than from an inline `DESKTOP_BUILD=1` in the
 * npm script: that syntax is not portable to Windows cmd, and this project is
 * developed on both macOS and Windows.
 */
/*
 * Point the database somewhere disposable for the duration of the build.
 *
 * Next evaluates the root layout while collecting page data, which opens the
 * database and runs migrations. Left alone, that writes into ./data — and Next's
 * file tracing would then copy the developer's real database into the shipped
 * application. The runtime path is set by the Electron main process, so nothing
 * depends on this value beyond the build itself.
 */
const buildDataDir = await mkdtemp(path.join(tmpdir(), "command-center-build-"));

console.log("• building Next.js (standalone output)");
const build = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DESKTOP_BUILD: "1",
    DATABASE_PATH: path.join(buildDataDir, "build.db"),
    UPLOADS_DIR: path.join(buildDataDir, "uploads"),
  },
  shell: process.platform === "win32",
});

await rm(buildDataDir, { recursive: true, force: true });

if (build.status !== 0) {
  console.error("Next build failed.");
  process.exit(build.status ?? 1);
}

if (!(await exists(path.join(standalone, "server.js")))) {
  console.error(
    "Build finished but no standalone server was produced. Check next.config.ts.",
  );
  process.exit(1);
}

// Client-side JS/CSS chunks.
await cp(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), {
  recursive: true,
});
console.log("• copied .next/static");

// Anything served from /public, if the project has any.
if (await exists(path.join(root, "public"))) {
  await cp(path.join(root, "public"), path.join(standalone, "public"), {
    recursive: true,
  });
  console.log("• copied public/");
}

/*
 * Migrations must ship: the app applies them on first launch so a new install
 * (or a new machine) creates its database without a manual step.
 */
await cp(path.join(root, "drizzle"), path.join(standalone, "drizzle"), {
  recursive: true,
});
console.log("• copied drizzle migrations");

// Belt and braces: never ship a database inside the application bundle.
const strayData = path.join(standalone, "data");
if (await exists(strayData)) {
  await rm(strayData, { recursive: true, force: true });
  console.log("• removed stray build database from bundle");
}

console.log("Standalone bundle ready for packaging.");
