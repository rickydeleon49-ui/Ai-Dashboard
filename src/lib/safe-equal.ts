import crypto from "node:crypto";

/**
 * Compares two strings in constant time using platform-supported crypto.timingSafeEqual.
 *
 * Both strings are hashed with SHA-256 before comparison so that the buffers passed
 * to crypto.timingSafeEqual are guaranteed to be identical fixed lengths (32 bytes),
 * preventing length leakage, timing attacks, and length-mismatch exceptions.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}
