/**
 * Prepares the Next standalone output for packaging.
 *
 * `next build` with `output: "standalone"` emits a server plus a pruned
 * node_modules, but deliberately leaves out static assets — they are normally
 * served by a CDN. A desktop app has no CDN, so they are copied in here.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readlink, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const require_ = createRequire(import.meta.url);
const root = process.cwd();

/**
 * Locates the project's own Next.js install.
 *
 * Deliberately not `npx next`: when the project has no node_modules, npx
 * silently runs some other copy of Next, which then fails deep inside the build
 * with an opaque "Could not find the Next.js package" resolution error. Checking
 * here turns that into one clear sentence.
 */
function resolveNextBin() {
  try {
    const pkg = require_.resolve("next/package.json");
    return path.join(path.dirname(pkg), "dist", "bin", "next");
  } catch {
    console.error(
      "Next.js is not installed in this project.\n" +
        "Run `npm install` in the project directory first, and make sure it " +
        "finishes without errors.",
    );
    process.exit(1);
  }
}
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
// Run the binary through the current Node executable: no shell, so there is no
// argument-quoting difference between Windows and everything else.
const nextBuild = spawnSync(process.execPath, [resolveNextBin(), "build", "--webpack"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DESKTOP_BUILD: "1",
    DATABASE_PATH: path.join(buildDataDir, "build.db"),
    UPLOADS_DIR: path.join(buildDataDir, "uploads"),
  },
});

await rm(buildDataDir, { recursive: true, force: true });

if (nextBuild.status !== 0) {
  console.error("Next build failed.");
  process.exit(nextBuild.status ?? 1);
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
 * Replace symlinks with real copies.
 *
 * Next emits the standalone bundle with a symlink per external server package
 * (better-sqlite3 here), pointing at the real copy inside the same bundle.
 * That is fine on the machine that builds it, but electron-builder recreates
 * every symlink when it copies the bundle into the app — and creating a symlink
 * on Windows requires Administrator rights or Developer Mode, so packaging fails
 * with EPERM for anyone who has neither.
 *
 * Materialising the links keeps resolution behaviour identical and leaves the
 * bundle as plain files, which every platform can copy without special rights.
 */
async function materializeSymlinks(dir) {
  let replaced = 0;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(full), await readlink(full));
      if (!(await exists(target))) {
        // A link to something outside the bundle would be dangling once
        // packaged; dropping it is better than shipping a broken path.
        await rm(full, { force: true });
        console.log(`• removed dangling symlink ${entry.name}`);
        continue;
      }
      await rm(full, { recursive: true, force: true });
      await cp(target, full, { recursive: true, dereference: true });
      replaced += 1;
    } else if (entry.isDirectory()) {
      replaced += await materializeSymlinks(full);
    }
  }

  return replaced;
}

const replaced = await materializeSymlinks(standalone);
if (replaced > 0) {
  console.log(`• replaced ${replaced} symlink(s) with real files (Windows cannot create them without elevation)`);
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

/*
 * Bundle the agent runner process.
 *
 * The runner owns every agent child process and runs outside the Next.js server.
 * Bundling with esbuild produces a standalone runner.js in the standalone
 * folder. Native addons (better-sqlite3) are externalized so they resolve from
 * standalone/node_modules.
 */
console.log("• bundling agent runner");
const runnerOutput = path.join(standalone, "runner.js");
try {
  await build({
    entryPoints: [path.join(root, "runner", "index.ts")],
    outfile: runnerOutput,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    conditions: ["react-server"],
    tsconfig: path.join(root, "tsconfig.json"),
    external: ["better-sqlite3"],
    sourcemap: false,
    legalComments: "none",
  });
} catch (error) {
  console.error("Agent runner bundling failed:", error);
  process.exit(1);
}

if (!(await exists(runnerOutput))) {
  console.error("Runner bundling failed: runner.js was not produced.");
  process.exit(1);
}
console.log("• bundled runner.js");

const sqliteAddon = path.join(standalone, "node_modules", "better-sqlite3");
if (!(await exists(sqliteAddon))) {
  console.error("Standalone bundle is missing node_modules/better-sqlite3 required by the runner.");
  process.exit(1);
}
console.log("• verified node_modules/better-sqlite3 is present for runner");

console.log("Standalone bundle ready for packaging.");
