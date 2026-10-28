/**
 * Turns Next's standalone output into a desktop payload whose every file has a
 * verified origin.
 *
 * A scan of the finished payload cannot tell where a regular file came from:
 * Next's standalone writer copies traced files by their *lexical* path with
 * `copyFile` (dereferencing any junction on the way), and a recursive
 * dereferencing copy of a symlinked dependency pulls in whatever its nested
 * links point at. Once copied, a private file is just another file inside the
 * bundle, and sanitising the trace manifests afterwards only erases the
 * evidence of where it came from.
 *
 * So provenance is established here, from source to destination:
 *
 *  1. Before anything is sanitised, every file Next wrote is matched to the
 *     source it was copied from — a traced file, a mirrored build output, the
 *     project's package.json, or the generated server.js — and that source is
 *     judged by its canonical location and compared byte-for-byte (SHA-256).
 *     A file Next copied from a refused source, or one nobody can explain,
 *     refuses the build. Nothing is "fixed up" after the fact.
 *  2. Everything this script copies itself (materialised symlinks, static
 *     assets, public/, migrations) goes through `validatedCopy`, which walks
 *     and judges every source — recursively, through every nested link, with
 *     cycle detection and work bounds — before a single byte is copied.
 *  3. Every resulting file is recorded in a ledger with its digest. The final
 *     reconciliation re-hashes the whole payload and refuses anything that is
 *     not in the ledger or no longer matches it, and the package inventory
 *     covers every root electron-builder packages, not just the standalone
 *     tree.
 *
 * Diagnostics are aggregate and redacted (see trace-boundary.mjs).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LIMITS,
  TraceBoundaryError,
  ViolationSink,
  assertTraceBoundary,
  canonicalize,
  classifyPath,
  evaluateManifestEntry,
  findManifests,
  fsViolation,
  hasEmbeddedDrive,
  hashPath,
  isSecretFileName,
  isWithin,
  isWithinAny,
  normalizeForCompare,
  readManifest,
  resolveAllowedRoots,
  resolveCanonical,
  sanitizeManifests,
  validateLimits,
} from "./trace-boundary.mjs";

const STOP = Symbol("package-payload-stop");

/**
 * The roots electron-builder packages (package.json `build.files`), with the
 * file types each may legitimately contain. The standalone tree is checked
 * against the provenance ledger instead of by type.
 */
export const PACKAGE_SOURCE_ROOTS = Object.freeze([
  { name: "desktop", rel: "desktop", types: [".js", ".mjs", ".cjs"], subdirTypes: { resources: [".png", ".ico", ".icns", ".svg"] } },
  { name: "drizzle", rel: "drizzle", types: [".sql", ".json"] },
]);

/** electron-builder exclusions in package.json, reported (still inspected). */
const EXCLUDED_BY_PATTERN = [/\.map$/i, /(^|[\\/])(test|tests|__tests__|example|examples)[\\/]/i];

/* ------------------------------------------------------------------------ */
/* Hashing and the ledger                                                   */
/* ------------------------------------------------------------------------ */

/** SHA-256 of a regular file, bounded before and during the read. */
function hashFile(p, maxFileBytes) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: { kind: "unsupported-entry-type", hash: hashPath(p) } };
    if (st.size > maxFileBytes) return { error: { kind: "guardrail-file-bytes", bytes: st.size, max: maxFileBytes, hash: hashPath(p) } };
    const h = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxFileBytes) return { error: { kind: "guardrail-file-bytes", bytes: total, max: maxFileBytes, hash: hashPath(p) } };
      h.update(buf.subarray(0, n));
    }
    return { hash: h.digest("hex"), size: total };
  } catch (err) {
    return { error: fsViolation("hash", p, err) };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closing a read-only descriptor; nothing to recover */
      }
    }
  }
}

/** Destination file -> how it got there and the digest it had when verified. */
export class ProvenanceLedger {
  constructor() {
    this.entries = new Map();
  }

  record(dest, kind, hash, size) {
    this.entries.set(normalizeForCompare(dest), { kind, hash, size });
  }

  get(dest) {
    return this.entries.get(normalizeForCompare(dest));
  }

  summary() {
    const byKind = {};
    for (const e of this.entries.values()) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return byKind;
  }
}

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

function lstatOrNull(p, sink) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    sink.add(fsViolation("lstat", p, err));
    return undefined;
  }
}

/** Read a small JSON build output with a size bound and shape check. */
function readJsonOutput(p, { limits, sink, category }) {
  const st = lstatOrNull(p, sink);
  if (st === undefined) return null;
  if (st === null || !st.isFile()) {
    sink.add({ kind: "expected-output-missing", category });
    return null;
  }
  if (st.size > limits.maxManifestBytes) {
    sink.add({ kind: "guardrail-manifest-bytes", category, bytes: st.size, max: limits.maxManifestBytes });
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("shape");
    return data;
  } catch {
    sink.add({ kind: "manifest-invalid", category });
    return null;
  }
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0 && !x.includes("\0"));
}

function throwIf(sink, totals) {
  if (sink.size > 0) throw new TraceBoundaryError(sink, totals ? { totals } : undefined);
}

/** Remove a link itself — never what it points at. */
function unlinkLink(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EISDIR")) fs.rmdirSync(p);
    else throw err;
  }
}

