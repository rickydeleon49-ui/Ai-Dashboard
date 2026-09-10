/** Runtime validation for the ownership-claim API. */
import { z } from "zod";

export const claimOwnershipSchema = z.object({
  password: z.string().min(1, "password is required"),
});
