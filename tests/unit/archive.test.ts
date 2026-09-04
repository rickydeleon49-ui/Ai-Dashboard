/**
 * Archiving and restoring a project.
 *
 * The bug these cover: restoring cleared the `archived` flag but left
 * `status` reading "archived", so a restored project came back to the library
 * still badged as archived, still matched the archived status filter, and still
 * counted toward the dashboard's archived total — while the archive itself was
 * empty.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate } from "../helpers/db";
import type { ProjectRepository } from "../../src/db/repositories/project-repository";

// Loaded in `before` rather than at the top of the file: the database client
// opens its connection at import time, so DATABASE_PATH (set by the helper
// above) has to be in place first, and a top-level await here would make this
// an async module that the CJS test transform cannot require.
let projectRepository: ProjectRepository;

before(async () => {
  await migrate();
  ({ projectRepository } = await import("../../src/db/repositories"));
});

after(() => cleanup());

describe("archive and restore", () => {
  it("moves status to archived and remembers where it came from", async () => {
    const project = await projectRepository.create({
      name: "Paused thing",
      source: "manual",
      type: "software",
      status: "paused",
    });

    const archived = await projectRepository.update(project.id, { archived: true });
    assert.equal(archived?.archived, true);
    assert.equal(archived?.status, "archived");
    assert.equal(archived?.metadata.statusBeforeArchive, "paused");
  });

  it("restores the status the project had before archiving", async () => {
    const project = await projectRepository.create({
      name: "Completed thing",
      source: "manual",
      type: "software",
      status: "completed",
    });

    await projectRepository.update(project.id, { archived: true });
    const restored = await projectRepository.update(project.id, { archived: false });

    assert.equal(restored?.archived, false);
    assert.equal(restored?.status, "completed", "status must not stay archived");
    assert.equal(
      restored?.metadata.statusBeforeArchive,
      undefined,
      "the bookkeeping key should be cleared once used",
    );
  });

  it("falls back to active for a project archived before this was recorded", async () => {
    const project = await projectRepository.create({
      name: "Legacy",
      source: "manual",
      type: "software",
      status: "active",
    });

    // Simulate the old behaviour: flag and status set, nothing remembered.
    await projectRepository.update(project.id, { status: "archived" });
    await projectRepository.update(project.id, { archived: true });

    const restored = await projectRepository.update(project.id, { archived: false });
    assert.equal(restored?.status, "active");
  });

  it("lets an explicit status win over the remembered one", async () => {
    const project = await projectRepository.create({
      name: "Explicit",
      source: "manual",
      type: "software",
      status: "planning",
    });

    await projectRepository.update(project.id, { archived: true });
    const restored = await projectRepository.update(project.id, {
      archived: false,
      status: "active",
    });

    assert.equal(restored?.status, "active");
  });

  it("keeps archived projects out of the default listing and in the stats", async () => {
    const project = await projectRepository.create({
      name: "Counted",
      source: "manual",
      type: "software",
      status: "active",
    });
    await projectRepository.update(project.id, { archived: true });

    const visible = await projectRepository.list({});
    assert.equal(
      visible.some((p) => p.id === project.id),
      false,
      "an archived project should not appear in the default library view",
    );

    const stats = await projectRepository.stats();
    assert.ok(stats.archived >= 1);
  });
});
