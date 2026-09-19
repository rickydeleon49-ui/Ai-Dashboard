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

export class RemovedMemberTransitionError extends Error {
  constructor(message = "Removed members must be re-invited.") {
    super(message);
    this.name = "RemovedMemberTransitionError";
  }
}

export class InvalidMemberTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemberTransitionError";
  }
}

export class MemberNotFoundError extends Error {
  constructor(message = "Member not found in this workspace.") {
    super(message);
    this.name = "MemberNotFoundError";
  }
}

export class ForbiddenMemberActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenMemberActionError";
  }
}

export interface UpdateMemberOptions {
  callerRole?: WorkspaceRole;
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
 * Atomically updates a member's role and/or status within a single transaction.
 * Locks the target membership row with SELECT ... FOR UPDATE before evaluating
 * role constraints and status transition invariants to prevent write skew or
 * concurrent privilege escalation.
 */
export async function updateMember(
  workspaceId: string,
  targetUserId: string,
  updates: { role?: WorkspaceRole; status?: WorkspaceMemberStatus },
  options?: UpdateMemberOptions,
): Promise<WorkspaceMemberSummary> {
  return await translatingLastOwnerErrors(async () => {
    const db = getPgDb();
    return await db.transaction(async (tx) => {
      // 1. Lock the target membership row with SELECT ... FOR UPDATE
      const [lockedMember] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        )
        .for("update");

      if (!lockedMember) {
        throw new MemberNotFoundError("Member not found in this workspace.");
      }

      const currentRole = lockedMember.role as WorkspaceRole;
      const currentStatus = lockedMember.status as WorkspaceMemberStatus;

      // 2. Permission checks against locked row
      if (options?.callerRole === "admin") {
        if (currentRole === "owner" || currentRole === "admin") {
          throw new ForbiddenMemberActionError("Admins cannot modify owners or other admins.");
        }
        if (updates.role === "owner" || updates.role === "admin") {
          throw new ForbiddenMemberActionError("Admins cannot grant admin or owner role.");
        }
      }

      // 3. Status and transition checks
      if (updates.status === "invited") {
        throw new InvalidMemberTransitionError(
          "The 'invited' status cannot be set directly; use the invitation flow.",
        );
      }

      if (currentStatus === "removed") {
        throw new RemovedMemberTransitionError("Removed members must be re-invited.");
      }

      if (updates.status && updates.status !== currentStatus) {
        const allowed =
          (currentStatus === "active" && (updates.status === "suspended" || updates.status === "removed")) ||
          (currentStatus === "suspended" && (updates.status === "active" || updates.status === "removed")) ||
          (currentStatus === "invited" && updates.status === "active");

        if (!allowed) {
          throw new InvalidMemberTransitionError(
            `Transition from ${currentStatus} to ${updates.status} is not allowed.`,
          );
        }
      }

      // 4. Apply role and status atomically
      const toSet: { role?: WorkspaceRole; status?: WorkspaceMemberStatus } = {};
      if (updates.role && updates.role !== currentRole) {
        toSet.role = updates.role;
      }
      if (updates.status && updates.status !== currentStatus) {
        toSet.status = updates.status;
      }

      if (Object.keys(toSet).length > 0) {
        await tx
          .update(workspaceMembers)
          .set(toSet)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, targetUserId),
            ),
          );
      }

      const [userRow] = await tx
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          image: users.image,
        })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);

      return {
        id: targetUserId,
        name: userRow?.name ?? null,
        email: userRow?.email ?? null,
        image: userRow?.image ?? null,
        role: (toSet.role ?? currentRole) as WorkspaceRole,
        status: (toSet.status ?? currentStatus) as WorkspaceMemberStatus,
        joinedAt: lockedMember.createdAt,
      };
    });
  });
}

/**
 * Changes a member's role. Rejects (via the DB trigger, translated to
 * `LastOwnerError`) a demotion that would leave the workspace with no owner.
 */
export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  options?: UpdateMemberOptions,
): Promise<void> {
  await updateMember(workspaceId, userId, { role }, options);
}

/**
 * Removes a member from a workspace (soft removal: sets status = 'removed').
 * Preserves historical task assignments and attribution. Rejects (via the DB trigger,
 * translated to `LastOwnerError`) removing a workspace's last active owner.
 */
export async function removeMember(
  workspaceId: string,
  userId: string,
  options?: UpdateMemberOptions,
): Promise<void> {
  await translatingLastOwnerErrors(async () => {
    const db = getPgDb();
    await db.transaction(async (tx) => {
      const [lockedMember] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .for("update");

      if (!lockedMember) {
        throw new MemberNotFoundError("Member not found in this workspace.");
      }

      const currentRole = lockedMember.role as WorkspaceRole;
      const currentStatus = lockedMember.status as WorkspaceMemberStatus;

      if (options?.callerRole === "admin") {
        if (currentRole === "owner" || currentRole === "admin") {
          throw new ForbiddenMemberActionError("Admins cannot remove owners or other admins.");
        }
      }

      if (currentStatus === "removed") {
        throw new RemovedMemberTransitionError("Removed members must be re-invited.");
      }

      await tx
        .update(workspaceMembers)
        .set({ status: "removed" })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
    });
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
 * - Directory visibility: members and viewers see only 'active' members. Admins and owners can filter by any status.
 *   Default filter is 'active' for everyone.
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

  let requestedStatus = options?.status ?? "active";
  const isElevated = options?.callerRole === "owner" || options?.callerRole === "admin";
  if (!isElevated) {
    requestedStatus = "active";
  }

  if (requestedStatus !== "all") {
    conditions.push(eq(workspaceMembers.status, requestedStatus));
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
 * Changes a member's status (active | suspended | removed).
 * The 'invited' status cannot be set directly (only created via invitations).
 * Rejects (via the DB trigger, translated to `LastOwnerError`) suspending
 * or removing a workspace's last active owner.
 */
export async function updateMemberStatus(
  workspaceId: string,
  userId: string,
  status: WorkspaceMemberStatus,
  options?: UpdateMemberOptions,
): Promise<void> {
  await updateMember(workspaceId, userId, { status }, options);
}

/** Returns the safe summary for a single member, or null if not found. */
export async function getMemberSummary(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberSummary | null> {
  const db = getPgDb();
  const [row] = await db
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
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    role: row.role as WorkspaceRole,
    status: row.status as WorkspaceMemberStatus,
    joinedAt: row.joinedAt,
  };
}


