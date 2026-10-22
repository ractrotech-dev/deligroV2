import { cashJson, cashRouteError, riderCashGate } from "@/lib/auth/rider-cash-route";
import { listRiderCollections } from "@/lib/data-access/rider-cash";

const ROUTE = "/api/rider/cash/collections";

/**
 * GET /api/rider/cash/collections?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=&limit=
 *
 * The orders the rider delivered, newest first — cash and paid online side by
 * side. Both `from` and `to` (IST days) or neither (the last 31 days);
 * `limit` 1–100, default 50.
 *
 *   200 { items: [{ orderId, code, at, amount, method: "cod" | "online",
 *                   status: "collected" | "not_recorded" | "paid_online" }],
 *         nextCursor: string | null }
 *
 * An online-paid order is `method: "online"`, `status: "paid_online"`: the
 * app lists it under "Paid online", never as cash to collect or collected.
 *
 *   400 invalid_date | invalid_range | invalid_cursor
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 */
export async function GET(request: Request) {
  const gate = await riderCashGate(ROUTE);
  if (!gate.ok) return gate.response;
  const params = new URL(request.url).searchParams;
  const limitRaw = params.get("limit");
  try {
    return cashJson(
      await listRiderCollections(gate.driverId, {
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        cursor: params.get("cursor"),
        limit: limitRaw !== null && /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : undefined,
      })
    );
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "GET", riderId: gate.driverId, event: "cash_collections" });
  }
}
