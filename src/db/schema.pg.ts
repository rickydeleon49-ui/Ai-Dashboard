/**
 * Database schema (PostgreSQL via Drizzle) — hosted multi-user mode only.
 *
 * Separate from `schema.ts` (SQLite) deliberately: Drizzle's `sqlite-core` and
 * `pg-core` table builders are not interchangeable, so there is no way to share
 * table definitions between the two dialects. Desktop and today's single-
 * password hosted mode never read this file or connect to Postgres at all —
 * this schema only exists once `DATABASE_URL` is configured.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/**
 * Auth.js's required tables, in the exact shape `@auth/drizzle-adapter`'s
 * Postgres adapter expects (its own default schema is not exported as an
 * importable subpath, so this mirrors it rather than reimplementing the
 * adapter's logic — matching its column names/types is what matters, not
 * matching its file layout).
 */
export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
  ],
);

/**
 * The workspace domain: personal and team workspaces, membership and roles,
 * pending invitations. Nothing outside hosted multi-user mode reads these —
 * desktop stays account-free and single-tenant forever.
 */

export const workspaces = pgTable(
  "workspace",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    /** 'personal' | 'team' */
    kind: text("kind").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    check("workspace_kind_check", sql`${t.kind} in ('personal', 'team')`),
    // Exactly one personal workspace per user. Also what makes the
    // create-personal-workspace self-heal (see core/workspaces/service.ts)
    // safe under a race: a second concurrent attempt just hits this and
    // fails, rather than creating a duplicate.
    uniqueIndex("workspace_personal_owner_idx")
      .on(t.createdBy)
      .where(sql`${t.kind} = 'personal'`),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_member",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 'owner' | 'admin' | 'member' | 'viewer' */
    role: text("role").notNull(),
    invitedBy: text("invited_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    // "Which workspaces does this user belong to" is the other direction
    // every membership lookup needs, beyond the primary key's own order.
    index("workspace_member_user_idx").on(t.userId),
    check(
      "workspace_member_role_check",
      sql`${t.role} in ('owner', 'admin', 'member', 'viewer')`,
    ),
  ],
);

export const workspaceInvitations = pgTable(
  "workspace_invitation",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Invited by address; the invitee may not have an account yet. */
    email: text("email").notNull(),
    /** 'admin' | 'member' | 'viewer' — never 'owner'. An invite cannot mint
     * an owner; ownership transfer is a separate action between an existing
     * owner and an existing member. */
    role: text("role").notNull(),
    /** sha-256 of the raw token. The raw token is never persisted. */
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
    acceptedAt: timestamp("accepted_at", { mode: "date" }),
    acceptedBy: text("accepted_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("workspace_invitation_workspace_idx").on(t.workspaceId),
    check(
      "workspace_invitation_role_check",
      sql`${t.role} in ('admin', 'member', 'viewer')`,
    ),
    // At most one live (pending) invite per (workspace, email) — re-inviting
    // the same address just means there is already one outstanding.
    uniqueIndex("workspace_invitation_pending_idx")
      .on(t.workspaceId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);
