/**
 * Output policy for comment lifecycle events on the normal activity endpoints.
 *
 * Stored activity rows are immutable audit records. Once a comment is
 * soft-deleted, the comment endpoints hide its author, deleter, and body, but
 * the lifecycle events would still reveal that (the author is the actor on
 * comment.created and comment.edited, the deleter on comment.deleted, and
 * comment.created carries the mentioned user IDs). So listings sanitize those
 * events on the way out, for every caller role alike.
 *
 * Default-safe: an event is only shown in full when its comment is proven live
 * within the listing's own workspace and task/project scope. Missing, deleted,
 * or out-of-scope comments, and events without a usable commentId, all redact.
 */
import type { TaskActivityEvent } from "./comment-types";

export const COMMENT_LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "comment.created",
  "comment.edited",
  "comment.deleted",
]);

function commentIdOf(event: TaskActivityEvent): string | null {
  const id = event.details?.commentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function hasCommentLifecycleEvents(events: readonly TaskActivityEvent[]): boolean {
  return events.some((event) => COMMENT_LIFECYCLE_EVENT_TYPES.has(event.type));
}

/** Distinct comment IDs referenced by the comment lifecycle events in one page. */
export function collectCommentLifecycleIds(events: readonly TaskActivityEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (!COMMENT_LIFECYCLE_EVENT_TYPES.has(event.type)) continue;
    const id = commentIdOf(event);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Returns sanitized copies: comment lifecycle events whose comment isn't in
 * `liveCommentIds` get `actorId: null` and `details` reduced to `{ commentId }`.
 * Every other event passes through unchanged.
 */
export function redactDeletedCommentEvents(
  events: readonly TaskActivityEvent[],
  liveCommentIds: ReadonlySet<string>,
): TaskActivityEvent[] {
  return events.map((event) => {
    if (!COMMENT_LIFECYCLE_EVENT_TYPES.has(event.type)) return event;
    const commentId = commentIdOf(event);
    if (commentId && liveCommentIds.has(commentId)) return event;
    return {
      ...event,
      actorId: null,
      details: commentId ? { commentId } : {},
    };
  });
}
