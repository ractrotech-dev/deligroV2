import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getManagerOrderDetail } from "@/lib/data-access/manager-ops-orders";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/orders/[id] — one order in the manager's zones: items,
 * money, addresses, the merged timeline, the rider and their last fix while in
 * flight, linked tickets, and the actions this manager may take now (§3.8–3.11).
 *
 * → 200 { order: OrderDetail }   → 404 { error: "not_found" } (missing and
 *   out of zone look the same)   → 500 { error: "load_failed" }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.orders.view");
  if (ctx instanceof Response) return ctx;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const order = await getManagerOrderDetail(ctx.scope, id.toLowerCase(), { permissions: ctx.permissions, now: new Date() });
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ order });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
