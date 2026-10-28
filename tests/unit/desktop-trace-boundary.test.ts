/**
 * Desktop trace / payload packaging boundary.
 *
 * Deterministic, synthetic-fixture tests for the fail-closed gate that keeps
 * arbitrary runtime directories (user-profile inventories, malformed cross-drive
 * paths, escaping symlinks) out of the shipped desktop bundle. Never touches a
 * real user profile or database: every fixture lives in a disposable temp tree.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Loaded through createRequire (Node's require(ESM)) so the untyped desktop
// `.mjs` module needs no declaration file and `tsc --noEmit` stays clean.
const tb = require("../../desktop/trace-boundary.mjs");

const {
  hasEmbeddedDrive,
  isWithin,
  isWithinAny,
  canonicalize,
  classifyPath,
  hashPath,
  resolveAllowedRoots,
  findManifests,
  scanManifest,
  scanPayload,
  sanitizeManifests,
  assertSymlinkTargetWithin,
  assertTraceBoundary,
  TraceBoundaryError,
  resolveCanonical,
  validateLimits,
  limitsFromEnv,
  isSecretFileName,
} = tb;

/** Create a directory symlink without needing elevation on Windows. */
function linkDir(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : undefined);
    return true;
  } catch {
    return false;
  }
}

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

let work = "";
let project = "";
let standalone = "";
let nextDir = "";
let external = "";
let allowedRoots: string[] = [];

