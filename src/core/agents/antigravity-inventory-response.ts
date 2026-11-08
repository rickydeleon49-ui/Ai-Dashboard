import { NextResponse } from "next/server";
import { isAgentRunsEnabled } from "./availability";
import { ensureDatabaseReady } from "@/db/bootstrap";
import {
  readAntigravityInventory,
  type AntigravityInventory,
} from "./adapters/antigravity-inventory";

/**
 * GET /api/agent-runs/antigravity-inventory body (AW3-05b). Lives outside the
 * route file so tests can inject an inventory: Next.js route files may only
 * export handlers with the standard (request, context) signature.
 * Names and error codes only; never file contents, paths or env values.
 */
export async function antigravityInventoryResponse(
  readInventory: () => Promise<AntigravityInventory> = readAntigravityInventory,
): Promise<NextResponse> {
  if (!isAgentRunsEnabled()) {
    return new NextResponse(null, { status: 404 });
  }
  ensureDatabaseReady();
  const inventory = await readInventory();
  return NextResponse.json({
    plugins: inventory.plugins.map((p) => ({
      name: p.name,
      hasHooks: p.hasHooks,
    })),
    mcpServers: inventory.mcpServers,
    errors: inventory.errors,
  });
}
