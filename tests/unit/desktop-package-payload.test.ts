/**
 * The desktop packaging entry point (desktop/package-payload.mjs), exercised
 * end to end on synthetic Next output.
 *
 * Each fixture is a disposable project whose `.next` is produced by
 * `emulateNextStandalone`, which reproduces what the installed Next 16
 * standalone writer does (next/dist/build/utils.js copyTracedFiles and
 * build/index.js writeStandaloneDirectory): traced files are copied by their
 * *lexical* path with copyFile (dereferencing junctions), traced symlinks are
 * recreated as symlinks, server/app is mirrored, required server files and a
 * loaded `.env` are copied, and server.js is generated. Then the real
 * `prepareDesktopPayload` / `runPrepareDesktopPayload` runs exactly as
 * desktop/build.mjs runs it after `next build`.
 *
 * Synthetic values only: no real profile, database, environment or secret.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const payloadModulePath = path.resolve("desktop/package-payload.mjs");
const pp = require("../../desktop/package-payload.mjs");
const tb = require("../../desktop/trace-boundary.mjs");
const { prepareDesktopPayload } = pp;
const { TraceBoundaryError, sanitizeManifests, resolveAllowedRoots } = tb;

type Violation = { kind: string; category?: string; code?: string; hash?: string };

const SENTINEL_NAME = "SENTINEL_PRIVATE_FILE_do_not_leak.txt";
const SENTINEL_CONTENT = "SYNTHETIC_PRIVATE_CONTENT_7d1f";
const SYNTHETIC_ENV_VALUE = "SYNTHETIC_ENV_VALUE_fixture_only_91c2";

let work = "";
let canLink = true;

function write(file: string, content: string | Buffer = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function linkDir(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-payload-"));
  try {
    fs.mkdirSync(path.join(work, "probe-target"));
    fs.symlinkSync(path.join(work, "probe-target"), path.join(work, "probe-link"), process.platform === "win32" ? "junction" : "dir");
    fs.unlinkSync(path.join(work, "probe-link"));
  } catch {
    canLink = false;
  }
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

interface Fixture {
  base: string;
  project: string;
  nextDir: string;
  standalone: string;
  sharedDeps: string;
  external: string;
}

/**
 * A realistic project inside an AppData-like directory, with node_modules a
 * junction to a shared dependency directory (as in this repository's
 * worktrees) and an external directory holding a synthetic sentinel.
 */
