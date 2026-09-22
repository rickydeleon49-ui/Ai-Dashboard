import {
  createBulkTaskUpdateHandler,
  productionBulkTaskUpdateDependencies,
} from "./handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/bulk
 *
 * Applies bounded, atomic per-task updates across a list of task IDs (up to 100),
 * with truthful partial-failure reporting. See ./handler.ts for the implementation
 * and its dependency-injection boundary.
 */
export const POST = createBulkTaskUpdateHandler(productionBulkTaskUpdateDependencies);
