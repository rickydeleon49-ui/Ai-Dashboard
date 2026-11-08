/**
 * Pure logic for agent run inline comments (AW2-07a).
 *
 * Provides:
 * - newFileLineNumbers: parses unified diff hunk headers to map each patch line to its new-file line number
 * - groupComments: partitions comments into whole-run (general) vs per-file/per-line buckets
 * - parseCommentList: defensively validates comment API JSON responses
 */

export interface RunComment {
  id: string;
  round: number;
  file: string | null;
  line: number | null;
  body: string;
  createdAt: string;
}

const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/**
 * For the lines of one file's unified patch, returns the new-file line number of each line.
 *
 * Rules:
 * - Hunk headers matching `@@ -a,b +c,d @@` (or `+c`) set the line counter to `c`.
 * - Added (`+`) and context (` ` or other) lines receive numbers counting from `c`.
 * - Removed lines (`-`), file/diff headers (`diff --git`, `index`, `---`, `+++`, etc.),
 *   `\ No newline at end of file`, and hunk headers receive `null`.
 * - A malformed hunk header sets the line counter to `null` until the next valid header.
 */
export function newFileLineNumbers(lines: string[]): (number | null)[] {
  let currentLine: number | null = null;
  // File headers ("--- a/x", "+++ b/x", "index ...") only appear before the first hunk.
  // Inside a hunk, "--- foo" is a removed line whose text starts with "-- ", so it must
  // not be mistaken for a header.
  let inHunk = false;

  return lines.map((line) => {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      currentLine = null;
      return null;
    }

    if (line.startsWith("@@")) {
      const match = HUNK_HEADER_RE.exec(line);
      if (match && match[1]) {
        currentLine = Number.parseInt(match[1], 10);
        inHunk = true;
      } else {
        currentLine = null;
        inHunk = false;
      }
      return null;
    }

    if (!inHunk || currentLine === null) {
      return null;
    }

    if (line.startsWith("\\") || line.startsWith("-")) {
      return null;
    }

    const num = currentLine;
    currentLine++;
    return num;
  });
}

export interface GroupedComments {
  general: RunComment[];
  byFile: Map<string, Map<number | "file", RunComment[]>>;
}

/**
 * Groups comments into general (whole run) and per-file/per-line buckets while keeping input order.
 * - Comments without file go into `general`.
 * - Comments with file but without line go under `byFile.get(file).get("file")`.
 * - Comments with file and line go under `byFile.get(file).get(line)`.
 */
export function groupComments(comments: RunComment[]): GroupedComments {
  const general: RunComment[] = [];
  const byFile = new Map<string, Map<number | "file", RunComment[]>>();

  if (!Array.isArray(comments)) {
    return { general, byFile };
  }

  for (const c of comments) {
    if (!c || typeof c !== "object") continue;
    if (!c.file) {
      general.push(c);
      continue;
    }

    let fileMap = byFile.get(c.file);
    if (!fileMap) {
      fileMap = new Map<number | "file", RunComment[]>();
      byFile.set(c.file, fileMap);
    }

    const key: number | "file" = typeof c.line === "number" ? c.line : "file";
    let list = fileMap.get(key);
    if (!list) {
      list = [];
      fileMap.set(key, list);
    }
    list.push(c);
  }

  return { general, byFile };
}

function parseSingleComment(item: unknown): RunComment | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const r = item as Record<string, unknown>;

  if (typeof r.id !== "string" || r.id.trim().length === 0) return null;
  if (typeof r.round !== "number" || !Number.isInteger(r.round) || r.round < 0) return null;
  if (typeof r.body !== "string" || r.body.length === 0) return null;

  const rawCreatedAt =
    typeof r.createdAt === "string"
      ? r.createdAt
      : typeof r.created_at === "string"
        ? r.created_at
        : null;
  if (!rawCreatedAt || rawCreatedAt.trim().length === 0) return null;

  let file: string | null = null;
  if (typeof r.file === "string" && r.file.trim().length > 0) {
    file = r.file.trim();
  } else if (r.file === null || r.file === undefined) {
    file = null;
  } else {
    return null;
  }

  let line: number | null = null;
  if (typeof r.line === "number" && Number.isInteger(r.line) && r.line >= 1) {
    if (file === null) return null;
    line = r.line;
  } else if (r.line === null || r.line === undefined) {
    line = null;
  } else {
    return null;
  }

  return {
    id: r.id,
    round: r.round,
    file,
    line,
    body: r.body,
    createdAt: rawCreatedAt,
  };
}

/**
 * Defensively parses comments from unknown JSON payload.
 * Drops malformed items and never throws.
 */
export function parseCommentList(json: unknown): RunComment[] {
  let items: unknown[] = [];
  if (Array.isArray(json)) {
    items = json;
  } else if (
    json &&
    typeof json === "object" &&
    Array.isArray((json as { comments?: unknown }).comments)
  ) {
    items = (json as { comments: unknown[] }).comments;
  } else {
    return [];
  }

  const result: RunComment[] = [];
  for (const item of items) {
    try {
      const parsed = parseSingleComment(item);
      if (parsed) {
        result.push(parsed);
      }
    } catch {
      // never throws
    }
  }
  return result;
}
