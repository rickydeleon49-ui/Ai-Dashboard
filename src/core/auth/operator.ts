/**
 * Operator sessions for self-hosted mode (AW.5).
 *
 * Cookie value: base64url(JSON {sid, iat, authAt, exp}) + "." + base64url(HMAC-SHA256).
 * The HMAC key is the `sessionKey` in the operator file, so setting a new
 * password (which rotates the key) invalidates every cookie. Times are epoch ms.
 */
import { readOperatorFile } from "../selfhost/operator-store";

export const OPERATOR_COOKIE = "cc_operator";
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const RECENT_SIGN_IN_MS = 5 * 60 * 1000;
const MAX_COOKIE_LENGTH = 1024;
const CLOCK_SKEW_MS = 60_000;

export type OperatorSession = {
  sid: string;
  iat: number;
  authAt: number;
  exp: number;
};

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(
  sessionKey: string,
  usage: "sign" | "verify",
): Promise<CryptoKey | null> {
  try {
    const bin = atob(sessionKey);
    if (bin.length !== 32) return null;
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = bin.charCodeAt(i);
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      [usage],
    );
  } catch {
    return null;
  }
}

function currentKey(): string | null {
  return readOperatorFile()?.sessionKey ?? null;
}

/** Signs a session cookie value. `authAt` is when the password was last entered. */
export async function createOperatorSession(
  now: number = Date.now(),
  sessionKey: string | null = currentKey(),
): Promise<{ value: string; session: OperatorSession } | null> {
  if (!sessionKey) return null;
  const key = await hmacKey(sessionKey, "sign");
  if (!key) return null;
  const session: OperatorSession = {
    sid: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    iat: now,
    authAt: now,
    exp: now + SESSION_LIFETIME_MS,
  };
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
  return { value: `${payload}.${toBase64Url(mac)}`, session };
}

/** Returns the session when the cookie is authentic and unexpired, else null. */
export async function verifyOperatorSession(
  cookieValue: string | undefined | null,
  now: number = Date.now(),
  sessionKey: string | null = currentKey(),
): Promise<OperatorSession | null> {
  try {
    if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH || !sessionKey)
      return null;
    const dot = cookieValue.indexOf(".");
    if (dot <= 0 || dot !== cookieValue.lastIndexOf(".")) return null;
    const payload = cookieValue.slice(0, dot);
    const mac = fromBase64Url(cookieValue.slice(dot + 1));
    if (!mac || mac.length !== 32) return null;
    const key = await hmacKey(sessionKey, "verify");
    if (!key) return null;
    // subtle.verify compares the MAC in constant time.
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      mac as BufferSource,
      encoder.encode(payload),
    );
    if (!ok) return null;
    const body = fromBase64Url(payload);
    if (!body) return null;
    const data = JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >;
    const { sid, iat, authAt, exp } = data;
    if (typeof sid !== "string" || sid.length === 0 || sid.length > 64)
      return null;
    if (
      typeof iat !== "number" ||
      typeof authAt !== "number" ||
      typeof exp !== "number"
    )
      return null;
    if (![iat, authAt, exp].every(Number.isFinite)) return null;
    if (exp <= now) return null;
    if (exp - iat > SESSION_LIFETIME_MS) return null;
    if (
      iat > now + CLOCK_SKEW_MS ||
      authAt > now + CLOCK_SKEW_MS ||
      authAt < iat - CLOCK_SKEW_MS
    ) {
      return null;
    }
    return { sid, iat, authAt, exp };
  } catch {
    return null;
  }
}

/** True when the password was entered within `windowMs` (default 5 minutes). */
export function isRecentSignIn(
  session: OperatorSession | null | undefined,
  now: number = Date.now(),
  windowMs: number = RECENT_SIGN_IN_MS,
): boolean {
  if (!session) return false;
  const age = now - session.authAt;
  return age >= -CLOCK_SKEW_MS && age <= windowMs;
}

export function operatorCookieHeader(
  value: string,
  maxAgeSeconds: number,
): string {
  return `${OPERATOR_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearOperatorCookieHeader(): string {
  return `${OPERATOR_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** Same-origin relative paths only; anything else becomes "/". */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const url = new URL(raw, "http://local.invalid");
    if (url.origin !== "http://local.invalid") return "/";
    if (url.pathname === "/login" || url.pathname.startsWith("/api/"))
      return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}

/** Sliding-window failure counter, in memory. */
export type RateLimiter = {
  isLimited(key: string, now?: number): boolean;
  recordFailure(key: string, now?: number): void;
  reset(key: string): void;
};

export function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();
  const recent = (key: string, now: number): number[] => {
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };
  return {
    isLimited: (key, now = Date.now()) => recent(key, now).length >= max,
    recordFailure(key, now = Date.now()) {
      if (hits.size > 5000) {
        for (const k of [...hits.keys()]) recent(k, now);
      }
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
    },
    reset: (key) => void hits.delete(key),
  };
}

export const LOGIN_FAILURES_PER_IP = 5;
/** Backstop in case the client address header is spoofed. */
export const LOGIN_FAILURES_GLOBAL = 20;
export const LOGIN_WINDOW_MS = 60_000;
