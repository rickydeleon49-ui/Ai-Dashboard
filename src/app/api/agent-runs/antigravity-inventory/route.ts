import { antigravityInventoryResponse } from "@/core/agents/antigravity-inventory-response";

export const dynamic = "force-dynamic";

export async function GET() {
  return antigravityInventoryResponse();
}
