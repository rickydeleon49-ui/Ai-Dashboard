/**
 * The persistence contract for milestones — mirrors
 * `./project-repository.ts`'s own shape and reasoning exactly. Everything
 * above this line depends only on this interface, never on Drizzle or a
 * specific database directly.
 */
import type {
  Milestone,
  MilestoneCreateInput,
  MilestoneQuery,
  MilestoneUpdateInput,
} from "@/core/tasks/types";

/**
 * `workspaceId` is a mandatory first parameter on every method, matching
 * `ProjectRepository` — explicit and grep-able, impossible to silently
 * forget at a call site. `DrizzleMilestoneRepository` (SQLite) only ever
 * accepts `LOCAL_WORKSPACE_ID` (re-exported from `./project-repository`)
 * and throws on anything else; `PostgresMilestoneRepository` genuinely
 * scopes every query to it.
 */
export interface MilestoneRepository {
  list(workspaceId: string, projectId: string, query?: MilestoneQuery): Promise<Milestone[]>;
  findById(workspaceId: string, id: string): Promise<Milestone | null>;
  create(workspaceId: string, input: MilestoneCreateInput): Promise<Milestone>;
  update(workspaceId: string, id: string, input: MilestoneUpdateInput): Promise<Milestone | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;
}
