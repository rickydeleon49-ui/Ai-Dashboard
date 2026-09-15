/**
 * The Milestones/Tasks API routes (Phase 2, Release A step 3) against a
 * real Postgres-backed, real signed-in Auth.js session — same shape as
 * `projects-workspace-scoping.test.ts`: workspace isolation, role
 * enforcement (viewer reads, member writes), plus what's new to this
 * domain — cross-project milestone/parent-task rejection, the dependency
 * API's cycle/cross-workspace rejection, and My Work's own scoping.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db.pg";

process.env.AUTH_SECRET = "test-secret-for-automated-tests-only-not-real";
process.env.AUTH_MODE = "accounts";

type ProjectsRoute = typeof import("../../src/app/api/projects/route");
type MilestonesRoute = typeof import("../../src/app/api/projects/[id]/milestones/route");
type MilestoneRoute = typeof import("../../src/app/api/projects/[id]/milestones/[milestoneId]/route");
type ProjectTasksRoute = typeof import("../../src/app/api/projects/[id]/tasks/route");
type TaskRoute = typeof import("../../src/app/api/tasks/[id]/route");
type TaskDependenciesRoute = typeof import("../../src/app/api/tasks/[id]/dependencies/route");
type MyWorkRoute = typeof import("../../src/app/api/my-work/route");
type WorkspacesRoute = typeof import("../../src/app/api/workspaces/route");
type CurrentWorkspaceRoute = typeof import("../../src/app/api/workspaces/current/route");
type InvitationsRoute = typeof import("../../src/app/api/workspaces/[id]/invitations/route");
type AcceptRoute = typeof import("../../src/app/api/invitations/accept/route");

let projectsRoute: ProjectsRoute;
let milestonesRoute: MilestonesRoute;
let milestoneRoute: MilestoneRoute;
let projectTasksRoute: ProjectTasksRoute;
let taskRoute: TaskRoute;
let taskDependenciesRoute: TaskDependenciesRoute;
let myWorkRoute: MyWorkRoute;
let workspacesRoute: WorkspacesRoute;
let currentWorkspaceRoute: CurrentWorkspaceRoute;
let invitationsRoute: InvitationsRoute;
let acceptRoute: AcceptRoute;
let handlers: typeof import("../../src/auth").handlers;
let NextRequest: typeof import("next/server").NextRequest;
let sessionFromRequest: typeof import("../../src/core/auth/session").sessionFromRequest;

before(async () => {
  await migrate();
  projectsRoute = await import("../../src/app/api/projects/route");
  milestonesRoute = await import("../../src/app/api/projects/[id]/milestones/route");
  milestoneRoute = await import("../../src/app/api/projects/[id]/milestones/[milestoneId]/route");
  projectTasksRoute = await import("../../src/app/api/projects/[id]/tasks/route");
  taskRoute = await import("../../src/app/api/tasks/[id]/route");
  taskDependenciesRoute = await import("../../src/app/api/tasks/[id]/dependencies/route");
  myWorkRoute = await import("../../src/app/api/my-work/route");
  workspacesRoute = await import("../../src/app/api/workspaces/route");
  currentWorkspaceRoute = await import("../../src/app/api/workspaces/current/route");
  invitationsRoute = await import("../../src/app/api/workspaces/[id]/invitations/route");
  acceptRoute = await import("../../src/app/api/invitations/accept/route");
  ({ handlers } = await import("../../src/auth"));
  ({ NextRequest } = await import("next/server"));
  ({ sessionFromRequest } = await import("../../src/core/auth/session"));
});

after(() => cleanup());

/** Runs fn while capturing console.log lines, since that's where the magic link goes when no real mail server is configured. */
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

/** A minimal cookie jar: absorbs Set-Cookie from a response, replays as Cookie on the next request. */
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

/** Signs in a fresh user via magic link and returns a Cookie header carrying a valid session. */
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
  assert.equal(callbackResponse.status, 302, "sign-in callback should redirect on success");

  return jar.header();
}

