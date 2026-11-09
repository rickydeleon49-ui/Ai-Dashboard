/**
 * Operator credential file for self-hosted mode (AW.5).
 *
 * One JSON file holds the scrypt password hash and the key that signs session
 * cookies. It is written only by `npm run operator:password` on the machine
 * itself. Anything missing, unreadable or malformed means "not configured",
 * and the proxy then refuses every request.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDatabasePath } from "../../db/path";

export const OPERATOR_FILE_VERSION = 1;
export const MIN_PASSWORD_LENGTH = 12;
export const SCRYPT_N = 1 << 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const KEY_BYTES = 32;
/** Bounds for parameters read back from the file, so a tampered file cannot demand huge memory. */
const MIN_N = 1 << 14;
const MAX_N = 1 << 20;
const MAX_R = 16;
const MAX_P = 4;

export type OperatorRecord = {
  version: number;
  passwordHash: string;
  sessionKey: string;
};

export function resolveOperatorFile(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.OPERATOR_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(resolveDatabasePath()), "operator.json");
}

function maxmemFor(n: number, r: number): number {
  return 128 * n * r * 2 + 1024 * 1024;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      length,
      { N: n, r, p, maxmem: maxmemFor(n, r) },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hash format: scrypt$N$r$p$saltBase64$hashBase64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptAsync(
    password,
    salt,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    HASH_BYTES,
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

type ParsedHash = {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
};

function parseParam(text: string | undefined): number {
  return /^\d{1,8}$/.test(text ?? "") ? Number(text) : NaN;
}

function parseHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const n = parseParam(parts[1]);
  const r = parseParam(parts[2]);
  const p = parseParam(parts[3]);
  if (!Number.isInteger(n) || n < MIN_N || n > MAX_N || (n & (n - 1)) !== 0)
    return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const hash = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length < SALT_BYTES || hash.length < 32) return null;
  return { n, r, p, salt, hash };
}

/** Constant-time check. Any malformed hash or error is a plain `false`. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 1024
  )
    return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const candidate = await scryptAsync(
      password,
      parsed.salt,
      parsed.n,
      parsed.r,
      parsed.p,
      parsed.hash.length,
    );
    return crypto.timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

/** Returns an error message, or null when the password is acceptable. */
export function validateNewPassword(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 1024) return "Password is too long.";
  return null;
}

/** Builds a fresh record: new hash and a new random session key (signs everyone out). */
export async function createOperatorRecord(
  password: string,
): Promise<OperatorRecord> {
  const problem = validateNewPassword(password);
  if (problem) throw new Error(problem);
  return {
    version: OPERATOR_FILE_VERSION,
    passwordHash: await hashPassword(password),
    sessionKey: crypto.randomBytes(KEY_BYTES).toString("base64"),
  };
}

/** Atomic write with mode 0600: temp file in the same directory, fsync, rename. */
export function writeOperatorFile(file: string, record: OperatorRecord): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.operator-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  clearOperatorCache();
}

function parseRecord(text: string): OperatorRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (o.version !== OPERATOR_FILE_VERSION) return null;
  if (!parseHash(o.passwordHash)) return null;
  if (typeof o.sessionKey !== "string") return null;
  const key = Buffer.from(o.sessionKey, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== o.sessionKey)
    return null;
  return {
    version: OPERATOR_FILE_VERSION,
    passwordHash: o.passwordHash as string,
    sessionKey: o.sessionKey,
  };
}

let cache: {
  file: string;
  mtimeMs: number;
  size: number;
  record: OperatorRecord | null;
} | null = null;

export function clearOperatorCache(): void {
  cache = null;
}

/** Reads the operator file (small mtime cache). null = not configured. */
export function readOperatorFile(
  file: string = resolveOperatorFile(),
): OperatorRecord | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null;
    return null;
  }
  if (!stat.isFile()) return null;
  if (
    cache &&
    cache.file === file &&
    cache.mtimeMs === stat.mtimeMs &&
    cache.size === stat.size
  ) {
    return cache.record;
  }
  let record: OperatorRecord | null = null;
  try {
    record = parseRecord(fs.readFileSync(file, "utf8"));
  } catch {
    record = null;
  }
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, record };
  return record;
}
