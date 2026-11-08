/**
 * Unit tests for JSON Schema export of planner and reviewer outputs (Round AW2-01).
 *
 * Source of truth: docs/design/AW-agent-workflow-control-center.md §3.1, §16.2 row 1.
 *
 * Verifies that:
 * 1. Both exports are Draft 2020-12 JSON Schema objects with type "object".
 * 2. Required keys match the Zod schema shape.
 * 3. additionalProperties: false is asserted on every object (top-level and nested finding items).
 * 4. Valid planner and reviewer samples round-trip through Zod and all used keys appear in properties.
 * 5. Bounds survive export (reviewer findings maxItems 100, planner checks maxItems 20, etc.).
 * 6. writeSchemaFile writes to a temp directory, files parse back to deepEqual the export, end with \n,
 *    and temp directories are cleaned up.
 * 7. Invalid roles throw before writing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  plannerJsonSchema,
  reviewerJsonSchema,
  writeSchemaFile,
} from "../../src/core/agents/schemas/export";
import {
  plannerOutputSchema,
  reviewerOutputSchema,
} from "../../src/core/agents/schema";

/**
 * Recursively asserts that every schema object with type: "object" explicitly
 * sets additionalProperties: false.
 */
function assertAllObjectsDisallowAdditionalProperties(
  node: unknown,
  pointer = "#",
): void {
  if (!node || typeof node !== "object") return;

  const schema = node as Record<string, unknown>;

  if (schema.type === "object") {
    assert.equal(
      schema.additionalProperties,
      false,
      `Expected additionalProperties: false at ${pointer}`,
    );
  }

  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(
      schema.properties as Record<string, unknown>,
    )) {
      assertAllObjectsDisallowAdditionalProperties(
        value,
        `${pointer}/properties/${key}`,
      );
    }
  }

  if (schema.items && typeof schema.items === "object") {
    assertAllObjectsDisallowAdditionalProperties(
      schema.items,
      `${pointer}/items`,
    );
  }
}

