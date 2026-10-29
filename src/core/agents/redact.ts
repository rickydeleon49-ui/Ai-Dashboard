/**
 * Secret redaction for agent output (AW design doc, section 6 and 15 step 5).
 *
 * Pure and dependency-free. Everything an agent prints is passed through here
 * before it is stored as an event payload or shown in the UI.
 *
 * Performance: every pattern uses bounded quantifiers or a single linear scan,
 * so no input can trigger catastrophic backtracking. Text longer than
 * `maxLength` is truncated (and then redacted) rather than passed through, so
 * an oversized blob can never smuggle a secret past the redactor.
 */

export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[Circular]";
export const TRUNCATED_DEPTH = "[Truncated]";

/** Default cap on the length of a single string that is scanned. */
export const DEFAULT_MAX_LENGTH = 4 * 1024 * 1024;
/** Explicit secrets shorter than this are ignored (they would mangle text). */
export const MIN_EXPLICIT_SECRET_LENGTH = 4;
const MAX_DEPTH = 64;
const PARTIAL_TOKEN_WINDOW = 256;

export interface RedactOptions {
  /** Exact secret strings (for example the run's own env values) to redact everywhere. */
  secrets?: readonly string[];
  /**
   * Caps how much of a string is SCANNED, not the output length: text beyond
   * the cap (backed up to a whitespace boundary) is dropped and replaced by a
   * "[truncated N characters]" note, and the kept part is redacted. The result
   * can therefore be shorter than the input but is never longer than
   * maxLength plus that note, and redaction itself can still change the length.
   */
  maxLength?: number;
}

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g;

// Header name, separator, value (value stops at end of line or a quote).
const HTTP_HEADER =
  /(?<![A-Za-z0-9_/@.-])((?:proxy-)?authorization|private-token|x-api-key|api-key|x-auth-token|x-access-token|x-dashboard-desktop-secret|(?:set-)?cookie|x-[a-z0-9-]{0,40}?(?:secret|token|key))([ \t]{0,8}:[ \t]{0,8})([^\r\n"']+)/gi;

// scheme://user:password@host -- keeps scheme, user and host.
const URL_USERINFO =
  /([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@"'<>]{0,256}:)[^\s/@"'<>]{1,512}(?=@)/gi;

const TOKEN_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{32,}/g,
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}/g,
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{30,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,}/g,
];

const BEARER = /(?<![A-Za-z0-9])(Bearer[ \t]{1,8})[A-Za-z0-9._~+/=-]{16,}/gi;

// NAME=value / NAME: value / "name": "value", also with JSON-escaped quotes
// (\"name\": \"value\") as found inside serialized JSON strings. Whether NAME
// is secret is decided in code (segment based).
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])(\\?["']|)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1([ \t]{0,8}[=:][ \t]{0,8})("(?:[^"\\\r\n]|\\.){0,8192}"|\\"(?:[^"\\\r\n]|\\(?!")){0,8192}\\"|'[^'\r\n]{0,8192}'|(?!\\")[^\s"',;&}]{1,8192})/g;

const SECRET_SEGMENTS: ReadonlySet<string> = new Set([
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "apikey",
  "credential",
  "credentials",
  "authorization",
  "cookie",
]);

/** Compound names that contain "key"/"token" but are not secrets (exact, normalized). */
const NON_SECRET_NAMES: ReadonlySet<string> = new Set([
  "public_key",
  "primary_key",
  "foreign_key",
  "sort_key",
  "partition_key",
  "routing_key",
  "cache_key",
  "key_type",
  "key_length",
  "key_id",
  "token_type",
  "token_count",
  "tokens_used",
  "max_tokens",
  "input_tokens",
  "output_tokens",
]);

/** True when an env var / JSON key name looks like it holds a secret. */
export function isSecretName(name: string): boolean {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter((s) => s.length > 0);
  if (NON_SECRET_NAMES.has(segments.join("_"))) return false;
  for (const segment of segments) {
    if (SECRET_SEGMENTS.has(segment)) return true;
    if (segment.length > 6 && (segment.includes("password") || segment.includes("secret"))) {
      return true;
    }
  }
  return false;
}

