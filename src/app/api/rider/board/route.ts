import { NextResponse, after } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getRiderBoard } from "@/lib/data-access/rider-jobs";
import { maybeSweepDispatch } from "@/lib/dispatch/sweep";

/**
 * GET /api/rider/board
 *
 * The rider app's Jobs screen, which polls it every few seconds while it is in
 * the foreground:
 *
 *   { offers, upcoming, active, offerWindowSeconds }
 *
 *   offers    ready orders the rider may accept: the one held for them first
 *             (`reservedForYou`, with `offerExpiresAt` for the countdown), then
 *             open ones. Orders held for another rider, and ones this rider
 *             rejected, are not listed. Empty while the rider is offline.
 *   upcoming  pickups offered to them while the kitchen is still cooking.
 *   active    the delivery they are carrying, with the customer's and the
 *             shop's numbers (unless `driver.call_customer` is off), items,
 *             timeline and exceptions; null when there is none.
 *
 * Read-only, but it is the heartbeat for the dispatch sweep (lapsed offers,
 * never-offered orders, riders who went quiet), which is throttled to about
 * one run a minute platform-wide and runs after the response.
 *
 *   401 unauthenticated · 403 not_rider · 429 · 500 server_error
 *
 * Reads degrade on a database without migration 0081/0082 (no offers, plain
 * statuses) rather than failing: the writes are what answer 503.
 */
export async function GET() {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  // The app polls about every 5 s (12 a minute); 40 leaves room for a foreground
  // refresh, a pull-to-refresh and a retry burst, and caps a runaway loop.
  const limit = await rateLimit(`rider-board:${profile.id}`, 40, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  try {
    const board = await getRiderBoard(profile.id);
    after(maybeSweepDispatch);
    return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/board", method: "GET", riderId: profile.id });
  }
}
