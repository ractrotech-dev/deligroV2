import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/finance/refunds/[id]/decide — closed. There are no refunds
 * (rule book), so nothing here can approve or deny one.
 *
 * Kept as a refusal because Manager apps already on phones still call it. Still needs
 * manager.finance.view, as the read of these records does, so it says nothing to
 * anyone else.
 * → 410 refunds_closed   → 401/403 as usual
 */
export async function POST() {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  return NextResponse.json({ error: "refunds_closed" }, { status: 410 });
}
