/**
 * Project policy for agent runs (design §5A, §16.4 rows 1-2): the one place that
 * parses and writes the `agent_project_policy` row.
 *
 * - `checks`: the commands the runner executes itself. `argv[0]` is resolved to an
 *   absolute path when the policy is saved (§5A), so a later run never searches
 *   PATH. `required: false` makes a check informational: its result is reported
 *   but a failure does not fail the run.
 * - `excludedPaths`: globs agents may not touch.
 * - `dependencyLinks`: folder names (`node_modules`, `.venv`) kept in the
 *   `defaults` JSON next to any other keys. Only stored for now.
 *
 * Test restrictions are expressed as `required` per check, so the
 * `test_restrictions` column is left as `[]` and is not read.
 *
 * Desktop SQLite only (the table has no Postgres counterpart).
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { agentProjectPolicies } from "@/db/schema";
import type { AgentDatabase } from "./events";
import type { PolicyCheck, RunPolicy } from "./orchestrator";
import { DEFAULT_CHECK_TIMEOUT_SEC } from "./run-check";
import { isSafeAbsolute, resolveExecutable, type ResolveDeps, type ResolveResult } from "./resolve-executable";
import { checkNameSchema } from "./schema";

export const MAX_POLICY_CHECKS = 20;
export const MAX_CHECK_ARGV_ITEMS = 50;
export const MAX_CHECK_ARG_CHARS = 2000;
export const MAX_CHECK_TIMEOUT_SEC = 3600;
export const MAX_EXCLUDED_PATHS = 200;
export const MAX_EXCLUDED_PATH_CHARS = 500;
export const MAX_DEPENDENCY_LINKS = 20;
export const MAX_DEPENDENCY_LINK_CHARS = 200;

const ISO_NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

function isAbsoluteLike(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p);
}

function hasDotDot(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => seg === "..");
}

export const policyCheckSchema = z
  .object({
    name: checkNameSchema,
    argv: z
      .array(z.string().min(1, "Argument must not be empty").max(MAX_CHECK_ARG_CHARS))
      .min(1, "A check needs a command")
      .max(MAX_CHECK_ARGV_ITEMS),
    timeoutSec: z.number().int().min(1).max(MAX_CHECK_TIMEOUT_SEC).default(DEFAULT_CHECK_TIMEOUT_SEC),
    required: z.boolean().default(true),
  })
  .strict();

export const excludedPathSchema = z
  .string()
  .min(1, "Excluded path must not be empty")
  .max(MAX_EXCLUDED_PATH_CHARS)
  .refine((p) => !isAbsoluteLike(p), { message: "Excluded path must be relative to the project" })
  .refine((p) => !hasDotDot(p), { message: 'Excluded path must not contain ".." segments' });

export const dependencyLinkSchema = z
  .string()
  .min(1, "Dependency link must not be empty")
  .max(MAX_DEPENDENCY_LINK_CHARS)
  .refine((p) => !isAbsoluteLike(p), { message: "Dependency link must be a relative folder name" })
  .refine((p) => !hasDotDot(p), { message: 'Dependency link must not contain ".." segments' });

export const policySchema = z
  .object({
    checks: z
      .array(policyCheckSchema)
      .max(MAX_POLICY_CHECKS)
      .superRefine((checks, ctx) => {
        const seen = new Set<string>();
        checks.forEach((c, i) => {
          if (seen.has(c.name)) {
            ctx.addIssue({ code: "custom", path: [i, "name"], message: `Duplicate check name "${c.name}"` });
          }
          seen.add(c.name);
        });
      })
      .default([]),
    excludedPaths: z.array(excludedPathSchema).max(MAX_EXCLUDED_PATHS).default([]),
    dependencyLinks: z.array(dependencyLinkSchema).max(MAX_DEPENDENCY_LINKS).default([]),
  })
  .strict();

export type ProjectPolicy = z.output<typeof policySchema>;
export type ProjectPolicyInput = z.input<typeof policySchema>;
export type ProjectPolicyCheck = ProjectPolicy["checks"][number];

/** A policy that cannot be saved. `issues` has one human-readable line per problem. */
export class PolicyError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "PolicyError";
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));
}

