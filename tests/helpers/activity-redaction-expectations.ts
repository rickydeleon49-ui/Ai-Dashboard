/**
 * One definition of the "safe deleted-comment event" shape, shared by the
 * PostgreSQL and SQLite suites so both databases are held to identical output.
 */
import assert from "node:assert/strict";

interface ActivityEventLike {
  type: string;
  actorId: string | null;
  details: Record<string, unknown>;
}

export const LIFECYCLE_TYPES = ["comment.created", "comment.edited", "comment.deleted"] as const;

/** A lifecycle event for a deleted comment exposes only its type and commentId. */
export function assertSafeDeletedCommentEvent(
  event: ActivityEventLike,
  commentId: string,
  forbiddenIds: readonly string[],
): void {
  assert.equal(event.actorId, null, `${event.type} must not expose an actor`);
  assert.deepEqual(event.details, { commentId }, `${event.type} details must be reduced to commentId`);
  const serialized = JSON.stringify(event);
  for (const id of forbiddenIds) {
    assert.ok(!serialized.includes(id), `${event.type} must not contain identity ${id}`);
  }
}

/** Every lifecycle event for `commentId` in `events`, keyed by type. */
export function lifecycleEventsFor<T extends ActivityEventLike>(
  events: readonly T[],
  commentId: string,
): Map<string, T> {
  const byType = new Map<string, T>();
  for (const event of events) {
    if ((LIFECYCLE_TYPES as readonly string[]).includes(event.type) && event.details.commentId === commentId) {
      byType.set(event.type, event);
    }
  }
  return byType;
}
