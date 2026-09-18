import "server-only";

import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { getPgDb } from "@/db/pg-client";
import { users, workspaceMembers, workspaces } from "@/db/schema.pg";
import { createId, slugify } from "@/lib/ids";
import { pgErrorCode, UNIQUE_VIOLATION } from "@/db/pg-errors";
import type {
  ListMembersOptions,
  PaginatedMembersResult,
  Workspace,
  WorkspaceMembership,
  WorkspaceMemberStatus,
  WorkspaceMemberSummary,
  WorkspaceRole,
  WorkspaceWithRole,
} from "./types";

/**
 * Thrown when an operation would leave a workspace with zero owners — the
 * friendly form of the `workspace_member_last_owner` trigger's exception
 * (see drizzle-pg/0002_workspace_last_owner_trigger.sql), which is the real
 * enforcement; this just gives callers something nicer than a raw Postgres
 * error to show a user.
 */
export class LastOwnerError extends Error {
  constructor() {
    super("A workspace must always have at least one owner.");
    this.name = "LastOwnerError";
  }
}

function isLastOwnerViolation(error: unknown): boolean {
  // Raised via plain RAISE EXCEPTION, so its SQLSTATE is the generic P0001
  // ("raise_exception"), not a code specific to this trigger — matching on
  // the message is what actually identifies it. Drizzle wraps the real
  // Postgres error in a `DrizzleQueryError` whose own `.message` is just
  // "Failed query: ..."; the trigger's message is on `.cause` instead.
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.message.includes("workspace must retain at least one owner")) return true;
  }
  return false;
}

/** Wraps the trigger's raw exception in `LastOwnerError`; rethrows anything else unchanged. */
async function translatingLastOwnerErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isLastOwnerViolation(error)) throw new LastOwnerError();
    throw error;
  }
}

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind as Workspace["kind"],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMembership(row: typeof workspaceMembers.$inferSelect): WorkspaceMembership {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role as WorkspaceRole,
    status: row.status as WorkspaceMemberStatus,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
  };
}

/** Appends a short random suffix until `candidate` isn't already taken. */
async function uniqueSlug(base: string): Promise<string> {
  const db = getPgDb();
  const root = slugify(base) || "workspace";

  let candidate = root;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const [existing] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
    candidate = `${root}-${createId().slice(-6)}`;
  }
  throw new Error(`Could not generate a unique slug for "${base}"`);
}

/** A workspace by id, with no membership check — callers authorize separately. */
export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  const db = getPgDb();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row ? toWorkspace(row) : null;
}

export async function findPersonalWorkspace(userId: string): Promise<Workspace | null> {
  const db = getPgDb();
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.createdBy, userId), eq(workspaces.kind, "personal")))
    .limit(1);
  return row ? toWorkspace(row) : null;
}

/** Creates a personal workspace and its owner membership in one transaction. */
export async function createPersonalWorkspace(
  userId: string,
  displayName?: string | null,
): Promise<Workspace> {
  const db = getPgDb();
  const name = displayName?.trim() || "Personal";
  const slug = await uniqueSlug(`${name}-${userId.slice(0, 8)}`);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workspaces)
      .values({ id: createId("ws"), name, slug, kind: "personal", createdBy: userId })
      .returning();
    if (!row) throw new Error("Failed to create personal workspace");

    await tx.insert(workspaceMembers).values({
      workspaceId: row.id,
      userId,
      role: "owner",
    });

    return toWorkspace(row);
  });
}

/**
 * Guarantees the user has a personal workspace, creating one if they don't.
 *
 * Called from two places: `events.createUser` in src/auth.ts (the normal
 * path, fires exactly once at true first sign-in) and lazily wherever a
 * request resolves the current user's workspaces (the self-heal — covers
 * that event handler's effect being lost, e.g. to a transient failure at
 * exactly the wrong moment). Both can race safely: the partial unique index
 * `workspace_personal_owner_idx` (one personal workspace per `created_by`)
 * means a losing concurrent attempt fails with a unique violation here,
 * which is treated as "someone else just created it" rather than an error.
 */
export async function ensurePersonalWorkspace(
  userId: string,
  displayName?: string | null,
): Promise<Workspace> {
  const existing = await findPersonalWorkspace(userId);
  if (existing) return existing;

  try {
    return await createPersonalWorkspace(userId, displayName);
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      const raceWinner = await findPersonalWorkspace(userId);
      if (raceWinner) return raceWinner;
    }
    throw error;
  }
}

/** Creates a team workspace with the caller as its sole, initial owner. */
export async function createTeamWorkspace(userId: string, name: string): Promise<Workspace> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A workspace needs a name.");

  const db = getPgDb();
  const slug = await uniqueSlug(trimmed);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workspaces)
      .values({ id: createId("ws"), name: trimmed, slug, kind: "team", createdBy: userId })
      .returning();
    if (!row) throw new Error("Failed to create workspace");

    await tx.insert(workspaceMembers).values({
      workspaceId: row.id,
      userId,
      role: "owner",
    });

    return toWorkspace(row);
  });
}

