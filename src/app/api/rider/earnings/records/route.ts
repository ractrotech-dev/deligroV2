import { earningsJson, earningsRouteError, riderEarningsGate } from "@/lib/auth/rider-earnings-route";
import { listEarningRecords } from "@/lib/data-access/rider-earnings";

const ROUTE = "/api/rider/earnings/records";

/**
 * GET /api/rider/earnings/records?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=…&limit=…
 *
 * The rider's money records, newest first: one per delivery earning, incentive
 * award, bonus, salary, adjustment (including a correction's reversal, linked
 * to its order) and deduction, each with its paid/pending state and settlement
 * date and reference. `from`/`to` are IST days, both or neither (neither = the
 * last 31 days), at most 366 days apart; `limit` 1–100 (default 50);
 * `cursor` is the previous page's `nextCursor`.
 *
 *   200 { items: EarningRecord[], nextCursor: string | null }
 *   400 invalid_date | invalid_range | invalid_cursor
 *   401 · 403 not_rider | feature_disabled · 429 · 503 migration_pending · 500
 */
export async function GET(request: Request) {
  const gate = await riderEarningsGate(ROUTE);
  if (!gate.ok) return gate.response;
  const q = new URL(request.url).searchParams;
  const rawLimit = q.get("limit");
  const limit = rawLimit !== null && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : undefined;
  try {
    return earningsJson(
      await listEarningRecords(gate.driverId, {
        from: q.get("from") ?? undefined,
        to: q.get("to") ?? undefined,
        cursor: q.get("cursor"),
        limit,
      })
    );
  } catch (e) {
    return earningsRouteError(e, ROUTE, gate.driverId);
  }
}
