import { earningsJson, earningsRouteError, riderEarningsGate } from "@/lib/auth/rider-earnings-route";
import { getStatement } from "@/lib/data-access/rider-earnings";

const ROUTE = "/api/rider/earnings/statement";

/**
 * GET /api/rider/earnings/statement?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The date-wise statement the app shows and saves as PDF/CSV: the rider's
 * name and rider ID, opening pending + earned − paid = closing pending for the
 * range (IST days, both required, at most 366 days), and every record dated in
 * it, oldest first, each with its own paid/pending state and reference.
 *
 *   200 { riderCode, name, from, to, openingPending, earned, paid, closingPending, rows }
 *   400 invalid_date | invalid_range
 *   401 · 403 not_rider | feature_disabled · 429 · 503 migration_pending · 500
 */
export async function GET(request: Request) {
  const gate = await riderEarningsGate(ROUTE);
  if (!gate.ok) return gate.response;
  const q = new URL(request.url).searchParams;
  try {
    return earningsJson(await getStatement(gate.driverId, q.get("from") ?? "", q.get("to") ?? ""));
  } catch (e) {
    return earningsRouteError(e, ROUTE, gate.driverId);
  }
}
