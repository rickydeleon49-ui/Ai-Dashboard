/**
 * Review regressions for the desktop trace boundary primitives.
 *
 * S1: a lexical match must never override a proven canonical escape.
 * S3: incomplete inspection, malformed manifests, absent outputs and invalid
 *     limits must refuse, with redacted diagnostics.
 *
 * Synthetic disposable fixtures only; no real profile, database or secret.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tb = require("../../desktop/trace-boundary.mjs");
const {
  isWithin,
  resolveCanonical,
  resolveAllowedRoots,
  findManifests,
  scanManifest,
  scanPayload,
  assertTraceBoundary,
  validateLimits,
  limitsFromEnv,
  isSecretFileName,
  TraceBoundaryError,
} = tb;

type Violation = { kind: string; category?: string; code?: string; hash?: string };

const SENTINEL_NAME = "SENTINEL_PRIVATE_FILE_do_not_leak.txt";
const SENTINEL_CONTENT = "SYNTHETIC_PRIVATE_CONTENT";

function write(file: string, content: string | Buffer = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function linkDir(target: string, linkPath: string): boolean {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

/** Temporarily replace one fs function; always restored. */
function patchFs<K extends keyof typeof fs>(name: K, impl: (original: (typeof fs)[K]) => (typeof fs)[K]): () => void {
  const original = fs[name];
  (fs as unknown as Record<string, unknown>)[name] = impl(original);
  return () => {
    (fs as unknown as Record<string, unknown>)[name] = original;
  };
}

function failFor(target: string, code: string) {
  return <T extends (...args: never[]) => unknown>(original: T): T =>
    function (this: unknown, p: unknown, ...rest: unknown[]) {
      if ((typeof p === "string" || p instanceof URL) && path.resolve(String(p)) === path.resolve(target)) {
        throw Object.assign(new Error("synthetic failure"), { code });
      }
      return (original as unknown as (...a: unknown[]) => unknown).call(this, p, ...rest);
    } as unknown as T;
}

let work = "";
let project = "";
let nextDir = "";
let standalone = "";
let external = "";
let allowedRoots: string[] = [];

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "trace-review-"));
  project = path.join(work, "proj");
  nextDir = path.join(project, ".next");
  standalone = path.join(nextDir, "standalone");
  external = path.join(work, "external");
  write(path.join(project, "src", "app.js"), "module.exports=1;");
  write(path.join(standalone, "server.js"), "server");
  write(path.join(external, SENTINEL_NAME), SENTINEL_CONTENT);
  allowedRoots = resolveAllowedRoots({ projectRoot: project, standaloneDir: standalone });
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function assertRedacted(text: string): void {
  assert.ok(!text.includes(SENTINEL_NAME), "must not contain the sentinel filename");
  assert.ok(!text.includes(SENTINEL_CONTENT), "must not contain private content");
  assert.ok(!text.toLowerCase().includes(work.toLowerCase()), "must not contain a fixture path");
}

function gateViolations(overrides: Record<string, unknown> = {}): Violation[] {
  try {
    assertTraceBoundary({ projectRoot: project, standaloneDir: standalone, nextDir, allowedRoots, home: os.homedir(), ...overrides });
    return [];
  } catch (err) {
    assert.ok(err instanceof TraceBoundaryError, `expected TraceBoundaryError, got ${String(err)}`);
    assertRedacted((err as Error).message);
    return (err as { violations: Violation[] }).violations;
  }
}

