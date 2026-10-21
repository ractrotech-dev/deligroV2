import { NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { getVendorOrderDetail } from "@/lib/data-access/vendor-orders";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/orders/:id — one order of the active shop, with its status
 * history. Another shop's order answers 404, exactly like one that doesn't
 * exist.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;
  const { id } = await params;

  try {
    const order = await getVendorOrderDetail(id, ctx.restaurant.id);
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ order });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
