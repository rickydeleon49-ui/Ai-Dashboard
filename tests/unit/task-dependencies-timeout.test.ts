import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import { TaskLockTimeoutError } from "../../src/core/tasks/errors";

describe("POST /api/tasks/:id/dependencies lock timeout handling", () => {
  let projectRepository: import("../../src/db/repositories/project-repository").ProjectRepository;
  let taskRepository: import("../../src/db/repositories/task-repository").TaskRepository;
  let route: typeof import("../../src/app/api/tasks/[id]/dependencies/route");
  let projectId: string;
  let t1Id: string;
  let t2Id: string;

  before(async () => {
    await migrate();
    ({ projectRepository, taskRepository } = await import("../../src/db/repositories"));
    route = await import("../../src/app/api/tasks/[id]/dependencies/route");

    const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Timeout Test Project" });
    projectId = project.id;
    const t1 = await taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "Task 1" });
    const t2 = await taskRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "Task 2" });
    t1Id = t1.id;
    t2Id = t2.id;
  });

  after(() => cleanup());

  it("maps TaskLockTimeoutError to HTTP 503 with retryable: true and Retry-After: 1", async () => {
    const originalAddDependency = taskRepository.addDependency;
    const timeoutErrorMessage = `Task mutation timed out waiting for workspace lock on "${LOCAL_WORKSPACE_ID}"; please retry.`;

    taskRepository.addDependency = async () => {
      throw new TaskLockTimeoutError(timeoutErrorMessage);
    };

    try {
      const request = new NextRequest(`http://localhost/api/tasks/${t1Id}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dependsOnTaskId: t2Id }),
      });

      const response = await route.POST(request, { params: Promise.resolve({ id: t1Id }) });

      assert.equal(response.status, 503, "Must return HTTP 503 on lock timeout");
      assert.equal(response.headers.get("retry-after"), "1", "Must include Retry-After: 1 header");

      const body = (await response.json()) as { error: string; retryable: boolean };
      assert.equal(body.error, timeoutErrorMessage);
      assert.equal(body.retryable, true);
    } finally {
      taskRepository.addDependency = originalAddDependency;
    }
  });
});
