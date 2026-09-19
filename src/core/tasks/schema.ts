/**
 * Runtime validation for milestones/tasks crossing an application boundary —
 * mirrors `core/projects/schema.ts`'s own conventions exactly. `projectId` is
 * never part of these schemas: every create/list route takes it from the URL
 * (`/api/projects/[id]/...`), never from the request body, so it can't drift
 * from the resource the caller actually has permission on.
 */
import { z } from "zod";
import { MILESTONE_STATUSES, TASK_PRIORITIES, TASK_STATUSES } from "./types";

/** Empty strings from a form should become null, not "". */
const optionalText = z
  .string()
  .trim()
  .max(20000)
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

/** Same as `optionalText` but for an id reference (milestoneId, parentTaskId, assigneeId). */
const optionalId = z
  .string()
  .trim()
  .max(200)
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

const optionalIsoDate = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional()
  .refine((v) => v === null || v === undefined || !Number.isNaN(Date.parse(v)), {
    message: "Must be a valid date/time",
  });

const milestoneFields = {
  title: z.string().trim().min(1, "Title is required").max(200),
  description: optionalText,
  status: z.enum(MILESTONE_STATUSES),
  dueDate: optionalIsoDate,
};

export const milestoneCreateSchema = z.object({
  ...milestoneFields,
  status: milestoneFields.status.default("open"),
});

/** Update accepts any subset; a key that was not sent stays unset. */
export const milestoneUpdateSchema = z.object(milestoneFields).partial();

export const milestoneQuerySchema = z.object({
  status: z.enum([...MILESTONE_STATUSES, "all"]).optional(),
});

const taskFields = {
  title: z.string().trim().min(1, "Title is required").max(200),
  description: optionalText,
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  milestoneId: optionalId,
  parentTaskId: optionalId,
  assigneeId: optionalId,
  dueDate: optionalIsoDate,
};

export const taskCreateSchema = z.object({
  ...taskFields,
  status: taskFields.status.default("todo"),
  priority: taskFields.priority.default("medium"),
});

export const taskUpdateSchema = z.object(taskFields).partial();

/**
 * `parentTaskId: "none"` is the query-string spelling of `TaskQuery`'s
 * `null` ("top-level tasks only") — an actual `null` has no representation
 * in a URL, and omitting the param already means "no filter".
 */
export const taskQuerySchema = z.object({
  status: z.enum([...TASK_STATUSES, "all"]).optional(),
  priority: z.enum([...TASK_PRIORITIES, "all"]).optional(),
  milestoneId: z.string().trim().optional(),
  assigneeId: z.string().trim().optional(),
  assignedTo: z.string().trim().optional(),
  assignedBy: z.string().trim().optional(),
  unassigned: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
    .optional(),
  parentTaskId: z.string().trim().optional(),
  sort: z.enum(["dueDate", "priority", "created", "updated"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** My Work spans every project in the workspace; the caller never picks `assigneeId` themselves. */
export const myWorkQuerySchema = taskQuerySchema.omit({ assigneeId: true, milestoneId: true, parentTaskId: true });

export const taskDependencyCreateSchema = z.object({
  dependsOnTaskId: z.string().trim().min(1, "dependsOnTaskId is required"),
});