describe("agent schema export (Round AW2-01)", () => {
  describe("schema structure and strictness", () => {
    it("exports planner JSON Schema with type object, required keys, and additionalProperties false", () => {
      const schema = plannerJsonSchema();

      assert.equal(typeof schema, "object");
      assert.notEqual(schema, null);
      assert.equal(schema.type, "object");
      assert.equal(
        schema.$schema,
        "https://json-schema.org/draft/2020-12/schema",
      );
      assert.equal(
        schema.additionalProperties,
        false,
        "planner schema top-level must have additionalProperties: false",
      );

      // Required keys matching Zod plannerOutputSchema shape
      const required = schema.required?.slice().sort();
      assert.deepEqual(required, [
        "acceptance",
        "checks",
        "scope_paths",
        "task",
      ]);

      const properties = schema.properties as Record<string, unknown>;
      assert.ok(properties.task, "expected 'task' in planner properties");
      assert.ok(
        properties.scope_paths,
        "expected 'scope_paths' in planner properties",
      );
      assert.ok(
        properties.acceptance,
        "expected 'acceptance' in planner properties",
      );
      assert.ok(properties.checks, "expected 'checks' in planner properties");

      assertAllObjectsDisallowAdditionalProperties(schema, "#/planner");
    });

    it("exports reviewer JSON Schema with type object, required keys, and additionalProperties false on top-level and finding items", () => {
      const schema = reviewerJsonSchema();

      assert.equal(typeof schema, "object");
      assert.notEqual(schema, null);
      assert.equal(schema.type, "object");
      assert.equal(
        schema.$schema,
        "https://json-schema.org/draft/2020-12/schema",
      );
      assert.equal(
        schema.additionalProperties,
        false,
        "reviewer schema top-level must have additionalProperties: false",
      );

      // Required keys matching Zod reviewerOutputSchema shape
      const required = schema.required?.slice().sort();
      assert.deepEqual(required, ["findings", "verdict"]);

      const properties = schema.properties as Record<string, unknown>;
      assert.ok(properties.verdict, "expected 'verdict' in reviewer properties");
      assert.ok(
        properties.findings,
        "expected 'findings' in reviewer properties",
      );

      // Inspect findings array items (reviewerFindingSchema)
      const findingsArray = properties.findings as Record<string, unknown>;
      assert.equal(findingsArray.type, "array");

      const findingItems = findingsArray.items as Record<string, unknown>;
      assert.equal(typeof findingItems, "object");
      assert.notEqual(findingItems, null);
      assert.equal(findingItems.type, "object");
      assert.equal(
        findingItems.additionalProperties,
        false,
        "finding items schema must have additionalProperties: false",
      );

      // Required keys on finding items (severity, message, actionable are required; path and line are optional)
      const findingRequired = (
        findingItems.required as string[] | undefined
      )?.slice().sort();
      assert.deepEqual(findingRequired, ["actionable", "message", "severity"]);

      const findingProperties = findingItems.properties as Record<
        string,
        unknown
      >;
      assert.ok(findingProperties.severity, "expected 'severity' in finding");
      assert.ok(findingProperties.path, "expected 'path' in finding");
      assert.ok(findingProperties.line, "expected 'line' in finding");
      assert.ok(findingProperties.message, "expected 'message' in finding");
      assert.ok(findingProperties.actionable, "expected 'actionable' in finding");

      assertAllObjectsDisallowAdditionalProperties(schema, "#/reviewer");
    });
  });

  describe("round-trip and property presence", () => {
    it("round-trips a valid planner sample through Zod and verifies every key appears in exported properties", () => {
      const plannerSample = {
        task: "Implement JSON Schema export for planner and reviewer output",
        scope_paths: [
          "src/core/agents/schemas/export.ts",
          "tests/unit/agent-schema-export.test.ts",
        ],
        acceptance: [
          "Export planner and reviewer schemas to Draft 2020-12",
          "Enforce additionalProperties: false on objects",
        ],
        checks: ["typecheck", "lint", "test:unit"],
      };

      // Validates successfully with Zod runtime schema
      const parsed = plannerOutputSchema.parse(plannerSample);
      assert.deepEqual(parsed, plannerSample);

      // Every key used appears in the exported properties
      const schema = plannerJsonSchema();
      const properties = schema.properties as Record<string, unknown>;
      for (const key of Object.keys(plannerSample)) {
        assert.ok(
          key in properties,
          `Key '${key}' from planner sample must appear in exported properties`,
        );
      }
    });

    it("round-trips a valid reviewer sample through Zod and verifies every key appears in exported properties", () => {
      const reviewerSample = {
        verdict: "request_changes" as const,
        findings: [
          {
            severity: "P1" as const,
            path: "src/core/agents/schemas/export.ts",
            line: 42,
            message: "Role must be validated against allowed values",
            actionable: true,
          },
          {
            severity: "P2" as const,
            message: "Trailing newline required in schema file",
            actionable: false,
          },
        ],
      };

      // Validates successfully with Zod runtime schema
      const parsed = reviewerOutputSchema.parse(reviewerSample);
      assert.deepEqual(parsed, reviewerSample);

      // Top-level keys appear in reviewer properties
      const schema = reviewerJsonSchema();
      const properties = schema.properties as Record<string, unknown>;
      for (const key of Object.keys(reviewerSample)) {
        assert.ok(
          key in properties,
          `Key '${key}' from reviewer sample must appear in exported properties`,
        );
      }

      // Finding item keys appear in finding items properties
      const findingsArray = properties.findings as Record<string, unknown>;
      const findingItems = findingsArray.items as Record<string, unknown>;
      const findingItemProps = findingItems.properties as Record<string, unknown>;

      for (const finding of reviewerSample.findings) {
        for (const key of Object.keys(finding)) {
          assert.ok(
            key in findingItemProps,
            `Finding key '${key}' must appear in exported finding item properties`,
          );
        }
      }
    });
  });

  describe("bounds survive export", () => {
    it("preserves reviewer findings maxItems 100 and planner checks maxItems 20", () => {
      const plannerSchema = plannerJsonSchema();
      const plannerProps = plannerSchema.properties as Record<string, unknown>;
      const checksSchema = plannerProps.checks as Record<string, unknown>;
      assert.equal(
        checksSchema.maxItems,
        20,
        "planner checks must have maxItems: 20",
      );

      const reviewerSchema = reviewerJsonSchema();
      const reviewerProps = reviewerSchema.properties as Record<string, unknown>;
      const findingsSchema = reviewerProps.findings as Record<string, unknown>;
      assert.equal(
        findingsSchema.maxItems,
        100,
        "reviewer findings must have maxItems: 100",
      );

      // Verify other bounds survive export as well
      const scopePathsSchema = plannerProps.scope_paths as Record<
        string,
        unknown
      >;
      assert.equal(
        scopePathsSchema.maxItems,
        200,
        "planner scope_paths must have maxItems: 200",
      );

      const acceptanceSchema = plannerProps.acceptance as Record<
        string,
        unknown
      >;
      assert.equal(
        acceptanceSchema.maxItems,
        50,
        "planner acceptance must have maxItems: 50",
      );

      const taskSchema = plannerProps.task as Record<string, unknown>;
      assert.equal(taskSchema.maxLength, 20000, "planner task maxLength: 20000");
    });
  });

  describe("writeSchemaFile", () => {
    let suiteTempDir: string;

    before(async () => {
      suiteTempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "agent-schema-suite-"),
      );
    });

    after(async () => {
      if (suiteTempDir) {
        await fs.promises.rm(suiteTempDir, { recursive: true, force: true });
      }
    });

    it("writes planner-output.schema.json, parses back to deepEqual the export, and ends with \\n", async () => {
      const returnedPath = await writeSchemaFile(suiteTempDir, "planner");
      const expectedPath = path.resolve(
        suiteTempDir,
        "planner-output.schema.json",
      );

      assert.equal(returnedPath, expectedPath);
      assert.ok(fs.existsSync(returnedPath), "file must exist on disk");

      const rawContent = await fs.promises.readFile(returnedPath, "utf8");
      assert.ok(
        rawContent.endsWith("\n"),
        "planner schema file must end with trailing newline '\\n'",
      );

      const parsed = JSON.parse(rawContent);
      assert.deepEqual(parsed, plannerJsonSchema());
    });

    it("writes reviewer-output.schema.json, parses back to deepEqual the export, and ends with \\n", async () => {
      const returnedPath = await writeSchemaFile(suiteTempDir, "reviewer");
      const expectedPath = path.resolve(
        suiteTempDir,
        "reviewer-output.schema.json",
      );

      assert.equal(returnedPath, expectedPath);
      assert.ok(fs.existsSync(returnedPath), "file must exist on disk");

      const rawContent = await fs.promises.readFile(returnedPath, "utf8");
      assert.ok(
        rawContent.endsWith("\n"),
        "reviewer schema file must end with trailing newline '\\n'",
      );

      const parsed = JSON.parse(rawContent);
      assert.deepEqual(parsed, reviewerJsonSchema());
    });

    it("operates in a fresh mkdtemp folder removed in a finally block", async () => {
      const isolatedTempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "agent-schema-isolated-"),
      );

      try {
        const plannerPath = await writeSchemaFile(isolatedTempDir, "planner");
        const reviewerPath = await writeSchemaFile(isolatedTempDir, "reviewer");

        const plannerContent = await fs.promises.readFile(plannerPath, "utf8");
        const reviewerContent = await fs.promises.readFile(reviewerPath, "utf8");

        assert.ok(plannerContent.endsWith("\n"));
        assert.ok(reviewerContent.endsWith("\n"));

        assert.deepEqual(JSON.parse(plannerContent), plannerJsonSchema());
        assert.deepEqual(JSON.parse(reviewerContent), reviewerJsonSchema());
      } finally {
        await fs.promises.rm(isolatedTempDir, { recursive: true, force: true });
        assert.equal(
          fs.existsSync(isolatedTempDir),
          false,
          "isolated temp folder must be removed in finally block",
        );
      }
    });

    it("refuses an invalid role outside 'planner' or 'reviewer' by throwing", async () => {
      const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "agent-schema-reject-"),
      );

      try {
        await assert.rejects(
          async () => {
            // @ts-expect-error Testing invalid role at runtime
            await writeSchemaFile(tempDir, "implementer");
          },
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /Unsupported schema export role/i);
            assert.match(err.message, /implementer/);
            return true;
          },
        );

        await assert.rejects(
          async () => {
            // @ts-expect-error Testing invalid role at runtime
            await writeSchemaFile(tempDir, "advisor");
          },
          /Unsupported schema export role/i,
        );

        await assert.rejects(
          async () => {
            // @ts-expect-error Testing invalid role at runtime
            await writeSchemaFile(tempDir, "unknown");
          },
          /Unsupported schema export role/i,
        );

        await assert.rejects(
          async () => {
            // @ts-expect-error Testing empty string role at runtime
            await writeSchemaFile(tempDir, "");
          },
          /Unsupported schema export role/i,
        );

        // Ensure no files were written on rejected roles
        const files = await fs.promises.readdir(tempDir);
        assert.equal(files.length, 0, "No files should be written on invalid role");
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
