import { handleOperatorLogout } from "@/core/auth/operator-routes";

export const dynamic = "force-dynamic";

export function POST() {
  return handleOperatorLogout();
}
