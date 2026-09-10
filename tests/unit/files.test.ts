/**
 * File storage safety and batch upload behaviour.
 *
 * Two things are covered: that a supplied filename can never influence where
 * bytes land, and that a batch which partly fails reports per file rather than
 * as a flat failure — the bug being that earlier files stayed on disk and in
 * the database while the caller was told the upload had failed.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, migrate, testRoot } from "../helpers/db";
import { LOCAL_WORKSPACE_ID } from "../../src/db/repositories/project-repository";

let files: typeof import("../../src/core/files/service");
let projectRepository: typeof import("../../src/db/repositories").projectRepository;

before(async () => {
  await migrate();
  files = await import("../../src/core/files/service");
  ({ projectRepository } = await import("../../src/db/repositories"));
});

after(() => cleanup());

async function newProject(name: string) {
  return projectRepository.create(LOCAL_WORKSPACE_ID, {
    name,
    source: "uploaded",
    type: "software",
    status: "active",
  });
}

const uploadsDir = () => path.join(testRoot, "uploads");

describe("file storage safety", () => {
  it("never lets a supplied filename escape the uploads directory", async () => {
    const project = await newProject("Traversal");
    const hostile = new File(["x"], "../../../../etc/passwd", { type: "text/plain" });

    const stored = await files.addProjectFile(project.id, hostile);

    // The display name is preserved verbatim; the path is not derived from it.
    assert.equal(stored.filename, "../../../../etc/passwd");
    assert.ok(
      !stored.storageKey.includes(".."),
      `storage key must not contain traversal: ${stored.storageKey}`,
    );

    const resolved = path.resolve(uploadsDir(), stored.storageKey);
    assert.ok(
      resolved.startsWith(path.resolve(uploadsDir()) + path.sep),
      `bytes landed outside the uploads directory: ${resolved}`,
    );
    assert.ok(existsSync(resolved));
  });

  it("stores the exact bytes it was given", async () => {
    const project = await newProject("Roundtrip");
    const body = "line one\nline two\n";
    const stored = await files.addProjectFile(
      project.id,
      new File([body], "notes.txt", { type: "text/plain" }),
    );

    assert.equal(stored.size, Buffer.byteLength(body));
    const read = await files.readFileContents(stored);
    assert.equal(read.toString("utf8"), body);
  });

  it("rejects a single file over the per-file limit", async () => {
    const project = await newProject("Too big");
    const huge = new File(["small"], "huge.bin");
    // Reported size is what the limit checks, so the bytes need not be real.
    Object.defineProperty(huge, "size", { value: files.MAX_UPLOAD_BYTES + 1 });

    await assert.rejects(
      () => files.addProjectFile(project.id, huge),
      /larger than the .*limit/,
    );
  });
});

describe("batch uploads", () => {
  it("reports each file separately when one of them fails", async () => {
    const project = await newProject("Partial");

    const good = new File(["ok"], "good.txt");
    const bad = new File(["nope"], "bad.bin");
    Object.defineProperty(bad, "size", { value: files.MAX_UPLOAD_BYTES + 1 });
    const alsoGood = new File(["fine"], "also-good.txt");

    const outcomes = await files.addProjectFiles(project.id, [good, bad, alsoGood]);

    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0]?.ok, true);
    assert.equal(outcomes[1]?.ok, false);
    assert.equal(outcomes[2]?.ok, true, "a failure must not stop later files");

    // The files that succeeded are really there — which is precisely why
    // reporting the batch as a flat failure was wrong.
    const stored = await files.listProjectFiles(project.id);
    assert.deepEqual(
      stored.map((f) => f.filename).sort(),
      ["also-good.txt", "good.txt"],
    );
  });

  it("refuses a batch over the total limit without writing anything", async () => {
    const project = await newProject("Over budget");

    const parts = [0, 1, 2].map((n) => {
      const file = new File(["x"], `part-${n}.bin`);
      Object.defineProperty(file, "size", { value: files.MAX_UPLOAD_BYTES });
      return file;
    });

    const outcomes = await files.addProjectFiles(project.id, parts);

    assert.ok(outcomes.every((o) => !o.ok), "the whole batch should be refused");
    assert.equal((await files.listProjectFiles(project.id)).length, 0);
    assert.equal(
      existsSync(path.join(uploadsDir(), project.id)),
      false,
      "nothing should have been written for a refused batch",
    );
  });

  it("removes both the row and the bytes on delete", async () => {
    const project = await newProject("Deletable");
    const stored = await files.addProjectFile(
      project.id,
      new File(["bye"], "temp.txt"),
    );
    const onDisk = path.resolve(uploadsDir(), stored.storageKey);
    assert.ok(existsSync(onDisk));

    assert.equal(await files.deleteProjectFile(stored.id), true);
    assert.equal(await files.findFile(stored.id), null);
    assert.equal(existsSync(onDisk), false);
    assert.equal(await files.deleteProjectFile(stored.id), false);
  });

  it("leaves no partial file behind when a write fails mid-stream", async () => {
    const project = await newProject("Broken stream");
    const failing = new File(["x"], "broken.bin");
    Object.defineProperty(failing, "stream", {
      value: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.error(new Error("connection dropped"));
          },
        }),
    });

    await assert.rejects(() => files.addProjectFile(project.id, failing));

    // The project directory is created before the write is attempted, so an
    // empty directory is expected. What must not survive is the file itself,
    // holding the bytes that arrived before the stream errored.
    const projectDir = path.join(uploadsDir(), project.id);
    assert.deepEqual(
      existsSync(projectDir) ? readdirSync(projectDir) : [],
      [],
      "a truncated file must not be left on disk",
    );
    assert.equal((await files.listProjectFiles(project.id)).length, 0);
  });
});
