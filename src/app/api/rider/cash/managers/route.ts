import { cashJson, cashRouteError, riderCashGate } from "@/lib/auth/rider-cash-route";
import { listDepositManagers } from "@/lib/data-access/rider-cash";

const ROUTE = "/api/rider/cash/managers";

/**
 * GET /api/rider/cash/managers — the managers a rider can name on a deposit.
 *
 *   200 { items: [{ id, name }] }
 *
 * Id and name only.
 *
 *   401 · 403 not_rider · 429 · 500
 */
export async function GET() {
  const gate = await riderCashGate(ROUTE);
  if (!gate.ok) return gate.response;
  try {
    return cashJson({ items: await listDepositManagers() });
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "GET", riderId: gate.driverId, event: "cash_managers" });
  }
}