function redactAssignments(text: string): string {
  ASSIGNMENT.lastIndex = 0;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT.exec(text)) !== null) {
    const whole = match[0];
    const quote = match[1] ?? "";
    const name = match[2] ?? "";
    const sep = match[3] ?? "";
    const value = match[4] ?? "";
    // Already redacted values (bare or quoted, possibly followed by more text
    // such as "@host" after URL userinfo redaction) are left alone.
    const unquoted = value.startsWith('\\"') ? value.slice(2) : value.slice(1);
    if (!isSecretName(name) || value.startsWith(REDACTED) || unquoted.startsWith(REDACTED)) {
      // Not a secret: resume right after the name so a later NAME=... inside
      // the value is still seen.
      ASSIGNMENT.lastIndex = match.index + quote.length + name.length + quote.length;
      continue;
    }
    const escape = quote.startsWith("\\") ? "\\" : "";
    let valueQuote = "";
    if (value.startsWith('\\"')) valueQuote = '\\"';
    else if (value.startsWith("'")) valueQuote = "'";
    else if (value.startsWith('"')) valueQuote = '"';
    else if (quote) valueQuote = `${escape}"`;
    const replacement = `${valueQuote}${REDACTED}${valueQuote}`;
    out += text.slice(last, match.index) + quote + name + quote + sep + replacement;
    last = match.index + whole.length;
  }
  return last === 0 ? text : out + text.slice(last);
}

function redactExplicit(text: string, secrets: readonly string[] | undefined): string {
  if (!secrets || secrets.length === 0) return text;
  const usable = [...new Set(secrets)]
    .filter((s) => typeof s === "string" && s.length >= MIN_EXPLICIT_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of usable) {
    if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  }
  return result;
}

/** Redact secrets in a string. Never throws; non-strings are returned as is. */
export function redactText(text: string, options: RedactOptions = {}): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  let result = text;
  let suffix = "";
  if (result.length > maxLength) {
    // Never cut through a token: back up to the last whitespace in the final
    // PARTIAL_TOKEN_WINDOW characters (or drop the whole window if there is
    // none) so a half-cut secret cannot slip under the minimum-length rules.
    let cut = maxLength;
    const windowStart = Math.max(0, maxLength - PARTIAL_TOKEN_WINDOW);
    let i = maxLength;
    while (i > windowStart && !/\s/.test(result.charAt(i - 1))) i--;
    cut = i > windowStart ? i : windowStart;
    suffix = `\n[truncated ${result.length - cut} characters]`;
    result = result.slice(0, cut);
  }
  result = redactExplicit(result, options.secrets);
  result = result.replace(PEM_BLOCK, REDACTED);
  result = result.replace(URL_USERINFO, `$1${REDACTED}`);
  result = result.replace(HTTP_HEADER, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  result = result.replace(BEARER, (_m, prefix: string) => `${prefix}${REDACTED}`);
  result = redactAssignments(result);
  return result + suffix;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, options: RedactOptions, ancestors: Set<object>, depth: number): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED_DEPTH;
  if (Array.isArray(value)) {
    ancestors.add(value);
    const out = value.map((item) => walk(item, options, ancestors, depth + 1));
    ancestors.delete(value);
    return out;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message, options) };
  }
  if (Buffer.isBuffer(value)) return redactText(value.toString("utf8"), options);
  if (value instanceof Set) {
    ancestors.add(value);
    const out = [...value].map((item) => walk(item, options, ancestors, depth + 1));
    ancestors.delete(value);
    return out;
  }
  let entries: Array<[string, unknown]>;
  if (value instanceof Map) {
    entries = [...value].map(([k, v]): [string, unknown] => [String(k), v]);
  } else if (isPlainObject(value)) {
    entries = Object.entries(value);
  } else {
    return value; // Date and other class instances carry no free text.
  }
  ancestors.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const next =
      isSecretName(key) && item !== null && item !== undefined
        ? REDACTED
        : walk(item, options, ancestors, depth + 1);
    Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return out;
}

/**
 * Deep copy of `value` with every string redacted and every value under a
 * secret-looking key replaced by the marker. Input is never mutated, cycles
 * become "[Circular]", and the result stays JSON-serializable.
 */
export function redactValue<T = unknown>(value: T, options: RedactOptions = {}): T {
  return walk(value, options, new Set(), 0) as T;
}