function apiRequest(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      host: "localhost",
      "x-forwarded-proto": "http",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

/** Signs `email` in, invites them into `workspaceId` at `role`, accepts, and switches to it. Returns their cookie. */
async function joinWorkspaceAs(
  email: string,
  workspaceId: string,
  role: "admin" | "member" | "viewer",
  ownerCookie: string,
): Promise<string> {
  const inviteResponse = await invitationsRoute.POST(
    apiRequest("POST", `/api/workspaces/${workspaceId}/invitations`, {
      cookie: ownerCookie,
      body: { email, role },
    }),
    { params: Promise.resolve({ id: workspaceId }) },
  );
  assert.equal(inviteResponse.status, 201, `inviting ${email} as ${role} should succeed`);
  const { token } = (await inviteResponse.json()) as { token: string };

  const cookie = await signIn(email);
  const acceptResponse = await acceptRoute.POST(apiRequest("POST", "/api/invitations/accept", { cookie, body: { token } }));
  assert.equal(acceptResponse.status, 200);

  const switchResponse = await currentWorkspaceRoute.PUT(
    apiRequest("PUT", "/api/workspaces/current", { cookie, body: { workspaceId } }),
  );
  assert.equal(switchResponse.status, 200);
  const cookiePair = switchResponse.headers.getSetCookie().join("; ").split(";")[0];
  return `${cookie}; ${cookiePair}`;
}

async function createProject(cookie: string, name: string) {
  const response = await projectsRoute.POST(apiRequest("POST", "/api/projects", { cookie, body: { name } }));
  assert.equal(response.status, 201, `create project "${name}" should succeed`);
  return ((await response.json()) as { project: { id: string } }).project;
}

async function createMilestone(cookie: string, projectId: string, title: string) {
  const response = await milestonesRoute.POST(
    apiRequest("POST", `/api/projects/${projectId}/milestones`, { cookie, body: { title } }),
    { params: Promise.resolve({ id: projectId }) },
  );
  assert.equal(response.status, 201, `create milestone "${title}" should succeed`);
  return ((await response.json()) as { milestone: { id: string; projectId: string } }).milestone;
}

async function createTask(
  cookie: string,
  projectId: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const response = await projectTasksRoute.POST(
    apiRequest("POST", `/api/projects/${projectId}/tasks`, { cookie, body: { title, ...extra } }),
    { params: Promise.resolve({ id: projectId }) },
  );
  assert.equal(response.status, 201, `create task "${title}" should succeed`);
  return ((await response.json()) as { task: { id: string; projectId: string; status: string } }).task;
}

describe("Milestones & Tasks API: workspace scoping", () => {
  it("requires a session", async () => {
    assert.equal(
      (await milestonesRoute.GET(apiRequest("GET", "/api/projects/x/milestones"), {
        params: Promise.resolve({ id: "x" }),
      })).status,
      401,
    );
    assert.equal(
      (await projectTasksRoute.GET(apiRequest("GET", "/api/projects/x/tasks"), {
        params: Promise.resolve({ id: "x" }),
      })).status,
      401,
    );
    assert.equal((await myWorkRoute.GET(apiRequest("GET", "/api/my-work"))).status, 401);
  });

  it("keeps two workspaces' milestones and tasks fully isolated", async () => {
    const aliceCookie = await signIn("tasks-scoping-alice@example.com");
    const bobCookie = await signIn("tasks-scoping-bob@example.com");

    const aliceProject = await createProject(aliceCookie, "Alice's Project");
    const aliceMilestone = await createMilestone(aliceCookie, aliceProject.id, "Alice's Milestone");
    const aliceTask = await createTask(aliceCookie, aliceProject.id, "Alice's Task");

    // Bob cannot reach Alice's project's milestones/tasks sub-collections at all.
    const bobListsMilestones = await milestonesRoute.GET(
      apiRequest("GET", `/api/projects/${aliceProject.id}/milestones`, { cookie: bobCookie }),
      { params: Promise.resolve({ id: aliceProject.id }) },
    );
    assert.equal(bobListsMilestones.status, 404);

    const bobListsTasks = await projectTasksRoute.GET(
      apiRequest("GET", `/api/projects/${aliceProject.id}/tasks`, { cookie: bobCookie }),
      { params: Promise.resolve({ id: aliceProject.id }) },
    );
    assert.equal(bobListsTasks.status, 404);

    // Nor by the global, cross-project task/milestone ids.
    const bobReadsMilestone = await milestoneRoute.GET(
      apiRequest("GET", `/api/projects/${aliceProject.id}/milestones/${aliceMilestone.id}`, { cookie: bobCookie }),
      { params: Promise.resolve({ id: aliceProject.id, milestoneId: aliceMilestone.id }) },
    );
    assert.equal(bobReadsMilestone.status, 404);

    const bobReadsTask = await taskRoute.GET(
      apiRequest("GET", `/api/tasks/${aliceTask.id}`, { cookie: bobCookie }),
      { params: Promise.resolve({ id: aliceTask.id }) },
    );
    assert.equal(bobReadsTask.status, 404);
  });

  it("rejects a milestoneId/parentTaskId that belongs to a different project", async () => {
    const cookie = await signIn("tasks-scoping-cross-project@example.com");
    const projectA = await createProject(cookie, "Project A");
    const projectB = await createProject(cookie, "Project B");
    const milestoneInA = await createMilestone(cookie, projectA.id, "Milestone in A");
    const taskInA = await createTask(cookie, projectA.id, "Task in A");

    const crossMilestone = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${projectB.id}/tasks`, {
        cookie,
        body: { title: "Cross-project milestone link", milestoneId: milestoneInA.id },
      }),
      { params: Promise.resolve({ id: projectB.id }) },
    );
    assert.equal(crossMilestone.status, 422);

    const crossParent = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${projectB.id}/tasks`, {
        cookie,
        body: { title: "Cross-project parent link", parentTaskId: taskInA.id },
      }),
      { params: Promise.resolve({ id: projectB.id }) },
    );
    assert.equal(crossParent.status, 422);
  });
});