const SENTINEL_NAME = "SENTINEL_PRIVATE_FILE_do_not_leak.txt";

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "trace-boundary-"));
  project = path.join(work, "proj");
  standalone = path.join(project, ".next", "standalone");
  nextDir = path.join(project, ".next");
  external = path.join(work, "external");

  // A realistic project: source, a native dep, a JS dep, migrations.
  write(path.join(project, "src", "app.js"), "module.exports=1;");
  write(path.join(project, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "native");
  write(path.join(project, "node_modules", "next", "dist", "server", "x.js"), "next");
  write(path.join(project, "drizzle", "0000_init.sql"), "-- migration");

  // Standalone payload (what actually ships).
  write(path.join(standalone, "server.js"), "server");
  write(path.join(standalone, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "native");
  write(path.join(standalone, "drizzle", "0000_init.sql"), "-- migration");

  // An external sentinel that must never enter traces or payload diagnostics.
  write(path.join(external, "secret", SENTINEL_NAME), "private");

  allowedRoots = resolveAllowedRoots({ projectRoot: project, standaloneDir: standalone });
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("true path containment", () => {
  it("treats the root itself and descendants as within", () => {
    assert.equal(isWithin(project, project), true);
    assert.equal(isWithin(project, path.join(project, "src", "app.js")), true);
    assert.equal(isWithin(project, path.join(project, "node_modules", "next")), true);
  });

  it("rejects a sibling whose name merely shares a prefix (repo-evil is not repo)", () => {
    const sibling = project + "-evil";
    assert.equal(isWithin(project, sibling), false);
    assert.equal(isWithin(project, path.join(sibling, "x.js")), false);
    // A raw startsWith() would have wrongly passed both of these.
    assert.ok(sibling.startsWith(project));
  });

  it("rejects ancestors and unrelated external paths", () => {
    assert.equal(isWithin(project, path.dirname(project)), false);
    assert.equal(isWithin(project, external), false);
    assert.equal(isWithinAny(allowedRoots, path.join(external, "secret")), false);
  });

  it("accepts canonicalised descendants and is case-insensitive on Windows", () => {
    assert.equal(isWithinAny(allowedRoots, canonicalize(path.join(project, "src", "app.js"))), true);
    if (process.platform === "win32") {
      assert.equal(isWithin(project, project.toUpperCase()), true);
      assert.equal(isWithin(project, path.join(project, "SRC", "app.js")), true);
    }
  });
});

describe("malformed embedded-drive detection", () => {
  it("flags a drive letter embedded after the start", () => {
    assert.equal(hasEmbeddedDrive(path.join(project, "C:", "Users", "x")), true);
    assert.equal(hasEmbeddedDrive("../../../../../C:/Users/foo/secret.txt"), true);
    assert.equal(hasEmbeddedDrive("..\\..\\..\\D:\\data\\x"), true);
  });

  it("does not flag a single legitimate leading drive or POSIX paths", () => {
    assert.equal(hasEmbeddedDrive("C:\\Users\\foo\\x"), false);
    assert.equal(hasEmbeddedDrive(path.join(project, "node_modules", "next", "x.js")), false);
    assert.equal(hasEmbeddedDrive("/home/user/project/x.js"), false);
    assert.equal(hasEmbeddedDrive("../../../node_modules/next/x.js"), false);
  });
});

describe("trace metadata scanning (manifest entries)", () => {
  const manifestDir = path.join(nextDir, "server", "app", "ai", "chat");
  const manifestPath = path.join(manifestDir, "page.js.nft.json");
  const upToProject = "../../../../../"; // chat -> ai -> app -> server -> .next -> project

  function buildManifest(files: string[]): void {
    write(manifestPath, JSON.stringify({ version: 1, files }));
  }

  it("accepts legitimate native, dependency and migration entries", () => {
    buildManifest([
      upToProject + "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      upToProject + "node_modules/next/dist/server/x.js",
      upToProject + "drizzle/0000_init.sql",
      upToProject + "src/app.js",
    ]);
    const r = scanManifest(manifestPath, { allowedRoots, projectRoot: project, home: os.homedir() });
    assert.equal(r.total, 4);
    assert.deepEqual(r.violations, []);
  });

  it("flags an external sentinel entry as out-of-boundary without leaking its name", () => {
    const sentinel = path.join(external, "secret", SENTINEL_NAME);
    const rel = path.relative(manifestDir, sentinel).replace(/\\/g, "/");
    buildManifest([rel]);
    const r = scanManifest(manifestPath, { allowedRoots, projectRoot: project, home: os.homedir() });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, "out-of-boundary");
    // The violation carries a hash + coarse category, never the private name.
    const serialised = JSON.stringify(r.violations[0]);
    assert.ok(!serialised.includes(SENTINEL_NAME), "violation must not contain the sentinel filename");
    assert.ok(!serialised.includes(sentinel), "violation must not contain the sentinel path");
    assert.equal(typeof r.violations[0].hash, "string");
    assert.equal(r.violations[0].hash, hashPath(rel));
  });

  it("flags a malformed cross-drive entry", () => {
    buildManifest([upToProject + "C:/Users/foo/AppData/Local/secret.txt"]);
    const r = scanManifest(manifestPath, { allowedRoots, projectRoot: project, home: os.homedir() });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, "embedded-drive");
  });

  it("reports an unparseable manifest rather than passing it silently", () => {
    write(manifestPath, "{ not json");
    const r = scanManifest(manifestPath, { allowedRoots, projectRoot: project, home: os.homedir() });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, "manifest-unparseable");
  });

  it("finds every manifest under .next, not just the observed routes", () => {
    write(path.join(nextDir, "server", "app", "api", "ai", "chat", "route.js.nft.json"), JSON.stringify({ version: 1, files: [] }));
    write(path.join(standalone, ".next", "server", "app", "ai", "chat", "page.js.nft.json"), JSON.stringify({ version: 1, files: [] }));
    write(path.join(nextDir, "next-server.js.nft.json"), JSON.stringify({ version: 1, files: [] }));
    const found = findManifests(nextDir).map((m: string) => path.relative(nextDir, m).replace(/\\/g, "/"));
    assert.ok(found.includes("server/app/api/ai/chat/route.js.nft.json"));
    assert.ok(found.includes("next-server.js.nft.json"));
    // The standalone copy lives under .next/standalone/.next and is found too.
    assert.ok(found.some((f: string) => f.startsWith("standalone/")), `expected a standalone manifest, got ${found.join(", ")}`);
  });
});

