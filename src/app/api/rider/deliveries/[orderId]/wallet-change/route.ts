import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { addWalletChange } from "@/lib/data-access/wallet";
import { isFeatureOn } from "@/lib/features/flags.server";
import { featureOffResponse } from "@/lib/features/guards.server";
import { walletChangeMessage } from "@/lib/wallet/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/rider/deliveries/:orderId/wallet-change
 *   { received: number, code: string, actionId: string }
 *
 * The rider has no change: the leftover goes to the customer's wallet as points. The
 * rider types what they received and the code the customer read out. The rider never
 * types the change: the database works it out from the order, checks the code and the
 * limit, and in one transaction adds the points and records the cash collected as the
 * FULL amount received. They hand all of it over. Then they tap Delivered as usual.
 *
 * This is the one step that needs a signal: it can't go through the app's offline queue,
 * because the rider has to know the answer before leaving. A rider who can't do it gives
 * the change in cash and finishes the delivery: nothing here blocks that.
 *
 * Who holds this delivery is the session against `deliveries.driver_id`, decided in the
 * database. Every refusal is 409 with a sentence for the rider, so a wrong try stays
 * counted (0197).
 *
 *   200 { ok: true, change, received, replayed }
 *   400 invalid_order | invalid_body
 *   403 feature_disabled
 *   404 not_found       not this rider's delivery
 *   409 { error, message, limit?, triesLeft?, cashDue? }
 *   429
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  if (!(await isFeatureOn("driver.cod_change", profile.id))) {
    return featureOffResponse("driver.cod_change");
  }

  const limit = await rateLimit(`rider-wallet-change:${profile.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });

  let body: { received?: unknown; code?: unknown; actionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { received, code, actionId } = body ?? {};
  if (
    typeof received !== "number" ||
    !Number.isInteger(received) ||
    received <= 0 ||
    received > 1_000_000 ||
    typeof code !== "string" ||
    code.length > 12 ||
    typeof actionId !== "string" ||
    !UUID.test(actionId)
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await addWalletChange(profile.id, orderId, { received, code, actionId });
    if (result.ok) return NextResponse.json(result);
    if (result.error === "not_yours") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: result.error,
        message: walletChangeMessage(result.error, result),
        limit: result.limit,
        triesLeft: result.triesLeft,
        cashDue: result.cashDue,
      },
      { status: 409 },
    );
  } catch (e) {
    return riderRouteError(e, {
      route: "/api/rider/deliveries/[orderId]/wallet-change",
      method: "POST",
      riderId: profile.id,
      event: "wallet_change",
    });
  }
}