/* ------------------------------------------------------------------------ */
/* Next's own output                                                        */
/* ------------------------------------------------------------------------ */

/**
 * What the build says about its own layout. The desktop bundle assumes the
 * project is the tracing root (server.js at the standalone root); anything
 * else is refused rather than guessed at.
 */
function readBuildLayout(ctx) {
  const sink = new ViolationSink();
  const rsf = readJsonOutput(path.join(ctx.nextDir, "required-server-files.json"), { ...ctx, sink, category: "required-server-files" });
  throwIf(sink);
  const tracingRootRaw = rsf.config && typeof rsf.config === "object" ? rsf.config.outputFileTracingRoot : undefined;
  if (rsf.version !== 1 || typeof rsf.appDir !== "string" || !isStringArray(rsf.files) || typeof tracingRootRaw !== "string") {
    throw new TraceBoundaryError([{ kind: "manifest-invalid", category: "required-server-files-shape" }]);
  }
  const tracingRoot = canonicalize(tracingRootRaw);
  const appDir = canonicalize(rsf.appDir);
  if (normalizeForCompare(tracingRoot) !== normalizeForCompare(ctx.projectRoot) || normalizeForCompare(appDir) !== normalizeForCompare(ctx.projectRoot)) {
    throw new TraceBoundaryError([{ kind: "unexpected-build-layout", category: "tracing-root-is-not-the-project" }]);
  }
  // Paths below are computed the way Next computes them (lexically, from the
  // lexical project path), so they match what it actually wrote.
  return { tracingRoot: ctx.lexicalRoot, appDir: ctx.lexicalRoot, requiredFiles: rsf.files };
}

/** Where Next's writer puts a source file inside the standalone tree. */
function standaloneDest(ctx, layout, source) {
  return path.join(ctx.standaloneDir, path.relative(layout.tracingRoot, source));
}

/** Files the edge runtime needs, which Next mirrors from the build output. */
function edgeFunctionFiles(ctx) {
  const sink = new ViolationSink();
  const manifestPath = path.join(ctx.nextDir, "server", "middleware-manifest.json");
  const st = lstatOrNull(manifestPath, sink);
  throwIf(sink);
  if (st === null) return [];
  const mm = readJsonOutput(manifestPath, { ...ctx, sink, category: "middleware-manifest" });
  throwIf(sink);
  const out = [];
  for (const group of [mm.middleware, mm.functions]) {
    if (group === undefined) continue;
    if (group === null || typeof group !== "object") {
      throw new TraceBoundaryError([{ kind: "manifest-invalid", category: "middleware-manifest-shape" }]);
    }
    for (const fn of Object.values(group)) {
      const files = [...(fn?.files ?? []), ...(fn?.wasm ?? []).map((w) => w?.filePath), ...(fn?.assets ?? []).map((a) => a?.filePath)];
      if (!isStringArray(files)) throw new TraceBoundaryError([{ kind: "manifest-invalid", category: "middleware-manifest-shape" }]);
      out.push(...files);
    }
  }
  return out;
}

/**
 * Map every standalone destination Next's trace copier may have written to
 * the source it would have copied, with that source's verdict. Read from the
 * original manifests, before any sanitising. Also collects the entries Next
 * definitely copies (app routes, the server, middleware, instrumentation), so
 * an incomplete copy is caught too.
 */
function buildTraceMap(ctx, layout) {
  const sink = new ViolationSink();
  const manifests = findManifests(ctx.nextDir, {
    limits: ctx.limits,
    sink,
    exclude: [ctx.standaloneDir, path.join(ctx.nextDir, "cache")],
  });
  const consumedPrefixes = [path.join(ctx.nextDir, "server", "app") + path.sep];
  const consumedFiles = new Set(
    ["next-server.js.nft.json", path.join("server", "middleware.js.nft.json"), path.join("server", "instrumentation.js.nft.json")]
      .map((f) => normalizeForCompare(path.join(ctx.nextDir, f))),
  );
  const map = new Map();
  const expected = new Map();
  const stats = { manifests: manifests.length, entries: 0, refused: 0, refusedByCategory: {}, destOutsideStandalone: 0 };
  for (const m of manifests) {
    const r = readManifest(m, { limits: ctx.limits, sink });
    if (!r) continue;
    stats.entries += r.files.length;
    if (stats.entries > ctx.limits.maxTotalManifestEntries) {
      sink.add({ kind: "guardrail-total-manifest-entries", count: stats.entries, max: ctx.limits.maxTotalManifestEntries });
      break;
    }
    const dir = path.dirname(m);
    const consumed = consumedFiles.has(normalizeForCompare(m)) || consumedPrefixes.some((p) => normalizeForCompare(m).startsWith(normalizeForCompare(p)));
    for (const entry of r.files) {
      const verdict = evaluateManifestEntry(entry, dir, ctx);
      if (verdict) {
        stats.refused += 1;
        stats.refusedByCategory[verdict.category] = (stats.refusedByCategory[verdict.category] || 0) + 1;
      }
      const source = path.join(dir, entry);
      const dest = standaloneDest(ctx, layout, source);
      if (!isWithin(ctx.standaloneDir, dest)) {
        stats.destOutsideStandalone += 1;
        continue;
      }
      const key = normalizeForCompare(dest);
      if (consumed && verdict) {
        // Next was told to put this into the payload. Whether the bytes landed
        // depends on its copy order (a write may pass through a recreated
        // link), so the request itself refuses the build: the tracing has to
        // be fixed at its source, not cleaned out of the metadata.
        sink.add({ ...verdict, kind: "unapproved-trace-in-payload" });
      }
      const prior = map.get(key);
      if (!prior || (!prior.verdict && verdict)) map.set(key, { source, verdict });
      if (consumed && !verdict) expected.set(key, source);
    }
  }
  throwIf(sink);
  return { map, expected, stats };
}

