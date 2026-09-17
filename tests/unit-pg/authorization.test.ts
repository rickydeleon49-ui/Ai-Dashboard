/**
 * The workspace authorization helper, against real Postgres: requireRole()
 * re-derives a caller's role fresh from workspace_member on every call, and
 * is the defense-in-depth check every workspace-scoped route handler will
 * use (proxy.ts, from step 4, only confirms someone is signed in — never
 * that they belong to the specific workspace a route operates on).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesTable: typeof import("../../src/db/schema.pg").workspaces;
let workspaces: typeof import("../../src/core/workspaces/service");
let authz: typeof import("../../src/core/workspaces/authorization");

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaceMembers, workspaces: workspacesTable } = await import("../../src/db/schema.pg"));
  workspaces = await import("../../src/core/workspaces/service");
  authz = await import("../../src/core/workspaces/authorization");
});

after(() => cleanup());

let userCounter = 0;

/** Inserts a throwaway user row and returns its id. */
async function makeUser(): Promise<string> {
  userCounter += 1;
  const id = `user_${userCounter}_${Date.now()}`;
  await db().insert(users).values({ id, email: `${id}@example.com` });
  return id;
}

beforeEach(async () => {
  await db().delete(workspacesTable);
  await db().delete(users);
  userCounter = 0;
});

describe("requireRole", () => {
  it("rejects when there is no signed-in user", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");

    await assert.rejects(
      () => authz.requireRole(ws.id, undefined, "viewer"),
      (error: unknown) => {
        assert.ok(error instanceof authz.AuthorizationError);
        assert.equal(error.reason, "unauthenticated");
        return true;
      },
    );
  });

  it("rejects a real user who never joined the workspace", async () => {
    const owner = await makeUser();
    const outsider = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");

    await assert.rejects(
      () => authz.requireRole(ws.id, outsider, "viewer"),
      (error: unknown) => {
        assert.ok(error instanceof authz.AuthorizationError);
        assert.equal(error.reason, "not_a_member");
        return true;
      },
    );
  });

  it("rejects a member whose role is below the minimum required", async () => {
    const owner = await makeUser();
    const viewerUser = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    await db()
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: viewerUser, role: "viewer" });

    await assert.rejects(
      () => authz.requireRole(ws.id, viewerUser, "admin"),
      (error: unknown) => {
        assert.ok(error instanceof authz.AuthorizationError);
        assert.equal(error.reason, "insufficient_role");
        return true;
      },
    );
  });

  it("allows a member whose role exactly matches the minimum", async () => {
    const owner = await makeUser();
    const memberUser = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");
    await db()
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: memberUser, role: "member" });

    const membership = await authz.requireRole(ws.id, memberUser, "member");
    assert.equal(membership.role, "member");
  });

  it("every role can act at or below its own level, and only its own level", async () => {
    const owner = await makeUser();
    const ws = await workspaces.createTeamWorkspace(owner, "Acme");

    // Most-to-least powerful, matching WORKSPACE_ROLES' own order.
    const rolesMostToLeastPowerful = ["owner", "admin", "member", "viewer"] as const;
    type Role = (typeof rolesMostToLeastPowerful)[number];

    for (const [i, role] of rolesMostToLeastPowerful.entries()) {
      let actingUserId: string;
      if (role === "owner") {
        // The workspace already has exactly one owner (its creator); a
        // second-owner scenario is exercised by workspaces.test.ts, not
        // needed here — reuse the creator instead of adding another.
        actingUserId = owner;
      } else {
        actingUserId = await makeUser();
        await db()
          .insert(workspaceMembers)
          .values({ workspaceId: ws.id, userId: actingUserId, role });
      }

      const atOrBelowOwnLevel: Role[] = rolesMostToLeastPowerful.slice(i);
      const moreEmpoweredThanOwnLevel: Role[] = rolesMostToLeastPowerful.slice(0, i);

      for (const requiredRole of atOrBelowOwnLevel) {
        const membership = await authz.requireRole(ws.id, actingUserId, requiredRole);
        assert.equal(membership.role, role);
      }

      for (const requiredRole of moreEmpoweredThanOwnLevel) {
        await assert.rejects(
          () => authz.requireRole(ws.id, actingUserId, requiredRole),
          authz.AuthorizationError,
          `${role} should not satisfy requireRole(..., "${requiredRole}")`,
        );
      }
    }
  });
});

describe("authorizationErrorResponse", () => {
  it("maps unauthenticated to 401", () => {
    const error = new authz.AuthorizationError("unauthenticated", "Sign-in required.");
    assert.equal(authz.authorizationErrorResponse(error).status, 401);
  });

  it("maps not_a_member to 403", () => {
    const error = new authz.AuthorizationError("not_a_member", "Not a member.");
    assert.equal(authz.authorizationErrorResponse(error).status, 403);
  });

  it("maps insufficient_role to 403", () => {
    const error = new authz.AuthorizationError("insufficient_role", "Not enough.");
    assert.equal(authz.authorizationErrorResponse(error).status, 403);
  });
});