describe("Milestones & Tasks API: role enforcement", () => {
  it("a viewer can read but not create, update or delete a milestone", async () => {
    const ownerCookie = await signIn("role-milestones-owner@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Role Test Milestones" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };
    const ownerInWorkspace = `${ownerCookie}; cc-current-workspace=${workspace.id}`;
    const project = await createProject(ownerInWorkspace, "Owner's Project");
    const milestone = await createMilestone(ownerInWorkspace, project.id, "Owner's Milestone");

    const viewerCookie = await joinWorkspaceAs("role-milestones-viewer@example.com", workspace.id, "viewer", ownerCookie);

    assert.equal(
      (await milestonesRoute.GET(apiRequest("GET", `/api/projects/${project.id}/milestones`, { cookie: viewerCookie }), {
        params: Promise.resolve({ id: project.id }),
      })).status,
      200,
    );

    const createResponse = await milestonesRoute.POST(
      apiRequest("POST", `/api/projects/${project.id}/milestones`, { cookie: viewerCookie, body: { title: "Viewer's" } }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(createResponse.status, 403);

    const updateResponse = await milestoneRoute.PATCH(
      apiRequest("PATCH", `/api/projects/${project.id}/milestones/${milestone.id}`, {
        cookie: viewerCookie,
        body: { title: "Renamed by viewer" },
      }),
      { params: Promise.resolve({ id: project.id, milestoneId: milestone.id }) },
    );
    assert.equal(updateResponse.status, 403);

    const deleteResponse = await milestoneRoute.DELETE(
      apiRequest("DELETE", `/api/projects/${project.id}/milestones/${milestone.id}`, { cookie: viewerCookie }),
      { params: Promise.resolve({ id: project.id, milestoneId: milestone.id }) },
    );
    assert.equal(deleteResponse.status, 403);
  });

  it("a viewer can read but not create, update or delete a task", async () => {
    const ownerCookie = await signIn("role-tasks-owner@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Role Test Tasks" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };
    const ownerInWorkspace = `${ownerCookie}; cc-current-workspace=${workspace.id}`;
    const project = await createProject(ownerInWorkspace, "Owner's Project");
    const task = await createTask(ownerInWorkspace, project.id, "Owner's Task");

    const viewerCookie = await joinWorkspaceAs("role-tasks-viewer@example.com", workspace.id, "viewer", ownerCookie);

    assert.equal(
      (await projectTasksRoute.GET(apiRequest("GET", `/api/projects/${project.id}/tasks`, { cookie: viewerCookie }), {
        params: Promise.resolve({ id: project.id }),
      })).status,
      200,
    );
    assert.equal((await taskRoute.GET(apiRequest("GET", `/api/tasks/${task.id}`, { cookie: viewerCookie }), {
      params: Promise.resolve({ id: task.id }),
    })).status, 200);

    const createResponse = await projectTasksRoute.POST(
      apiRequest("POST", `/api/projects/${project.id}/tasks`, { cookie: viewerCookie, body: { title: "Viewer's" } }),
      { params: Promise.resolve({ id: project.id }) },
    );
    assert.equal(createResponse.status, 403);

    const updateResponse = await taskRoute.PATCH(
      apiRequest("PATCH", `/api/tasks/${task.id}`, { cookie: viewerCookie, body: { title: "Renamed by viewer" } }),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(updateResponse.status, 403);

    const deleteResponse = await taskRoute.DELETE(
      apiRequest("DELETE", `/api/tasks/${task.id}`, { cookie: viewerCookie }),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(deleteResponse.status, 403);

    const dependencyResponse = await taskDependenciesRoute.POST(
      apiRequest("POST", `/api/tasks/${task.id}/dependencies`, { cookie: viewerCookie, body: { dependsOnTaskId: task.id } }),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(dependencyResponse.status, 403);
  });

  it("a member can create, update and delete milestones and tasks", async () => {
    const ownerCookie = await signIn("role-member-owner@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "Role Test Member" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };

    const memberCookie = await joinWorkspaceAs("role-member-member@example.com", workspace.id, "member", ownerCookie);

    const project = await createProject(memberCookie, "Member's Project");
    const milestone = await createMilestone(memberCookie, project.id, "Member's Milestone");
    const task = await createTask(memberCookie, project.id, "Member's Task");

    const updateMilestone = await milestoneRoute.PATCH(
      apiRequest("PATCH", `/api/projects/${project.id}/milestones/${milestone.id}`, {
        cookie: memberCookie,
        body: { title: "Renamed by member" },
      }),
      { params: Promise.resolve({ id: project.id, milestoneId: milestone.id }) },
    );
    assert.equal(updateMilestone.status, 200);

    const updateTask = await taskRoute.PATCH(
      apiRequest("PATCH", `/api/tasks/${task.id}`, { cookie: memberCookie, body: { status: "in_progress" } }),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(updateTask.status, 200);
    assert.equal(((await updateTask.json()) as { task: { status: string } }).task.status, "in_progress");

    const deleteTask = await taskRoute.DELETE(
      apiRequest("DELETE", `/api/tasks/${task.id}`, { cookie: memberCookie }),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(deleteTask.status, 200);

    const deleteMilestone = await milestoneRoute.DELETE(
      apiRequest("DELETE", `/api/projects/${project.id}/milestones/${milestone.id}`, { cookie: memberCookie }),
      { params: Promise.resolve({ id: project.id, milestoneId: milestone.id }) },
    );
    assert.equal(deleteMilestone.status, 200);
  });
});

describe("Task dependencies API", () => {
  it("adds a dependency and reflects it in both directions", async () => {
    const cookie = await signIn("deps-basic@example.com");
    const project = await createProject(cookie, "Deps Project");
    const taskA = await createTask(cookie, project.id, "A");
    const taskB = await createTask(cookie, project.id, "B");

    const addResponse = await taskDependenciesRoute.POST(
      apiRequest("POST", `/api/tasks/${taskA.id}/dependencies`, { cookie, body: { dependsOnTaskId: taskB.id } }),
      { params: Promise.resolve({ id: taskA.id }) },
    );
    assert.equal(addResponse.status, 201);

    const aDeps = await taskDependenciesRoute.GET(
      apiRequest("GET", `/api/tasks/${taskA.id}/dependencies`, { cookie }),
      { params: Promise.resolve({ id: taskA.id }) },
    );
    const { blockers } = (await aDeps.json()) as { blockers: { id: string }[] };
    assert.ok(blockers.some((t) => t.id === taskB.id));

    const bDeps = await taskDependenciesRoute.GET(
      apiRequest("GET", `/api/tasks/${taskB.id}/dependencies`, { cookie }),
      { params: Promise.resolve({ id: taskB.id }) },
    );
    const { dependents } = (await bDeps.json()) as { dependents: { id: string }[] };
    assert.ok(dependents.some((t) => t.id === taskA.id));

    // A is blocked (B is still "todo"); the task itself reports this too.
    const aRead = await taskRoute.GET(apiRequest("GET", `/api/tasks/${taskA.id}`, { cookie }), {
      params: Promise.resolve({ id: taskA.id }),
    });
    assert.equal(((await aRead.json()) as { task: { blocked: boolean } }).task.blocked, true);

    const removeResponse = await taskDependenciesRoute.DELETE(
      apiRequest("DELETE", `/api/tasks/${taskA.id}/dependencies?dependsOnTaskId=${taskB.id}`, { cookie }),
      { params: Promise.resolve({ id: taskA.id }) },
    );
    assert.equal(removeResponse.status, 200);

    const aReadAfter = await taskRoute.GET(apiRequest("GET", `/api/tasks/${taskA.id}`, { cookie }), {
      params: Promise.resolve({ id: taskA.id }),
    });
    assert.equal(((await aReadAfter.json()) as { task: { blocked: boolean } }).task.blocked, false);
  });

  it("rejects a dependency that would create a cycle, with 409", async () => {
    const cookie = await signIn("deps-cycle@example.com");
    const project = await createProject(cookie, "Deps Cycle Project");
    const taskA = await createTask(cookie, project.id, "A");
    const taskB = await createTask(cookie, project.id, "B");

    const first = await taskDependenciesRoute.POST(
      apiRequest("POST", `/api/tasks/${taskA.id}/dependencies`, { cookie, body: { dependsOnTaskId: taskB.id } }),
      { params: Promise.resolve({ id: taskA.id }) },
    );
    assert.equal(first.status, 201);

    const cyclical = await taskDependenciesRoute.POST(
      apiRequest("POST", `/api/tasks/${taskB.id}/dependencies`, { cookie, body: { dependsOnTaskId: taskA.id } }),
      { params: Promise.resolve({ id: taskB.id }) },
    );
    assert.equal(cyclical.status, 409);
  });

  it("rejects a dependsOnTaskId from a different workspace, with 404", async () => {
    const aliceCookie = await signIn("deps-cross-workspace-alice@example.com");
    const bobCookie = await signIn("deps-cross-workspace-bob@example.com");

    const aliceProject = await createProject(aliceCookie, "Alice's Deps Project");
    const aliceTask = await createTask(aliceCookie, aliceProject.id, "Alice's Task");

    const bobProject = await createProject(bobCookie, "Bob's Deps Project");
    const bobTask = await createTask(bobCookie, bobProject.id, "Bob's Task");

    const response = await taskDependenciesRoute.POST(
      apiRequest("POST", `/api/tasks/${bobTask.id}/dependencies`, {
        cookie: bobCookie,
        body: { dependsOnTaskId: aliceTask.id },
      }),
      { params: Promise.resolve({ id: bobTask.id }) },
    );
    assert.equal(response.status, 404);
  });
});

/**
 * The signed-in user's own id. The public `/api/auth/session` route
 * redacts `user.id` from its JSON response (client-safe fields only), so
 * this goes through `sessionFromRequest` instead — the same helper every
 * accounts-mode route already uses to resolve the caller.
 */
async function currentUserId(cookie: string): Promise<string> {
  const session = await sessionFromRequest(apiRequest("GET", "/api/my-work", { cookie }));
  const id = session?.user?.id;
  if (!id) throw new Error("No session user id — was the caller signed in?");
  return id;
}

describe("My Work API", () => {
  it("returns only the caller's own assignments in their current workspace, across projects", async () => {
    const ownerCookie = await signIn("my-work-owner@example.com");
    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie: ownerCookie, body: { name: "My Work Test" } }),
    );
    const { workspace } = (await createWsResponse.json()) as { workspace: { id: string } };
    const ownerInWorkspace = `${ownerCookie}; cc-current-workspace=${workspace.id}`;

    const memberCookie = await joinWorkspaceAs("my-work-member@example.com", workspace.id, "member", ownerCookie);
    const ownerId = await currentUserId(ownerCookie);
    const memberId = await currentUserId(memberCookie);

    const projectOne = await createProject(ownerInWorkspace, "Project One");
    const projectTwo = await createProject(ownerInWorkspace, "Project Two");

    const taskForMember = await createTask(ownerInWorkspace, projectOne.id, "Assigned to member", {
      assigneeId: memberId,
    });
    const taskForOwner = await createTask(ownerInWorkspace, projectTwo.id, "Assigned to owner", {
      assigneeId: ownerId,
    });
    const unassigned = await createTask(ownerInWorkspace, projectOne.id, "Unassigned");

    const ownerMyWork = await myWorkRoute.GET(apiRequest("GET", "/api/my-work", { cookie: ownerInWorkspace }));
    assert.equal(ownerMyWork.status, 200);
    const { tasks: ownerTasks } = (await ownerMyWork.json()) as { tasks: { id: string }[] };
    assert.ok(ownerTasks.some((t) => t.id === taskForOwner.id));
    assert.ok(!ownerTasks.some((t) => t.id === taskForMember.id));
    assert.ok(!ownerTasks.some((t) => t.id === unassigned.id));

    const memberMyWork = await myWorkRoute.GET(apiRequest("GET", "/api/my-work", { cookie: memberCookie }));
    assert.equal(memberMyWork.status, 200);
    const { tasks: memberTasks } = (await memberMyWork.json()) as { tasks: { id: string }[] };
    assert.ok(memberTasks.some((t) => t.id === taskForMember.id));
    assert.ok(!memberTasks.some((t) => t.id === taskForOwner.id));
    assert.ok(!memberTasks.some((t) => t.id === unassigned.id));
  });

  it("updates after a workspace switch", async () => {
    const cookie = await signIn("my-work-switch@example.com");
    const userId = await currentUserId(cookie);

    const personalProject = await createProject(cookie, "Personal Project");
    const personalTask = await createTask(cookie, personalProject.id, "Personal task", { assigneeId: userId });

    const createWsResponse = await workspacesRoute.POST(
      apiRequest("POST", "/api/workspaces", { cookie, body: { name: "Team for My Work" } }),
    );
    const { workspace: teamWorkspace } = (await createWsResponse.json()) as { workspace: { id: string } };
    const switchToTeam = await currentWorkspaceRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", { cookie, body: { workspaceId: teamWorkspace.id } }),
    );
    assert.equal(switchToTeam.status, 200);
    const teamCookiePair = switchToTeam.headers.getSetCookie().join("; ").split(";")[0];
    const cookieInTeam = `${cookie}; ${teamCookiePair}`;

    const teamProject = await createProject(cookieInTeam, "Team Project");
    const teamTask = await createTask(cookieInTeam, teamProject.id, "Team task", { assigneeId: userId });

    const myWorkInTeam = await myWorkRoute.GET(apiRequest("GET", "/api/my-work", { cookie: cookieInTeam }));
    const { tasks: teamTasks } = (await myWorkInTeam.json()) as { tasks: { id: string }[] };
    assert.ok(teamTasks.some((t) => t.id === teamTask.id));
    assert.ok(!teamTasks.some((t) => t.id === personalTask.id));

    // Switching back to the personal workspace sees the original task again.
    const listResponse = await workspacesRoute.GET(apiRequest("GET", "/api/workspaces", { cookie }));
    const { workspaces } = (await listResponse.json()) as { workspaces: { id: string; kind: string }[] };
    const personalWorkspaceId = workspaces.find((w) => w.kind === "personal")?.id;
    assert.ok(personalWorkspaceId);
    const switchBack = await currentWorkspaceRoute.PUT(
      apiRequest("PUT", "/api/workspaces/current", { cookie: cookieInTeam, body: { workspaceId: personalWorkspaceId } }),
    );
    assert.equal(switchBack.status, 200);
    const personalCookiePair = switchBack.headers.getSetCookie().join("; ").split(";")[0];
    const cookieBackInPersonal = `${cookie}; ${personalCookiePair}`;

    const myWorkBackInPersonal = await myWorkRoute.GET(
      apiRequest("GET", "/api/my-work", { cookie: cookieBackInPersonal }),
    );
    const { tasks: personalTasks } = (await myWorkBackInPersonal.json()) as { tasks: { id: string }[] };
    assert.ok(personalTasks.some((t) => t.id === personalTask.id));
    assert.ok(!personalTasks.some((t) => t.id === teamTask.id));
  });
});