/**
 * Remove the environment files Next's standalone writer copies when it loaded
 * them (`.env`, `.env.production`). The desktop runtime gets its configuration
 * from the Electron main process; these files are never packaged. Only the
 * names Next writes are removed here — any other env/credential file anywhere
 * in the payload is a refusal.
 */
function stripNextEnvCopies(ctx, layout) {
  const sink = new ViolationSink();
  let removed = 0;
  for (const name of [".env", ".env.production"]) {
    const dest = standaloneDest(ctx, layout, path.join(layout.appDir, name));
    const st = lstatOrNull(dest, sink);
    if (!st) continue;
    if (!st.isFile()) {
      sink.add({ kind: "secret-file", category: "env-or-credential-file", hash: hashPath(name) });
      continue;
    }
    try {
      fs.unlinkSync(dest);
      removed += 1;
    } catch (err) {
      sink.add(fsViolation("unlink", dest, err));
    }
  }
  throwIf(sink);
  return removed;
}

/** Never ship a database: `standalone/data` would be the build-time one. */
function removeStrayData(ctx) {
  const sink = new ViolationSink();
  const strayData = path.join(ctx.standaloneDir, "data");
  const st = lstatOrNull(strayData, sink);
  throwIf(sink);
  if (!st) return false;
  try {
    if (st.isSymbolicLink()) unlinkLink(strayData);
    else fs.rmSync(strayData, { recursive: true, force: true });
  } catch (err) {
    throw new TraceBoundaryError([fsViolation("remove", strayData, err)]);
  }
  return true;
}

/**
 * Step 1: account for every file Next wrote into the standalone tree.
 * Returns the symlinks still to be materialised (judged there).
 */
function verifyNextOutput(ctx, layout, trace) {
  const sink = new ViolationSink();
  const nextRel = path.relative(layout.tracingRoot, ctx.nextDir);
  const standaloneNext = path.join(ctx.standaloneDir, nextRel);
  const canonNext = canonicalize(ctx.nextDir);
  const canonStandalone = ctx.canonStandalone;

  // Exact files Next mirrors from the build output.
  const mirrored = new Map();
  const addMirror = (source, kind) => mirrored.set(normalizeForCompare(standaloneDest(ctx, layout, source)), { source, kind });
  for (const f of layout.requiredFiles) addMirror(path.join(layout.appDir, f), "next-required");
  addMirror(path.join(ctx.nextDir, "required-server-files.json"), "next-required");
  addMirror(path.join(ctx.nextDir, "server", "middleware.js"), "next-mirror");
  for (const f of edgeFunctionFiles(ctx)) addMirror(path.join(ctx.nextDir, f), "next-mirror");
  // Directories Next mirrors wholesale.
  const mirroredDirs = ["app", "pages"].map((d) => path.join(standaloneNext, "server", d) + path.sep);

  const generated = new Set([normalizeForCompare(path.join(ctx.standaloneDir, path.relative(layout.tracingRoot, layout.appDir), "server.js"))]);
  const packageJsonDest = normalizeForCompare(standaloneDest(ctx, layout, path.join(layout.appDir, "package.json")));

  const pendingLinks = [];
  let files = 0;
  let bytes = 0;
  let visited = 0;

  // A mirrored or traced source must never be the payload itself.
  const judgeSourceIn = (source, roots) => {
    const judged = judgeSourceAgainst(source, roots, ctx);
    if (judged.ok && isWithin(canonStandalone, judged.canonical)) {
      return { ok: false, violation: { kind: "out-of-boundary", category: "standalone-self-reference", hash: hashPath(source) } };
    }
    return judged;
  };

  const verifyAgainst = (dest, source, kind, roots) => {
    const judged = roots === null ? { ok: true } : judgeSourceIn(source, roots);
    if (!judged.ok) {
      sink.add({ ...judged.violation, kind: "unapproved-source-copied" });
      return;
    }
    const d = hashFile(dest, ctx.limits.maxFileBytes);
    if (d.error) return sink.add(d.error);
    if (source !== null) {
      const s = hashFile(source, ctx.limits.maxFileBytes);
      if (s.error) return sink.add(s.error);
      if (s.hash !== d.hash) return sink.add({ kind: "content-mismatch", category: kind, hash: hashPath(path.relative(ctx.standaloneDir, dest)) });
    }
    ctx.ledger.record(dest, kind, d.hash, d.size);
  };

  const walk = (dir, depth) => {
    if (depth > ctx.limits.maxDepth) return sink.add({ kind: "guardrail-depth", hash: hashPath(dir) });
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return sink.add(fsViolation("readdir", dir, err));
    }
    for (const e of entries) {
      visited += 1;
      if (visited > ctx.limits.maxWalkEntries) {
        sink.add({ kind: "guardrail-walk-entries", count: visited, max: ctx.limits.maxWalkEntries });
        throw STOP;
      }
      const full = path.join(dir, e.name);
      const relHash = hashPath(path.relative(ctx.standaloneDir, full));
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (err) {
        sink.add(fsViolation("lstat", full, err));
        continue;
      }
      if (isSecretFileName(full) && !st.isDirectory()) {
        sink.add({ kind: "secret-file", category: "env-or-credential-file", hash: relHash });
        continue;
      }
      if (st.isSymbolicLink()) {
        pendingLinks.push(full);
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        sink.add({ kind: "unsupported-entry-type", hash: relHash });
        continue;
      }
      files += 1;
      bytes += st.size;
      if (files > ctx.limits.maxFiles) {
        sink.add({ kind: "guardrail-file-count", count: files, max: ctx.limits.maxFiles });
        throw STOP;
      }
      if (bytes > ctx.limits.maxBytes) {
        sink.add({ kind: "guardrail-bytes", bytes, max: ctx.limits.maxBytes });
        throw STOP;
      }

      const key = normalizeForCompare(full);
      const traced = trace.map.get(key);
      if (traced && traced.verdict) {
        // Next copied this from a source outside the boundary. The bytes are
        // already here; refuse the build rather than tidy the metadata.
        sink.add({ ...traced.verdict, kind: "unapproved-source-copied" });
        continue;
      }
      if (generated.has(key)) {
        verifyAgainst(full, null, "next-generated", null);
      } else if (key === packageJsonDest) {
        verifyAgainst(full, path.join(layout.appDir, "package.json"), "project-package-json", [ctx.projectRoot]);
      } else if (mirrored.has(key)) {
        const m = mirrored.get(key);
        verifyAgainst(full, m.source, m.kind, [canonNext]);
      } else if (mirroredDirs.some((p) => key.startsWith(normalizeForCompare(p)))) {
        const source = path.join(ctx.nextDir, path.relative(standaloneNext, full));
        verifyAgainst(full, source, "next-mirror", [canonNext]);
      } else if (traced) {
        verifyAgainst(full, traced.source, "next-traced", ctx.allowedRoots);
      } else {
        sink.add({ kind: "unexpected-payload-file", hash: relHash });
      }
    }
  };

  try {
    walk(ctx.standaloneDir, 0);
  } catch (err) {
    if (err !== STOP) throw err;
  }
  throwIf(sink, { payloadFiles: files, payloadBytes: bytes, symlinks: pendingLinks.length });
  return { pendingLinks, files, bytes };
}

