/**
 * Sortable, URL-safe identifiers.
 *
 * A timestamp prefix means ids sort chronologically, which makes debugging and
 * raw SQL browsing far more pleasant than opaque UUIDs — and, more importantly,
 * lets a query break a tie between two rows written in the same millisecond by
 * ordering on the id.
 *
 * That tie-break is why the sequence exists. `Date.now()` has millisecond
 * resolution, and a synchronous SQLite write takes far less than that, so rows
 * written back to back routinely share a timestamp. With only a random suffix
 * to separate them the id ordering was random too, and a transcript could come
 * back with the assistant's reply before the question that prompted it. The
 * counter makes ids created in the same millisecond sort in the order they were
 * created, which is what every caller already assumed.
 */
let lastTime = 0;
let sequence = 0;

/** Fixed width so the sequence sorts lexicographically, not numerically. */
const SEQUENCE_DIGITS = 4;

export function createId(prefix?: string): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    sequence = 0;
  } else {
    // The same millisecond, or a clock that stepped backwards. Advancing the
    // sequence against the last time we saw keeps ids monotonic either way; a
    // backwards clock is rare but it must not be able to reorder history.
    sequence += 1;
  }

  const time = lastTime.toString(36);
  const seq = sequence.toString(36).padStart(SEQUENCE_DIGITS, "0");
  const random = Math.random().toString(36).slice(2, 10);
  const id = `${time}${seq}${random}`;
  return prefix ? `${prefix}_${id}` : id;
}

/** Turns "Starfield Mod Tools" into "starfield-mod-tools". */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