function makeProject(name: string, configure: (f: Fixture) => void = () => {}, opts: { wholeNodeModulesLink?: boolean } = {}): Fixture {
  const base = path.join(work, name);
  const project = path.join(base, "AppData", "Local", "Programs", "CommandCenter");
  const f: Fixture = {
    base,
    project,
    nextDir: path.join(project, ".next"),
    standalone: path.join(project, ".next", "standalone"),
    sharedDeps: path.join(base, "shared", "node_modules"),
    external: path.join(base, "external"),
  };
  write(path.join(f.external, SENTINEL_NAME), SENTINEL_CONTENT);

  // Dependencies, reached through a junctioned node_modules.
  write(path.join(f.sharedDeps, "dep", "index.js"), "module.exports = 'dep';");
  write(path.join(f.sharedDeps, "dep", "package.json"), JSON.stringify({ name: "dep" }));
  write(path.join(f.sharedDeps, "next", "package.json"), JSON.stringify({ name: "next" }));
  write(path.join(f.sharedDeps, "next", "dist", "server", "next-server.js"), "// next server");
  write(path.join(f.sharedDeps, "native-dep", "package.json"), JSON.stringify({ name: "native-dep" }));
  write(path.join(f.sharedDeps, "native-dep", "lib", "index.js"), "module.exports = require('../build/Release/native.node');");
  write(path.join(f.sharedDeps, "native-dep", "build", "Release", "native.node"), "\u007fELF-synthetic-native");
  linkDir(f.sharedDeps, path.join(project, "node_modules"));

  // Project sources and package roots.
  write(path.join(project, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  write(path.join(project, "src", "app.js"), "module.exports = 1;");
  write(path.join(project, "desktop", "main.js"), "// main");
  write(path.join(project, "desktop", "build.mjs"), "// build");
  write(path.join(project, "desktop", "resources", "icon.png"), "png");
  write(path.join(project, "drizzle", "0000_init.sql"), "-- migration");
  write(path.join(project, "drizzle", "meta", "_journal.json"), "{}");
  write(path.join(project, "public", "logo.svg"), "<svg/>");

  // Build output.
  write(path.join(f.nextDir, "BUILD_ID"), "build-1");
  write(path.join(f.nextDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  write(path.join(f.nextDir, "routes-manifest.json"), "{}");
  write(path.join(f.nextDir, "static", "chunks", "app.js"), "// client chunk");
  write(path.join(f.nextDir, "server", "chunks", "1.js"), "// server chunk");
  write(path.join(f.nextDir, "server", "app", "page.js"), "// page");
  write(path.join(f.nextDir, "server", "app", "page.js.nft.json"), JSON.stringify({
    version: 1,
    files: [
      "../../package.json",
      "../chunks/1.js",
      "../../../node_modules/dep/index.js",
      "../../../node_modules/dep/package.json",
    ],
  }));
  write(path.join(f.nextDir, "next-server.js.nft.json"), JSON.stringify({
    version: 1,
    files: ["../node_modules/next/package.json", "../node_modules/next/dist/server/next-server.js"],
  }));
  write(path.join(f.nextDir, "required-server-files.json"), JSON.stringify({
    version: 1,
    config: { outputFileTracingRoot: project, distDir: ".next" },
    appDir: project,
    relativeAppDir: "",
    files: [path.join(".next", "BUILD_ID"), path.join(".next", "routes-manifest.json"), path.join(".next", "required-server-files.json")],
    ignore: [],
  }));

  write(path.join(f.sharedDeps, "devtool", "index.js"), "// a development-only package nothing traces");
  if (opts.wholeNodeModulesLink) {
    // As in a git worktree: nft records the junctioned node_modules itself as a
    // traced symlink, alongside the files reached through it.
    const m = path.join(f.nextDir, "server", "app", "page.js.nft.json");
    const data = JSON.parse(fs.readFileSync(m, "utf8"));
    data.files.unshift("../../../node_modules");
    data.files.push("../../../node_modules/native-dep/package.json", "../../../node_modules/native-dep/lib/index.js", "../../../node_modules/native-dep/build/Release/native.node");
    fs.writeFileSync(m, JSON.stringify(data));
  }

  configure(f);
  emulateNextStandalone(f, opts);
  return f;
}

/** What the installed Next standalone writer does, reduced to its file operations. */
function emulateNextStandalone(f: Fixture, opts: { wholeNodeModulesLink?: boolean } = {}): void {
  const out = f.standalone;
  fs.rmSync(out, { recursive: true, force: true });
  write(path.join(out, "package.json"), fs.readFileSync(path.join(f.project, "package.json")));
  const traceFiles = [
    ...walkFiles(path.join(f.nextDir, "server", "app")).filter((p) => p.endsWith(".nft.json")),
    path.join(f.nextDir, "next-server.js.nft.json"),
  ];
  for (const traceFile of traceFiles) {
    const data = JSON.parse(fs.readFileSync(traceFile, "utf8"));
    for (const rel of data.files) {
      const traced = path.join(path.dirname(traceFile), rel);
      const dest = path.join(out, path.relative(f.project, traced));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let link: string | null = null;
      try {
        link = fs.readlinkSync(traced);
      } catch {
        link = null;
      }
      if (link) {
        if (!fs.existsSync(dest)) fs.symlinkSync(link, dest, process.platform === "win32" ? "junction" : undefined);
      } else if (fs.existsSync(dest) && fs.realpathSync.native(dest) === fs.realpathSync.native(traced)) {
        // Written "through" a recreated link onto the very same file: a no-op.
      } else {
        fs.copyFileSync(traced, dest);
      }
    }
  }
  write(path.join(out, "server.js"), "// generated by next");
  const rsf = JSON.parse(fs.readFileSync(path.join(f.nextDir, "required-server-files.json"), "utf8"));
  for (const file of rsf.files) {
    const src = path.join(f.project, file);
    write(path.join(out, path.relative(f.project, src)), fs.readFileSync(src));
  }
  for (const envName of [".env", ".env.production"]) {
    const src = path.join(f.project, envName);
    if (fs.existsSync(src)) write(path.join(out, envName), fs.readFileSync(src));
  }
  fs.cpSync(path.join(f.nextDir, "server", "app"), path.join(out, ".next", "server", "app"), { recursive: true });
  if (!opts.wholeNodeModulesLink) {
    // The external server package link Next emits for a native dependency.
    fs.mkdirSync(path.join(out, "node_modules"), { recursive: true });
    linkDir(path.join(f.project, "node_modules", "native-dep"), path.join(out, "node_modules", "native-dep"));
  }
}

function prepare(f: Fixture, extra: Record<string, unknown> = {}) {
  return prepareDesktopPayload({ root: f.project, nativeModules: ["native-dep"], ...extra });
}

function refusal(f: Fixture, extra: Record<string, unknown> = {}): { violations: Violation[]; message: string } {
  try {
    prepare(f, extra);
  } catch (err) {
    assert.ok(err instanceof TraceBoundaryError, `expected TraceBoundaryError, got ${String((err as Error)?.stack ?? err)}`);
    const message = (err as Error).message;
    assertRedacted(message, f);
    return { violations: (err as { violations: Violation[] }).violations, message };
  }
  assert.fail("expected the packaging entry point to refuse");
}

function assertRedacted(text: string, f: Fixture): void {
  const lower = text.toLowerCase();
  assert.ok(!text.includes(SENTINEL_NAME), "must not contain the sentinel filename");
  assert.ok(!text.includes(SENTINEL_CONTENT), "must not contain private content");
  assert.ok(!text.includes(SYNTHETIC_ENV_VALUE), "must not contain an environment value");
  assert.ok(!lower.includes(f.base.toLowerCase()), "must not contain a fixture path");
  assert.ok(!lower.includes(f.external.toLowerCase()), "must not contain the external path");
}

function payloadContainsSentinel(f: Fixture): boolean {
  if (!fs.existsSync(f.standalone)) return false;
  return walkFiles(f.standalone).some((p) => {
    try {
      return fs.readFileSync(p, "utf8").includes(SENTINEL_CONTENT);
    } catch {
      return false;
    }
  });
}

describe("desktop payload entry point: legitimate builds", () => {
  it("packages a valid build under an AppData-like checkout with a shared node_modules junction", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("valid");
    const lines: string[] = [];
    const summary = prepare(f, { log: (l: string) => lines.push(l) });
    assert.equal(summary.ok, true);

    // Native module materialised from the link, with its binary.
    assert.ok(fs.lstatSync(path.join(f.standalone, "node_modules", "native-dep")).isDirectory());
    assert.ok(fs.existsSync(path.join(f.standalone, "node_modules", "native-dep", "build", "Release", "native.node")));
    // Traced dependencies, Next assets, migrations, public assets.
    for (const rel of ["node_modules/dep/index.js", "node_modules/next/package.json", ".next/static/chunks/app.js", ".next/server/app/page.js", "drizzle/0000_init.sql", "drizzle/meta/_journal.json", "public/logo.svg", "server.js"]) {
      assert.ok(fs.existsSync(path.join(f.standalone, rel)), `${rel} must be packaged`);
    }
    assert.equal(summary.materialized.replaced, 1);
    assert.equal(summary.completeness.tracedMissing, 0);
    const byProvenance = summary.inventory.standalone.byProvenance;
    for (const kind of ["next-traced", "next-mirror", "next-required", "next-generated", "project-package-json", "materialized-link", "next-static", "public-asset", "migration"]) {
      assert.ok(byProvenance[kind] > 0, `expected ${kind} provenance, got ${JSON.stringify(byProvenance)}`);
    }
    assert.equal(summary.inventory.desktop.files, 3);
    assert.equal(summary.inventory.drizzle.files, 2);
    assert.equal(summary.inventory.packageJson.files, 1);
    assertRedacted(lines.join("\n"), f);
  });

  it("replaces a traced node_modules junction with a validated copy of the dependency root (worktree layout)", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("worktree-layout", () => {}, { wholeNodeModulesLink: true });
    assert.ok(fs.lstatSync(path.join(f.standalone, "node_modules")).isSymbolicLink(), "precondition: Next recreated the junction");
    const summary = prepare(f);
    assert.equal(summary.materialized.replaced, 1);
    assert.ok(fs.lstatSync(path.join(f.standalone, "node_modules")).isDirectory());
    for (const rel of ["node_modules/dep/index.js", "node_modules/next/package.json", "node_modules/native-dep/build/Release/native.node"]) {
      assert.ok(fs.existsSync(path.join(f.standalone, rel)), `${rel} must be packaged`);
    }
    // The tracer cannot see through the junction, so the whole allowed
    // dependency root ships (as before this change), each file validated.
    assert.ok(fs.existsSync(path.join(f.standalone, "node_modules", "devtool", "index.js")));
    assert.ok(fs.existsSync(path.join(f.sharedDeps, "devtool", "index.js")), "the shared dependency directory is untouched");
    assert.equal(summary.completeness.tracedMissing, 0);
  });

  it("refuses an escaping nested junction reached through a traced node_modules junction", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("worktree-escape", (fx) => {
      linkDir(fx.external, path.join(fx.sharedDeps, "dep", "nested"));
      const m = path.join(fx.nextDir, "server", "app", "page.js.nft.json");
      const data = JSON.parse(fs.readFileSync(m, "utf8"));
      data.files.push("../../../node_modules/dep/nested");
      fs.writeFileSync(m, JSON.stringify(data));
    }, { wholeNodeModulesLink: true });
    const { violations } = refusal(f);
    assert.ok(violations.some((v) => v.kind === "unapproved-trace-in-payload"), JSON.stringify(violations));
    assert.equal(payloadContainsSentinel(f), false);
    assert.ok(fs.lstatSync(path.join(f.standalone, "node_modules")).isSymbolicLink(), "no partial replacement");
  });

  it("refuses an untraced escaping junction inside a junctioned node_modules, leaving no staging copy", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("worktree-untraced-escape", (fx) => linkDir(fx.external, path.join(fx.sharedDeps, "devtool", "nested")), { wholeNodeModulesLink: true });
    const { violations } = refusal(f);
    assert.ok(violations.some((v) => v.kind === "copy-source-out-of-boundary"), JSON.stringify(violations));
    assert.equal(payloadContainsSentinel(f), false);
    assert.ok(fs.lstatSync(path.join(f.standalone, "node_modules")).isSymbolicLink(), "no partial replacement");
    assert.equal(fs.readdirSync(f.standalone).some((n) => n.includes(".materialize-")), false, "no staging directory left behind");
    assert.ok(fs.existsSync(path.join(f.sharedDeps, "devtool", "index.js")), "the shared dependency directory is untouched");
  });

  it("strips the .env Next copies and never prints its synthetic value", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("env-copied", (fx) => write(path.join(fx.project, ".env"), `DATABASE_URL=${SYNTHETIC_ENV_VALUE}\n`));
    assert.ok(fs.existsSync(path.join(f.standalone, ".env")), "precondition: Next copied the loaded .env");
    const lines: string[] = [];
    const summary = prepare(f, { log: (l: string) => lines.push(l) });
    assert.equal(summary.envFilesRemoved, 1);
    assert.equal(fs.existsSync(path.join(f.standalone, ".env")), false);
    assert.equal(walkFiles(f.standalone).some((p) => fs.readFileSync(p, "utf8").includes(SYNTHETIC_ENV_VALUE)), false);
    assertRedacted(lines.join("\n"), f);
  });
});