/** judgeSource with a specific set of roots (existing sources only). */
function judgeSourceAgainst(source, roots, ctx) {
  const hash = hashPath(source);
  if (hasEmbeddedDrive(source)) return { ok: false, violation: { kind: "embedded-drive", category: "embedded-drive", hash } };
  const r = resolveCanonical(source);
  if (r.status !== "ok") return { ok: false, violation: { kind: "resolve-failed", category: r.code ?? "missing", hash } };
  if (!isWithinAny(roots, r.path)) {
    return { ok: false, violation: { kind: "out-of-boundary", category: classifyPath(r.path, ctx), hash } };
  }
  if (isSecretFileName(source) || isSecretFileName(r.path)) {
    return { ok: false, violation: { kind: "secret-file", category: "env-or-credential-file", hash } };
  }
  return { ok: true, canonical: r.path };
}

/* ------------------------------------------------------------------------ */
/* Validated copy (S2)                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Copy `src` (file or directory, following links) to `dest` inside the
 * standalone tree, but only after every source in it — including everything
 * reached through nested symlinks/junctions — has been resolved to its real
 * location and judged against `sourceRoots`. Detects link cycles and enforces
 * depth/entry/file/byte bounds during the walk. Nothing is copied unless the
 * whole tree passes. Every copied file is hashed into the ledger.
 */
