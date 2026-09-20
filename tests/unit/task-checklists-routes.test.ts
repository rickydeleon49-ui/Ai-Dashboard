/**
 * Release 2C.3 Task Checklists: Desktop Route Tests.
 *
 * Verifies Next.js route handlers under /api/tasks/[id]/checklist in desktop mode:
 * - List (GET /api/tasks/:id/checklist)
 * - Add item (POST /api/tasks/:id/checklist)
 * - Text validation (empty, whitespace, >500 chars -> 422)
 * - Item limit (100-item cap per task -> 422 on 101st item)
 * - Toggle & edit (PATCH /api/tasks/:id/checklist/:itemId)
 * - Reorder (POST /api/tasks/:id/checklist/reorder & PUT /api/tasks/:id/checklist)
 * - Delete (DELETE /api/tasks/:id/checklist/:itemId)
 * - Convert to task (POST /api/tasks/:id/checklist/:itemId/convert)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";
import type { TaskChecklistItem } from "../../src/core/tasks/types";

let projectRepository: typeof import("../../src/db/repositories").projectRepository;
let taskRepository: typeof import("../../src/db/repositories").taskRepository;

type ChecklistRoute = typeof import("../../src/app/api/tasks/[id]/checklist/route");
type ChecklistItemRoute = typeof import("../../src/app/api/tasks/[id]/checklist/[itemId]/route");
type ChecklistReorderRoute = typeof import("../../src/app/api/tasks/[id]/checklist/reorder/route");
type ChecklistConvertRoute = typeof import("../../src/app/api/tasks/[id]/checklist/[itemId]/convert/route");

let checklistRoute: ChecklistRoute;
let checklistItemRoute: ChecklistItemRoute;
let checklistReorderRoute: ChecklistReorderRoute;
let checklistConvertRoute: ChecklistConvertRoute;

let projectId: string;
let taskId: string;

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  await migrate();
  ({ projectRepository, taskRepository } = await import("../../src/db/repositories"));
  checklistRoute = await import("../../src/app/api/tasks/[id]/checklist/route");
  checklistItemRoute = await import("../../src/app/api/tasks/[id]/checklist/[itemId]/route");
  checklistReorderRoute = await import("../../src/app/api/tasks/[id]/checklist/reorder/route");
  checklistConvertRoute = await import(
    "../../src/app/api/tasks/[id]/checklist/[itemId]/convert/route"
  );

  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, {
    name: "Desktop Checklist Route Project",
  });
  projectId = project.id;

  const task = await taskRepository.create(LOCAL_WORKSPACE_ID, {
    projectId,
    title: "Desktop Route Test Task",
  });
  taskId = task.id;
});

after(() => cleanup());

describe("Desktop checklist routes (/api/tasks/[id]/checklist)", () => {
  it("GET returns empty items array initially with no-store cache header", async () => {
    const req = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "GET");
    const res = await checklistRoute.GET(req, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = (await res.json()) as { items: TaskChecklistItem[] };
    assert.deepEqual(data.items, []);
  });

  it("POST validates input text (empty, whitespace, >500 chars)", async () => {
    // 1. Empty string
    const reqEmpty = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "POST", {
      text: "",
    });
    const resEmpty = await checklistRoute.POST(reqEmpty, {
      params: Promise.resolve({ id: taskId }),
    });
    assert.equal(resEmpty.status, 422);

    // 2. Whitespace only
    const reqWhitespace = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "POST", {
      text: "   ",
    });
    const resWhitespace = await checklistRoute.POST(reqWhitespace, {
      params: Promise.resolve({ id: taskId }),
    });
    assert.equal(resWhitespace.status, 422);

    // 3. Text > 500 characters
    const reqLong = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "POST", {
      text: "a".repeat(501),
    });
    const resLong = await checklistRoute.POST(reqLong, {
      params: Promise.resolve({ id: taskId }),
    });
    assert.equal(resLong.status, 422);
  });

  it("POST creates checklist items with status 201 and correct positions", async () => {
    const req1 = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "POST", {
      text: "First item",
    });
    const res1 = await checklistRoute.POST(req1, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res1.status, 201);
    const data1 = (await res1.json()) as { item: TaskChecklistItem };
    assert.equal(data1.item.text, "First item");
    assert.equal(data1.item.position, 0);
    assert.equal(data1.item.done, false);

    const req2 = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "POST", {
      text: "Second item",
    });
    const res2 = await checklistRoute.POST(req2, { params: Promise.resolve({ id: taskId }) });
    assert.equal(res2.status, 201);
    const data2 = (await res2.json()) as { item: TaskChecklistItem };
    assert.equal(data2.item.text, "Second item");
    assert.equal(data2.item.position, 1);
  });

  it("PATCH toggles completion and updates text", async () => {
    const listRes = await checklistRoute.GET(
      jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "GET"),
      { params: Promise.resolve({ id: taskId }) },
    );
    const { items } = (await listRes.json()) as { items: TaskChecklistItem[] };
    const firstItem = items[0]!;

    // Complete item
    const patchReq = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/${firstItem.id}`,
      "PATCH",
      { done: true },
    );
    const patchRes = await checklistItemRoute.PATCH(patchReq, {
      params: Promise.resolve({ id: taskId, itemId: firstItem.id }),
    });
    assert.equal(patchRes.status, 200);
    const patchedData = (await patchRes.json()) as { item: TaskChecklistItem };
    assert.equal(patchedData.item.done, true);
    assert.ok(patchedData.item.doneAt);

    // Update text
    const textReq = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/${firstItem.id}`,
      "PATCH",
      { text: "Updated First Item" },
    );
    const textRes = await checklistItemRoute.PATCH(textReq, {
      params: Promise.resolve({ id: taskId, itemId: firstItem.id }),
    });
    assert.equal(textRes.status, 200);
    const textData = (await textRes.json()) as { item: TaskChecklistItem };
    assert.equal(textData.item.text, "Updated First Item");

    // Invalid text on patch -> 422
    const invalidTextReq = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/${firstItem.id}`,
      "PATCH",
      { text: "   " },
    );
    const invalidTextRes = await checklistItemRoute.PATCH(invalidTextReq, {
      params: Promise.resolve({ id: taskId, itemId: firstItem.id }),
    });
    assert.equal(invalidTextRes.status, 422);
  });

  it("reorders checklist items via POST /reorder and PUT", async () => {
    // Add third item
    const req3 = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "POST", {
      text: "Third item",
    });
    await checklistRoute.POST(req3, { params: Promise.resolve({ id: taskId }) });

    const listRes = await checklistRoute.GET(
      jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "GET"),
      { params: Promise.resolve({ id: taskId }) },
    );
    const { items } = (await listRes.json()) as { items: TaskChecklistItem[] };
    assert.equal(items.length, 3);

    const reversedIds = [items[2]!.id, items[1]!.id, items[0]!.id];

    // Reorder via POST /api/tasks/:id/checklist/reorder
    const reorderReq = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/reorder`,
      "POST",
      { itemIds: reversedIds },
    );
    const reorderRes = await checklistReorderRoute.POST(reorderReq, {
      params: Promise.resolve({ id: taskId }),
    });
    assert.equal(reorderRes.status, 200);
    const reordered = (await reorderRes.json()) as { items: TaskChecklistItem[] };
    assert.equal(reordered.items[0]?.id, items[2]!.id);
    assert.equal(reordered.items[0]?.position, 0);
    assert.equal(reordered.items[1]?.id, items[1]!.id);
    assert.equal(reordered.items[1]?.position, 1);
    assert.equal(reordered.items[2]?.id, items[0]!.id);
    assert.equal(reordered.items[2]?.position, 2);

    // Reorder via PUT /api/tasks/:id/checklist
    const putReq = jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "PUT", {
      itemIds: items.map((i) => i.id),
    });
    const putRes = await checklistRoute.PUT(putReq, { params: Promise.resolve({ id: taskId }) });
    assert.equal(putRes.status, 200);

    // Invalid reorder (duplicate / mismatched length) -> 422
    const invalidReorderReq = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/reorder`,
      "POST",
      { itemIds: [items[0]!.id] },
    );
    const invalidReorderRes = await checklistReorderRoute.POST(invalidReorderReq, {
      params: Promise.resolve({ id: taskId }),
    });
    assert.equal(invalidReorderRes.status, 422);
  });

  it("DELETE removes an item and re-indexes remaining items", async () => {
    const listRes = await checklistRoute.GET(
      jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "GET"),
      { params: Promise.resolve({ id: taskId }) },
    );
    const { items } = (await listRes.json()) as { items: TaskChecklistItem[] };
    const toDelete = items[0]!;

    const delReq = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/${toDelete.id}`,
      "DELETE",
    );
    const delRes = await checklistItemRoute.DELETE(delReq, {
      params: Promise.resolve({ id: taskId, itemId: toDelete.id }),
    });
    assert.equal(delRes.status, 200);
    const delData = (await delRes.json()) as { ok: boolean };
    assert.equal(delData.ok, true);

    const afterRes = await checklistRoute.GET(
      jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "GET"),
      { params: Promise.resolve({ id: taskId }) },
    );
    const afterItems = ((await afterRes.json()) as { items: TaskChecklistItem[] }).items;
    assert.equal(afterItems.length, 2);
    assert.equal(afterItems[0]?.position, 0);
    assert.equal(afterItems[1]?.position, 1);
  });

  it("POST /convert converts checklist item into top-level task and deletes item", async () => {
    const listRes = await checklistRoute.GET(
      jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "GET"),
      { params: Promise.resolve({ id: taskId }) },
    );
    const { items } = (await listRes.json()) as { items: TaskChecklistItem[] };
    const toConvert = items[0]!;

    const convertReq = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/${toConvert.id}/convert`,
      "POST",
    );
    const convertRes = await checklistConvertRoute.POST(convertReq, {
      params: Promise.resolve({ id: taskId, itemId: toConvert.id }),
    });
    assert.equal(convertRes.status, 201);
    const convertData = (await convertRes.json()) as { task: { id: string; title: string; projectId: string } };
    assert.equal(convertData.task.title, toConvert.text);
    assert.equal(convertData.task.projectId, projectId);

    // Verify item is removed from checklist
    const afterRes = await checklistRoute.GET(
      jsonRequest(`http://localhost/api/tasks/${taskId}/checklist`, "GET"),
      { params: Promise.resolve({ id: taskId }) },
    );
    const afterItems = ((await afterRes.json()) as { items: TaskChecklistItem[] }).items;
    assert.equal(afterItems.length, items.length - 1);
    assert.ok(!afterItems.some((i) => i.id === toConvert.id));

    // Verify task exists in repository
    const createdTask = await taskRepository.findById(LOCAL_WORKSPACE_ID, convertData.task.id);
    assert.ok(createdTask);
    assert.equal(createdTask.title, toConvert.text);
  });

  it("enforces 100-item per-task limit", async () => {
    const limitTask = await taskRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Limit Task Test",
    });

    // Create 100 items directly via repository for speed
    const { checklistRepository } = await import("../../src/db/repositories");
    for (let i = 0; i < 100; i++) {
      await checklistRepository.create(LOCAL_WORKSPACE_ID, limitTask.id, { text: `Item ${i}` });
    }

    // 101st item via POST route must fail with 422
    const req101 = jsonRequest(`http://localhost/api/tasks/${limitTask.id}/checklist`, "POST", {
      text: "Item 101",
    });
    const res101 = await checklistRoute.POST(req101, {
      params: Promise.resolve({ id: limitTask.id }),
    });
    assert.equal(res101.status, 422);
    const errData = (await res101.json()) as { error: string };
    assert.match(errData.error, /cannot exceed 100 items/i);
  });

  it("returns 404 when targeting nonexistent task or nonexistent checklist item", async () => {
    const reqNonexistentTask = jsonRequest(
      "http://localhost/api/tasks/tsk_nonexistent/checklist",
      "GET",
    );
    const resNonexistentTask = await checklistRoute.GET(reqNonexistentTask, {
      params: Promise.resolve({ id: "tsk_nonexistent" }),
    });
    assert.equal(resNonexistentTask.status, 404);

    const reqNonexistentItem = jsonRequest(
      `http://localhost/api/tasks/${taskId}/checklist/chk_nonexistent`,
      "PATCH",
      { text: "Hello" },
    );
    const resNonexistentItem = await checklistItemRoute.PATCH(reqNonexistentItem, {
      params: Promise.resolve({ id: taskId, itemId: "chk_nonexistent" }),
    });
    assert.equal(resNonexistentItem.status, 404);
  });
});