function parseJsonColumn(raw: string, column: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${column} is not valid JSON`);
  }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads the project's policy, or the empty default when there is no row. Throws a clear error on a bad row. */
export function getPolicy(db: AgentDatabase, projectId: string): ProjectPolicy {
  const row = db.select().from(agentProjectPolicies).where(eq(agentProjectPolicies.projectId, projectId)).get();
  if (!row) return { checks: [], excludedPaths: [], dependencyLinks: [] };
  const defaults = plainObject(parseJsonColumn(row.defaults, "defaults"));
  if (!defaults) throw new Error("defaults must be a JSON object");
  const parsed = policySchema.safeParse({
    checks: parseJsonColumn(row.checkCommands, "check_commands"),
    excludedPaths: parseJsonColumn(row.excludedPaths, "excluded_paths"),
    dependencyLinks: defaults.dependencyLinks ?? [],
  });
  if (!parsed.success) throw new Error(formatIssues(parsed.error).join("; "));
  return parsed.data;
}

export interface SavePolicyDeps extends ResolveDeps {
  /** Replaces the executable lookup (tests). */
  resolve?: (command: string) => ResolveResult;
}

function resolveCheckArgv(
  check: ProjectPolicyCheck,
  index: number,
  deps: SavePolicyDeps,
): { argv: string[] } | { issue: string } {
  const command = check.argv[0] ?? "";
  const platform = deps.platform ?? process.platform;
  const result = deps.resolve
    ? deps.resolve(command)
    : isSafeAbsolute(command, platform)
      ? resolveExecutable(command, { ...deps, explicitPath: command })
      : resolveExecutable(command, deps);
  if (!result.ok) {
    return {
      issue: `checks.${index}.argv.0: cannot find "${command}" for check "${check.name}" (tried ${result.tried.join(", ") || "nothing"})`,
    };
  }
  return { argv: [result.file, ...result.prefixArgs, ...check.argv.slice(1)] };
}

/**
 * Validates and stores the policy. Every check's `argv[0]` is resolved to an
 * absolute path first; if any cannot be resolved nothing is written. Other keys
 * in `defaults` are kept. Returns the stored policy.
 */
export function savePolicy(
  db: AgentDatabase,
  projectId: string,
  input: unknown,
  deps: SavePolicyDeps = {},
): ProjectPolicy {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) throw new PolicyError(formatIssues(parsed.error));

  const issues: string[] = [];
  const checks: ProjectPolicyCheck[] = [];
  parsed.data.checks.forEach((check, index) => {
    const resolved = resolveCheckArgv(check, index, deps);
    if ("issue" in resolved) issues.push(resolved.issue);
    else checks.push({ ...check, argv: resolved.argv });
  });
  if (issues.length > 0) throw new PolicyError(issues);
  const policy: ProjectPolicy = { ...parsed.data, checks };

  // Keep any other keys already in `defaults`; replace only dependencyLinks.
  const existing = db.select().from(agentProjectPolicies).where(eq(agentProjectPolicies.projectId, projectId)).get();
  let defaults: Record<string, unknown> = {};
  if (existing) {
    try {
      defaults = plainObject(JSON.parse(existing.defaults)) ?? {};
    } catch {
      defaults = {};
    }
  }
  defaults = { ...defaults, dependencyLinks: policy.dependencyLinks };

  const values = {
    checkCommands: JSON.stringify(policy.checks),
    excludedPaths: JSON.stringify(policy.excludedPaths),
    defaults: JSON.stringify(defaults),
  };
  db.insert(agentProjectPolicies)
    .values({ projectId, ...values })
    .onConflictDoUpdate({ target: agentProjectPolicies.projectId, set: { ...values, updatedAt: ISO_NOW } })
    .run();
  return policy;
}

/** The shape the orchestrator takes. */
export function toRunPolicy(policy: ProjectPolicy): RunPolicy {
  const checks: PolicyCheck[] = policy.checks.map((c) => ({
    name: c.name,
    argv: c.argv,
    timeoutSec: c.timeoutSec,
    required: c.required,
  }));
  return { checks, excludedPaths: policy.excludedPaths };
}
