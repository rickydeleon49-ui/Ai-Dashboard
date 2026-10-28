/**
 * Desktop trace / payload packaging boundary.
 *
 * The Next webpack build's file tracer can pull arbitrary runtime filesystem
 * roots into a route's `.nft.json` manifest. When the project and the user
 * profile live on different drives, those entries become malformed cross-drive
 * paths (`../../../../../C:/Users/.../...`) that are both a privacy leak (a
 * machine-specific filename inventory ships inside the installer) and a
 * packaging hazard. This module holds the primitives of the fail-closed
 * boundary: it decides what may remain in a trace manifest or the standalone
 * payload, and refuses the package when anything else is present or when the
 * inspection itself could not be completed. desktop/package-payload.mjs builds
 * the source-to-destination provenance check on top of these.
 *
 * Design rules:
 *  - ALLOWLIST, not denylist. A path is permitted only when it canonically
 *    resides within a justified root (the project, its dependencies, the
 *    standalone bundle, declared shared assets). Machine directory *names*
 *    (AppData, System32, WindowsApps) are never used to reject: a legitimate
 *    checkout or dependency may live under one.
 *  - CANONICAL containment is authoritative. Symlinks and junctions are
 *    resolved; a path whose real location is outside every allowed root is
 *    refused even when its lexical spelling is inside the project. A missing
 *    path is judged by the real location of its nearest existing ancestor, so a
 *    nonexistent child of an escaping junction is outside too. A path that
 *    cannot be resolved for any other reason is a failure, never a pass.
 *  - FAIL CLOSED. Enumeration, stat, read or parse failures, malformed
 *    manifests, missing expected outputs and invalid limits are violations. A
 *    scan that could not complete is never reported as a clean scan.
 *  - BOUNDED. Sizes are checked before reading, and counts/work are checked
 *    during traversal rather than afterwards.
 *  - Malformed embedded drives are detected explicitly: a drive letter appearing
 *    anywhere but position 0 is a cross-drive join artefact, never a real file.
 *  - Redacted diagnostics. Violations are reported as aggregate counts, coarse
 *    categories, error codes and SHA-256 path prefixes — never as private paths,
 *    file contents or the text of an underlying exception.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A drive letter that is not at position 0 — the cross-drive join artefact. */
const EMBEDDED_DRIVE_RE = /[\\/][A-Za-z]:([\\/]|$)/;

/**
 * True when a path contains a drive letter embedded after its start, e.g.
 * `H:\proj\C:\Users\...` or `../../../C:/Users/...`. These are produced by
 * `path.join(tracingRoot, absoluteCrossDrivePath)` and can never name a real
 * file. A legitimate Windows path has at most one drive letter, at position 0.
 */
export function hasEmbeddedDrive(p) {
  const s = String(p);
  // Drop one legitimate leading drive, then look for another.
  const withoutLeading = s.replace(/^[A-Za-z]:[\\/]/, "");
  return EMBEDDED_DRIVE_RE.test(withoutLeading);
}

/** Absolute, separator-normalised, case-folded on Windows. No symlink resolution. */
export function normalizeForCompare(p) {
  let n = path.resolve(String(p));
  if (process.platform === "win32") n = n.toLowerCase();
  return n;
}

/** Short, stable, non-reversible identifier for a path, for redacted reports. */
export function hashPath(p) {
  return crypto.createHash("sha256").update(String(p)).digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------------ */
/* Limits                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Work and size bounds. Every value must be a finite positive integer; there
 * is no "0 disables the check".
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** Bytes of one trace manifest; checked before the file is read. */
  maxManifestBytes: 32 * 1024 * 1024,
  maxManifestEntriesPerFile: 100_000,
  maxTotalManifestEntries: 400_000,
  maxManifests: 20_000,
  /** Regular files in the payload / package inventory. */
  maxFiles: 200_000,
  maxBytes: 3 * 1024 * 1024 * 1024,
  /** Bytes of any single payload file; checked before it is hashed or copied. */
  maxFileBytes: 1024 * 1024 * 1024,
  maxDepth: 64,
  /** Directory entries visited by one traversal. */
  maxWalkEntries: 2_000_000,
});

