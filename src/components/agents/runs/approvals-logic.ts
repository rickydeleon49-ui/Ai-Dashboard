export const APPROVAL_KINDS = [
  "merge",
  "push",
  "draft_pr",
  "apply_back",
  "delete_worktree",
] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "done"
  | "failed";

export interface Approval {
  id: string;
  runId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  preview: Record<string, unknown>;
  target: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  requestedAt: string;
  decidedAt: string | null;
  executedAt: string | null;
}

export const KIND_LABELS: Record<ApprovalKind, string> = {
  merge: "Merge into a branch",
  push: "Push branch",
  draft_pr: "Open draft pull request",
  apply_back: "Copy results back to your folder",
  delete_worktree: "Delete worktree",
};

export const STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "Waiting for your approval",
  approved: "Approved, queued",
  rejected: "Rejected",
  executing: "Running",
  done: "Done",
  failed: "Failed",
};

export function isOpen(status: ApprovalStatus): boolean {
  return status === "pending" || status === "approved" || status === "executing";
}

export function sortNewestFirst(list: readonly Approval[]): Approval[] {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a.requestedAt);
    const tb = Date.parse(b.requestedAt);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) {
      if (tb !== ta) return tb - ta;
    }
    return b.requestedAt.localeCompare(a.requestedAt);
  });
}

export type BuildTargetResult =
  | { target: Record<string, string> }
  | { error: string };

export function buildTarget(
  kind: ApprovalKind,
  fields: Record<string, string>,
): BuildTargetResult {
  switch (kind) {
    case "merge": {
      const targetBranch = fields["targetBranch"]?.trim() ?? "";
      if (!targetBranch) {
        return { error: "Enter the branch to merge into" };
      }
      return { target: { targetBranch } };
    }
    case "push": {
      const target: Record<string, string> = {};
      const remote = fields["remote"]?.trim() ?? "";
      if (remote) {
        target["remote"] = remote;
      }
      return { target };
    }
    case "draft_pr": {
      const base = fields["base"]?.trim() ?? "";
      if (!base) {
        return { error: "Enter the base branch" };
      }
      const target: Record<string, string> = { base };
      const remote = fields["remote"]?.trim() ?? "";
      if (remote) {
        target["remote"] = remote;
      }
      const title = fields["title"]?.trim() ?? "";
      if (title) {
        target["title"] = title;
      }
      return { target };
    }
    case "apply_back": {
      return { target: {} };
    }
    case "delete_worktree": {
      return { target: {} };
    }
    default: {
      return { target: {} };
    }
  }
}