export function validatedCopy(src, dest, ctx, { kind, sourceRoots }) {
  const sink = new ViolationSink();
  if (!isWithin(ctx.standaloneDir, dest)) {
    throw new TraceBoundaryError([{ kind: "copy-destination-out-of-boundary", hash: hashPath(dest) }]);
  }
  const plan = { dirs: [], files: [], dangling: 0 };
  const budget = { entries: 0, files: 0, bytes: 0 };

  const visit = (from, to, depth, stack) => {
    budget.entries += 1;
    if (budget.entries > ctx.limits.maxWalkEntries) {
      sink.add({ kind: "guardrail-walk-entries", count: budget.entries, max: ctx.limits.maxWalkEntries });
      throw STOP;
    }
    if (depth > ctx.limits.maxDepth) return sink.add({ kind: "guardrail-depth", hash: hashPath(from) });
    const r = resolveCanonical(from);
    if (r.status === "error" && r.code === "EDANGLING") {
      // A link to nothing carries no content; it is simply not reproduced.
      plan.dangling += 1;
      return;
    }
    if (r.status !== "ok") return sink.add({ kind: "resolve-failed", category: r.code ?? "missing", hash: hashPath(from) });
    if (!isWithinAny(sourceRoots, r.path)) {
      return sink.add({ kind: "copy-source-out-of-boundary", category: classifyPath(r.path, ctx), hash: hashPath(from) });
    }
    if (isSecretFileName(from) || isSecretFileName(r.path)) {
      return sink.add({ kind: "secret-file", category: "env-or-credential-file", hash: hashPath(from) });
    }
    let st;
    try {
      st = fs.statSync(r.path);
    } catch (err) {
      return sink.add(fsViolation("stat", from, err));
    }
    if (st.isDirectory()) {
      const key = normalizeForCompare(r.path);
      if (stack.has(key)) return sink.add({ kind: "symlink-cycle", hash: hashPath(from) });
      plan.dirs.push(to);
      let names;
      try {
        names = fs.readdirSync(r.path);
      } catch (err) {
        return sink.add(fsViolation("readdir", from, err));
      }
      stack.add(key);
      for (const name of names) visit(path.join(r.path, name), path.join(to, name), depth + 1, stack);
      stack.delete(key);
      return;
    }
    if (!st.isFile()) return sink.add({ kind: "unsupported-entry-type", hash: hashPath(from) });
    if (st.size > ctx.limits.maxFileBytes) {
      return sink.add({ kind: "guardrail-file-bytes", bytes: st.size, max: ctx.limits.maxFileBytes, hash: hashPath(from) });
    }
    budget.files += 1;
    budget.bytes += st.size;
    if (budget.files > ctx.limits.maxFiles) {
      sink.add({ kind: "guardrail-file-count", count: budget.files, max: ctx.limits.maxFiles });
      throw STOP;
    }
    if (budget.bytes > ctx.limits.maxBytes) {
      sink.add({ kind: "guardrail-bytes", bytes: budget.bytes, max: ctx.limits.maxBytes });
      throw STOP;
    }
    plan.files.push({ src: r.path, dest: to, size: st.size });
  };

  try {
    visit(src, dest, 0, new Set());
  } catch (err) {
    if (err !== STOP) throw err;
  }
  throwIf(sink);

  // Copy phase. Destination directories must really be where they appear to
  // be (no link in the destination chain redirecting the write elsewhere), and
  // each source must still be the regular file that was judged.
  const checkedDirs = new Set();
  const checkDestDir = (dir) => {
    const key = normalizeForCompare(dir);
    if (checkedDirs.has(key)) return;
    const r = resolveCanonical(dir);
    const expected = path.join(ctx.canonStandalone, path.relative(ctx.standaloneDir, dir));
    if (r.status !== "ok" || normalizeForCompare(r.path) !== normalizeForCompare(expected)) {
      throw new TraceBoundaryError([{ kind: "copy-destination-out-of-boundary", hash: hashPath(path.relative(ctx.standaloneDir, dir)) }]);
    }
    checkedDirs.add(key);
  };
  try {
    for (const d of plan.dirs) {
      fs.mkdirSync(d, { recursive: true });
      checkDestDir(d);
    }
    for (const f of plan.files) {
      fs.mkdirSync(path.dirname(f.dest), { recursive: true });
      checkDestDir(path.dirname(f.dest));
      const now = resolveCanonical(f.src);
      if (now.status !== "ok" || normalizeForCompare(now.path) !== normalizeForCompare(f.src) || !fs.lstatSync(f.src).isFile()) {
        throw new TraceBoundaryError([{ kind: "copy-source-changed", hash: hashPath(f.src) }]);
      }
      const existing = lstatOrNull(f.dest, sink);
      throwIf(sink);
      if (existing && !existing.isFile()) {
        throw new TraceBoundaryError([{ kind: "copy-destination-out-of-boundary", category: "not-a-regular-file", hash: hashPath(path.relative(ctx.standaloneDir, f.dest)) }]);
      }
      fs.copyFileSync(f.src, f.dest);
      const d = hashFile(f.dest, ctx.limits.maxFileBytes);
      if (d.error) throw new TraceBoundaryError([d.error]);
      if (d.size !== f.size) throw new TraceBoundaryError([{ kind: "copy-source-changed", hash: hashPath(f.src) }]);
      ctx.ledger.record(f.dest, kind, d.hash, d.size);
    }
  } catch (err) {
    if (err instanceof TraceBoundaryError) throw err;
    throw new TraceBoundaryError([fsViolation("copy", dest, err)]);
  }
  return { files: plan.files.length, dirs: plan.dirs.length, dangling: plan.dangling };
}

/**
 * Replace every symlink Next left in the standalone tree with validated real
 * files. electron-builder recreates symlinks, which on Windows needs elevation
 * or Developer Mode; plain files need neither.
 *
 * Next recreates a *traced* symlink as a symlink. In a git worktree whose
 * whole node_modules is a junction to a shared dependency directory, that
 * junction is the only node_modules entry the tracer records: it ignores files
 * whose real path is outside the project, so the traced subset is incomplete
 * (the native better-sqlite3 module is not in it). The link is therefore
 * replaced by a validated copy of its whole target — an explicitly allowed
 * dependency root — every nested link judged on the way.
 *
 * The replacement is assembled in a staging directory and only swapped in once
 * every source has passed; a refusal leaves no partial copy.
 */
