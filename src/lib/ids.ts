/**
 * Sortable, URL-safe identifiers.
 *
 * A timestamp prefix means ids sort chronologically, which makes debugging and
 * raw SQL browsing far more pleasant than opaque UUIDs.
 */
export function createId(prefix?: string): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  const id = `${time}${random}`;
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