/** Environment overrides understood by the desktop build. */
export const LIMIT_ENV = Object.freeze({
  maxManifestBytes: "TRACE_BOUNDARY_MAX_MANIFEST_BYTES",
  maxManifestEntriesPerFile: "TRACE_BOUNDARY_MAX_MANIFEST_ENTRIES_PER_FILE",
  maxTotalManifestEntries: "TRACE_BOUNDARY_MAX_TOTAL_MANIFEST_ENTRIES",
  maxFiles: "TRACE_BOUNDARY_MAX_PAYLOAD_FILES",
  maxBytes: "TRACE_BOUNDARY_MAX_PAYLOAD_BYTES",
  maxFileBytes: "TRACE_BOUNDARY_MAX_FILE_BYTES",
});

/**
 * Merge overrides into the defaults, refusing anything that is not a finite
 * positive safe integer. Unknown keys are refused too, so a typo cannot
 * silently leave a bound at its default.
 */
export function validateLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  const bad = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, key)) {
      bad.push({ kind: "invalid-limit", category: "unknown-limit" });
    } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      bad.push({ kind: "invalid-limit", category: key });
    } else {
      limits[key] = value;
    }
  }
  if (bad.length > 0) throw new TraceBoundaryError(bad);
  return Object.freeze(limits);
}

/** Read limit overrides from the environment; invalid text is refused, not ignored. */
export function limitsFromEnv(env = process.env) {
  const overrides = {};
  for (const [key, name] of Object.entries(LIMIT_ENV)) {
    const raw = env[name];
    if (raw === undefined) continue;
    const text = String(raw).trim();
    overrides[key] = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  }
  return validateLimits(overrides);
}

/* ------------------------------------------------------------------------ */
/* Canonical resolution (S1)                                                */
/* ------------------------------------------------------------------------ */

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Where a path really is.
 *
 *  - `{ status: "ok", path }`      it exists; `path` is its real location.
 *  - `{ status: "missing", path }` it does not exist; `path` is the real
 *    location of its nearest existing ancestor joined with the missing tail, so
 *    a missing child of an escaping junction resolves outside as well.
 *  - `{ status: "error", code }`   it could not be resolved (permission, loop,
 *    dangling link, invalid name...). Callers must treat this as a failure.
 */
