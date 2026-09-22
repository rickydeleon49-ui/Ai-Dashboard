/**
 * Release 2C.5 Bulk Editing API Integration Tests (Auth.js + PostgreSQL).
 *
 * Verifies:
 * 1. Role Matrix:
 *    - Owner, Admin, Member allowed to bulk edit (HTTP 200).
 *    - Viewer rejected with HTTP 403.
 *    - Suspended and Removed members rejected with HTTP 403.
 *    - Outsider rejected with HTTP 403 / 404.
 *    - Unauthenticated rejected with HTTP 401.
 * 2. Assignee Validations:
 *    - Active member succeeds with actor attribution.
 *    - Clear assignee (assigneeId: null) succeeds.
 *    - Suspended member rejected with invalid_assignee.
 *    - Removed member rejected with invalid_assignee.
 *    - Invited member rejected with invalid_assignee.
 *    - Outsider / cross-workspace user rejected with invalid_assignee.
 * 3. Milestone Validations:
 *    - Valid milestone in same project succeeds.
 *    - Clear milestone (milestoneId: null) succeeds.
 *    - Milestone from another project in same workspace rejected with invalid_milestone.
 *    - Milestone from another workspace rejected with invalid_milestone.
 * 4. Blocked Task:
 *    - Attempting status: "done" on a blocked task fails with blocked_task (retryable: false).
 * 5. Partial Failures & Stable Envelopes:
 *    - Mixed batch reports truthful requested, succeeded, and failed counts.
 * 6. Activity Attribution & Suppression:
 *    - Events logged with authenticated actor ID.
 *    - No-op updates emit zero activity events and report status: "unchanged".
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";
import type { BulkTaskUpdateResponse, TaskActivityEvent } from "../../src/core/tasks/types";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

import { eq } from "drizzle-orm";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type ProjectTasksRoute = typeof import("../../src/app/api/projects/[id]/tasks/route");
type MilestonesRoute = typeof import("../../src/app/api/projects/[id]/milestones/route");
type BulkTasksRoute = typeof import("../../src/app/api/tasks/bulk/route");
type TaskActivityRoute = typeof import("../../src/app/api/tasks/[id]/activity/route");
type WorkspaceMembersRoute = typeof import("../../src/app/api/workspaces/[id]/members/route");

let projectsRoute: ProjectsRoute;
let projectTasksRoute: ProjectTasksRoute;
let milestonesRoute: MilestonesRoute;
let bulkTasksRoute: BulkTasksRoute;
let bulkHandler: typeof import("../../src/app/api/tasks/bulk/handler");
let taskActivityRoute: TaskActivityRoute;
let workspaceMembersRoute: WorkspaceMembersRoute;

let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let db: typeof import("../../src/db/pg-client").getPgDb;
let users: typeof import("../../src/db/schema.pg").users;
let tasks: typeof import("../../src/db/schema.pg").tasks;
let workspaceMembers: typeof import("../../src/db/schema.pg").workspaceMembers;
let workspacesService: typeof import("../../src/core/workspaces/service");

let ownerCookie: string;
let adminCookie: string;
let memberCookie: string;
let viewerCookie: string;
let suspendedCookie: string;
let removedCookie: string;
let outsiderCookie: string;

let ownerId: string;
let adminId: string;
let memberId: string;
let viewerId: string;
let suspendedId: string;
let removedId: string;
let invitedId: string;
let outsiderId: string;

let workspaceA: string;
let workspaceB: string;
let projectA1Id: string;
let projectA2Id: string;
let projectBId: string;
let milestoneA1Id: string;
let milestoneA2Id: string;
let milestoneBId: string;

function cookieJar() {
  const jar = new Map<string, string>();
  return {
    header(): string {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    absorb(response: Response): void {
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value === "") jar.delete(key);
        else jar.set(key, value);
      }
    },
  };
}

async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return [await fn(), lines];
  } finally {
    console.log = original;
  }
}

async function signIn(email: string): Promise<string> {
  const jar = cookieJar();

  const csrfResponse = await handlers.GET(new NextRequest("http://localhost/api/auth/csrf"));
  jar.absorb(csrfResponse);
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const signinBody = new URLSearchParams({ email, csrfToken, callbackUrl: "http://localhost/" });
  const [signinResponse, logs] = await withCapturedLogs(() =>
    handlers.POST(
      new NextRequest("http://localhost/api/auth/signin/nodemailer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
        body: signinBody.toString(),
      }),
    ),
  );
  jar.absorb(signinResponse);

  const magicLinkLine = logs.find((line) => line.includes(`magic link for ${email}`));
  const magicLink = magicLinkLine?.match(/(http:\S+)/)?.[1];
  if (!magicLink) throw new Error(`no magic link logged for ${email}: ${JSON.stringify(logs)}`);

  const callbackResponse = await handlers.GET(
    new NextRequest(magicLink, { headers: { cookie: jar.header() } }),
  );
  jar.absorb(callbackResponse);
  assert.equal(callbackResponse.status, 302);

  return jar.header();
}

function withWorkspaceCookie(cookie: string, workspaceId: string): string {
  return `${cookie}; cc-current-workspace=${workspaceId}`;
}

function apiRequest(
  method: string,
  pathname: string,
  options?: {
    cookie?: string;
    body?: unknown;
  },
): InstanceType<typeof NextRequest> {
  const url = `http://localhost${pathname}`;
  const headers: Record<string, string> = {
    host: "localhost",
    "x-forwarded-proto": "http",
  };
  if (options?.cookie) headers["cookie"] = options.cookie;
  if (options?.body !== undefined) headers["content-type"] = "application/json";

  return new NextRequest(url, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

before(async () => {
  await migrate();

  projectsRoute = await import("../../src/app/api/projects/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  milestonesRoute = await import("../../src/app/api/projects/[id]/milestones/route");
  bulkTasksRoute = await import("../../src/app/api/tasks/bulk/route");
  bulkHandler = await import("../../src/app/api/tasks/bulk/handler");
  taskActivityRoute = await import("../../src/app/api/tasks/[id]/activity/route");
  workspaceMembersRoute = await import("../../src/app/api/workspaces/[id]/members/route");

  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ getPgDb: db } = await import("../../src/db/pg-client"));
  ({ users, tasks, workspaceMembers } = await import("../../src/db/schema.pg"));
  workspacesService = await import("../../src/core/workspaces/service");

  // Sign in test users
  ownerCookie = await signIn("bulk_owner@example.com");
  adminCookie = await signIn("bulk_admin@example.com");
  memberCookie = await signIn("bulk_member@example.com");
  viewerCookie = await signIn("bulk_viewer@example.com");
  suspendedCookie = await signIn("bulk_suspended@example.com");
  removedCookie = await signIn("bulk_removed@example.com");
  outsiderCookie = await signIn("bulk_outsider@example.com");

  const pgDb = db();
  const allUsers = await pgDb.select().from(users);
  const userMap = new Map(allUsers.map((u) => [u.email, u.id]));

  ownerId = userMap.get("bulk_owner@example.com")!;
  adminId = userMap.get("bulk_admin@example.com")!;
  memberId = userMap.get("bulk_member@example.com")!;
  viewerId = userMap.get("bulk_viewer@example.com")!;
  suspendedId = userMap.get("bulk_suspended@example.com")!;
  removedId = userMap.get("bulk_removed@example.com")!;
  outsiderId = userMap.get("bulk_outsider@example.com")!;

  // Create invited user without cookie
  invitedId = `usr_invited_${Date.now()}`;
  await pgDb.insert(users).values({ id: invitedId, email: "bulk_invited@example.com" });

  // Create Workspace A and memberships
  const wsA = await workspacesService.createTeamWorkspace(ownerId, "Bulk Workspace A");
  workspaceA = wsA.id;

  await pgDb.insert(workspaceMembers).values([
    { workspaceId: workspaceA, userId: adminId, role: "admin", status: "active" },
    { workspaceId: workspaceA, userId: memberId, role: "member", status: "active" },
    { workspaceId: workspaceA, userId: viewerId, role: "viewer", status: "active" },
    { workspaceId: workspaceA, userId: suspendedId, role: "member", status: "suspended" },
    { workspaceId: workspaceA, userId: removedId, role: "member", status: "removed" },
    { workspaceId: workspaceA, userId: invitedId, role: "member", status: "invited" },
  ]);

  // Create Workspace B for outsider
  const wsB = await workspacesService.createTeamWorkspace(outsiderId, "Bulk Workspace B");
  workspaceB = wsB.id;

  // Decorate cookies
  ownerCookie = withWorkspaceCookie(ownerCookie, workspaceA);
  adminCookie = withWorkspaceCookie(adminCookie, workspaceA);
  memberCookie = withWorkspaceCookie(memberCookie, workspaceA);
  viewerCookie = withWorkspaceCookie(viewerCookie, workspaceA);
  suspendedCookie = withWorkspaceCookie(suspendedCookie, workspaceA);
  removedCookie = withWorkspaceCookie(removedCookie, workspaceA);
  outsiderCookie = withWorkspaceCookie(outsiderCookie, workspaceB);

  // Create Project A1 & A2 in Workspace A
  const pA1Res = await projectsRoute.POST(
    apiRequest("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Project A1" } }),
  );
  assert.equal(pA1Res.status, 201);
  const pA1Data = (await pA1Res.json()) as { project: { id: string } };
  assert.ok(pA1Data.project);
  assert.ok(pA1Data.project.id);
  projectA1Id = pA1Data.project.id;

  const pA2Res = await projectsRoute.POST(
    apiRequest("POST", "/api/projects", { cookie: ownerCookie, body: { name: "Project A2" } }),
  );
  assert.equal(pA2Res.status, 201);
  const pA2Data = (await pA2Res.json()) as { project: { id: string } };
  assert.ok(pA2Data.project);
  assert.ok(pA2Data.project.id);
  projectA2Id = pA2Data.project.id;

  // Create Project B in Workspace B
  const pBRes = await projectsRoute.POST(
    apiRequest("POST", "/api/projects", { cookie: outsiderCookie, body: { name: "Project B" } }),
  );
  assert.equal(pBRes.status, 201);
  const pBData = (await pBRes.json()) as { project: { id: string } };
  assert.ok(pBData.project);
  assert.ok(pBData.project.id);
  projectBId = pBData.project.id;

  // Create Milestones
  const msA1Res = await milestonesRoute.POST(
    apiRequest("POST", `/api/projects/${projectA1Id}/milestones`, {
      cookie: ownerCookie,
      body: { title: "Milestone A1" },
    }),
    { params: Promise.resolve({ id: projectA1Id }) },
  );
  assert.equal(msA1Res.status, 201);
  const msA1Data = (await msA1Res.json()) as { milestone: { id: string } };
  assert.ok(msA1Data.milestone);
  assert.ok(msA1Data.milestone.id);
  milestoneA1Id = msA1Data.milestone.id;

  const msA2Res = await milestonesRoute.POST(
    apiRequest("POST", `/api/projects/${projectA2Id}/milestones`, {
      cookie: ownerCookie,
      body: { title: "Milestone A2" },
    }),
    { params: Promise.resolve({ id: projectA2Id }) },
  );
  assert.equal(msA2Res.status, 201);
  const msA2Data = (await msA2Res.json()) as { milestone: { id: string } };
  assert.ok(msA2Data.milestone);
  assert.ok(msA2Data.milestone.id);
  milestoneA2Id = msA2Data.milestone.id;

  const msBRes = await milestonesRoute.POST(
    apiRequest("POST", `/api/projects/${projectBId}/milestones`, {
      cookie: outsiderCookie,
      body: { title: "Milestone B" },
    }),
    { params: Promise.resolve({ id: projectBId }) },
  );
  assert.equal(msBRes.status, 201);
  const msBData = (await msBRes.json()) as { milestone: { id: string } };
  assert.ok(msBData.milestone);
  assert.ok(msBData.milestone.id);
  milestoneBId = msBData.milestone.id;
});

after(() => cleanup());

async function createTestTask(projectId: string, title: string): Promise<string> {
  const res = await projectTasksRoute.POST(
    apiRequest("POST", `/api/projects/${projectId}/tasks`, {
      cookie: ownerCookie,
      body: { title },
    }),
    { params: Promise.resolve({ id: projectId }) },
  );
  assert.equal(res.status, 201);
  const data = (await res.json()) as { task: { id: string } };
  assert.ok(data.task);
  assert.ok(data.task.id);
  return data.task.id;
}

describe("POST /api/tasks/bulk (Accounts Mode API Integration)", () => {
  describe("Role Matrix", () => {
    it("allows Owner to bulk edit tasks (200)", async () => {
      const taskId = await createTestTask(projectA1Id, "Owner task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { priority: "urgent" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 1);
    });

    it("allows Admin to bulk edit tasks (200)", async () => {
      const taskId = await createTestTask(projectA1Id, "Admin task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: adminCookie,
        body: { taskIds: [taskId], changes: { priority: "high" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 1);
    });

    it("allows Member to bulk edit tasks (200)", async () => {
      const taskId = await createTestTask(projectA1Id, "Member task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: memberCookie,
        body: { taskIds: [taskId], changes: { status: "in_progress" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 1);
    });

    it("rejects Viewer with 403", async () => {
      const taskId = await createTestTask(projectA1Id, "Viewer task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: viewerCookie,
        body: { taskIds: [taskId], changes: { priority: "low" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 403);
    });

    it("rejects Suspended member with 403", async () => {
      const taskId = await createTestTask(projectA1Id, "Suspended caller task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: suspendedCookie,
        body: { taskIds: [taskId], changes: { priority: "low" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 403);
    });

    it("rejects Removed member with 403", async () => {
      const taskId = await createTestTask(projectA1Id, "Removed caller task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: removedCookie,
        body: { taskIds: [taskId], changes: { priority: "low" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 403);
    });

    it("rejects Unauthenticated caller with 401", async () => {
      const taskId = await createTestTask(projectA1Id, "Unauth task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        body: { taskIds: [taskId], changes: { priority: "low" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 401);
    });

    it("rejects direct Outsider request against another workspace's task with not_found", async () => {
      const taskId = await createTestTask(projectA1Id, "Outsider target task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: outsiderCookie,
        body: { taskIds: [taskId], changes: { priority: "low" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 0);
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.taskId, taskId);
      assert.equal(data.results[0]!.status, "failed");
      assert.equal(data.results[0]!.errorCode, "not_found");
    });

    it("ensures cross-workspace task is indistinguishable from non-existent task for outsider", async () => {
      const taskInA = await createTestTask(projectA1Id, "Task in A");
      const nonExistent = "tsk_doesnotexist999";
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: outsiderCookie,
        body: { taskIds: [taskInA, nonExistent], changes: { priority: "high" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 0);
      assert.equal(data.failed, 2);
      const rA = data.results.find((r) => r.taskId === taskInA);
      const rNon = data.results.find((r) => r.taskId === nonExistent);
      assert.equal(rA?.status, "failed");
      assert.equal(rA?.errorCode, "not_found");
      assert.equal(rNon?.status, "failed");
      assert.equal(rNon?.errorCode, "not_found");
      assert.equal(rA?.error, rNon?.error);
    });
  });

  describe("Assignee Validations", () => {
    it("successfully assigns an active workspace member and sets actor attribution", async () => {
      const taskId = await createTestTask(projectA1Id, "Assign task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: memberCookie,
        body: { taskIds: [taskId], changes: { assigneeId: adminId } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 1);

      // Verify activity attribution
      const actReq = apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: memberCookie });
      const actRes = await taskActivityRoute.GET(actReq, { params: Promise.resolve({ id: taskId }) });
      const actData = (await actRes.json()) as { events: TaskActivityEvent[] };
      const assignEvent = actData.events.find((e) => e.type === "task.assigned");
      assert.ok(assignEvent);
      assert.equal(assignEvent.actorId, memberId);
    });

    it("clears assignee when assigneeId is null", async () => {
      const taskId = await createTestTask(projectA1Id, "Unassign task");
      // First assign
      await bulkTasksRoute.POST(
        apiRequest("POST", "/api/tasks/bulk", {
          cookie: ownerCookie,
          body: { taskIds: [taskId], changes: { assigneeId: memberId } },
        }),
      );

      // Then clear
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { assigneeId: null } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 1);
      assert.equal(data.results[0]!.status, "updated");
    });

    it("rejects assigning suspended member with invalid_assignee", async () => {
      const taskId = await createTestTask(projectA1Id, "Assign suspended task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { assigneeId: suspendedId } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 0);
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.errorCode, "invalid_assignee");
      assert.equal(data.results[0]!.retryable, false);
    });

    it("rejects assigning removed member with invalid_assignee", async () => {
      const taskId = await createTestTask(projectA1Id, "Assign removed task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { assigneeId: removedId } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.errorCode, "invalid_assignee");
    });

    it("rejects assigning invited member with invalid_assignee", async () => {
      const taskId = await createTestTask(projectA1Id, "Assign invited task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { assigneeId: invitedId } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.errorCode, "invalid_assignee");
    });

    it("rejects assigning outsider / cross-workspace user with invalid_assignee", async () => {
      const taskId = await createTestTask(projectA1Id, "Assign outsider task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { assigneeId: outsiderId } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.errorCode, "invalid_assignee");
    });

    it("supports workspaces with > 100 members via member search and assigns member beyond page 1", async () => {
      const pgDb = db();
      const extraMemberIds: string[] = [];
      const userInserts = [];
      const memberInserts = [];

      for (let i = 1; i <= 104; i++) {
        const uId = `usr_scale_member_${i}_${Date.now()}`;
        extraMemberIds.push(uId);
        userInserts.push({
          id: uId,
          email: `alpha_member_${i}_${Date.now()}@scaletest.com`,
          name: `Alpha Member ${String(i).padStart(3, "0")}`,
        });
        memberInserts.push({
          workspaceId: workspaceA,
          userId: uId,
          role: "member" as const,
          status: "active" as const,
        });
      }

      // Member 105 named Zulu Member 105 will be ordered last (beyond page 1 and 2)
      const targetMemberId = `usr_zulu_member_105_${Date.now()}`;
      userInserts.push({
        id: targetMemberId,
        email: `zulu_member_105_${Date.now()}@scaletest.com`,
        name: "Zulu Member 105",
      });
      memberInserts.push({
        workspaceId: workspaceA,
        userId: targetMemberId,
        role: "member" as const,
        status: "active" as const,
      });

      await pgDb.insert(users).values(userInserts);
      await pgDb.insert(workspaceMembers).values(memberInserts);

      // Step 1: Default page 1 with limit 50 does NOT include member 105
      const page1Req = apiRequest("GET", `/api/workspaces/${workspaceA}/members?status=active&limit=50`, {
        cookie: ownerCookie,
      });
      const page1Res = await workspaceMembersRoute.GET(page1Req, {
        params: Promise.resolve({ id: workspaceA }),
      });
      assert.equal(page1Res.status, 200);
      const page1Data = (await page1Res.json()) as { members: { id: string }[] };
      assert.equal(page1Data.members.length, 50);
      assert.equal(
        page1Data.members.some((m) => m.id === targetMemberId),
        false,
        "Member 105 should not be in page 1",
      );

      // Step 2: Search for member 105 specifically
      const searchReq = apiRequest(
        "GET",
        `/api/workspaces/${workspaceA}/members?status=active&limit=50&search=Zulu%20Member%20105`,
        {
          cookie: ownerCookie,
        },
      );
      const searchRes = await workspaceMembersRoute.GET(searchReq, {
        params: Promise.resolve({ id: workspaceA }),
      });
      assert.equal(searchRes.status, 200);
      const searchData = (await searchRes.json()) as { members: { id: string; name: string }[] };
      assert.ok(searchData.members.length >= 1);
      assert.ok(
        searchData.members.some((m) => m.id === targetMemberId),
        "Member 105 must be found via search",
      );

      // Step 3: Perform bulk update assigning tasks to this member beyond page 1
      const taskId = await createTestTask(projectA1Id, "Task for member beyond page 1");
      const bulkReq = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { assigneeId: targetMemberId } },
      });
      const bulkRes = await bulkTasksRoute.POST(bulkReq);
      assert.equal(bulkRes.status, 200);
      const bulkData: BulkTaskUpdateResponse = await bulkRes.json();
      assert.equal(bulkData.requested, 1);
      assert.equal(bulkData.updated, 1);
      assert.equal(bulkData.failed, 0);

      // Verify task assignment in database
      const [assignedTask] = await pgDb
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId));
      assert.ok(assignedTask);
      assert.equal(assignedTask.assigneeId, targetMemberId);
    });
  });

  describe("Milestone Validations", () => {
    it("successfully sets and clears a valid milestone in the same project", async () => {
      const taskId = await createTestTask(projectA1Id, "Milestone test task");

      // Set milestone
      const setReq = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { milestoneId: milestoneA1Id } },
      });
      const setRes = await bulkTasksRoute.POST(setReq);
      assert.equal(setRes.status, 200);
      const setData: BulkTaskUpdateResponse = await setRes.json();
      assert.equal(setData.succeeded, 1);

      // Clear milestone
      const clearReq = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { milestoneId: null } },
      });
      const clearRes = await bulkTasksRoute.POST(clearReq);
      assert.equal(clearRes.status, 200);
      const clearData: BulkTaskUpdateResponse = await clearRes.json();
      assert.equal(clearData.succeeded, 1);
    });

    it("rejects milestone from another project within the same workspace with invalid_milestone", async () => {
      const taskId = await createTestTask(projectA1Id, "Cross-project milestone task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { milestoneId: milestoneA2Id } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.errorCode, "invalid_milestone");
      assert.equal(data.results[0]!.retryable, false);
    });

    it("rejects milestone from another workspace with invalid_milestone", async () => {
      const taskId = await createTestTask(projectA1Id, "Cross-ws milestone task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { milestoneId: milestoneBId } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.errorCode, "invalid_milestone");
    });
  });

  describe("Partial-Failure Reporting & Activity Suppression", () => {
    it("reports truthful partial failure counts across a diverse batch", async () => {
      const validTask = await createTestTask(projectA1Id, "Valid task");
      const invalidMilestoneTask = await createTestTask(projectA1Id, "Invalid MS task");
      const invalidAssigneeTask = await createTestTask(projectA1Id, "Invalid Assignee task");

      // Valid task update
      const req1 = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: {
          taskIds: [validTask, "nonexistent_task_id"],
          changes: { priority: "high" },
        },
      });
      const res1 = await bulkTasksRoute.POST(req1);
      assert.equal(res1.status, 200);
      const data1: BulkTaskUpdateResponse = await res1.json();
      assert.equal(data1.requested, 2);
      assert.equal(data1.succeeded, 1);
      assert.equal(data1.failed, 1);

      const rValid = data1.results.find((r) => r.taskId === validTask);
      const rMissing = data1.results.find((r) => r.taskId === "nonexistent_task_id");
      assert.equal(rValid?.status, "updated");
      assert.equal(rMissing?.status, "failed");
      assert.equal(rMissing?.errorCode, "not_found");
    });

    it("suppresses activity events and reports unchanged for no-op bulk updates", async () => {
      const taskId = await createTestTask(projectA1Id, "No-op task");

      // First change
      await bulkTasksRoute.POST(
        apiRequest("POST", "/api/tasks/bulk", {
          cookie: ownerCookie,
          body: { taskIds: [taskId], changes: { priority: "urgent" } },
        }),
      );

      // Fetch activity count
      const actRes1 = await taskActivityRoute.GET(
        apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: ownerCookie }),
        { params: Promise.resolve({ id: taskId }) },
      );
      const actData1 = (await actRes1.json()) as { events: TaskActivityEvent[] };
      const countBefore = actData1.events.length;

      // Duplicate no-op update
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { priority: "urgent" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.results[0]!.status, "unchanged");

      // Verify no new activity event was created
      const actRes2 = await taskActivityRoute.GET(
        apiRequest("GET", `/api/tasks/${taskId}/activity`, { cookie: ownerCookie }),
        { params: Promise.resolve({ id: taskId }) },
      );
      const actData2 = (await actRes2.json()) as { events: TaskActivityEvent[] };
      assert.equal(actData2.events.length, countBefore);
    });

    it("truthfully reports separate updated, unchanged, and failed counts", async () => {
      const t1 = await createTestTask(projectA1Id, "T1 to change");
      const t2 = await createTestTask(projectA1Id, "T2 already urgent");
      // Set t2 to urgent
      await bulkTasksRoute.POST(
        apiRequest("POST", "/api/tasks/bulk", {
          cookie: ownerCookie,
          body: { taskIds: [t2], changes: { priority: "urgent" } },
        }),
      );

      // Now batch update both t1 and t2 with urgent, plus a non-existent task
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [t1, t2, "missing_tsk_123"], changes: { priority: "urgent" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.requested, 3);
      assert.equal(data.succeeded, 2);
      assert.equal(data.updated, 1);
      assert.equal(data.unchanged, 1);
      assert.equal(data.failed, 1);
    });
  });

  describe("Blocked-Task Completion Validations", () => {
    it("rejects completing a blocked task with blocked_task errorCode", async () => {
      const taskRepositoryModule = await import("../../src/db/repositories");
      const blockerId = await createTestTask(projectA1Id, "Blocker Task");
      const blockedId = await createTestTask(projectA1Id, "Blocked Task");

      await taskRepositoryModule.taskRepository.addDependency(workspaceA, blockedId, blockerId);

      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [blockedId], changes: { status: "done" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.succeeded, 0);
      assert.equal(data.failed, 1);
      assert.equal(data.results[0]!.errorCode, "blocked_task");
      assert.equal(data.results[0]!.retryable, false);

      // Confirm task was not marked done
      const checkTask = await taskRepositoryModule.taskRepository.findById(workspaceA, blockedId);
      assert.equal(checkTask?.status, "todo");
    });
  });

  describe("Request Validation & Batch Limits", () => {
    it("rejects empty taskIds array with 400", async () => {
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [], changes: { priority: "high" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 400);
    });

    it("rejects batch exceeding 100 taskIds with 400", async () => {
      const taskIds = Array.from({ length: 101 }, (_, i) => `tsk_overlimit_${i}`);
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds, changes: { priority: "high" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 400);
    });

    it("deduplicates duplicate taskIds and reports accurate requested count", async () => {
      const taskId = await createTestTask(projectA1Id, "Dedupe task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId, taskId], changes: { priority: "urgent" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 200);
      const data: BulkTaskUpdateResponse = await res.json();
      assert.equal(data.requested, 1);
      assert.equal(data.succeeded, 1);
      assert.equal(data.updated, 1);
      assert.equal(data.results.length, 1);
    });

    it("rejects overlong task ID exceeding 200 chars with 400", async () => {
      const overlongId = "a".repeat(201);
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [overlongId], changes: { priority: "high" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 400);
    });

    it("rejects task ID with newline or control characters with 400", async () => {
      const forgedId = "task_id\nInjected Log Line";
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [forgedId], changes: { priority: "high" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 400);
    });

    it("rejects unknown root fields with 400", async () => {
      const taskId = await createTestTask(projectA1Id, "Unknown field task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { priority: "high" }, unexpectedField: true },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 400);
    });

    it("rejects unknown changes fields with 400", async () => {
      const taskId = await createTestTask(projectA1Id, "Unknown change field task");
      const req = apiRequest("POST", "/api/tasks/bulk", {
        cookie: ownerCookie,
        body: { taskIds: [taskId], changes: { priority: "high", bogusField: "invalid" } },
      });
      const res = await bulkTasksRoute.POST(req);
      assert.equal(res.status, 400);
    });

    it("fault injection: shared assignee lookup failure in accounts mode executes lookup at most once across 100 tasks", async () => {
      const taskIds: string[] = [];
      for (let i = 0; i < 100; i++) {
        const id = await createTestTask(projectA1Id, `Assignee Lookup Task ${i}`);
        taskIds.push(id);
      }

      // The fault lives only in this handler's own injected dependency. Authorization
      // still runs against the genuine membership service, so the caller is admitted.
      let membershipLookupCount = 0;
      const faultyPOST = bulkHandler.createBulkTaskUpdateHandler({
        ...bulkHandler.productionBulkTaskUpdateDependencies,
        getMembership: async () => {
          membershipLookupCount++;
          throw new Error("Simulated connection timeout / pool exhaustion: SELECT * FROM secrets_table");
        },
      });

      {
        const req = apiRequest("POST", "/api/tasks/bulk", {
          cookie: ownerCookie,
          body: {
            taskIds,
            changes: { assigneeId: memberId },
          },
        });
        const res = await faultyPOST(req);
        assert.equal(res.status, 200);
        const data: BulkTaskUpdateResponse = await res.json();

        assert.equal(data.requested, 100);
        assert.equal(data.failed, 100);
        assert.equal(data.succeeded, 0);
        assert.equal(data.results.length, 100);

        // Crucial requirement: The shared lookup must execute at most once!
        assert.equal(
          membershipLookupCount,
          1,
          "Shared assignee lookup must execute at most once across 100 tasks",
        );

        for (const r of data.results) {
          assert.equal(r.status, "failed");
          assert.equal(r.errorCode, "internal_error");
          assert.equal(r.retryable, true);
          assert.match(
            r.error ?? "",
            /unexpected error occurred while verifying assignee membership/i,
          );
          assert.doesNotMatch(r.error ?? "", /secrets_table/i);
          assert.doesNotMatch(r.error ?? "", /SELECT \*/i);
        }
      }
    });
  });

  describe("Dependency-injected handler: no mutable production override", () => {
    const activeMembership = (workspaceId: string, userId: string) => ({
      workspaceId,
      userId,
      role: "member" as const,
      status: "active" as const,
      invitedBy: null,
      createdAt: new Date(),
    });

    async function assignTo(
      post: (req: InstanceType<typeof NextRequest>) => Promise<Response>,
      taskIds: string[],
    ): Promise<BulkTaskUpdateResponse> {
      const res = await post(
        apiRequest("POST", "/api/tasks/bulk", {
          cookie: ownerCookie,
          body: { taskIds, changes: { assigneeId: memberId } },
        }),
      );
      assert.equal(res.status, 200);
      return (await res.json()) as BulkTaskUpdateResponse;
    }

    it("the workspace service no longer exports a membership test hook", async () => {
      const service = (await import("../../src/core/workspaces/service")) as Record<string, unknown>;
      assert.equal("setGetMembershipForTest" in service, false);
      assert.equal("getMembershipOverride" in service, false);
      assert.equal(typeof service.getMembership, "function");
    });

    it("no mutable membership override exists anywhere in production source", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
            const text = fs.readFileSync(full, "utf8");
            if (/setGetMembershipForTest|getMembershipOverride|MembershipOverride/.test(text)) {
              offenders.push(full);
            }
            if (/export\s+(async\s+)?function\s+set\w*ForTest\b/.test(text)) offenders.push(full);
          }
        }
      };
      walk(path.resolve("src"));
      assert.deepEqual(offenders, [], "production source must not contain a membership override");
    });

    it("two handlers built with different dependencies can't affect each other", async () => {
      const aCalls: string[] = [];
      const bCalls: string[] = [];
      const handlerA = bulkHandler.createBulkTaskUpdateHandler({
        ...bulkHandler.productionBulkTaskUpdateDependencies,
        getMembership: async (ws, uid) => {
          aCalls.push(uid);
          return activeMembership(ws, uid);
        },
      });
      const handlerB = bulkHandler.createBulkTaskUpdateHandler({
        ...bulkHandler.productionBulkTaskUpdateDependencies,
        getMembership: async (_ws, uid) => {
          bCalls.push(uid);
          throw new Error("handler B's injected failure");
        },
      });

      const tasksA1 = [await createTestTask(projectA1Id, "DI A1")];
      const tasksB = [await createTestTask(projectA1Id, "DI B")];
      const tasksA2 = [await createTestTask(projectA1Id, "DI A2")];

      assert.deepEqual((await assignTo(handlerA, tasksA1)).results.map((r) => r.status), ["updated"]);
      assert.deepEqual((await assignTo(handlerB, tasksB)).results.map((r) => r.errorCode), ["internal_error"]);
      // Handler A is unaffected by handler B having run in between.
      assert.deepEqual((await assignTo(handlerA, tasksA2)).results.map((r) => r.status), ["updated"]);

      assert.deepEqual(aCalls, [memberId, memberId]);
      assert.deepEqual(bCalls, [memberId]);
    });

    it("concurrent calls can't observe another call's injected dependency", async () => {
      // Each dependency waits until both requests are mid-flight, forcing them to interleave.
      let arrived = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      const rendezvous = async () => {
        arrived++;
        if (arrived === 2) release();
        await bothArrived;
      };

      const aCalls: string[] = [];
      const bCalls: string[] = [];
      const handlerA = bulkHandler.createBulkTaskUpdateHandler({
        ...bulkHandler.productionBulkTaskUpdateDependencies,
        getMembership: async (ws, uid) => {
          aCalls.push(uid);
          await rendezvous();
          return activeMembership(ws, uid);
        },
      });
      const handlerB = bulkHandler.createBulkTaskUpdateHandler({
        ...bulkHandler.productionBulkTaskUpdateDependencies,
        getMembership: async (_ws, uid) => {
          bCalls.push(uid);
          await rendezvous();
          throw new Error("handler B's injected failure");
        },
      });

      const tasksA: string[] = [];
      const tasksB: string[] = [];
      for (let i = 0; i < 5; i++) {
        tasksA.push(await createTestTask(projectA1Id, `Concurrent DI A ${i}`));
        tasksB.push(await createTestTask(projectA1Id, `Concurrent DI B ${i}`));
      }

      const [resultA, resultB] = await Promise.all([assignTo(handlerA, tasksA), assignTo(handlerB, tasksB)]);

      assert.equal(arrived, 2, "both calls were in flight at the same time");
      assert.ok(resultA.results.every((r) => r.status === "updated"), "A saw only its own active-member dependency");
      assert.ok(
        resultB.results.every((r) => r.status === "failed" && r.errorCode === "internal_error" && r.retryable),
        "B saw only its own failing dependency",
      );
      assert.deepEqual(aCalls, [memberId], "A's dependency ran once, only for A");
      assert.deepEqual(bCalls, [memberId], "B's dependency ran once, only for B");
    });

    it("the production handler uses the genuine workspace membership service", async () => {
      const prod = bulkHandler.productionBulkTaskUpdateDependencies;
      assert.ok(Object.isFrozen(prod), "production dependencies are immutable");

      for (const uid of [memberId, suspendedId, viewerId]) {
        assert.deepEqual(
          await prod.getMembership(workspaceA, uid),
          await workspacesService.getMembership(workspaceA, uid),
          "production lookup returns exactly what the real service returns",
        );
      }
      assert.equal(await prod.getMembership(workspaceA, "not-a-member"), null);

      // End to end through the exported route: the real database decides.
      const [activeTask, suspendedTask] = [
        await createTestTask(projectA1Id, "Prod genuine active"),
        await createTestTask(projectA1Id, "Prod genuine suspended"),
      ];
      const active = await assignTo(bulkTasksRoute.POST, [activeTask]);
      assert.equal(active.results[0]?.status, "updated");
      const suspended = await bulkTasksRoute.POST(
        apiRequest("POST", "/api/tasks/bulk", {
          cookie: ownerCookie,
          body: { taskIds: [suspendedTask], changes: { assigneeId: suspendedId } },
        }),
      );
      const suspendedBody = (await suspended.json()) as BulkTaskUpdateResponse;
      assert.equal(suspendedBody.results[0]?.errorCode, "invalid_assignee");
    });
  });
});
