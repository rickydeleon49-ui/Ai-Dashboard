/**
 * Framework-facing route types.
 *
 * Kept out of `core/` so the domain stays free of Next.js concepts.
 */

/** The shape Next passes to a page's `searchParams` prop. */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