function materializeSymlinks(ctx, links) {
  let replaced = 0;
  let dangling = 0;
  let files = 0;
  for (const link of links) {
    const r = resolveCanonical(link);
    if (r.status === "error" && r.code === "EDANGLING") {
      // Would be dangling once packaged; dropping it ships nothing.
      try {
        unlinkLink(link);
      } catch (err) {
        throw new TraceBoundaryError([fsViolation("unlink", link, err)]);
      }
      dangling += 1;
      continue;
    }
    if (r.status !== "ok") {
      throw new TraceBoundaryError([{ kind: "resolve-failed", category: r.code ?? "missing", hash: hashPath(path.relative(ctx.standaloneDir, link)) }]);
    }
    if (!isWithinAny(ctx.linkRoots, r.path)) {
      throw new TraceBoundaryError([{ kind: "symlink-escape", category: classifyPath(r.path, ctx), hash: hashPath(path.relative(ctx.standaloneDir, link)) }]);
    }
    const staging = `${link}.materialize-${process.pid}`;
    const stagingKey = normalizeForCompare(staging);
    let copied = 0;
    try {
      copied = validatedCopy(r.path, staging, ctx, { kind: "materialized-link", sourceRoots: ctx.linkRoots }).files;
    } catch (err) {
      // Only our own staging directory (real files we just created) is removed.
      fs.rmSync(staging, { recursive: true, force: true });
      for (const key of [...ctx.ledger.entries.keys()]) {
        if (key === stagingKey || key.startsWith(stagingKey + path.sep)) ctx.ledger.entries.delete(key);
      }
      throw err;
    }
    try {
      unlinkLink(link);
      fs.renameSync(staging, link);
    } catch (err) {
      throw new TraceBoundaryError([fsViolation("materialize", link, err)]);
    }
    // Ledger entries were recorded under the staging name; move them.
    for (const [key, entry] of [...ctx.ledger.entries]) {
      if (key === stagingKey || key.startsWith(stagingKey + path.sep)) {
        ctx.ledger.entries.delete(key);
        ctx.ledger.entries.set(normalizeForCompare(link) + key.slice(stagingKey.length), entry);
      }
    }
    files += copied;
    replaced += 1;
  }
  return { replaced, dangling, files };
}

/* ------------------------------------------------------------------------ */
/* Final reconciliation and package inventory                               */
/* ------------------------------------------------------------------------ */

/** Every standalone file must be in the ledger and still match its digest. */
function reconcilePayload(ctx) {
  const sink = new ViolationSink();
  let files = 0;
  let bytes = 0;
  let excluded = 0;
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > ctx.limits.maxDepth) return sink.add({ kind: "guardrail-depth", hash: hashPath(dir) });
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return sink.add(fsViolation("readdir", dir, err));
    }
    for (const e of entries) {
      visited += 1;
      if (visited > ctx.limits.maxWalkEntries) {
        sink.add({ kind: "guardrail-walk-entries", count: visited, max: ctx.limits.maxWalkEntries });
        throw STOP;
      }
      const full = path.join(dir, e.name);
      const relHash = hashPath(path.relative(ctx.standaloneDir, full));
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (err) {
        sink.add(fsViolation("lstat", full, err));
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (st.isSymbolicLink()) {
        sink.add({ kind: "symlink-unmaterialized", hash: relHash });
        continue;
      }
      const entry = ctx.ledger.get(full);
      if (!entry) {
        sink.add({ kind: "unexpected-payload-file", hash: relHash });
        continue;
      }
      if (EXCLUDED_BY_PATTERN.some((re) => re.test(path.relative(ctx.standaloneDir, full)))) excluded += 1;
      const d = hashFile(full, ctx.limits.maxFileBytes);
      if (d.error) {
        sink.add(d.error);
        continue;
      }
      if (d.hash !== entry.hash || d.size !== entry.size) {
        sink.add({ kind: "content-changed-after-verification", category: entry.kind, hash: relHash });
        continue;
      }
      files += 1;
      bytes += d.size;
    }
  };
  try {
    walk(ctx.standaloneDir, 0);
  } catch (err) {
    if (err !== STOP) throw err;
  }
  if (files !== ctx.ledger.entries.size) {
    sink.add({ kind: "ledger-file-missing", count: ctx.ledger.entries.size - files });
  }
  throwIf(sink, { payloadFiles: files, payloadBytes: bytes });
  return { files, bytes, excludedByPattern: excluded };
}

/**
 * The non-standalone package roots: real files only, inside their root,
 * of a type that root legitimately holds, and never an env/credential file.
 */