export function resolveCanonical(p) {
  const abs = path.resolve(String(p));
  const tail = [];
  let current = abs;
  for (let guard = 0; guard < 4096; guard += 1) {
    try {
      const real = fs.realpathSync.native(current);
      if (tail.length === 0) return { status: "ok", path: real };
      return { status: "missing", path: path.join(real, ...tail.reverse()) };
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "EUNKNOWN";
      if (!MISSING_CODES.has(code)) return { status: "error", code };
      // The entry itself exists but cannot be resolved: a dangling link or
      // junction. Its destination is unknown, so it is not "missing".
      try {
        fs.lstatSync(current);
        return { status: "error", code: "EDANGLING" };
      } catch (lerr) {
        const lcode = lerr && typeof lerr.code === "string" ? lerr.code : "EUNKNOWN";
        if (!MISSING_CODES.has(lcode)) return { status: "error", code: lcode };
      }
      const parent = path.dirname(current);
      if (parent === current) return { status: "error", code };
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return { status: "error", code: "ETOODEEP" };
}

/**
 * Canonical location of a path (existing, or nearest-ancestor for a missing
 * one). Throws a redacted TraceBoundaryError when it cannot be resolved.
 */
export function canonicalize(p) {
  const r = resolveCanonical(p);
  if (r.status === "error") {
    throw new TraceBoundaryError([{ kind: "resolve-failed", category: r.code, hash: hashPath(p) }]);
  }
  return r.path;
}

/**
 * True containment: `candidate` is `root` itself or somewhere inside it.
 * Uses a relative-path test rather than a string prefix, so `repo-evil` is not
 * a child of `repo`. Callers pass canonical paths when symlink awareness is
 * required.
 */
export function isWithin(root, candidate) {
  const r = normalizeForCompare(root);
  const c = normalizeForCompare(candidate);
  if (c === r) return true;
  const rel = path.relative(r, c);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

export function isWithinAny(roots, candidate) {
  for (const r of roots) if (isWithin(r, candidate)) return true;
  return false;
}

/**
 * Coarse, non-sensitive bucket for a path. Never returns the path itself.
 * `home` defaults to the current user's profile directory.
 *
 * Order matters: a malformed embedded drive is never a real file; a path inside
 * the project is "project" even when the project itself lives under the home
 * directory (a common checkout location); only a path under the profile but
 * outside the project is a "user-profile" leak.
 */
export function classifyPath(absPath, { projectRoot, home = os.homedir() } = {}) {
  const s = String(absPath);
  if (hasEmbeddedDrive(s)) return "embedded-drive";
  if (projectRoot && isWithin(projectRoot, s)) return "project";
  if (home && isWithin(home, s)) return "user-profile";
  return "external";
}

/**
 * The justified roots a desktop bundle may draw from, canonicalised so a
 * junctioned/symlinked node_modules compares by where it really is.
 * `extraRoots` declares an intentional external shared root explicitly rather
 * than suppressing the check wholesale. Throws if a root cannot be resolved.
 */
export function resolveAllowedRoots({ projectRoot, standaloneDir, extraRoots = [] }) {
  const roots = [projectRoot, path.join(projectRoot, "node_modules"), standaloneDir, ...extraRoots];
  return roots.map((r) => canonicalize(r));
}

/**
 * Judge one path against the allowed roots by its canonical location only.
 * Returns `{ ok: true, canonical, status }` or `{ ok: false, violation }`.
 */
export function judgeSource(p, { allowedRoots, projectRoot, home, rawForHash }) {
  const hash = hashPath(rawForHash ?? p);
  if (hasEmbeddedDrive(p)) {
    return { ok: false, violation: { kind: "embedded-drive", category: "embedded-drive", hash } };
  }
  const r = resolveCanonical(p);
  if (r.status === "error") {
    return { ok: false, violation: { kind: "resolve-failed", category: r.code, hash } };
  }
  if (!isWithinAny(allowedRoots, r.path)) {
    return { ok: false, violation: { kind: "out-of-boundary", category: classifyPath(r.path, { projectRoot, home }), hash } };
  }
  if (isSecretFileName(p) || isSecretFileName(r.path)) {
    return { ok: false, violation: { kind: "secret-file", category: "env-or-credential-file", hash } };
  }
  return { ok: true, canonical: r.path, status: r.status };
}

/* ------------------------------------------------------------------------ */
/* Secret-file policy                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Files that must never be packaged into the desktop app, whatever their
 * origin. Next's standalone writer copies a loaded `.env` / `.env.production`
 * into the bundle; the desktop runtime receives its configuration from the
 * Electron main process instead, so no environment file belongs in it. The
 * checked-in, dummy-valued `.env.example` is the only exception.
 */
const SECRET_FILE_NAMES = new Set([".env", ".envrc", ".npmrc", ".netrc", ".pgpass"]);
const SECRET_FILE_EXCEPTIONS = new Set([".env.example"]);

export function isSecretFileName(p) {
  const name = path.basename(String(p)).toLowerCase();
  if (SECRET_FILE_EXCEPTIONS.has(name)) return false;
  return SECRET_FILE_NAMES.has(name) || name.startsWith(".env.");
}

/* ------------------------------------------------------------------------ */
/* Violations and the redacted refusal                                      */
/* ------------------------------------------------------------------------ */

/** Bounded violation collector: counts everything, keeps a capped sample. */
export class ViolationSink {
  constructor(cap = 10_000) {
    this.list = [];
    this.total = 0;
    this.byKind = new Map();
    this.byCategory = new Map();
    this.cap = cap;
  }

  add(v) {
    this.total += 1;
    this.byKind.set(v.kind, (this.byKind.get(v.kind) || 0) + 1);
    if (v.category) this.byCategory.set(v.category, (this.byCategory.get(v.category) || 0) + 1);
    if (this.list.length < this.cap) this.list.push(v);
  }

  get size() {
    return this.total;
  }
}

/** A redacted violation for a filesystem failure: operation, code and hash only. */
export function fsViolation(op, p, err) {
  const code = err && typeof err.code === "string" ? err.code : "EUNKNOWN";
  return { kind: "inspect-failed", category: op, code, hash: hashPath(p) };
}

function fmtMap(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
}

/**
 * The refusal raised when the boundary is violated. Its message is actionable
 * but redacted: aggregate counts, coarse categories, error codes and path
 * hashes only.
 */
export class TraceBoundaryError extends Error {
  constructor(violations, info) {
    const sink = violations instanceof ViolationSink ? violations : null;
    const list = sink ? sink.list : violations;
    const byKind = sink ? sink.byKind : new Map();
    const byCategory = sink ? sink.byCategory : new Map();
    if (!sink) {
      for (const v of list) {
        byKind.set(v.kind, (byKind.get(v.kind) || 0) + 1);
        if (v.category) byCategory.set(v.category, (byCategory.get(v.category) || 0) + 1);
      }
    }
    const count = sink ? sink.total : list.length;
    const maxReported = info?.maxReported ?? 8;
    const samples = list
      .slice(0, maxReported)
      .map((v) => `${v.kind}${v.category ? "/" + v.category : ""}${v.code ? "(" + v.code + ")" : ""}${v.hash ? "#" + v.hash : ""}`);
    const t = info?.totals ?? {};
    const msg = [
      `Desktop trace/packaging boundary refused the bundle: ${count} violation(s).`,
      `Scanned -> manifests: ${t.manifests ?? 0}, trace entries: ${t.totalManifestEntries ?? 0}, payload files: ${t.payloadFiles ?? 0}, payload bytes: ${t.payloadBytes ?? 0}, symlinks: ${t.symlinks ?? 0}.`,
      `By kind: ${fmtMap(byKind)}.`,
      `By redacted category: ${fmtMap(byCategory)}.`,
      `Samples (kind/category(code)#sha256-16, no private paths): ${samples.join(", ") || "none"}.`,
      `A desktop bundle may only contain files with a verified origin inside the project, dependency, standalone or declared shared roots, and the inspection must complete. Out-of-boundary or unexplained files, environment/credential files, unreadable or malformed build outputs, or invalid limits were present, so packaging was refused.`,
      `Remediation: find what made the tracer or a copy reach outside the allowed roots (a path built from a runtime directory, an escaping symlink/junction) and fix it at the source; do not widen the allowed roots or disable the check.`,
    ].join("\n");
    super(msg);
    this.name = "TraceBoundaryError";
    this.violations = list;
    this.violationCount = count;
    this.info = info;
  }
}

/* ------------------------------------------------------------------------ */
/* Manifests (S3: complete, validated inspection)                           */
/* ------------------------------------------------------------------------ */

const STOP = Symbol("trace-boundary-stop");

/**
 * Recursively list every `*.nft.json` under `dir`. Links are not followed.
 * Any enumeration failure or bound breach is a violation: by default this
 * throws, or records into `opts.sink` when the caller aggregates.
 * `opts.exclude` lists directories to skip (canonical comparisons).
 */
export function findManifests(dir, opts = {}) {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const ownSink = !opts.sink;
  const sink = opts.sink ?? new ViolationSink();
  const exclude = (opts.exclude ?? []).map((d) => normalizeForCompare(d));
  const out = [];
  let visited = 0;
  const walk = (d, depth) => {
    if (depth > limits.maxDepth) {
      sink.add({ kind: "guardrail-depth", hash: hashPath(d) });
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (err) {
      sink.add(fsViolation("readdir", d, err));
      return;
    }
    for (const e of entries) {
      visited += 1;
      if (visited > limits.maxWalkEntries) {
        sink.add({ kind: "guardrail-walk-entries", count: visited, max: limits.maxWalkEntries });
        throw STOP;
      }
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue; // never follow links while enumerating
      if (e.isDirectory()) {
        if (!exclude.includes(normalizeForCompare(full))) walk(full, depth + 1);
      } else if (e.isFile()) {
        if (e.name.endsWith(".nft.json")) {
          out.push(full);
          if (out.length > limits.maxManifests) {
            sink.add({ kind: "guardrail-manifest-count", count: out.length, max: limits.maxManifests });
            throw STOP;
          }
        }
      } else if (e.name.endsWith(".nft.json")) {
        sink.add({ kind: "manifest-invalid", category: "not-a-regular-file", hash: hashPath(full) });
      }
    }
  };
  try {
    walk(dir, 0);
  } catch (err) {
    if (err !== STOP) throw err;
  }
  if (ownSink && sink.size > 0) throw new TraceBoundaryError(sink);
  return out;
}

/**
 * Read and validate one trace manifest. Returns `{ data, files }` or null
 * after recording why it was refused. The size is checked before reading and
 * the entry count before any entry is evaluated.
 */
export function readManifest(manifestPath, { limits = DEFAULT_LIMITS, sink }) {
  const hash = hashPath(manifestPath);
  let st;
  try {
    st = fs.lstatSync(manifestPath);
  } catch (err) {
    sink.add(fsViolation("stat", manifestPath, err));
    return null;
  }
  if (!st.isFile()) {
    sink.add({ kind: "manifest-invalid", category: "not-a-regular-file", hash });
    return null;
  }
  if (st.size > limits.maxManifestBytes) {
    sink.add({ kind: "guardrail-manifest-bytes", bytes: st.size, max: limits.maxManifestBytes, hash });
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    sink.add(fsViolation("read", manifestPath, err));
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    sink.add({ kind: "manifest-unparseable", hash });
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    sink.add({ kind: "manifest-invalid", category: "not-an-object", hash });
    return null;
  }
  if (data.version !== 1) {
    sink.add({ kind: "manifest-invalid", category: "unsupported-version", hash });
    return null;
  }
  if (!Array.isArray(data.files)) {
    sink.add({ kind: "manifest-invalid", category: "files-not-an-array", hash });
    return null;
  }
  if (data.files.length > limits.maxManifestEntriesPerFile) {
    sink.add({ kind: "guardrail-manifest-entries", count: data.files.length, max: limits.maxManifestEntriesPerFile, hash });
    return null;
  }
  for (const entry of data.files) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 4096 || entry.includes("\0")) {
      sink.add({ kind: "manifest-invalid", category: "entry-not-a-path-string", hash });
      return null;
    }
  }
  return { data, files: data.files };
}

/**
 * Decide whether one manifest entry is allowed. Returns a violation descriptor
 * or null. `manifestDir` is the directory the entry is relative to. Only the
 * canonical location counts: a lexical match never overrides a proven escape.
 */
export function evaluateManifestEntry(entry, manifestDir, { allowedRoots, projectRoot, home }) {
  const raw = String(entry);
  const resolved = path.resolve(manifestDir, raw);
  if (hasEmbeddedDrive(raw) || hasEmbeddedDrive(resolved)) {
    return { kind: "embedded-drive", category: "embedded-drive", hash: hashPath(raw) };
  }
  const judged = judgeSource(resolved, { allowedRoots, projectRoot, home, rawForHash: raw });
  return judged.ok ? null : judged.violation;
}

/** Scan one manifest; returns `{ total, violations[] }`. Invalid manifests are violations. */
export function scanManifest(manifestPath, opts) {
  const sink = new ViolationSink();
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const m = readManifest(manifestPath, { limits, sink });
  if (!m) return { manifestPath, total: 0, violations: sink.list };
  const manifestDir = path.dirname(manifestPath);
  for (const entry of m.files) {
    const v = evaluateManifestEntry(entry, manifestDir, opts);
    if (v) sink.add(v);
  }
  return { manifestPath, total: m.files.length, violations: sink.list };
}

/**
 * Rewrite every manifest under `nextDir`, dropping out-of-boundary entries and
 * keeping all legitimate traced dependencies. This only removes *metadata*: it
 * is not evidence that a refused source was never copied, which the provenance
 * check in package-payload.mjs establishes before this runs. A manifest that
 * cannot be read or validated is a refusal, not something to skip.
 * Returns aggregate, redacted counts plus the rewritten paths (for the
 * provenance ledger).
 */
export function sanitizeManifests(nextDir, opts) {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const sink = new ViolationSink();
  const manifests = findManifests(nextDir, { limits, sink, exclude: opts.exclude });
  const parsed = [];
  let totalEntries = 0;
  for (const m of manifests) {
    const r = readManifest(m, { limits, sink });
    if (!r) continue;
    totalEntries += r.files.length;
    if (totalEntries > limits.maxTotalManifestEntries) {
      sink.add({ kind: "guardrail-total-manifest-entries", count: totalEntries, max: limits.maxTotalManifestEntries });
      break;
    }
    parsed.push([m, r.data]);
  }
  if (sink.size > 0) throw new TraceBoundaryError(sink);

  const removedCategories = new Map();
  const rewrittenPaths = [];
  let scanned = 0;
  let removed = 0;
  for (const [m, data] of parsed) {
    const manifestDir = path.dirname(m);
    const kept = [];
    for (const entry of data.files) {
      scanned += 1;
      const v = evaluateManifestEntry(entry, manifestDir, opts);
      if (v) {
        removed += 1;
        removedCategories.set(v.category, (removedCategories.get(v.category) || 0) + 1);
      } else {
        kept.push(entry);
      }
    }
    if (kept.length !== data.files.length) {
      data.files = kept;
      try {
        fs.writeFileSync(m, JSON.stringify(data));
      } catch (err) {
        throw new TraceBoundaryError([fsViolation("write", m, err)]);
      }
      rewrittenPaths.push(m);
    }
  }
  return {
    manifests: manifests.length,
    scanned,
    removed,
    kept: scanned - removed,
    rewritten: rewrittenPaths.length,
    rewrittenPaths,
    removedCategories: Object.fromEntries(removedCategories),
  };
}

/* ------------------------------------------------------------------------ */
/* Payload scan                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Walk the standalone payload without following links. Flags symlinks whose
 * real target escapes the allowed roots, dangling or unresolvable links,
 * malformed embedded-drive names, environment/credential files, files whose
 * canonical location escapes the payload, unsupported entry types and every
 * enumeration or stat failure. Count and byte bounds are enforced during the
 * walk.
 */
export function scanPayload(standaloneDir, opts) {
  const { allowedRoots, projectRoot, home } = opts;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const sink = opts.sink ?? new ViolationSink();
  const violationsBefore = sink.list.length;
  const rootResolved = resolveCanonical(standaloneDir);
  let fileCount = 0;
  let totalBytes = 0;
  let symlinkCount = 0;
  let visited = 0;

  if (rootResolved.status !== "ok") {
    sink.add({ kind: "expected-output-missing", category: "standalone-dir" });
    return { fileCount, totalBytes, symlinkCount, violations: sink.list.slice(violationsBefore) };
  }
  const canonRoot = rootResolved.path;

  const walk = (dir, depth) => {
    if (depth > limits.maxDepth) {
      sink.add({ kind: "guardrail-depth", hash: hashPath(dir) });
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      sink.add(fsViolation("readdir", dir, err));
      return;
    }
    for (const e of entries) {
      visited += 1;
      if (visited > limits.maxWalkEntries) {
        sink.add({ kind: "guardrail-walk-entries", count: visited, max: limits.maxWalkEntries });
        throw STOP;
      }
      const full = path.join(dir, e.name);
      if (hasEmbeddedDrive(full)) {
        sink.add({ kind: "embedded-drive", category: "embedded-drive", hash: hashPath(full) });
        continue;
      }
      let lst;
      try {
        lst = fs.lstatSync(full);
      } catch (err) {
        sink.add(fsViolation("lstat", full, err));
        continue;
      }
      if (isSecretFileName(full) && !lst.isDirectory()) {
        sink.add({ kind: "secret-file", category: "env-or-credential-file", hash: hashPath(full) });
      }
      if (lst.isSymbolicLink()) {
        symlinkCount += 1;
        const r = resolveCanonical(full);
        if (r.status === "error" && r.code === "EDANGLING") {
          // Nothing escapes through it, but it should not ship either.
          sink.add({ kind: "symlink-dangling", category: "external", hash: hashPath(full) });
        } else if (r.status !== "ok") {
          sink.add({ kind: "resolve-failed", category: r.code ?? "missing", hash: hashPath(full) });
        } else if (!isWithin(canonRoot, r.path) && !isWithinAny(allowedRoots, r.path)) {
          sink.add({ kind: "symlink-escape", category: classifyPath(r.path, { projectRoot, home }), hash: hashPath(full) });
        }
        continue; // never follow the link; its target has been judged
      }
      if (lst.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!lst.isFile()) {
        sink.add({ kind: "unsupported-entry-type", hash: hashPath(full) });
        continue;
      }
      fileCount += 1;
      totalBytes += lst.size;
      if (fileCount > limits.maxFiles) {
        sink.add({ kind: "guardrail-file-count", count: fileCount, max: limits.maxFiles });
        throw STOP;
      }
      if (totalBytes > limits.maxBytes) {
        sink.add({ kind: "guardrail-bytes", bytes: totalBytes, max: limits.maxBytes });
        throw STOP;
      }
      const r = resolveCanonical(full);
      if (r.status !== "ok") {
        sink.add({ kind: "resolve-failed", category: r.code ?? "missing", hash: hashPath(full) });
      } else if (!isWithin(canonRoot, r.path)) {
        sink.add({ kind: "payload-out-of-boundary", category: classifyPath(r.path, { projectRoot, home }), hash: hashPath(full) });
      }
    }
  };
  try {
    walk(standaloneDir, 0);
  } catch (err) {
    if (err !== STOP) throw err;
  }
  return { fileCount, totalBytes, symlinkCount, violations: sink.list.slice(violationsBefore) };
}

/**
 * Fail closed on a single escaping (or unresolvable) symlink target.
 */
export function assertSymlinkTargetWithin(target, standaloneDir, allowedRoots, meta = {}) {
  const r = resolveCanonical(target);
  const totals = { manifests: 0, totalManifestEntries: 0, payloadFiles: 0, payloadBytes: 0, symlinks: 1 };
  if (r.status === "error") {
    throw new TraceBoundaryError([{ kind: "resolve-failed", category: r.code, hash: hashPath(target) }], { maxReported: 4, totals });
  }
  const canonStandalone = resolveCanonical(standaloneDir);
  const inStandalone = canonStandalone.status !== "error" && isWithin(canonStandalone.path, r.path);
  if (inStandalone || isWithinAny(allowedRoots, r.path)) return;
  throw new TraceBoundaryError(
    [{ kind: "symlink-escape", category: classifyPath(r.path, meta), hash: hashPath(target) }],
    { maxReported: 4, totals },
  );
}

/* ------------------------------------------------------------------------ */
/* The gate                                                                 */
/* ------------------------------------------------------------------------ */

function requireDirectory(p, category, sink) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if (err && MISSING_CODES.has(err.code)) sink.add({ kind: "expected-output-missing", category });
    else sink.add(fsViolation("lstat", p, err));
    return false;
  }
  if (!st.isDirectory()) {
    sink.add({ kind: "expected-output-missing", category: `${category}-not-a-directory` });
    return false;
  }
  return true;
}

