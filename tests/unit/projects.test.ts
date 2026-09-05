/**
 * Project queries: search, filtering and the counts the dashboard renders.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import type { ProjectRepository } from "../../src/db/repositories/project-repository";

let projectRepository: ProjectRepository;

before(async () => {
  await migrate();
  ({ projectRepository } = await import("../../src/db/repositories"));

  await projectRepository.create({
    name: "Trading Agent",
    description: "Autonomous IBKR execution",
    source: "manual",
    type: "automation",
    status: "active",
    tags: ["python", "finance"],
  });
  await projectRepository.create({
    name: "Dashboard",
    description: "Personal command center",
    source: "github",
    type: "software",
    status: "active",
    tags: ["typescript"],
    favorite: true,
  });
  await projectRepository.create({
    name: "Old Experiment",
    description: "Shelved for now",
    source: "uploaded",
    type: "experiment",
    status: "paused",
    tags: ["python"],
  });
});

after(() => cleanup());

const names = (list: Array<{ name: string }>) => list.map((p) => p.name).sort();

describe("project queries", () => {
  it("searches names", async () => {
    assert.deepEqual(names(await projectRepository.list({ search: "trading" })), [
      "Trading Agent",
    ]);
  });

  it("searches descriptions, not just names", async () => {
    assert.deepEqual(names(await projectRepository.list({ search: "command" })), [
      "Dashboard",
    ]);
  });

  it("searches tags", async () => {
    assert.deepEqual(names(await projectRepository.list({ search: "python" })), [
      "Old Experiment",
      "Trading Agent",
    ]);
  });

  it("filters by source", async () => {
    assert.deepEqual(names(await projectRepository.list({ source: "github" })), [
      "Dashboard",
    ]);
  });

  it("filters by status", async () => {
    assert.deepEqual(names(await projectRepository.list({ status: "paused" })), [
      "Old Experiment",
    ]);
  });

  it("returns nothing rather than everything for an unmatched search", async () => {
    assert.deepEqual(await projectRepository.list({ search: "zzzz-no-match" }), []);
  });

  it("counts by source, and counts archived separately", async () => {
    const stats = await projectRepository.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.github, 1);
    assert.equal(stats.uploaded, 1);
    assert.equal(stats.manual, 1);
    assert.equal(stats.archived, 0);
  });

  it("lists every tag in use", async () => {
    const tags = (await projectRepository.allTags()).map((t) =>
      typeof t === "string" ? t : t.name,
    );
    assert.deepEqual(tags.sort(), ["finance", "python", "typescript"]);
  });

  it("summaries carry what the command palette needs", async () => {
    const summaries = await projectRepository.listSummaries();
    assert.equal(summaries.length, 3);
    for (const summary of summaries) {
      assert.ok(summary.id && summary.name, "id and name are required");
    }
  });
});
