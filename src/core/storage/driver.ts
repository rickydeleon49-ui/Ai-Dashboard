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
  /**
   * Persists a stream, so a large upload is not copied into a Buffer first.
   *
   * The uploaded bytes already exist once as the request's File object; reading
   * them into a Buffer to hand to `write` makes a second full-size copy of
   * every file. Streaming to disk avoids that copy.
   */
  writeStream(
    projectId: string,
    filename: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<StoredFile>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Removes everything belonging to a project. */
  deleteProject(projectId: string): Promise<void>;
}
