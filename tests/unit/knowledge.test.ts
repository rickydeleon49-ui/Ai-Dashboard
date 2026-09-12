/**
 * Knowledge documents against a throwaway SQLite database — desktop mode.
 * Workspace isolation (the reason a Postgres implementation exists at all)
 * is covered separately in tests/unit-pg/knowledge-repository.test.ts; this
 * file exercises the CRUD + search shape both implementations share.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";

let projectRepository: import("../../src/db/repositories/project-repository").ProjectRepository;
let knowledgeDocumentRepository: import(
  "../../src/db/repositories/knowledge-document-repository"
).KnowledgeDocumentRepository;
let projectId: string;

before(async () => {
  await migrate();
  ({ projectRepository, knowledgeDocumentRepository } = await import("../../src/db/repositories"));
  const project = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Test Project" });
  projectId = project.id;
});

after(() => cleanup());

describe("knowledge documents (SQLite)", () => {
  it("creates a document with defaults", async () => {
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Onboarding notes",
    });
    assert.equal(doc.content, "");
    assert.equal(doc.category, null);
    assert.equal(doc.pinned, false);
  });

  it("updates title, content, category and pinned", async () => {
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Draft",
      content: "first draft",
    });

    const updated = await knowledgeDocumentRepository.update(LOCAL_WORKSPACE_ID, doc.id, {
      title: "Final",
      content: "final content",
      category: "runbooks",
      pinned: true,
    });
    assert.equal(updated?.title, "Final");
    assert.equal(updated?.content, "final content");
    assert.equal(updated?.category, "runbooks");
    assert.equal(updated?.pinned, true);
  });

  it("lists only documents for the given project, pinned first", async () => {
    const other = await projectRepository.create(LOCAL_WORKSPACE_ID, { name: "Other Project" });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, { projectId, title: "Mine" });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId: other.id,
      title: "Not mine",
    });
    const pinned = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Pinned one",
      pinned: true,
    });

    const list = await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId);
    assert.ok(list.every((d) => d.title !== "Not mine"));
    assert.ok(list.some((d) => d.title === "Mine"));
    assert.equal(list[0]?.id, pinned.id);
  });

  it("filters by category", async () => {
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Runbook A",
      category: "runbooks",
    });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Design note",
      category: "design",
    });

    const runbooksOnly = await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId, {
      category: "runbooks",
    });
    assert.ok(runbooksOnly.every((d) => d.category === "runbooks"));
    assert.ok(runbooksOnly.some((d) => d.title === "Runbook A"));
  });

  it("search matches title, content, and category", async () => {
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Deploy steps",
      content: "run the release script",
      category: "ops",
    });
    await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Unrelated",
      content: "nothing relevant here",
    });

    const byTitle = await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId, {
      search: "deploy",
    });
    assert.ok(byTitle.some((d) => d.title === "Deploy steps"));

    const byContent = await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId, {
      search: "release script",
    });
    assert.ok(byContent.some((d) => d.title === "Deploy steps"));

    const byCategory = await knowledgeDocumentRepository.list(LOCAL_WORKSPACE_ID, projectId, {
      search: "ops",
    });
    assert.ok(byCategory.some((d) => d.title === "Deploy steps"));
  });

  it("delete removes the row; a second delete reports false", async () => {
    const doc = await knowledgeDocumentRepository.create(LOCAL_WORKSPACE_ID, {
      projectId,
      title: "Temporary",
    });
    assert.equal(await knowledgeDocumentRepository.delete(LOCAL_WORKSPACE_ID, doc.id), true);
    assert.equal(await knowledgeDocumentRepository.delete(LOCAL_WORKSPACE_ID, doc.id), false);
    assert.equal(await knowledgeDocumentRepository.findById(LOCAL_WORKSPACE_ID, doc.id), null);
  });

  it("rejects a non-local workspace id", async () => {
    await assert.rejects(() => knowledgeDocumentRepository.list("some-other-workspace", projectId));
  });
});
