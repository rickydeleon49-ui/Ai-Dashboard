/**
 * Translates URL search parameters into a repository query.
 *
 * Lives in core rather than beside a page because every listing screen shares
 * it — the library, favorites, and any future filtered view — and filters must
 * behave identically in all of them. It is pure: no framework imports, so it is
 * testable and reusable from a route handler as easily as from a page.
 */
import { projectQuerySchema } from "./schema";
import type { ProjectQuery } from "./types";

/** A single search param may arrive repeated; the first value wins. */
type RawSearchParams = Record<string, string | string[] | undefined>;

export function buildProjectQuery(
  raw: RawSearchParams,
  overrides: Partial<ProjectQuery> = {},
): ProjectQuery {
  const flat = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value,
    ]),
  );

  const parsed = projectQuerySchema.safeParse({
    search: flat.search,
    source: flat.source,
    status: flat.status,
    type: flat.type,
    tag: flat.tag,
    sort: flat.sort,
  });

  // An unparseable query degrades to "no filters" rather than an error page:
  // a stale or hand-edited URL should still show the library.
  const base: ProjectQuery = parsed.success ? parsed.data : {};

  return {
    ...base,
    includeArchived: flat.archived === "1",
    ...overrides,
  };
}
