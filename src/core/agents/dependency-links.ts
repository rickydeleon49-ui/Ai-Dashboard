/**
 * Dependency folders linked into run worktrees (AW4-14, design §10A row 6).
 *
 * A project policy may list folder names such as `node_modules` or `.venv`.
 * Each run links those folders from the user's project into the run's
 * worktree so checks can run without a fresh install. Only top-level folders
 * that Git ignores are linked, so a commit never includes them.
 *
 * Removal safety: every worktree removal first calls unlinkDependencies(),
 * which deletes only the link itself and never follows it into the project.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { execGit } from "./workspace";

export interface LinkDependenciesOptions {
  /** The user's project folder (the source of the links). */
  projectPath: string;
  worktreePath: string;
  names: readonly string[];
}

export interface LinkDependenciesResult {
  linked: string[];
  skipped: { name: string; reason: string }[];
}

/** A single path segment: no separators, not `.` or `..`, no NUL. */
export function isSingleSegmentName(name: unknown): name is string {
  if (typeof name !== "string" || name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  return true;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Removes only the link entry itself; neither call follows it into the target. */
function removeLinkEntry(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EISDIR" || code === "EACCES") fs.rmdirSync(p);
    else throw err;
  }
}

async function isIgnoredByGit(worktreePath: string, name: string): Promise<boolean> {
  try {
    await execGit(["check-ignore", "-q", "--", name], { cwd: worktreePath });
    return true;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 1) return false;
    throw err;
  }
}

export async function linkDependencies(options: LinkDependenciesOptions): Promise<LinkDependenciesResult> {
  const { projectPath, worktreePath, names } = options;
  const result: LinkDependenciesResult = { linked: [], skipped: [] };
  const seen = new Set<string>();
  for (const name of names) {
    const skip = (reason: string) => result.skipped.push({ name: String(name), reason });
    try {
      if (!isSingleSegmentName(name)) {
        skip("not a single folder name");
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      const source = nodePath.join(projectPath, name);
      const target = nodePath.join(worktreePath, name);
      const srcStat = lstatOrNull(source);
      if (!srcStat) {
        skip("not found in the project");
        continue;
      }
      if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
        skip("not a real folder in the project");
        continue;
      }
      if (lstatOrNull(target)) {
        skip("already exists in the worktree");
        continue;
      }
      fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
      // Checked after linking: a symlink is not matched by a `name/` pattern on every platform.
      let ignored = false;
      try {
        ignored = await isIgnoredByGit(worktreePath, name);
      } catch {
        ignored = false;
      }
      if (!ignored) {
        removeLinkEntry(target);
        skip(
          process.platform === "win32"
            ? "not ignored by Git, so a commit would include it"
            : `not ignored by Git, so a commit would include it (a "${name}/" rule does not match a link; list it as "${name}" without the slash)`,
        );
        continue;
      }
      result.linked.push(name);
    } catch (err) {
      skip(err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}

/**
 * Removes every top-level symlink or junction of the worktree and returns the
 * names removed. Throws when a link cannot be removed, so the caller refuses
 * the worktree removal instead of deleting through it.
 */
export function unlinkDependencies(worktreePath: string): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(worktreePath);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const p = nodePath.join(worktreePath, entry);
    const st = lstatOrNull(p);
    if (!st || !st.isSymbolicLink()) continue;
    removeLinkEntry(p);
    removed.push(entry);
  }
  return removed;
}
