/**
 * Shared PostgreSQL seed for the Release 2C.6 notification suites. Call only
 * after tests/helpers/db.pg.ts's migrate(): every application module is
 * imported dynamically here, after DATABASE_URL points at the throwaway DB.
 */
export const W1 = "ws-notif-1";
export const W2 = "ws-notif-2";

export const U = {
  alice: "a0000000-0000-4000-8000-000000000001", // actor, owner of W1
  bob: "b0000000-0000-4000-8000-000000000002", // member of W1 and W2
  carol: "c0000000-0000-4000-8000-000000000003", // member of W1
  vic: "d0000000-0000-4000-8000-000000000004", // viewer of W1
  sus: "e0000000-0000-4000-8000-000000000005", // suspended in W1
  rem: "f0000000-0000-4000-8000-000000000006", // removed from W1
  inv: "10000000-0000-4000-8000-000000000007", // invited to W1
  out: "20000000-0000-4000-8000-000000000008", // outsider (owner of W2 only)
} as const;

export async function seedNotificationWorld() {
  const { getPgDb } = await import("../../src/db/pg-client");
  const schema = await import("../../src/db/schema.pg");
  const { PostgresProjectRepository } = await import("../../src/db/repositories/postgres-project-repository");
  const { PostgresTaskRepository } = await import("../../src/db/repositories/postgres-task-repository");
  const { PostgresCommentRepository } = await import("../../src/db/repositories/postgres-comment-repository");
  const notificationModule = await import("../../src/db/repositories/postgres-notification-repository");

  const db = getPgDb();
  const names: Record<string, string> = {
    [U.alice]: "Alice Actor",
    [U.bob]: "Bob Member",
    [U.carol]: "Carol Member",
    [U.vic]: "Vic Viewer",
    [U.sus]: "Sue Suspended",
    [U.rem]: "Rex Removed",
    [U.inv]: "Ivy Invited",
    [U.out]: "Oscar Outsider",
  };
  for (const id of Object.values(U)) {
    await db.insert(schema.users).values({ id, name: names[id], email: `${id}@example.com` }).onConflictDoNothing();
  }
  for (const id of [W1, W2]) {
    await db
      .insert(schema.workspaces)
      .values({ id, name: `Workspace ${id}`, slug: id, kind: "team" })
      .onConflictDoNothing();
  }
  await db
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: W1, userId: U.alice, role: "owner", status: "active" },
      { workspaceId: W1, userId: U.bob, role: "member", status: "active" },
      { workspaceId: W1, userId: U.carol, role: "member", status: "active" },
      { workspaceId: W1, userId: U.vic, role: "viewer", status: "active" },
      { workspaceId: W1, userId: U.sus, role: "member", status: "suspended" },
      { workspaceId: W1, userId: U.rem, role: "member", status: "removed" },
      { workspaceId: W1, userId: U.inv, role: "member", status: "invited" },
      { workspaceId: W2, userId: U.out, role: "owner", status: "active" },
      { workspaceId: W2, userId: U.bob, role: "member", status: "active" },
    ])
    .onConflictDoNothing();

  const projectRepo = new PostgresProjectRepository();
  const taskRepo = new PostgresTaskRepository();
  const commentRepo = new PostgresCommentRepository();
  const notificationRepo = new notificationModule.PostgresNotificationRepository();

  const project1 = await projectRepo.create(W1, { name: "Notif Project One" });
  const project2 = await projectRepo.create(W2, { name: "Notif Project Two" });

  return {
    db,
    schema,
    projectRepo,
    taskRepo,
    commentRepo,
    notificationRepo,
    insertNotificationDrafts: notificationModule.insertNotificationDrafts,
    project1: project1.id,
    project2: project2.id,
  };
}

export type NotificationWorld = Awaited<ReturnType<typeof seedNotificationWorld>>;