describe("S2: nested and copied escapes stop packaging", () => {
  it("refuses a dependency whose nested junction escapes, and copies none of it", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("nested-escape", (fx) => linkDir(fx.external, path.join(fx.sharedDeps, "native-dep", "nested")));
    const { violations } = refusal(f);
    assert.ok(violations.some((v) => v.kind === "copy-source-out-of-boundary"), JSON.stringify(violations));
    assert.equal(payloadContainsSentinel(f), false, "external content must not reach the payload");
    assert.ok(fs.lstatSync(path.join(f.standalone, "node_modules", "native-dep")).isSymbolicLink(), "the link is left unmaterialised");
  });

  it("refuses a dependency link cycle instead of recursing", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("cycle", (fx) => linkDir(path.join(fx.sharedDeps, "native-dep"), path.join(fx.sharedDeps, "native-dep", "loop")));
    const { violations } = refusal(f);
    assert.ok(violations.some((v) => v.kind === "symlink-cycle"), JSON.stringify(violations));
  });

  it("refuses a traced file Next copied through an escaping project junction", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("traced-junction", (fx) => {
      linkDir(fx.external, path.join(fx.project, "vendor", "linked"));
      const m = path.join(fx.nextDir, "server", "app", "page.js.nft.json");
      const data = JSON.parse(fs.readFileSync(m, "utf8"));
      data.files.push(`../../../vendor/linked/${SENTINEL_NAME}`);
      fs.writeFileSync(m, JSON.stringify(data));
    });
    assert.ok(payloadContainsSentinel(f), "precondition: Next's lexical copy dereferenced the junction");
    const { violations } = refusal(f);
    assert.ok(violations.some((v) => v.kind === "unapproved-trace-in-payload"), JSON.stringify(violations));
  });

  it("refuses bytes copied from an unapproved source even via a manifest outside the copied set", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("other-manifest-copy", (fx) => {
      linkDir(fx.external, path.join(fx.project, "vendor", "linked"));
      write(path.join(fx.nextDir, "server", "pages", "legacy.js.nft.json"), JSON.stringify({ version: 1, files: [`../../../vendor/linked/${SENTINEL_NAME}`] }));
    });
    // Copied where that trace maps, through the junction (dereferenced).
    write(path.join(f.standalone, "vendor", "linked", SENTINEL_NAME), SENTINEL_CONTENT);
    const { violations } = refusal(f);
    assert.ok(violations.some((v) => v.kind === "unapproved-source-copied"), JSON.stringify(violations));
  });

  it("still refuses a copied external file after its trace entry was sanitised away", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("sanitized-after-copy", (fx) => {
      const m = path.join(fx.nextDir, "server", "app", "page.js.nft.json");
      const data = JSON.parse(fs.readFileSync(m, "utf8"));
      data.files.push(path.relative(path.dirname(m), path.join(fx.external, SENTINEL_NAME)));
      fs.writeFileSync(m, JSON.stringify(data));
    });
    // Next copied it to a regular payload file outside the usual layout.
    const copied = path.join(f.standalone, "copied", SENTINEL_NAME);
    write(copied, SENTINEL_CONTENT);
    // The old order: sanitise first, erasing the only origin evidence.
    const roots = resolveAllowedRoots({ projectRoot: f.project, standaloneDir: f.standalone });
    const res = sanitizeManifests(f.nextDir, { allowedRoots: roots, projectRoot: f.project, home: os.homedir() });
    assert.ok(res.removed >= 1);
    const { violations } = refusal(f);
    assert.ok(violations.some((v) => v.kind === "unexpected-payload-file"), JSON.stringify(violations));
    assert.ok(fs.existsSync(copied), "nothing is silently deleted to make the build pass");
  });

  it("refuses an unexplained extra file in the standalone payload", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("extra-standalone");
    write(path.join(f.standalone, "notes", "extra.txt"), "synthetic");
    assert.ok(refusal(f).violations.some((v) => v.kind === "unexpected-payload-file"));
  });

  it("refuses a payload file whose content differs from its traced source", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("mismatch");
    fs.writeFileSync(path.join(f.standalone, "node_modules", "dep", "index.js"), "// altered");
    assert.ok(refusal(f).violations.some((v) => v.kind === "content-mismatch"));
  });

  it("refuses unexpected or credential files in the other package roots", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const a = makeProject("extra-desktop", (fx) => write(path.join(fx.project, "desktop", "notes.txt"), "synthetic"));
    assert.ok(refusal(a).violations.some((v) => v.kind === "unexpected-package-file" && v.category === "desktop"));
    const b = makeProject("env-desktop", (fx) => write(path.join(fx.project, "desktop", ".env"), `X=${SYNTHETIC_ENV_VALUE}`));
    assert.ok(refusal(b).violations.some((v) => v.kind === "secret-file"));
    const c = makeProject("link-drizzle", (fx) => linkDir(fx.external, path.join(fx.project, "drizzle", "linked")));
    const vc = refusal(c).violations;
    assert.ok(vc.some((v) => v.kind === "copy-source-out-of-boundary" || v.kind === "symlink-in-package-root"), JSON.stringify(vc));
  });

  it("refuses an env file Next did not put there, wherever it is", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("env-elsewhere");
    write(path.join(f.standalone, "node_modules", "dep", ".env.local"), `X=${SYNTHETIC_ENV_VALUE}`);
    assert.ok(refusal(f).violations.some((v) => v.kind === "secret-file"));
  });

  it("refuses when a traced runtime file never made it into the payload", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("incomplete");
    fs.rmSync(path.join(f.standalone, "node_modules", "dep", "index.js"));
    assert.ok(refusal(f).violations.some((v) => v.kind === "trace-copy-incomplete"));
  });

  it("refuses a native module that lost its binary", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("native-missing", (fx) => fs.rmSync(path.join(fx.sharedDeps, "native-dep", "build"), { recursive: true }));
    assert.ok(refusal(f).violations.some((v) => v.kind === "native-module-incomplete"));
  });
});