describe("S1: canonical containment is authoritative", () => {
  const manifest = () => path.join(nextDir, "server", "app", "s1", "route.js.nft.json");
  const linkRoot = () => path.join(project, "vendor", "linked");
  let linked = false;

  before(() => {
    linked = linkDir(external, linkRoot());
  });

  after(() => {
    if (linked) fs.unlinkSync(linkRoot());
    fs.rmSync(path.dirname(manifest()), { recursive: true, force: true });
  });

  function scanEntries(entries: string[]): Violation[] {
    write(manifest(), JSON.stringify({ version: 1, files: entries }));
    return scanManifest(manifest(), { allowedRoots, projectRoot: project, home: os.homedir() }).violations;
  }

  it("refuses a file reached through an escaping project junction, though lexically inside", (t) => {
    if (!linked) return t.skip("junctions/symlinks unavailable");
    const traced = path.join(linkRoot(), SENTINEL_NAME);
    assert.ok(isWithin(project, traced), "precondition: lexically inside the project");
    const v = scanEntries([path.relative(path.dirname(manifest()), traced)]);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.kind, "out-of-boundary");
    assertRedacted(JSON.stringify(v));
    assert.ok(gateViolations().some((x) => x.kind === "out-of-boundary"), "the gate refuses it too");
  });

  it("refuses a nonexistent child below an escaping junction", (t) => {
    if (!linked) return t.skip("junctions/symlinks unavailable");
    const missing = path.join(linkRoot(), "does-not-exist", "child.txt");
    const r = resolveCanonical(missing);
    assert.equal(r.status, "missing");
    assert.ok(isWithin(external, r.path), "resolved through the junction to the outside");
    const v = scanEntries([path.relative(path.dirname(manifest()), missing)]);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.kind, "out-of-boundary");
  });

  it("refuses an entry through a dangling junction instead of treating it as missing", (t) => {
    const target = path.join(work, "dangling-target");
    fs.mkdirSync(target, { recursive: true });
    const dangling = path.join(project, "vendor", "dangling");
    if (!linkDir(target, dangling)) return t.skip("junctions/symlinks unavailable");
    try {
      fs.rmSync(target, { recursive: true, force: true });
      assert.equal(resolveCanonical(path.join(dangling, "x.js")).status, "error");
      const v = scanEntries([path.relative(path.dirname(manifest()), path.join(dangling, "x.js"))]);
      assert.equal(v.length, 1);
      assert.equal(v[0]?.kind, "resolve-failed");
    } finally {
      fs.unlinkSync(dangling);
    }
  });

  it("keeps an explicitly allowed shared dependency junction by its canonical root", (t) => {
    const sharedProject = path.join(work, "shared-proj");
    const sharedDeps = path.join(work, "shared-deps");
    write(path.join(sharedDeps, "dep", "index.js"), "module.exports=1;");
    write(path.join(sharedProject, "src", "a.js"), "x");
    if (!linkDir(sharedDeps, path.join(sharedProject, "node_modules"))) return t.skip("junctions/symlinks unavailable");
    try {
      const roots = resolveAllowedRoots({ projectRoot: sharedProject, standaloneDir: path.join(sharedProject, ".next", "standalone") });
      const m = path.join(sharedProject, ".next", "server", "app", "p.js.nft.json");
      write(m, JSON.stringify({ version: 1, files: ["../../../node_modules/dep/index.js", "../../../node_modules/dep/not-yet-built.js"] }));
      const r = scanManifest(m, { allowedRoots: roots, projectRoot: sharedProject, home: os.homedir() });
      assert.deepEqual(r.violations, []);
    } finally {
      fs.unlinkSync(path.join(sharedProject, "node_modules"));
    }
  });

  it("treats a resolution failure as a refusal, never as authorization", () => {
    const target = path.join(project, "src", "app.js");
    const original = fs.realpathSync.native;
    fs.realpathSync.native = failFor(target, "EACCES")(original);
    try {
      const v = scanEntries([path.relative(path.dirname(manifest()), target)]);
      assert.equal(v.length, 1);
      assert.equal(v[0]?.kind, "resolve-failed");
      assert.equal(v[0]?.category, "EACCES");
    } finally {
      fs.realpathSync.native = original;
    }
  });

  it("treats '..foo' as a child and '../foo' as outside", () => {
    assert.equal(isWithin(project, path.join(project, "..foo")), true);
    assert.equal(isWithin(project, path.join(project, "..", "foo")), false);
  });
});

