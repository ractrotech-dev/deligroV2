import { cashJson, cashRouteError, riderCashGate } from "@/lib/auth/rider-cash-route";
import { withdrawDeposit } from "@/lib/data-access/rider-cash";

const ROUTE = "/api/rider/cash/deposits/[id]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/rider/cash/deposits/:id — withdraw a deposit still waiting for a
 * decision.
 *
 *   200 { ok: true }
 *   400 invalid_id
 *   404 not_found         not this rider's deposit (or no such deposit)
 *   409 already_decided   confirmed, disputed, already withdrawn, or a manager
 *                         is confirming it right now
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await riderCashGate(ROUTE, { writePerMinute: 20 });
  if (!gate.ok) return gate.response;
  const { id } = await params;
  if (!UUID.test(id)) return cashJson({ error: "invalid_id" }, 400);
  try {
    const result = await withdrawDeposit(gate.driverId, id);
    if (result.ok) return cashJson({ ok: true });
    return cashJson({ error: result.error }, result.error === "not_found" ? 404 : 409);
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "DELETE", riderId: gate.driverId, event: "cash_deposit_withdraw" });
  }
}