/**
 * The gate. Requires the expected outputs to exist, scans every trace
 * manifest under `nextDir` and the standalone payload, and throws
 * `TraceBoundaryError` if anything is out of boundary or could not be
 * inspected. Returns a privacy-safe summary on success.
 */
export function assertTraceBoundary(opts) {
  const {
    projectRoot,
    standaloneDir,
    nextDir,
    allowedRoots,
    home = os.homedir(),
    maxReported = 8,
    requiredFiles = ["server.js"],
  } = opts;
  const limits = opts.limits ?? validateLimits({
    maxManifestEntriesPerFile: opts.maxManifestEntriesPerFile,
    maxTotalManifestEntries: opts.maxTotalManifestEntries,
    maxFiles: opts.maxFiles,
    maxBytes: opts.maxBytes,
  });

  const sink = new ViolationSink();
  const haveNext = requireDirectory(nextDir, "next-dir", sink);
  const haveStandalone = requireDirectory(standaloneDir, "standalone-dir", sink);
  if (haveStandalone) {
    for (const rel of requiredFiles) {
      try {
        if (!fs.lstatSync(path.join(standaloneDir, rel)).isFile()) {
          sink.add({ kind: "expected-output-missing", category: "required-file", hash: hashPath(rel) });
        }
      } catch {
        sink.add({ kind: "expected-output-missing", category: "required-file", hash: hashPath(rel) });
      }
    }
  }

  let manifests = [];
  let totalManifestEntries = 0;
  if (haveNext) {
    manifests = findManifests(nextDir, { limits, sink });
    for (const m of manifests) {
      const r = readManifest(m, { limits, sink });
      if (!r) continue;
      totalManifestEntries += r.files.length;
      if (totalManifestEntries > limits.maxTotalManifestEntries) {
        sink.add({ kind: "guardrail-total-manifest-entries", count: totalManifestEntries, max: limits.maxTotalManifestEntries });
        break;
      }
      const manifestDir = path.dirname(m);
      for (const entry of r.files) {
        const v = evaluateManifestEntry(entry, manifestDir, { allowedRoots, projectRoot, home });
        if (v) sink.add(v);
      }
    }
  }

  let payload = { fileCount: 0, totalBytes: 0, symlinkCount: 0 };
  if (haveStandalone) {
    payload = scanPayload(standaloneDir, { allowedRoots, projectRoot, home, limits, sink });
  }

  const totals = {
    manifests: manifests.length,
    totalManifestEntries,
    payloadFiles: payload.fileCount,
    payloadBytes: payload.totalBytes,
    symlinks: payload.symlinkCount,
  };

  if (sink.size > 0) throw new TraceBoundaryError(sink, { maxReported, totals });
  return { ok: true, ...totals };
}