describe("S3: incomplete inspection and invalid input fail closed", () => {
  const m = () => path.join(nextDir, "server", "app", "s3", "route.js.nft.json");
  after(() => fs.rmSync(path.dirname(m()), { recursive: true, force: true }));

  it("refuses wrong-typed or malformed manifest shapes", () => {
    const shapes: [unknown, string][] = [
      [{ version: 1, files: "invalid-not-an-array" }, "files-not-an-array"],
      [{ version: 1, files: [1, 2] }, "entry-not-a-path-string"],
      [{ version: 1, files: [""] }, "entry-not-a-path-string"],
      [{ version: 2, files: [] }, "unsupported-version"],
      [["not", "an", "object"], "not-an-object"],
      [null, "not-an-object"],
    ];
    for (const [data, category] of shapes) {
      write(m(), JSON.stringify(data));
      const v = gateViolations();
      assert.ok(v.some((x) => x.kind === "manifest-invalid" && x.category === category), `expected ${category}, got ${JSON.stringify(v)}`);
    }
    write(m(), "{ not json");
    assert.ok(gateViolations().some((x) => x.kind === "manifest-unparseable"));
    fs.rmSync(m());
  });

  it("refuses an unreadable manifest and never reports it as empty", () => {
    write(m(), JSON.stringify({ version: 1, files: [] }));
    const restore = patchFs("readFileSync", failFor(m(), "EACCES"));
    try {
      const v = gateViolations();
      assert.ok(v.some((x) => x.kind === "inspect-failed" && x.category === "read" && x.code === "EACCES"));
    } finally {
      restore();
      fs.rmSync(m());
    }
  });

  it("checks the manifest byte bound before reading it", () => {
    write(m(), JSON.stringify({ version: 1, files: ["../../../../../src/app.js"] }));
    let reads = 0;
    const restore = patchFs("readFileSync", (original) =>
      function (this: unknown, p: unknown, ...rest: unknown[]) {
        if (typeof p === "string" && path.resolve(p) === path.resolve(m())) reads += 1;
        return (original as unknown as (...a: unknown[]) => unknown).call(this, p, ...rest);
      } as unknown as typeof fs.readFileSync,
    );
    try {
      const r = scanManifest(m(), { allowedRoots, projectRoot: project, home: os.homedir(), limits: validateLimits({ maxManifestBytes: 8 }) });
      assert.ok(r.violations.some((x: Violation) => x.kind === "guardrail-manifest-bytes"));
      assert.equal(reads, 0, "an oversized manifest must not be read");
    } finally {
      restore();
      fs.rmSync(m());
    }
  });

  it("checks the per-manifest entry bound before evaluating entries", () => {
    write(m(), JSON.stringify({ version: 1, files: ["a.js", "b.js", "c.js"] }));
    try {
      const r = scanManifest(m(), { allowedRoots, projectRoot: project, home: os.homedir(), limits: validateLimits({ maxManifestEntriesPerFile: 2 }) });
      assert.deepEqual(r.violations.map((x: Violation) => x.kind), ["guardrail-manifest-entries"]);
    } finally {
      fs.rmSync(m());
    }
  });

  it("refuses an injected enumeration failure inside the payload", () => {
    const unreadable = path.join(standalone, "unreadable");
    fs.mkdirSync(unreadable, { recursive: true });
    const restore = patchFs("readdirSync", failFor(unreadable, "EACCES"));
    try {
      const v = gateViolations();
      assert.ok(v.some((x) => x.kind === "inspect-failed" && x.category === "readdir" && x.code === "EACCES"));
    } finally {
      restore();
      fs.rmSync(unreadable, { recursive: true, force: true });
    }
  });

  it("refuses an injected stat failure inside the payload", () => {
    const victim = path.join(standalone, "extra.js");
    write(victim, "x");
    const restore = patchFs("lstatSync", failFor(victim, "EPERM"));
    try {
      const v = gateViolations();
      assert.ok(v.some((x) => x.kind === "inspect-failed" && x.category === "lstat" && x.code === "EPERM"));
    } finally {
      restore();
      fs.rmSync(victim);
    }
  });

  it("refuses an injected enumeration failure while finding manifests", () => {
    fs.mkdirSync(path.join(nextDir, "server"), { recursive: true });
    const restore = patchFs("readdirSync", failFor(path.join(nextDir, "server"), "EACCES"));
    try {
      assert.throws(() => findManifests(nextDir), TraceBoundaryError);
      assert.ok(gateViolations().some((x) => x.kind === "inspect-failed" && x.category === "readdir"));
    } finally {
      restore();
    }
  });

  it("refuses absent expected outputs instead of scanning nothing", () => {
    const v = gateViolations({ standaloneDir: path.join(project, "absent-standalone"), nextDir: path.join(project, "absent-next") });
    const kinds = v.map((x) => `${x.kind}/${x.category}`);
    assert.ok(kinds.includes("expected-output-missing/next-dir"));
    assert.ok(kinds.includes("expected-output-missing/standalone-dir"));
  });

  it("refuses a standalone tree without its server", () => {
    const bare = path.join(work, "bare");
    const bareStandalone = path.join(bare, ".next", "standalone");
    fs.mkdirSync(bareStandalone, { recursive: true });
    assert.throws(
      () =>
        assertTraceBoundary({
          projectRoot: bare,
          standaloneDir: bareStandalone,
          nextDir: path.join(bare, ".next"),
          allowedRoots: resolveAllowedRoots({ projectRoot: bare, standaloneDir: bareStandalone }),
          home: os.homedir(),
        }),
      /expected-output-missing\/required-file/,
    );
  });

  it("validates limits as finite positive integers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      assert.throws(() => validateLimits({ maxFiles: bad }), /invalid-limit\/maxFiles/);
    }
    assert.throws(() => validateLimits({ maxFlies: 5 }), /invalid-limit\/unknown-limit/);
    assert.equal(validateLimits({ maxFiles: 5 }).maxFiles, 5);
    for (const bad of ["abc", "", "-5", "1.5", "Infinity", "1e3"]) {
      assert.throws(() => limitsFromEnv({ TRACE_BOUNDARY_MAX_PAYLOAD_FILES: bad }), TraceBoundaryError);
    }
    assert.equal(limitsFromEnv({ TRACE_BOUNDARY_MAX_PAYLOAD_FILES: " 42 " }).maxFiles, 42);
    assert.throws(
      () => assertTraceBoundary({ projectRoot: project, standaloneDir: standalone, nextDir, allowedRoots, home: os.homedir(), maxFiles: Number("not-a-number") }),
      /invalid-limit/,
    );
  });

  it("enforces the file-count bound during traversal", () => {
    write(path.join(standalone, "a", "1.js"));
    write(path.join(standalone, "a", "2.js"));
    write(path.join(standalone, "a", "3.js"));
    try {
      const r = scanPayload(standalone, { allowedRoots, projectRoot: project, home: os.homedir(), limits: validateLimits({ maxFiles: 1 }) });
      assert.equal(r.violations.filter((v: Violation) => v.kind === "guardrail-file-count").length, 1);
      assert.ok(r.fileCount <= 2, "the walk stops at the bound instead of finishing first");
    } finally {
      fs.rmSync(path.join(standalone, "a"), { recursive: true, force: true });
    }
  });
});

