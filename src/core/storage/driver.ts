/**
 * Where uploaded files physically live.
 *
 * An interface rather than direct filesystem calls, for the same reason the
 * project repository is one: the desktop app keeps files on local disk, but a
 * hosted deployment would want object storage, and that should be one new
 * implementation rather than a rewrite of every call site.
 */
export interface StoredFile {
  /** Opaque key the driver understands. Never a user-supplied path. */
  key: string;
  size: number;
}

export interface StorageDriver {
  /** Persists bytes and returns the key needed to read them back. */
  write(projectId: string, filename: string, data: Buffer): Promise<StoredFile>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Removes everything belonging to a project. */
  deleteProject(projectId: string): Promise<void>;
}