function inventorySourceRoots(ctx) {
  const sink = new ViolationSink();
  const roots = {};
  let excluded = 0;
  for (const spec of ctx.packageRoots) {
    const rootPath = path.join(ctx.lexicalRoot, spec.rel);
    const stat = { files: 0, bytes: 0 };
    roots[spec.name] = stat;
    const rr = resolveCanonical(rootPath);
    if (rr.status !== "ok") {
      sink.add({ kind: "expected-output-missing", category: `package-root-${spec.name}` });
      continue;
    }
    const canonRoot = rr.path;
    if (!isWithin(ctx.projectRoot, canonRoot)) {
      sink.add({ kind: "out-of-boundary", category: `package-root-${spec.name}` });
      continue;
    }
    const walk = (dir, depth) => {
      if (depth > ctx.limits.maxDepth) return sink.add({ kind: "guardrail-depth", hash: hashPath(dir) });
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return sink.add(fsViolation("readdir", dir, err));
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(canonRoot, full);
        const relHash = hashPath(path.join(spec.rel, rel));
        let st;
        try {
          st = fs.lstatSync(full);
        } catch (err) {
          sink.add(fsViolation("lstat", full, err));
          continue;
        }
        if (st.isSymbolicLink()) {
          sink.add({ kind: "symlink-in-package-root", category: spec.name, hash: relHash });
          continue;
        }
        if (st.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!st.isFile()) {
          sink.add({ kind: "unsupported-entry-type", category: spec.name, hash: relHash });
          continue;
        }
        if (isSecretFileName(full)) {
          sink.add({ kind: "secret-file", category: "env-or-credential-file", hash: relHash });
          continue;
        }
        const top = rel.split(path.sep)[0];
        const subdir = rel.includes(path.sep) ? top : null;
        const allowed = (subdir && spec.subdirTypes?.[subdir]) || spec.types;
        if (!allowed.includes(path.extname(full).toLowerCase())) {
          sink.add({ kind: "unexpected-package-file", category: spec.name, hash: relHash });
          continue;
        }
        if (EXCLUDED_BY_PATTERN.some((re) => re.test(rel))) excluded += 1;
        stat.files += 1;
        stat.bytes += st.size;
      }
    };
    walk(canonRoot, 0);
  }
  const pkg = path.join(ctx.lexicalRoot, "package.json");
  const pst = lstatOrNull(pkg, sink);
  if (pst === null || (pst && !pst.isFile())) sink.add({ kind: "expected-output-missing", category: "package-json" });
  roots.packageJson = { files: pst && pst.isFile() ? 1 : 0, bytes: pst && pst.isFile() ? pst.size : 0 };
  throwIf(sink);
  return { roots, excludedByPattern: excluded };
}