describe("payload scanning (copied files and symlinks)", () => {
  it("accepts an in-boundary payload", () => {
    const r = scanPayload(standalone, { allowedRoots, projectRoot: project, home: os.homedir() });
    assert.deepEqual(r.violations, []);
    assert.ok(r.fileCount >= 3);
  });

  it("flags a symlink whose target escapes the bundle", () => {
    const link = path.join(standalone, "escape-link");
    if (!linkDir(path.join(external, "secret"), link)) {
      // Symlink/junction unsupported here: assert the pure logic instead.
      assert.throws(
        () => assertSymlinkTargetWithin(path.join(external, "secret"), standalone, allowedRoots, { projectRoot: project, home: os.homedir() }),
        TraceBoundaryError,
      );
      return;
    }
    try {
      const r = scanPayload(standalone, { allowedRoots, projectRoot: project, home: os.homedir() });
      const escape = r.violations.find((v: { kind: string }) => v.kind === "symlink-escape");
      assert.ok(escape, "expected a symlink-escape violation");
      assert.ok(!JSON.stringify(r.violations).includes(SENTINEL_NAME), "payload violation must not leak the sentinel name");
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it("does not flag an internal symlink that stays within the bundle", () => {
    const realDir = path.join(standalone, "nm-real");
    write(path.join(realDir, "x.js"), "x");
    const link = path.join(standalone, "nm-link");
    if (!linkDir(realDir, link)) return; // unsupported; nothing to assert
    try {
      const r = scanPayload(standalone, { allowedRoots, projectRoot: project, home: os.homedir() });
      assert.ok(!r.violations.some((v: { kind: string }) => v.kind === "symlink-escape"));
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("enforces size/count guardrails as defense in depth", () => {
    const r = scanPayload(standalone, { allowedRoots, projectRoot: project, home: os.homedir(), limits: validateLimits({ maxFiles: 1 }) });
    assert.ok(r.violations.some((v: { kind: string }) => v.kind === "guardrail-file-count"));
  });
});

describe("symlink target assertion (materialisation guard)", () => {
  it("throws a redacted TraceBoundaryError for an escaping target", () => {
    assert.throws(
      () => assertSymlinkTargetWithin(path.join(external, "secret"), standalone, allowedRoots, { projectRoot: project, home: os.homedir() }),
      (err: unknown) => {
        assert.ok(err instanceof TraceBoundaryError);
        const e = err as Error;
        assert.ok(!e.message.includes(SENTINEL_NAME));
        assert.match(e.message, /symlink-escape/);
        return true;
      },
    );
  });

  it("accepts a target inside the standalone bundle", () => {
    assert.doesNotThrow(() =>
      assertSymlinkTargetWithin(path.join(standalone, "server.js"), standalone, allowedRoots, { projectRoot: project, home: os.homedir() }),
    );
  });
});

describe("manifest sanitisation (prevention)", () => {
  it("strips out-of-boundary entries and keeps legitimate ones", () => {
    const manifestDir = path.join(nextDir, "server", "app", "ai", "chat");
    const manifestPath = path.join(manifestDir, "page.js.nft.json");
    const upToProject = "../../../../../";
    const sentinelRel = path.relative(manifestDir, path.join(external, "secret", SENTINEL_NAME)).replace(/\\/g, "/");
    write(manifestPath, JSON.stringify({
      version: 1,
      files: [
        upToProject + "node_modules/next/dist/server/x.js",
        upToProject + "drizzle/0000_init.sql",
        sentinelRel,
        upToProject + "C:/Users/foo/secret.txt",
      ],
    }));

    const res = sanitizeManifests(nextDir, { allowedRoots, projectRoot: project, home: os.homedir() });
    assert.ok(res.removed >= 2, `expected the sentinel and the cross-drive entry removed, removed=${res.removed}`);

    const after = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { files: string[] };
    assert.ok(after.files.includes(upToProject + "node_modules/next/dist/server/x.js"));
    assert.ok(after.files.includes(upToProject + "drizzle/0000_init.sql"));
    assert.ok(!after.files.some((f: string) => f.includes(SENTINEL_NAME)));
    assert.ok(!after.files.some((f: string) => /[\\/][A-Za-z]:[\\/]/.test(f.replace(/^[A-Za-z]:[\\/]/, ""))));
  });
});

describe("the packaging gate (fail closed)", () => {
  const manifestDir = path.join(nextDir, "server", "app", "other");
  const manifestPath = path.join(manifestDir, "route.js.nft.json");
  const upToProject = "../../../../../";

  it("refuses a bundle whose trace reaches an external sentinel, with a redacted message", () => {
    const sentinelRel = path.relative(manifestDir, path.join(external, "secret", SENTINEL_NAME)).replace(/\\/g, "/");
    write(manifestPath, JSON.stringify({ version: 1, files: [sentinelRel, upToProject + "C:/Users/foo/x"] }));

    assert.throws(
      () => assertTraceBoundary({ projectRoot: project, standaloneDir: standalone, nextDir, allowedRoots, home: os.homedir() }),
      (err: unknown) => {
        assert.ok(err instanceof TraceBoundaryError);
        const e = err as Error;
        // Actionable but redacted: counts and categories, never the private path.
        assert.match(e.message, /boundary refused the bundle/);
        assert.ok(!e.message.includes(SENTINEL_NAME), "gate message must not leak the sentinel filename");
        assert.ok(!e.message.includes(path.join(external, "secret")), "gate message must not leak the external path");
        return true;
      },
    );
  });

  it("passes once the offending entries are sanitised away", () => {
    sanitizeManifests(nextDir, { allowedRoots, projectRoot: project, home: os.homedir() });
    const result = assertTraceBoundary({ projectRoot: project, standaloneDir: standalone, nextDir, allowedRoots, home: os.homedir() });
    assert.equal(result.ok, true);
    assert.ok(result.manifests >= 1);
  });

  it("does not reject a legitimate project merely located under a machine-like path", () => {
    // A checkout that happens to live under AppData/Local/Programs must pass:
    // the gate keys on containment, not on forbidden directory names.
    const unusualRoot = path.join(work, "AppData", "Local", "Programs", "MyLegitApp");
    const unusualStandalone = path.join(unusualRoot, ".next", "standalone");
    write(path.join(unusualRoot, "src", "app.js"), "x");
    write(path.join(unusualRoot, "node_modules", "dep", "index.js"), "x");
    write(path.join(unusualStandalone, "server.js"), "x");
    write(path.join(unusualRoot, ".next", "server", "app", "p.js.nft.json"), JSON.stringify({
      version: 1,
      files: ["../../../node_modules/dep/index.js", "../../../src/app.js"],
    }));

    const unusualRoots = resolveAllowedRoots({ projectRoot: unusualRoot, standaloneDir: unusualStandalone });
    const result = assertTraceBoundary({
      projectRoot: unusualRoot,
      standaloneDir: unusualStandalone,
      nextDir: path.join(unusualRoot, ".next"),
      allowedRoots: unusualRoots,
      home: os.homedir(),
    });
    assert.equal(result.ok, true);
  });
});

describe("redaction helpers", () => {
  it("classifyPath returns coarse categories, never the path", () => {
    assert.equal(classifyPath(path.join(project, "src", "app.js"), { projectRoot: project, home: os.homedir() }), "project");
    assert.equal(classifyPath(path.join(project, "C:", "Users", "x"), { projectRoot: project, home: os.homedir() }), "embedded-drive");
    const cats = new Set(["project", "embedded-drive", "user-profile", "external"]);
    assert.ok(cats.has(classifyPath(path.join(external, "secret"), { projectRoot: project, home: os.homedir() })));
  });

  it("hashPath is stable and does not contain the input", () => {
    const h = hashPath("C:/Users/some/secret/path.txt");
    assert.equal(h, hashPath("C:/Users/some/secret/path.txt"));
    assert.equal(h.length, 16);
    assert.ok(!h.includes("secret"));
  });
});
