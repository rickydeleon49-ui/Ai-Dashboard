/** Runtime validation for the workspace management API. */
import { z } from "zod";

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export const switchWorkspaceSchema = z.object({
  workspaceId: z.string().trim().min(1, "workspaceId is required"),
});
