/**
 * Prepares the Next standalone output for packaging.
 *
 * `next build` with `output: "standalone"` emits a server plus a pruned
 * node_modules, but deliberately leaves out static assets — they are normally
 * served by a CDN. A desktop app has no CDN, so they are copied in here.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPrepareDesktopPayload } from "./package-payload.mjs";
import { TraceBoundaryError, limitsFromEnv } from "./trace-boundary.mjs";

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
const build = spawnSync(process.execPath, [resolveNextBin(), "build", "--webpack"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DESKTOP_BUILD: "1",
    DATABASE_PATH: path.join(buildDataDir, "build.db"),
    UPLOADS_DIR: path.join(buildDataDir, "uploads"),
  },
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

/*
 * Everything after `next build` — copying static assets, public/ and the
 * migrations, materialising symlinks, removing a stray build database and any
 * environment file Next copied, cleaning the trace manifests, and the final
 * packaging gate — runs through one entry point that records where every
 * payload file came from. See desktop/package-payload.mjs.
 *
 * Static assets: `next build` leaves them out of the standalone output (they
 * are normally served by a CDN); a desktop app has no CDN.
 *
 * Symlinks: Next emits the standalone bundle with a symlink per external
 * server package (better-sqlite3 here). electron-builder recreates every
 * symlink when it copies the bundle into the app — and creating a symlink on
 * Windows requires Administrator rights or Developer Mode, so packaging fails
 * with EPERM for anyone who has neither. They are replaced with validated
 * copies of what they point at.
 *
 * Migrations must ship: the app applies them on first launch so a new install
 * (or a new machine) creates its database without a manual step.
 *
 * Trace boundary: the webpack file tracer can pull arbitrary runtime
 * filesystem roots into a route's `.nft.json`, and Next copies traced files
 * into the bundle. The build refuses — with a redacted, aggregate report —
 * rather than hand electron-builder a payload containing anything whose origin
 * is outside the project, its dependencies or the build output.
 */
let limits;
try {
  limits = limitsFromEnv(process.env);
} catch (err) {
  console.error(err instanceof TraceBoundaryError ? err.message : "Invalid TRACE_BOUNDARY_* limit.");
  process.exit(1);
}
const { code } = runPrepareDesktopPayload({ root, limits });
if (code !== 0) process.exit(code);

console.log("Standalone bundle ready for packaging.");
