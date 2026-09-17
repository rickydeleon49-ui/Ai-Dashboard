import "server-only";

import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projectFiles } from "@/db/schema";
import { storage } from "@/core/storage";
import { createId } from "@/lib/ids";
import type { ProjectFile } from "@/core/projects/types";
import { isAccountsMode } from "@/lib/auth-mode";

function assertFilesEnabled(): void {
  if (isAccountsMode()) {
    throw new Error("File operations are disabled in hosted multi-user accounts mode.");
  }
}

/** Refuse any single file larger than this. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Refuse a batch larger than this in total.
 *
 * The per-file limit alone does not bound a request: fifty files just under the
 * per-file cap is several gigabytes. This is the number that actually protects
 * the disk and the process.
 */
export const MAX_UPLOAD_BATCH_BYTES = 250 * 1024 * 1024;

export function formatLimit(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  assertFilesEnabled();
  return db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))
    .orderBy(desc(projectFiles.createdAt))
    .all();
}

export async function findFile(id: string): Promise<ProjectFile | null> {
  assertFilesEnabled();
  return db.select().from(projectFiles).where(eq(projectFiles.id, id)).get() ?? null;
}

export async function addProjectFile(
  projectId: string,
  file: File,
): Promise<ProjectFile> {
  assertFilesEnabled();
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"${file.name}" is larger than the ${formatLimit(MAX_UPLOAD_BYTES)} limit`,
    );
  }

  // Streamed rather than buffered: the bytes already exist once as the File,
  // and reading them into a Buffer would make a second full-size copy.
  const stored = await storage.writeStream(projectId, file.name, file.stream());

  const row = {
    id: createId("file"),
    projectId,
    // The supplied name is kept for display only — it never becomes a path.
    filename: file.name.slice(0, 255),
    mimeType: file.type || null,
    size: stored.size,
    storageKey: stored.key,
    createdAt: new Date().toISOString(),
  };

  try {
    db.insert(projectFiles).values(row).run();
    return row;
  } catch (dbError) {
    try {
      await storage.delete(stored.key);
    } catch (cleanupError) {
      // Log only a sanitized blob identifier and error type.
      // Never log file contents, credentials, signed URLs, auth tokens, or complete storage paths.
      const errorType =
        cleanupError instanceof Error ? cleanupError.constructor.name : "UnknownError";
      console.error(
        `[ERR_FILE_CLEANUP_FAILED] failed to clean up unreferenced file blob after metadata insert failure (correlation_id=${row.id}, error_type=${errorType})`,
      );
    }
    throw dbError;
  }
}

export async function readFileContents(file: ProjectFile): Promise<Buffer> {
  assertFilesEnabled();
  return storage.read(file.storageKey);
}

export async function deleteProjectFile(id: string): Promise<boolean> {
  assertFilesEnabled();
  const file = await findFile(id);
  if (!file) return false;

  // Remove the row first: an orphaned blob on disk is harmless, whereas a row
  // pointing at a missing file shows a broken entry in the UI.
  db.delete(projectFiles).where(eq(projectFiles.id, id)).run();
  await storage.delete(file.storageKey).catch(() => undefined);
  return true;
}

/** One file's outcome within a batch upload. */
export type UploadOutcome =
  | { ok: true; file: ProjectFile }
  | { ok: false; filename: string; error: string };

/**
 * Stores a batch, reporting each file separately.
 *
 * A batch is not all-or-nothing, and pretending otherwise was the bug: the
 * route used to stop at the first rejection and return a single error, while
 * the files stored before it stayed on disk and in the database. The user saw
 * "Upload failed" and a list that had in fact grown. Every file is attempted,
 * and the caller is told exactly which ones landed.
 */
export async function addProjectFiles(
  projectId: string,
  files: File[],
): Promise<UploadOutcome[]> {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_UPLOAD_BATCH_BYTES) {
    const message = `That batch is ${formatLimit(total)}, over the ${formatLimit(
      MAX_UPLOAD_BATCH_BYTES,
    )} limit for one upload. Add the files in smaller groups.`;
    return files.map((file) => ({ ok: false, filename: file.name, error: message }));
  }

  const outcomes: UploadOutcome[] = [];
  for (const file of files) {
    try {
      outcomes.push({ ok: true, file: await addProjectFile(projectId, file) });
    } catch (error) {
      outcomes.push({
        ok: false,
        filename: file.name,
        error: error instanceof Error ? error.message : "Could not be stored",
      });
    }
  }
  return outcomes;
}