describe("S3 at the entry point: incomplete inspection stops packaging", () => {
  it("refuses an injected enumeration failure in the payload", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("eacces");
    const victim = path.join(f.standalone, ".next", "server");
    const original = fs.readdirSync;
    fs.readdirSync = function (this: unknown, dir: fs.PathLike, ...rest: unknown[]) {
      if (path.resolve(String(dir)) === path.resolve(victim)) throw Object.assign(new Error("synthetic"), { code: "EACCES" });
      return (original as unknown as (...a: unknown[]) => unknown).call(this, dir, ...rest);
    } as unknown as typeof fs.readdirSync;
    try {
      assert.ok(refusal(f).violations.some((v) => v.kind === "inspect-failed" && v.code === "EACCES"));
    } finally {
      fs.readdirSync = original;
    }
  });

  it("refuses a malformed trace manifest", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("bad-manifest");
    write(path.join(f.nextDir, "server", "app", "other.js.nft.json"), JSON.stringify({ version: 1, files: "not-an-array" }));
    assert.ok(refusal(f).violations.some((v) => v.kind === "manifest-invalid"));
  });

  it("refuses absent build output", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("absent");
    fs.rmSync(f.standalone, { recursive: true, force: true });
    assert.ok(refusal(f).violations.some((v) => v.kind === "expected-output-missing"));
  });

  it("refuses an unexpected tracing root rather than guessing the layout", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("tracing-root");
    const p = path.join(f.nextDir, "required-server-files.json");
    const rsf = JSON.parse(fs.readFileSync(p, "utf8"));
    rsf.config.outputFileTracingRoot = f.base;
    fs.writeFileSync(p, JSON.stringify(rsf));
    assert.ok(refusal(f).violations.some((v) => v.kind === "unexpected-build-layout"));
  });

  it("refuses invalid limits before touching the payload", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("bad-limits");
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.ok(refusal(f, { limits: { maxFiles: bad } }).violations.some((v) => v.kind === "invalid-limit"));
    }
    assert.ok(fs.lstatSync(path.join(f.standalone, "node_modules", "native-dep")).isSymbolicLink(), "nothing was processed");
  });

  it("refuses when the payload exceeds a bound, during the walk", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("bounded");
    assert.ok(refusal(f, { limits: { maxFiles: 3 } }).violations.some((v) => v.kind === "guardrail-file-count"));
  });
});

describe("the build's CLI wrapper", () => {
  it("exits nonzero with a redacted report for a payload carrying external content", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("cli", (fx) => linkDir(fx.external, path.join(fx.sharedDeps, "native-dep", "nested")));
    const script = `import(${JSON.stringify(pathToFileURL(payloadModulePath).href)}).then((m) => { const r = m.runPrepareDesktopPayload({ root: process.argv[1], nativeModules: ["native-dep"] }); process.exit(r.code); });`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.project], { encoding: "utf8" });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /boundary refused the bundle/);
    assertRedacted(r.stdout + r.stderr, f);
    assert.equal(payloadContainsSentinel(f), false);
  });

  it("exits zero for a valid build", (t) => {
    if (!canLink) return t.skip("junctions/symlinks unavailable");
    const f = makeProject("cli-ok");
    const script = `import(${JSON.stringify(pathToFileURL(payloadModulePath).href)}).then((m) => { const r = m.runPrepareDesktopPayload({ root: process.argv[1], nativeModules: ["native-dep"] }); process.exit(r.code); });`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.project], { encoding: "utf8" });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /trace\/packaging boundary OK/);
    assertRedacted(r.stdout + r.stderr, f);
  });
});
