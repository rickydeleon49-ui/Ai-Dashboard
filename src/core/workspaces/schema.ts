/** Runtime validation for the workspace management API. */
import { z } from "zod";
import { INVITABLE_ROLES, WORKSPACE_ROLES } from "./types";

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export const switchWorkspaceSchema = z.object({
  workspaceId: z.string().trim().min(1, "workspaceId is required"),
});

export const createInvitationSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Not a valid email address"),
  // Never "owner" — INVITABLE_ROLES already excludes it (see its own
  // comment in ./types), so this schema has nothing extra to enforce.
  role: z.enum(INVITABLE_ROLES),
});

export const acceptInvitationSchema = z.object({
  token: z.string().trim().min(1, "token is required"),
});

export const listMembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1, "limit must be at least 1").max(100, "limit cannot exceed 100").optional(),
  offset: z.coerce.number().int().min(0, "offset cannot be negative").optional(),
  search: z.string().trim().max(100, "search query cannot exceed 100 characters").optional(),
  status: z.enum(["active", "invited", "suspended", "removed", "all"]).optional(),
});

export const updateMemberSchema = z
  .object({
    role: z.enum(WORKSPACE_ROLES).optional(),
    status: z.enum(["active", "suspended", "removed"]).optional(),
  })
  .refine((data) => data.role !== undefined || data.status !== undefined, {
    message: "At least one of role or status must be provided",
  });