/** Runtime completeness: required files and native modules made it in. */
function checkCompleteness(ctx, trace) {
  const sink = new ViolationSink();
  for (const rel of ctx.requiredPayloadFiles) {
    if (!ctx.ledger.get(path.join(ctx.standaloneDir, rel))) {
      sink.add({ kind: "runtime-file-missing", hash: hashPath(rel) });
    }
  }
  for (const mod of ctx.nativeModules) {
    const prefix = normalizeForCompare(path.join(ctx.standaloneDir, "node_modules", mod)) + path.sep;
    let hasPackageJson = false;
    let hasBinary = false;
    for (const key of ctx.ledger.entries.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (key === prefix + "package.json") hasPackageJson = true;
      if (key.endsWith(".node")) hasBinary = true;
    }
    if (!hasPackageJson || !hasBinary) sink.add({ kind: "native-module-incomplete", category: mod });
  }
  // Every in-boundary file Next was asked to copy for a route must be present.
  let missing = 0;
  for (const [key, source] of trace.expected) {
    if (ctx.ledger.entries.has(key)) continue;
    const r = resolveCanonical(source);
    if (r.status !== "ok") continue; // Next could not have copied a source that does not exist
    let st;
    try {
      st = fs.statSync(r.path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    missing += 1;
    if (missing <= 16) sink.add({ kind: "trace-copy-incomplete", hash: hashPath(path.relative(ctx.standaloneDir, key)) });
  }
  if (missing > 16) sink.add({ kind: "trace-copy-incomplete", count: missing });
  throwIf(sink);
  return { tracedExpected: trace.expected.size, tracedMissing: missing };
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Prepare `.next/standalone` for packaging after `next build`, and verify the
 * complete package inventory. Throws `TraceBoundaryError` (redacted) on any
 * refusal. Returns an aggregate, privacy-safe summary.
 */
export function prepareDesktopPayload({
  root,
  extraRoots = [],
  limits: limitOverrides = {},
  home = os.homedir(),
  requiredPayloadFiles = ["server.js", "package.json", path.join(".next", "BUILD_ID"), path.join(".next", "required-server-files.json"), path.join("node_modules", "next", "package.json"), path.join("drizzle", "meta", "_journal.json")],
  nativeModules = ["better-sqlite3"],
  packageRoots = PACKAGE_SOURCE_ROOTS,
  log = () => {},
}) {
  const limits = validateLimits(limitOverrides);
  const lexicalRoot = path.resolve(root);
  const nextDir = path.join(lexicalRoot, ".next");
  const standaloneDir = path.join(nextDir, "standalone");

  const sink = new ViolationSink();
  for (const [p, category] of [[nextDir, "next-dir"], [standaloneDir, "standalone-dir"]]) {
    const st = lstatOrNull(p, sink);
    if (st === null || (st && !st.isDirectory())) sink.add({ kind: "expected-output-missing", category });
  }
  throwIf(sink);

  const projectRoot = canonicalize(lexicalRoot);
  const allowedRoots = resolveAllowedRoots({ projectRoot: lexicalRoot, standaloneDir, extraRoots });
  const canonStandalone = canonicalize(standaloneDir);
  // Symlinks in the payload may only lead into the payload or a dependency
  // root (a junctioned node_modules counts by where it really is) — not the
  // project tree at large.
  const linkRoots = [canonStandalone, canonicalize(path.join(lexicalRoot, "node_modules")), ...extraRoots.map((r) => canonicalize(r))];
  const ctx = {
    lexicalRoot,
    projectRoot,
    nextDir,
    standaloneDir,
    canonStandalone,
    allowedRoots,
    linkRoots,
    home,
    limits,
    ledger: new ProvenanceLedger(),
    requiredPayloadFiles,
    nativeModules,
    packageRoots,
  };

  const layout = readBuildLayout(ctx);
  const trace = buildTraceMap(ctx, layout);
  log(
    `• trace manifests (as built): ${trace.stats.manifests} manifests, ${trace.stats.entries} entries, ` +
      `${trace.stats.refused} outside the boundary, ${trace.stats.destOutsideStandalone} mapped outside the payload`,
  );

  const envRemoved = stripNextEnvCopies(ctx, layout);
  if (envRemoved > 0) log(`• removed ${envRemoved} environment file(s) Next copied into the bundle (desktop policy: none ship)`);
  if (removeStrayData(ctx)) log("• removed stray build database from bundle");

  const verified = verifyNextOutput(ctx, layout, trace);
  log(`• verified the origin of ${verified.files} file(s) written by Next`);

  const materialized = materializeSymlinks(ctx, verified.pendingLinks);
  if (materialized.replaced > 0 || materialized.dangling > 0) {
    log(`• replaced ${materialized.replaced} symlink(s) with validated copies (${materialized.files} files); dropped ${materialized.dangling} dangling`);
  }

  const nextRel = path.relative(layout.tracingRoot, nextDir);
  const staticSrc = path.join(nextDir, "static");
  validatedCopy(staticSrc, path.join(standaloneDir, nextRel, "static"), ctx, { kind: "next-static", sourceRoots: [canonicalize(staticSrc)] });
  log("• copied .next/static");
  const publicSrc = path.join(lexicalRoot, "public");
  const pubSink = new ViolationSink();
  const publicSt = lstatOrNull(publicSrc, pubSink);
  throwIf(pubSink);
  if (publicSt) {
    validatedCopy(publicSrc, path.join(standaloneDir, "public"), ctx, { kind: "public-asset", sourceRoots: [canonicalize(publicSrc)] });
    log("• copied public/");
  }
  const drizzleSrc = path.join(lexicalRoot, "drizzle");
  validatedCopy(drizzleSrc, path.join(standaloneDir, "drizzle"), ctx, { kind: "migration", sourceRoots: [canonicalize(drizzleSrc)] });
  log("• copied drizzle migrations");

  // Metadata clean-up only — the provenance decision was made above.
  const sanitized = sanitizeManifests(nextDir, { allowedRoots, projectRoot, home, limits });
  const ledgerSink = new ViolationSink();
  for (const m of sanitized.rewrittenPaths) {
    if (!isWithin(standaloneDir, m)) continue;
    const prior = ctx.ledger.get(m);
    const d = hashFile(m, limits.maxFileBytes);
    if (!prior) ledgerSink.add({ kind: "unexpected-payload-file", hash: hashPath(path.relative(standaloneDir, m)) });
    else if (d.error) ledgerSink.add(d.error);
    else ctx.ledger.record(m, "sanitized-trace-manifest", d.hash, d.size);
  }
  throwIf(ledgerSink);
  log(
    `• sanitized trace manifests: ${sanitized.manifests} scanned, ${sanitized.scanned} entries, ` +
      `${sanitized.removed} out-of-boundary entries removed across ${sanitized.rewritten} manifest(s), ${sanitized.kept} kept`,
  );

  const boundary = assertTraceBoundary({ projectRoot, standaloneDir, nextDir, allowedRoots, home, limits });
  const completeness = checkCompleteness(ctx, trace);
  const reconciled = reconcilePayload(ctx);
  const sources = inventorySourceRoots(ctx);
  log(
    `• trace/packaging boundary OK: ${boundary.manifests} manifests, ${boundary.totalManifestEntries} trace entries, ` +
      `${reconciled.files} payload files (${reconciled.bytes} bytes) each matched to a verified source`,
  );

  return {
    ok: true,
    traceBefore: trace.stats,
    envFilesRemoved: envRemoved,
    sanitized: { manifests: sanitized.manifests, scanned: sanitized.scanned, removed: sanitized.removed, kept: sanitized.kept, rewritten: sanitized.rewritten, removedCategories: sanitized.removedCategories },
    boundary,
    materialized,
    completeness,
    inventory: {
      standalone: { files: reconciled.files, bytes: reconciled.bytes, byProvenance: ctx.ledger.summary() },
      ...sources.roots,
      excludedByPattern: reconciled.excludedByPattern + sources.excludedByPattern,
    },
  };
}

/**
 * CLI wrapper used by desktop/build.mjs: prints the redacted refusal (or a
 * path-free summary of an unexpected failure) and returns an exit code.
 */
export function runPrepareDesktopPayload(options) {
  try {
    const summary = prepareDesktopPayload({ log: (line) => console.log(line), ...options });
    return { code: 0, summary };
  } catch (err) {
    if (err instanceof TraceBoundaryError) {
      console.error(err.message);
    } else {
      const code = err && typeof err.code === "string" ? ` (${err.code})` : "";
      console.error(`Desktop payload preparation failed: ${err?.name ?? "Error"}${code}. Details are withheld because they may contain local paths.`);
    }
    return { code: 1 };
  }
}

export { DEFAULT_LIMITS };