describe("root cause: the tracer must not expand the builder's home directory", () => {
  /**
   * Next's bundled @vercel/nft evaluates the real `os` module statically, so
   * `path.join(os.homedir(), <dynamic>)` became a wildcard over the whole
   * profile (and nft's own `../` guard does not apply across drives). This
   * traces the real source with a synthetic home and expects none of it.
   */
  async function homeEntriesTraced(source: string): Promise<number> {
    const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
    const ts = require("typescript");
    const base = fs.mkdtempSync(path.join(work, "nft-"));
    const fakeHome = path.join(base, "fakehome");
    write(path.join(fakeHome, "Documents", "private.txt"), SENTINEL_CONTENT);
    write(path.join(fakeHome, ".config", "token"), SENTINEL_CONTENT);
    const entry = path.join(base, "context.js");
    fs.writeFileSync(entry, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      assert.equal(path.resolve(os.homedir()), path.resolve(fakeHome), "precondition: synthetic home in effect");
      const r = await nodeFileTrace([entry], { base, processCwd: base, mixedModules: true });
      return [...r.fileList].filter((f: string) => f.split(path.sep).includes("fakehome")).length;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("does not trace any home-directory file from src/core/projects/context.ts", async () => {
    const source = fs.readFileSync(path.resolve("src/core/projects/context.ts"), "utf8");
    assert.equal(await homeEntriesTraced(source), 0);
  });

  it("(control) the probe does detect the original inlined os.homedir() pattern", async () => {
    const source = fs.readFileSync(path.resolve("src/core/projects/context.ts"), "utf8");
    const inlined = source.replace("path.join(homeDirectory(), localPath.slice(1))", "path.join(os.homedir(), localPath.slice(1))");
    assert.notEqual(inlined, source, "precondition: the helper call is present");
    assert.ok((await homeEntriesTraced(inlined)) > 0);
  });
});

describe("environment / credential file policy", () => {
  it("names the files that never ship, except the dummy-valued example", () => {
    for (const name of [".env", ".env.local", ".env.production", ".ENV", ".envrc", ".npmrc", ".netrc", ".pgpass"]) {
      assert.equal(isSecretFileName(path.join("x", name)), true, name);
    }
    for (const name of [".env.example", "env.js", "environment.ts", "dotenv.js"]) {
      assert.equal(isSecretFileName(path.join("x", name)), false, name);
    }
  });

  it("refuses an env file anywhere in the payload", () => {
    write(path.join(standalone, "nested", ".env.local"), "SYNTHETIC_ONLY=1");
    try {
      assert.ok(gateViolations().some((v) => v.kind === "secret-file"));
    } finally {
      fs.rmSync(path.join(standalone, "nested"), { recursive: true, force: true });
    }
  });
});
