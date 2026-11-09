/**
 * Container path mapping helper for container sandboxes (AW.6 groundwork).
 *
 * Fixed mount layout:
 * - run worktree -> /workspace (read-write)
 * - per-run grant dir -> /run/grant (read-only)
 * - Codex run dir (<grantDir>/codex/<role>-r<round>) -> /run/codex (read-write)
 */
import { posix, win32 } from "node:path";

export type ContainerMounts = {
  worktree: string;
  grantDir: string;
  codexRunDir?: string;
};

const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_GRANT = "/run/grant";
const CONTAINER_CODEX = "/run/codex";

function hasDotDot(p: string): boolean {
  const segments = p.split(/[/\\]/);
  return segments.some((s) => s === "..");
}

function isAbsoluteHost(p: string, platform: NodeJS.Platform): boolean {
  if (typeof p !== "string" || p.trim() === "") return false;
  if (platform === "win32") {
    return /^[A-Za-z]:[/\\]/.test(p);
  }
  return posix.isAbsolute(p);
}

function normalizeHost(p: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    let norm = win32.normalize(p.replace(/\//g, "\\"));
    const parsed = win32.parse(norm);
    if (norm.length > parsed.root.length && norm.endsWith("\\")) {
      norm = norm.slice(0, -1);
    }
    return norm;
  }
  let norm = posix.normalize(p);
  if (norm.length > 1 && norm.endsWith("/")) {
    norm = norm.slice(0, -1);
  }
  return norm;
}

function getHostRelativePath(
  mountHostPath: string,
  candidateHostPath: string,
  platform: NodeJS.Platform,
): { isInside: boolean; rel: string } {
  if (!isAbsoluteHost(mountHostPath, platform)) {
    return { isInside: false, rel: "" };
  }
  if (hasDotDot(mountHostPath)) {
    return { isInside: false, rel: "" };
  }

  const normMount = normalizeHost(mountHostPath, platform);
  const normCandidate = normalizeHost(candidateHostPath, platform);

  if (platform === "win32") {
    const mountLower = normMount.toLowerCase();
    const candidateLower = normCandidate.toLowerCase();

    if (candidateLower === mountLower) {
      return { isInside: true, rel: "" };
    }

    const sep = "\\";
    const prefix = mountLower.endsWith(sep) ? mountLower : mountLower + sep;
    if (candidateLower.startsWith(prefix)) {
      const relWin = normCandidate.slice(prefix.length);
      const relPosix = relWin.replace(/\\/g, "/");
      return { isInside: true, rel: relPosix };
    }
    return { isInside: false, rel: "" };
  } else {
    if (normCandidate === normMount) {
      return { isInside: true, rel: "" };
    }

    const sep = "/";
    const prefix = normMount.endsWith(sep) ? normMount : normMount + sep;
    if (normCandidate.startsWith(prefix)) {
      const relPosix = normCandidate.slice(prefix.length);
      return { isInside: true, rel: relPosix };
    }
    return { isInside: false, rel: "" };
  }
}

export function toContainerPath(
  mounts: ContainerMounts,
  hostPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof hostPath !== "string" || hostPath.trim() === "") {
    throw new Error("path outside container mounts");
  }
  if (hasDotDot(hostPath)) {
    throw new Error("path outside container mounts");
  }
  if (!isAbsoluteHost(hostPath, platform)) {
    throw new Error("path outside container mounts");
  }

  const mountCandidates: Array<{ containerBase: string; hostBase: string }> = [
    { containerBase: CONTAINER_WORKSPACE, hostBase: mounts.worktree },
    { containerBase: CONTAINER_GRANT, hostBase: mounts.grantDir },
  ];
  if (mounts.codexRunDir) {
    mountCandidates.push({ containerBase: CONTAINER_CODEX, hostBase: mounts.codexRunDir });
  }

  const matches: Array<{
    containerBase: string;
    hostBase: string;
    normMountLength: number;
    rel: string;
  }> = [];

  for (const candidate of mountCandidates) {
    const check = getHostRelativePath(candidate.hostBase, hostPath, platform);
    if (check.isInside) {
      const normMount = normalizeHost(candidate.hostBase, platform);
      matches.push({
        containerBase: candidate.containerBase,
        hostBase: candidate.hostBase,
        normMountLength: normMount.length,
        rel: check.rel,
      });
    }
  }

  if (matches.length === 0) {
    throw new Error("path outside container mounts");
  }

  matches.sort((a, b) => b.normMountLength - a.normMountLength);
  const winner = matches[0];
  if (!winner) {
    throw new Error("path outside container mounts");
  }

  if (winner.rel === "") {
    return winner.containerBase;
  }
  return posix.join(winner.containerBase, winner.rel);
}

export function toHostPath(
  mounts: ContainerMounts,
  containerPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof containerPath !== "string" || containerPath.trim() === "") {
    throw new Error("path outside container mounts");
  }
  if (hasDotDot(containerPath)) {
    throw new Error("path outside container mounts");
  }
  if (!posix.isAbsolute(containerPath)) {
    throw new Error("path outside container mounts");
  }

  const norm = posix.normalize(containerPath);
  const clean = norm.length > 1 && norm.endsWith("/") ? norm.slice(0, -1) : norm;

  let hostBase: string | undefined;
  let rel = "";

  if (clean === CONTAINER_WORKSPACE || clean.startsWith(CONTAINER_WORKSPACE + "/")) {
    hostBase = mounts.worktree;
    rel = clean === CONTAINER_WORKSPACE ? "" : clean.slice((CONTAINER_WORKSPACE + "/").length);
  } else if (clean === CONTAINER_GRANT || clean.startsWith(CONTAINER_GRANT + "/")) {
    hostBase = mounts.grantDir;
    rel = clean === CONTAINER_GRANT ? "" : clean.slice((CONTAINER_GRANT + "/").length);
  } else if (clean === CONTAINER_CODEX || clean.startsWith(CONTAINER_CODEX + "/")) {
    if (!mounts.codexRunDir) {
      throw new Error("path outside container mounts");
    }
    hostBase = mounts.codexRunDir;
    rel = clean === CONTAINER_CODEX ? "" : clean.slice((CONTAINER_CODEX + "/").length);
  } else {
    throw new Error("path outside container mounts");
  }

  if (typeof hostBase !== "string" || !isAbsoluteHost(hostBase, platform) || hasDotDot(hostBase)) {
    throw new Error("path outside container mounts");
  }

  if (rel === "") {
    return normalizeHost(hostBase, platform);
  }

  const relSegments = rel.split("/").filter(Boolean);
  if (platform === "win32") {
    return win32.join(hostBase, ...relSegments);
  } else {
    return posix.join(hostBase, ...relSegments);
  }
}
