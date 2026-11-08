/**
 * JSON Schema export for planner and reviewer outputs.
 *
 * Source of truth: docs/design/AW-agent-workflow-control-center.md (§3.1, §16.2 row 1)
 *
 * Provides JSON Schema (Draft 2020-12) generated directly from the runtime Zod
 * schemas (plannerOutputSchema and reviewerOutputSchema), which serve as the single
 * source of truth across CLI adapters (Codex --output-schema, Claude Code --json-schema).
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { plannerOutputSchema, reviewerOutputSchema } from "../schema";

export type SchemaRole = "planner" | "reviewer";

/**
 * Returns the JSON Schema object for plannerOutputSchema (Draft 2020-12, the Zod default).
 */
export function plannerJsonSchema() {
  return z.toJSONSchema(plannerOutputSchema);
}

/**
 * Returns the JSON Schema object for reviewerOutputSchema (Draft 2020-12, the Zod default).
 */
export function reviewerJsonSchema() {
  return z.toJSONSchema(reviewerOutputSchema);
}

/**
 * Writes the JSON Schema file `<role>-output.schema.json` into the specified directory.
 *
 * Emits UTF-8 without BOM, pretty-printed JSON (2-space indent) with a trailing newline.
 *
 * @param dir Directory to write the schema file into.
 * @param role Agent role ("planner" | "reviewer").
 * @returns Full path to the written schema file.
 * @throws Error if role is not "planner" or "reviewer".
 */
export async function writeSchemaFile(
  dir: string,
  role: SchemaRole,
): Promise<string> {
  if (role !== "planner" && role !== "reviewer") {
    throw new Error(
      `Unsupported schema export role: "${String(role)}". Expected "planner" | "reviewer".`,
    );
  }

  const schema = role === "planner" ? plannerJsonSchema() : reviewerJsonSchema();
  const filePath = path.resolve(dir, `${role}-output.schema.json`);
  const content = `${JSON.stringify(schema, null, 2)}\n`;

  await writeFile(filePath, content, "utf8");
  return filePath;
}
