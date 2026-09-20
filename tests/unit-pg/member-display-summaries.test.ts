/**
 * Release 2C.2 Stage 1A & 1B: Member Display Summaries Tests (PostgreSQL).
 *
 * Verifies:
 * 1. Service-level privacy and role enforcement:
 *    - member or viewer caller gets no email, role, or joinedAt for suspended or removed members
 *    - admin or owner caller gets full safe summary (email, role, status, joinedAt)
 *    - active members get full safe summary for all callers
 * 2. Cross-workspace isolation:
 *    - user IDs from another workspace resolve to nothing
 * 3. Scoping & deduplication:
 *    - only members whose IDs are passed in userIds are returned
 *    - duplicates in userIds are deduplicated
 *    - non-member user IDs return nothing
 *    - empty userIds returns empty array
 * 4. Stage 1B (100-member cap removal):
 *    - In a workspace with >100 members, an assignee sorting past the first 100
 *      resolves their display summary successfully without hitting any pagination cap.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesService: typeof import("../../src/core/workspaces/service");

before(async () => {
  await migrate();
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, workspaceMembers } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");
});

after(async () => {
  await cleanup();
});

async function createUser(name: string, email: string) {
  const [user] = await db()
    .insert(users)
    .values({
      name,
      email,
      emailVerified: new Date(),
    })
    .returning();
  return user!;
}

async function addMember(workspaceId: string, userId: string, role: "owner" | "admin" | "member" | "viewer") {
  await db().insert(workspaceMembers).values({
    workspaceId,
    userId,
    role,
    status: "active",
  });
}

describe("getMemberDisplaySummaries", () => {
  it("enforces privacy rules based on callerRole (Stage 1A)", async () => {
    // 1. Setup workspace with owner, admin, member, viewer, and 3 targets (active, suspended, removed)
    const owner = await createUser("Owner User", "owner@example.com");
    const admin = await createUser("Admin User", "admin@example.com");
    const member = await createUser("Member User", "member@example.com");
    const viewer = await createUser("Viewer User", "viewer@example.com");

    const activeColleague = await createUser("Active Colleague", "active@example.com");
    const suspendedColleague = await createUser("Suspended Colleague", "suspended@example.com");
    const removedColleague = await createUser("Removed Colleague", "removed@example.com");

    const ws = await workspacesService.createTeamWorkspace(owner.id, "Privacy Test WS");

    await addMember(ws.id, admin.id, "admin");
    await addMember(ws.id, member.id, "member");
    await addMember(ws.id, viewer.id, "viewer");

    await addMember(ws.id, activeColleague.id, "member");
    await addMember(ws.id, suspendedColleague.id, "member");
    await addMember(ws.id, removedColleague.id, "member");

    // Suspend one, remove one
    await workspacesService.updateMemberStatus(ws.id, suspendedColleague.id, "suspended", {
      callerRole: "owner",
    });
    await workspacesService.removeMember(ws.id, removedColleague.id, {
      callerRole: "owner",
    });

    const targetIds = [activeColleague.id, suspendedColleague.id, removedColleague.id];

    // 2. Viewer caller
    const viewerResults = await workspacesService.getMemberDisplaySummaries(ws.id, targetIds, "viewer");
    assert.equal(viewerResults.length, 3);
    const viewerMap = new Map(viewerResults.map((m) => [m.id, m]));

    // Active member has full summary
    const viewerActive = viewerMap.get(activeColleague.id)!;
    assert.equal(viewerActive.name, "Active Colleague");
    assert.equal(viewerActive.status, "active");
    assert.equal(viewerActive.email, "active@example.com");
    assert.equal(viewerActive.role, "member");
    assert.ok(viewerActive.joinedAt instanceof Date);

    // Suspended member has minimal summary: NO email, role, or joinedAt
    const viewerSuspended = viewerMap.get(suspendedColleague.id)!;
    assert.equal(viewerSuspended.name, "Suspended Colleague");
    assert.equal(viewerSuspended.status, "suspended");
    assert.equal(viewerSuspended.email, undefined);
    assert.equal(viewerSuspended.role, undefined);
    assert.equal(viewerSuspended.joinedAt, undefined);
    assert.equal("email" in viewerSuspended, false, "email key must not be present");
    assert.equal("role" in viewerSuspended, false, "role key must not be present");
    assert.equal("joinedAt" in viewerSuspended, false, "joinedAt key must not be present");

    // Removed member has minimal summary: NO email, role, or joinedAt
    const viewerRemoved = viewerMap.get(removedColleague.id)!;
    assert.equal(viewerRemoved.name, "Removed Colleague");
    assert.equal(viewerRemoved.status, "removed");
    assert.equal(viewerRemoved.email, undefined);
    assert.equal(viewerRemoved.role, undefined);
    assert.equal(viewerRemoved.joinedAt, undefined);
    assert.equal("email" in viewerRemoved, false, "email key must not be present");
    assert.equal("role" in viewerRemoved, false, "role key must not be present");
    assert.equal("joinedAt" in viewerRemoved, false, "joinedAt key must not be present");

    // 3. Member caller: exact same privacy enforcement as viewer
    const memberResults = await workspacesService.getMemberDisplaySummaries(ws.id, targetIds, "member");
    const memberMap = new Map(memberResults.map((m) => [m.id, m]));
    const memberSuspended = memberMap.get(suspendedColleague.id)!;
    assert.equal(memberSuspended.status, "suspended");
    assert.equal(memberSuspended.email, undefined);
    assert.equal("email" in memberSuspended, false);

    // 4. Admin caller: elevated role receives full safe summary
    const adminResults = await workspacesService.getMemberDisplaySummaries(ws.id, targetIds, "admin");
    const adminMap = new Map(adminResults.map((m) => [m.id, m]));

    const adminSuspended = adminMap.get(suspendedColleague.id)!;
    assert.equal(adminSuspended.name, "Suspended Colleague");
    assert.equal(adminSuspended.status, "suspended");
    assert.equal(adminSuspended.email, "suspended@example.com");
    assert.equal(adminSuspended.role, "member");
    assert.ok(adminSuspended.joinedAt instanceof Date);

    const adminRemoved = adminMap.get(removedColleague.id)!;
    assert.equal(adminRemoved.name, "Removed Colleague");
    assert.equal(adminRemoved.status, "removed");
    assert.equal(adminRemoved.email, "removed@example.com");
    assert.equal(adminRemoved.role, "member");
    assert.ok(adminRemoved.joinedAt instanceof Date);

    // 5. Owner caller: elevated role also receives full safe summary
    const ownerResults = await workspacesService.getMemberDisplaySummaries(ws.id, targetIds, "owner");
    const ownerMap = new Map(ownerResults.map((m) => [m.id, m]));
    const ownerSuspended = ownerMap.get(suspendedColleague.id)!;
    assert.equal(ownerSuspended.email, "suspended@example.com");
  });

  it("enforces cross-workspace isolation: user IDs from another workspace resolve to nothing", async () => {
    const userA = await createUser("User A", "usera@example.com");
    const userB = await createUser("User B", "userb@example.com");

    const ws1 = await workspacesService.createTeamWorkspace(userA.id, "Workspace 1");
    const ws2 = await workspacesService.createTeamWorkspace(userB.id, "Workspace 2");

    // Query ws1 with userB (member of ws2 only)
    const res1 = await workspacesService.getMemberDisplaySummaries(ws1.id, [userB.id], "owner");
    assert.deepEqual(res1, [], "cross-workspace user ID must resolve to nothing");

    // Query ws1 with both userA and userB
    const res2 = await workspacesService.getMemberDisplaySummaries(ws1.id, [userA.id, userB.id], "owner");
    assert.equal(res2.length, 1);
    assert.equal(res2[0]?.id, userA.id);
  });

  it("scopes strictly to referenced IDs and handles edge cases", async () => {
    const user1 = await createUser("Scoped 1", "s1@example.com");
    const user2 = await createUser("Scoped 2", "s2@example.com");
    const user3 = await createUser("Scoped 3", "s3@example.com");

    const ws = await workspacesService.createTeamWorkspace(user1.id, "Scoping WS");
    await addMember(ws.id, user2.id, "member");
    await addMember(ws.id, user3.id, "member");

    // Only requesting user2 — user1 and user3 must not be returned
    const res = await workspacesService.getMemberDisplaySummaries(ws.id, [user2.id], "member");
    assert.equal(res.length, 1);
    assert.equal(res[0]?.id, user2.id);

    // Duplicated IDs in list
    const resDedupe = await workspacesService.getMemberDisplaySummaries(
      ws.id,
      [user2.id, user2.id, user2.id],
      "member",
    );
    assert.equal(resDedupe.length, 1);

    // Empty list
    const resEmpty = await workspacesService.getMemberDisplaySummaries(ws.id, [], "member");
    assert.deepEqual(resEmpty, []);

    // Non-existent ID
    const resNonExistent = await workspacesService.getMemberDisplaySummaries(
      ws.id,
      ["non-existent-user-id"],
      "member",
    );
    assert.deepEqual(resNonExistent, []);
  });

  it("resolves display summary without being limited by 100-member cap (Stage 1B)", async () => {
    const owner = await createUser("Cap Owner", "capowner@example.com");
    const ws = await workspacesService.createTeamWorkspace(owner.id, "Large Workspace");

    // Create 105 members in this workspace
    // The 105th member will sort past the first 100
    const member105 = await createUser("ZZZ Last Member", "zzz_member105@example.com");
    await addMember(ws.id, member105.id, "member");

    // Insert 104 dummy users and memberships efficiently in batches
    const dummyUsers = await db()
      .insert(users)
      .values(
        Array.from({ length: 104 }, (_, i) => ({
          name: `Member ${String(i + 1).padStart(3, "0")}`,
          email: `bulk_member_${i + 1}_${Date.now()}@example.com`,
          emailVerified: new Date(),
        })),
      )
      .returning();

    await db()
      .insert(workspaceMembers)
      .values(
        dummyUsers.map((u) => ({
          workspaceId: ws.id,
          userId: u.id,
          role: "member" as const,
          status: "active" as const,
        })),
      );

    // Verify listMembersPaginated caps at 100
    const paginated = await workspacesService.listMembersPaginated(ws.id, {
      status: "all",
      callerRole: "owner",
      limit: 200,
    });
    assert.equal(paginated.members.length, 100, "listMembersPaginated is capped to MAX_MEMBER_PAGE_SIZE (100)");

    // Because ZZZ Last Member is after the first 100, it is NOT in paginated.members
    const foundInPaginated = paginated.members.some((m) => m.id === member105.id);
    assert.equal(foundInPaginated, false, "member #105 is beyond the 100-member pagination cap");

    // Now verify getMemberDisplaySummaries resolves member105 without any 100 cap
    const summaries = await workspacesService.getMemberDisplaySummaries(ws.id, [member105.id], "viewer");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.id, member105.id);
    assert.equal(summaries[0]?.name, "ZZZ Last Member");
    assert.equal(summaries[0]?.email, "zzz_member105@example.com");
  });
});