export function previewLines(
  approval: Pick<Approval, "kind"> & { preview?: Record<string, unknown> | null },
): string[] {
  const p = approval.preview && typeof approval.preview === "object" ? approval.preview : {};
  const lines: string[] = [];

  switch (approval.kind) {
    case "merge": {
      const commitsAhead =
        typeof p["commitsAhead"] === "number"
          ? p["commitsAhead"]
          : Array.isArray(p["commits"])
            ? p["commits"].length
            : undefined;
      const runBranch =
        typeof p["runBranch"] === "string" && p["runBranch"].length > 0
          ? p["runBranch"]
          : undefined;
      const targetBranch =
        typeof p["targetBranch"] === "string" && p["targetBranch"].length > 0
          ? p["targetBranch"]
          : undefined;

      if (commitsAhead !== undefined || runBranch !== undefined || targetBranch !== undefined) {
        const countStr =
          commitsAhead !== undefined
            ? `${commitsAhead} commit${commitsAhead === 1 ? "" : "s"}`
            : "? commits";
        lines.push(`${countStr} from ${runBranch ?? "?"} into ${targetBranch ?? "?"}`);
      }

      if (p["conflicts"] === false) {
        lines.push("Conflicts: none");
      } else if (p["conflicts"] === true) {
        const conflictFiles = Array.isArray(p["conflictFiles"])
          ? p["conflictFiles"].filter((f): f is string => typeof f === "string")
          : [];
        if (conflictFiles.length > 0) {
          const fWord = conflictFiles.length === 1 ? "file" : "files";
          lines.push(
            `Conflicts in ${conflictFiles.length} ${fWord}: ${conflictFiles.join(", ")}`,
          );
        } else {
          lines.push("Conflicts detected");
        }
      } else if (p["conflicts"] === null) {
        lines.push("Conflicts: could not check");
      }

      if (p["dirty"] === true) {
        const dirtyCount = Array.isArray(p["dirtyFiles"])
          ? p["dirtyFiles"].length
          : typeof p["dirtyCount"] === "number"
            ? p["dirtyCount"]
            : undefined;
        const n = dirtyCount !== undefined ? String(dirtyCount) : "?";
        const fWord = dirtyCount === 1 ? "file" : "files";
        lines.push(`Your checkout has uncommitted changes (${n} ${fWord})`);
      }
      break;
    }

    case "push": {
      const branch =
        typeof p["branch"] === "string" && p["branch"].length > 0
          ? p["branch"]
          : undefined;
      const remote =
        typeof p["remote"] === "string" && p["remote"].length > 0
          ? p["remote"]
          : undefined;
      const remoteUrl =
        typeof p["remoteUrl"] === "string" && p["remoteUrl"].length > 0
          ? p["remoteUrl"]
          : undefined;

      if (branch !== undefined || remote !== undefined || remoteUrl !== undefined) {
        const urlPart = remoteUrl ? ` (${remoteUrl})` : "";
        lines.push(`Push ${branch ?? "?"} to ${remote ?? "?"}${urlPart}`);
      }

      const commitsAhead =
        typeof p["commitsAhead"] === "number"
          ? p["commitsAhead"]
          : Array.isArray(p["commits"])
            ? p["commits"].length
            : undefined;

      if (commitsAhead !== undefined) {
        lines.push(`${commitsAhead} new commit${commitsAhead === 1 ? "" : "s"}`);
      }
      break;
    }

    case "draft_pr": {
      const owner =
        typeof p["owner"] === "string" && p["owner"].length > 0
          ? p["owner"]
          : undefined;
      const repo =
        typeof p["repo"] === "string" && p["repo"].length > 0
          ? p["repo"]
          : undefined;
      const head =
        typeof p["head"] === "string" && p["head"].length > 0
          ? p["head"]
          : undefined;
      const base =
        typeof p["base"] === "string" && p["base"].length > 0
          ? p["base"]
          : undefined;

      if (owner !== undefined || repo !== undefined || head !== undefined || base !== undefined) {
        const repoStr = owner && repo ? `${owner}/${repo}` : (owner ?? repo ?? "?");
        lines.push(`Draft PR ${repoStr}: ${head ?? "?"} -> ${base ?? "?"}`);
      }

      if (typeof p["title"] === "string" && p["title"].trim().length > 0) {
        lines.push(`Title: ${p["title"].trim()}`);
      }

      const changedCount = Array.isArray(p["changedFiles"])
        ? p["changedFiles"].length
        : typeof p["changedFilesCount"] === "number"
          ? p["changedFilesCount"]
          : undefined;

      if (changedCount !== undefined) {
        lines.push(`${changedCount} changed file${changedCount === 1 ? "" : "s"}`);
      }
      break;
    }

    case "apply_back": {
      const writes =
        typeof p["writes"] === "number"
          ? p["writes"]
          : Array.isArray(p["entries"])
            ? p["entries"].filter(
                (e) =>
                  typeof e === "object" &&
                  e !== null &&
                  (e as { action?: string }).action === "write",
              ).length
            : undefined;

      const deletes =
        typeof p["deletes"] === "number"
          ? p["deletes"]
          : Array.isArray(p["entries"])
            ? p["entries"].filter(
                (e) =>
                  typeof e === "object" &&
                  e !== null &&
                  (e as { action?: string }).action === "delete",
              ).length
            : undefined;

      const sourceDir =
        typeof p["sourceDir"] === "string" && p["sourceDir"].length > 0
          ? p["sourceDir"]
          : undefined;

      if (writes !== undefined || deletes !== undefined || sourceDir !== undefined) {
        const wCount = writes !== undefined ? String(writes) : "?";
        const dCount = deletes !== undefined ? String(deletes) : "?";
        const wWord = writes === 1 ? "file" : "files";
        lines.push(`${wCount} ${wWord} to write, ${dCount} to delete in ${sourceDir ?? "?"}`);
      }
      break;
    }

    case "delete_worktree": {
      const worktreePath =
        typeof p["worktreePath"] === "string" && p["worktreePath"].length > 0
          ? p["worktreePath"]
          : undefined;
      const branch =
        typeof p["branch"] === "string" && p["branch"].length > 0
          ? p["branch"]
          : undefined;

      if (worktreePath !== undefined || branch !== undefined) {
        lines.push(`Deletes ${worktreePath ?? "?"}; the branch ${branch ?? "?"} is kept`);
      }

      const unmerged =
        typeof p["unmergedCommitsCount"] === "number"
          ? p["unmergedCommitsCount"]
          : Array.isArray(p["unmergedCommits"])
            ? p["unmergedCommits"].length
            : undefined;

      if (unmerged !== undefined) {
        lines.push(`${unmerged} unmerged commit${unmerged === 1 ? "" : "s"}`);
      }

      const uncommitted = Array.isArray(p["uncommittedFiles"])
        ? p["uncommittedFiles"].length
        : typeof p["uncommittedFilesCount"] === "number"
          ? p["uncommittedFilesCount"]
          : 0;

      if (uncommitted > 0) {
        const fWord = uncommitted === 1 ? "file" : "files";
        lines.push(`${uncommitted} uncommitted ${fWord} will be lost`);
      }
      break;
    }
  }

  return lines;
}

export function approveBlocker(
  approval: Pick<Approval, "kind" | "status"> & {
    preview?: Record<string, unknown> | null;
  },
): string | null {
  if (approval.status !== "pending" || approval.kind !== "merge") {
    return null;
  }
  const preview =
    approval.preview && typeof approval.preview === "object" ? approval.preview : {};

  if (preview["dirty"] === true) {
    return "Fix this before approving: commit or stash your changes";
  }
  if (preview["conflicts"] === true) {
    return "This merge has conflicts; resolve them in your repo or request a new preview";
  }
  return null;
}
