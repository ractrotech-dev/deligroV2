import { cashJson, cashRouteError, riderCashGate } from "@/lib/auth/rider-cash-route";
import { listRiderDisputes, raiseCashDispute } from "@/lib/data-access/rider-cash";

const ROUTE = "/api/rider/cash/disputes";

/**
 * GET /api/rider/cash/disputes — the rider's disputes, newest first.
 *
 *   200 { items: [{ id, day, claimedAmount, message, status: "open" | "resolved",
 *                   resolution, createdAt }] }
 *
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 */
export async function GET() {
  const gate = await riderCashGate(`${ROUTE}:list`);
  if (!gate.ok) return gate.response;
  try {
    return cashJson({ items: await listRiderDisputes(gate.driverId) });
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "GET", riderId: gate.driverId, event: "cash_disputes" });
  }
}

/**
 * POST /api/rider/cash/disputes   { day: "YYYY-MM-DD", claimedAmount?: int, message }
 *
 * "This day's figure is wrong." Managers see it on the cash page. One open
 * dispute per day.
 *
 *   201 { ok: true, id }
 *   400 invalid_body | invalid_day (not a real day, in the future, or older
 *       than 90 days) | message_required (empty, or over 500 characters) |
 *       invalid_amount
 *   409 already_open
 *   401 · 403 not_rider · 429 · 503 migration_pending · 500
 *
 * Rate limit: 6 a minute per rider.
 */
export async function POST(request: Request) {
  const gate = await riderCashGate(`${ROUTE}:post`, { writePerMinute: 6 });
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return cashJson({ error: "invalid_body" }, 400);
  }
  const { day, claimedAmount, message } = body;
  if (typeof day !== "string") return cashJson({ error: "invalid_day" }, 400);
  if (typeof message !== "string") return cashJson({ error: "message_required" }, 400);
  if (claimedAmount !== undefined && claimedAmount !== null && typeof claimedAmount !== "number") {
    return cashJson({ error: "invalid_amount" }, 400);
  }

  try {
    const result = await raiseCashDispute(gate.driverId, {
      day,
      claimedAmount: typeof claimedAmount === "number" ? claimedAmount : undefined,
      message,
    });
    if (result.ok) return cashJson({ ok: true, id: result.id }, 201);
    return cashJson({ error: result.error }, result.error === "already_open" ? 409 : 400);
  } catch (e) {
    return cashRouteError(e, { route: ROUTE, method: "POST", riderId: gate.driverId, event: "cash_dispute_raise" });
  }
}
