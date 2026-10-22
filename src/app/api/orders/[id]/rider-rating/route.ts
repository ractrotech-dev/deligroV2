import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getOwnRiderRating, submitRiderRating } from "@/lib/data-access/rider-rating";
import { isRiderSchemaPending } from "@/lib/data-access/rider-status";
import { ratingErrorStatus } from "@/lib/rider/rating";
import { captureError } from "@/lib/obs/emit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = "/api/orders/[id]/rider-rating";

/** The signed-in customer, or the response to send instead. */
async function customer(): Promise<{ ok: true; id: string } | { ok: false; response: Response }> {
  if (!isSupabaseConfigured) {
    return { ok: false, response: NextResponse.json({ error: "backend_not_configured" }, { status: 503 }) };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return { ok: true, id: user.id };
}

function failure(error: unknown, userId: string): Response {
  const pending = isRiderSchemaPending(error);
  captureError(error, {
    source: ROUTE,
    httpRoute: ROUTE,
    actorId: userId,
    attrs: { event: pending ? "rider_rating_migration_pending" : "rider_rating_failed" },
  });
  return NextResponse.json({ error: pending ? "migration_pending" : "server_error" }, { status: pending ? 503 : 500 });
}

/**
 * POST /api/orders/:id/rider-rating   { rating: 1-5, comment?: string (<= 300) }
 *
 * The customer of a delivered order rates the rider who delivered it, once.
 * The rider is read from the delivery, the customer from the session - the body
 * names neither.
 *
 *   200 { ok: true, rating, comment }
 *   400 invalid_body | invalid_rating | comment_too_long
 *   401 unauthorized
 *   403 not_yours        not this customer's order (or no such order)
 *   409 not_delivered    the order or its delivery is not delivered yet
 *       no_rider         delivered, but no rider on it
 *       already_rated    one rating per order
 *   429 · 503 migration_pending (no 0084) · 500 server_error
 *
 * Rate limit: 10 a minute per customer.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await customer();
  if (!who.ok) return who.response;

  const limit = await rateLimit(`rider-rating:${who.id}`, 10, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  let body: { rating?: unknown; comment?: unknown } | null;
  try {
    body = (await request.json()) as { rating?: unknown; comment?: unknown } | null;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  // A malformed id cannot be anyone's order: the same answer as someone else's.
  if (!UUID.test(id)) return NextResponse.json({ error: "not_yours" }, { status: 403 });

  try {
    const result = await submitRiderRating(who.id, id, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: ratingErrorStatus(result.error) });
    return NextResponse.json({ ok: true, rating: result.rating, comment: result.comment });
  } catch (e) {
    return failure(e, who.id);
  }
}

/**
 * GET /api/orders/:id/rider-rating - what this customer already rated the
 * rider for this order.
 *
 *   200 { rating: number | null, comment: string | null }   nulls: not rated (or not theirs)
 *   401 unauthorized · 429 · 500 server_error
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = await customer();
  if (!who.ok) return who.response;

  const limit = await rateLimit(`rider-rating-read:${who.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ rating: null, comment: null });
  try {
    return NextResponse.json(await getOwnRiderRating(who.id, id), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e, who.id);
  }
}
