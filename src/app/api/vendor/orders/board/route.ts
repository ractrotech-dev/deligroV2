import { after, NextResponse } from "next/server";
import { vendorApiContext } from "@/lib/auth/vendor-api.server";
import { listKitchenOrders } from "@/lib/data-access/vendor-orders";
import { maybeSweepDispatch } from "@/lib/dispatch/sweep";

export const dynamic = "force-dynamic";

/**
 * GET /api/vendor/orders/board — the active shop's live orders for the Partner
 * app: new, accepted, preparing, ready and out for delivery, newest first.
 * Same query as the web kitchen board (paid-or-COD only, so nobody cooks an
 * unpaid online order). Each order carries its `stage`.
 */
export async function GET() {
  const ctx = await vendorApiContext();
  if (ctx instanceof Response) return ctx;

  // Like the web kitchen board: an open board is also what drives the dispatch
  // sweep (rider re-offers, "order still waiting" reminders) when no cron is
  // configured. Throttled inside to once a minute across all callers.
  after(maybeSweepDispatch);

  try {
    const { incoming, preparing, ready } = await listKitchenOrders(ctx.restaurant.id);
    const orders = [...incoming, ...preparing, ...ready].sort((a, b) =>
      (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
    );
    return NextResponse.json({ orders, serverTime: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
