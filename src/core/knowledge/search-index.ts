/**
 * Budgets and batch selection for re-deriving stale knowledge `search_text`
 * (Release 2E.1, review finding M2).
 *
 * A row is stale when `search_text` is NULL or `search_indexed_at` differs from
 * `updated_at`: every document written before 2E.1, and any row an older build
 * edits after a rollback. Instead of re-deriving every stale row in a project
 * on one search, each search request re-derives at most ONE batch, bounded by
 * both a row count and the stored size of the text it must parse, inside one
 * short transaction. Progress is the rows themselves becoming fresh, so the
 * next search resumes where the last one stopped; nothing loops to completion
 * within a request, at startup or while a page renders.
 *
 * A search over a project that still has stale rows reports itself as
 * incomplete (`complete: false`, with the number still pending) rather than
 * presenting partial results as complete.
 */

/** At most this many stale rows are re-derived by one search request. */
export const SEARCH_INDEX_BATCH_ROWS = 25;

/**
 * At most this many bytes of stored text (title + category + content, UTF-8 as
 * the database measures it) are re-derived by one search request. One row is
 * always admitted so progress is guaranteed; a single document is at most
 * 50,000 characters (≤ 200,000 bytes) plus its title and category, inside this.
 */
export const SEARCH_INDEX_BATCH_BYTES = 256 * 1024;

export interface StaleCandidate {
  id: string;
  bytes: number;
}

/**
 * The ids to re-derive now: candidates in the order given (callers order by id,
 * so progress is deterministic), stopping before the row or byte budget would
 * be exceeded — except that the first candidate is always taken.
 */
export function chooseSearchIndexBatch(
  candidates: readonly StaleCandidate[],
  budget: { rows: number; bytes: number } = { rows: SEARCH_INDEX_BATCH_ROWS, bytes: SEARCH_INDEX_BATCH_BYTES },
): string[] {
  const chosen: string[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (chosen.length >= budget.rows) break;
    const size = Math.max(0, Number(candidate.bytes) || 0);
    if (chosen.length > 0 && bytes + size > budget.bytes) break;
    chosen.push(candidate.id);
    bytes += size;
  }
  return chosen;
}
