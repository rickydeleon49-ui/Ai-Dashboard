import "server-only";

import { LocalStorageDriver } from "./local-driver";
import type { StorageDriver } from "./driver";

/**
 * Composition root for file storage — the only place naming a concrete driver.
 */
export const storage: StorageDriver = new LocalStorageDriver();

export type { StorageDriver, StoredFile } from "./driver";