/**
 * Every workspace a user belongs to, with their role in each, ordered
 * newest-first. `limit` is optional (and omitted by every caller from
 * step 3, so their behavior is unaffected) — the workspace-management API
 * route passes one, since a list a user can keep growing (accepting team
 * invitations over years) should be capped rather than fetched whole.
 */
export async function listWorkspacesForUser(
  userId: string,
  limit?: number,
): Promise<WorkspaceWithRole[]> {
  const db = getPgDb();
  let query = db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")))
    .orderBy(desc(workspaces.createdAt))
    .$dynamic();
  if (limit) query = query.limit(limit);
  const rows = await query;

  return rows.map(({ workspace, role }) => ({
    ...toWorkspace(workspace),
    role: role as WorkspaceRole,
  }));
}

/** A user's membership in a specific workspace, or null if they aren't a member. */
export async function getMembership(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMembership | null> {
  const db = getPgDb();
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row ? toMembership(row) : null;
}

/** Every member of a workspace. */
export async function listMembers(workspaceId: string): Promise<WorkspaceMembership[]> {
  const db = getPgDb();
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return rows.map(toMembership);
}

/**
 * Changes a member's role. Rejects (via the DB trigger, translated to
 * `LastOwnerError`) a demotion that would leave the workspace with no owner.
 */
export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await translatingLastOwnerErrors(async () => {
    const db = getPgDb();
    await db
      .update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  });
}

/**
 * Removes a member from a workspace. Rejects (via the DB trigger, translated
 * to `LastOwnerError`) removing a workspace's last owner.
 */
export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await translatingLastOwnerErrors(async () => {
    const db = getPgDb();
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  });
}

export const DEFAULT_MEMBER_PAGE_SIZE = 20;
export const MAX_MEMBER_PAGE_SIZE = 100;
export const MIN_MEMBER_PAGE_SIZE = 1;
export const MAX_SEARCH_LENGTH = 100;

function escapeSqlLike(term: string): string {
  return term.replace(/([\\%_])/g, "\\$1");
}

/**
 * Paginated, searchable workspace member directory query.
 *
 * Invariants:
 * - Scopes directly to `workspaceId` in the SQL WHERE clause — never filters in memory.
 * - Enforces minimum (1) and maximum (100) bounds on page size to prevent unbounded queries.
 * - Searches across user `name` and `email` using case-insensitive ILIKE with literal wildcard escaping.
 * - Caps search input length at MAX_SEARCH_LENGTH (100 chars).
 * - Selects ONLY safe user-summary fields: (id, name, email, image, role, status, joinedAt).
 *   Never selects or returns account credentials, sessions, password hashes, emailVerified internals,
 *   or cross-workspace memberships.
 */
export async function listMembersPaginated(
  workspaceId: string,
  options?: ListMembersOptions,
): Promise<PaginatedMembersResult> {
  const db = getPgDb();

  const rawLimit = options?.limit ?? DEFAULT_MEMBER_PAGE_SIZE;
  const limit = Math.max(
    MIN_MEMBER_PAGE_SIZE,
    Math.min(
      MAX_MEMBER_PAGE_SIZE,
      Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_MEMBER_PAGE_SIZE,
    ),
  );
  const rawOffset = options?.offset ?? 0;
  const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);

  const conditions: SQL[] = [eq(workspaceMembers.workspaceId, workspaceId)];

  if (options?.status && options.status !== "all") {
    conditions.push(eq(workspaceMembers.status, options.status));
  }

  if (options?.search) {
    const rawSearch = options.search.trim();
    if (rawSearch.length > 0) {
      const term = rawSearch.slice(0, MAX_SEARCH_LENGTH);
      const escaped = escapeSqlLike(term);
      const pattern = `%${escaped}%`;
      conditions.push(
        or(
          sql`${users.name} ILIKE ${pattern} ESCAPE ${"\\"}`,
          sql`${users.email} ILIKE ${pattern} ESCAPE ${"\\"}`,
        )!,
      );
    }
  }

  const whereClause = and(...conditions);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(whereClause);

  const total = Number(countRow?.count ?? 0);

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      role: workspaceMembers.role,
      status: workspaceMembers.status,
      joinedAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(whereClause)
    .orderBy(asc(users.name), asc(workspaceMembers.userId))
    .limit(limit)
    .offset(offset);

  return {
    members: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      image: row.image,
      role: row.role as WorkspaceRole,
      status: row.status as WorkspaceMemberStatus,
      joinedAt: row.joinedAt,
    })),
    total,
    limit,
    offset,
  };
}

/**
 * Changes a member's status (active | invited | suspended | removed).
 * Rejects (via the DB trigger, translated to `LastOwnerError`) suspending
 * or removing a workspace's last active owner.
 */
export async function updateMemberStatus(
  workspaceId: string,
  userId: string,
  status: WorkspaceMemberStatus,
): Promise<void> {
  await translatingLastOwnerErrors(async () => {
    const db = getPgDb();
    await db
      .update(workspaceMembers)
      .set({ status })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  });
}

