/**
 * Runtime validation schemas for agent requests, orchestration outputs, and findings.
 *
 * All schemas enforce strict input shapes (unknown keys rejected) to prevent
 * accidental injection of arbitrary arguments or commands across boundaries.
 */
import { z } from "zod";
import { EFFORT_LEVELS } from "./types";

/**
 * Validates check names referenced in run requests.
 *
 * Check names identify pre-configured commands in project policy (e.g. "lint", "typecheck", "test:unit").
 * Slashes and whitespace are strictly rejected so a check name can never encode a path or shell command.
 */
export const checkNameSchema = z
  .string()
  .min(1, "Check name is required")
  .max(64, "Check name must be at most 64 characters")
  .refine((name) => !/[\s/\\]/.test(name), {
    message: "Check name must not contain spaces or slashes",
  })
  .refine((name) => /^[A-Za-z0-9_.:-]+$/.test(name), {
    message:
      "Check name must be an identifier consisting only of letters, numbers, hyphens, underscores, dots, or colons",
  });

/**
 * Configuration for a single agent role (provider, model, reasoning effort).
 */
export const roleConfigSchema = z
  .object({
    provider: z.string().trim().min(1, "Provider is required"),
    model: z.string().trim().min(1, "Model must not be empty").optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
  })
  .strict();

export type RoleConfig = z.infer<typeof roleConfigSchema>;

/**
 * Role assignments for a run. Implementer is required; planner and reviewer are optional.
 */
export const runRolesSchema = z
  .object({
    implementer: roleConfigSchema,
    planner: roleConfigSchema.optional(),
    reviewer: roleConfigSchema.optional(),
  })
  .strict()
  .superRefine((roles, ctx) => {
    if (roles.implementer.provider === "codex") {
      ctx.addIssue({
        code: "custom",
        path: ["implementer", "provider"],
        message:
          "Codex cannot be the implementer in this version (it runs read-only here). Use it as planner or reviewer.",
      });
    }
  });

export type RunRoles = z.infer<typeof runRolesSchema>;

/**
 * Request body for creating an agent run.
 */
export const runRequestSchema = z
  .object({
    projectId: z.string().trim().min(1, "Project ID is required").max(200),
    task: z
      .string()
      .trim()
      .min(1, "Task is required")
      .max(20000, "Task cannot exceed 20000 characters"),
    roles: runRolesSchema,
    checks: z
      .array(checkNameSchema)
      .max(20, "At most 20 checks allowed")
      .default([]),
  })
  .strict();

export type RunRequest = z.infer<typeof runRequestSchema>;

/**
 * Structured output schema returned by the planner agent per §7.
 *
 * Agent output is untrusted: every list and string is bounded so a runaway
 * planner cannot flood events or the database.
 */
export const plannerOutputSchema = z
  .object({
    task: z.string().trim().min(1, "Task is required").max(20000),
    scope_paths: z.array(z.string().trim().min(1, "Path cannot be empty").max(1000)).max(200),
    acceptance: z
      .array(z.string().trim().min(1, "Acceptance criterion cannot be empty").max(2000))
      .max(50),
    checks: z.array(checkNameSchema).max(20),
  })
  .strict();

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

/**
 * Review verdict options per §7.
 */
export const REVIEWER_VERDICTS = ["approve", "request_changes"] as const;
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number];

/**
 * Finding severity ratings.
 */
export const FINDING_SEVERITIES = ["P1", "P2", "P3"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * A single structured finding from the reviewer agent.
 */
export const reviewerFindingSchema = z
  .object({
    severity: z.enum(FINDING_SEVERITIES),
    path: z.string().trim().min(1, "Path cannot be empty").max(1000).optional(),
    line: z
      .number()
      .int("Line must be an integer")
      .min(1, "Line must be at least 1")
      .optional(),
    message: z.string().trim().min(1, "Message is required").max(4000),
    actionable: z.boolean(),
  })
  .strict();

export type ReviewerFinding = z.infer<typeof reviewerFindingSchema>;

/**
 * Structured output schema returned by the reviewer agent per §7.
 */
export const reviewerOutputSchema = z
  .object({
    verdict: z.enum(REVIEWER_VERDICTS),
    findings: z.array(reviewerFindingSchema).max(100),
  })
  .strict();

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
