import "server-only";

import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projectFiles } from "@/db/schema";
import { storage } from "@/core/storage";
import { createId } from "@/lib/ids";
import type { ProjectFile } from "@/core/projects/types";

/** Refuse anything larger than this in a single upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  return db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))
    .orderBy(desc(projectFiles.createdAt))
    .all();
}

export async function findFile(id: string): Promise<ProjectFile | null> {
  return db.select().from(projectFiles).where(eq(projectFiles.id, id)).get() ?? null;
}

export async function addProjectFile(
  projectId: string,
  file: File,
): Promise<ProjectFile> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"${file.name}" is larger than the ${Math.round(
        MAX_UPLOAD_BYTES / 1024 / 1024,
      )}MB limit`,
    );
  }

  const data = Buffer.from(await file.arrayBuffer());
  const stored = await storage.write(projectId, file.name, data);

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

  db.insert(projectFiles).values(row).run();
  return row;
}

export async function readFileContents(file: ProjectFile): Promise<Buffer> {
  return storage.read(file.storageKey);
}

export async function deleteProjectFile(id: string): Promise<boolean> {
  const file = await findFile(id);
  if (!file) return false;

  // Remove the row first: an orphaned blob on disk is harmless, whereas a row
  // pointing at a missing file shows a broken entry in the UI.
  db.delete(projectFiles).where(eq(projectFiles.id, id)).run();
  await storage.delete(file.storageKey).catch(() => undefined);
  return true;
}
