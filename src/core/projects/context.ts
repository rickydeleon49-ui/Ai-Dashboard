import "server-only";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "./types";

/**
 * What the AI workspace is allowed to know about a project before anyone types
 * anything.
 *
 * Metadata only — name, kind, status, tags, where it lives and which branch is
 * checked out. Never file contents: sending a repository to a model because a
 * project happened to be selected is a decision the user has to make per file,
 * not a side effect of opening a page.
 */

export interface GitInfo {
  /** Whether the folder is a git working tree. */
  isRepository: boolean;
  /** Current branch, or null when detached or unreadable. */
  branch: string | null;
  /** Short commit id when the head is detached rather than on a branch. */
  detachedAt: string | null;
}

export interface ProjectContext {
  id: string;
  name: string;
  type: string;
  status: string;
  description: string | null;
  tags: string[];
  /** Absolute local path, when one is set. */
  localPath: string | null;
  /** Whether that path exists right now. */
  localPathExists: boolean;
  repositoryUrl: string | null;
  git: GitInfo;
}

/**
 * The current user's home directory, read at run time.
 *
 * Deliberately behind a function rather than inlined into `path.join`: the
 * build's file tracer evaluates `os.homedir()` statically, and joined with a
 * user-supplied suffix it becomes a wildcard over the entire profile of the
 * machine doing the build. That put a filename inventory of the builder's home
 * directory into the AI routes' trace manifests (see desktop/trace-boundary.mjs).
 * The tracer does not evaluate calls to local functions.
 */
function homeDirectory(): string {
  return os.homedir();
}

/** Expands a leading `~` and makes the path absolute. */
export function resolveLocalPath(localPath: string): string {
  const expanded = localPath.startsWith("~")
    ? path.join(homeDirectory(), localPath.slice(1))
    : localPath;
  return path.resolve(expanded);
}

/**
 * Reads the checked-out branch by reading `.git/HEAD`.
 *
 * Not by running `git`: spawning a process per page render is slow, needs git
 * on PATH, and puts a user-supplied directory next to a command line. `HEAD` is
 * a one-line file with a stable format, and reading it costs nothing.
 *
 * Handles the `.git`-as-a-file case (worktrees and submodules point at their
 * real git directory with a `gitdir:` line) because a linked worktree is
 * exactly where someone doing parallel work would be.
 */
export function readGitInfo(directory: string): GitInfo {
  const absent: GitInfo = { isRepository: false, branch: null, detachedAt: null };

  let gitDir = path.join(directory, ".git");
  try {
    const stats = fs.statSync(/*turbopackIgnore: true*/ gitDir);
    if (stats.isFile()) {
      const pointer = fs.readFileSync(/*turbopackIgnore: true*/ gitDir, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      const pointed = match?.[1];
      if (!pointed) return absent;
      gitDir = path.isAbsolute(pointed) ? pointed : path.resolve(directory, pointed);
    } else if (!stats.isDirectory()) {
      return absent;
    }
  } catch {
    return absent;
  }

  let head: string;
  try {
    head = fs.readFileSync(/*turbopackIgnore: true*/ path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    // A .git that exists but has no readable HEAD is still a repository — just
    // one we cannot name a branch for.
    return { isRepository: true, branch: null, detachedAt: null };
  }

  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (branch) return { isRepository: true, branch, detachedAt: null };

  if (/^[0-9a-f]{7,40}$/i.test(head)) {
    return { isRepository: true, branch: null, detachedAt: head.slice(0, 7) };
  }

  return { isRepository: true, branch: null, detachedAt: null };
}

export function buildProjectContext(project: Project): ProjectContext {
  const resolved = project.localPath ? resolveLocalPath(project.localPath) : null;
  const exists = resolved ? fs.existsSync(/*turbopackIgnore: true*/ resolved) : false;

  return {
    id: project.id,
    name: project.name,
    type: project.type,
    status: project.status,
    description: project.description,
    tags: project.tags,
    localPath: resolved,
    localPathExists: exists,
    repositoryUrl: project.repositoryUrl,
    git: exists && resolved ? readGitInfo(resolved) : {
      isRepository: false,
      branch: null,
      detachedAt: null,
    },
  };
}

/**
 * The system message describing the active project.
 *
 * Short and factual. A long preamble spends context the user wanted for their
 * own material, and a model told nothing but the truth about a project is more
 * useful than one told a story about it.
 */
export function projectSystemPrompt(
  context: ProjectContext,
  options: { attachedFiles?: number } = {},
): string {
  const lines = [
    "You are the local assistant inside Command Center, the user's project dashboard.",
    "",
    `The user is working on the project "${context.name}".`,
    `Kind: ${context.type}. Status: ${context.status}.`,
  ];

  if (context.description) lines.push(`Description: ${context.description}`);
  if (context.tags.length > 0) lines.push(`Tags: ${context.tags.join(", ")}`);
  if (context.localPath) {
    lines.push(
      context.localPathExists
        ? `Local folder: ${context.localPath}`
        : `Local folder (currently missing): ${context.localPath}`,
    );
  }
  if (context.repositoryUrl) lines.push(`Repository: ${context.repositoryUrl}`);
  if (context.git.isRepository) {
    lines.push(
      context.git.branch
        ? `Checked-out branch: ${context.git.branch}`
        : context.git.detachedAt
          ? `Detached head at ${context.git.detachedAt}`
          : "The folder is a git repository.",
    );
  }

  const attached = options.attachedFiles ?? 0;
  lines.push(
    "",
    attached > 0
      ? `You have been given the contents of ${attached} file${attached === 1 ? "" : "s"} the user attached to this message, and nothing else from the project. If you need to see more, ask them to attach it.`
      : "You have not been given the contents of any file. If you need to see code, ask the user to attach the specific files.",
  );

  return lines.join("\n");
}
