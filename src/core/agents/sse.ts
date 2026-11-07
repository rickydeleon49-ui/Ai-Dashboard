/**
 * SSE helpers for GET /api/agent-runs/:id/events (design §8).
 * Kept out of the route file: Next.js route modules may export only handlers and config.
 */

/** Start sequence for replay: Last-Event-ID header wins, then ?after=, else 0. Non-numeric values are ignored. */
export function resolveAfterSeq(
  lastEventIdHeader: string | null | undefined,
  afterParam: string | null | undefined,
): number {
  if (lastEventIdHeader !== null && lastEventIdHeader !== undefined) {
    const trimmed = lastEventIdHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }

  if (afterParam !== null && afterParam !== undefined) {
    const trimmed = afterParam.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }

  return 0;
}
