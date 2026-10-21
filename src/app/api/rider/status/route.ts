import { NextResponse } from "next/server";
import { requireRiderApi } from "@/lib/auth/rider-api";
import { riderRouteError } from "@/lib/auth/rider-route-error";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { setRiderAvailability } from "@/lib/data-access/rider-status";
import { riderPhase, type AvailabilityAction } from "@/lib/rider/availability";

const ACTIONS: readonly AvailabilityAction[] = ["online", "offline", "break", "resume"];

/**
 * POST /api/rider/status  { action: "online" | "offline" | "break" | "resume", minutes? }
 *
 * The rider's Go online / Go offline / Take a break. The server decides: the
 * rules in `lib/rider/availability.ts` run against the database row, so a
 * stale or modified app cannot leave a shift it is not allowed to leave.
 *
 * `minutes` is for `break` only: 15, 30 or 60, or an explicit null for "until I
 * resume". There is no rider id in the body: it is the session's.
 *
 *   200 { availability, phase }
 *   400 invalid_body | invalid_action | invalid_minutes
 *   409 active_delivery | not_online
 *   503 migration_pending
 */
export async function POST(request: Request) {
  const auth = await requireRiderApi();
  if (!auth.ok) return auth.response;
  const { profile } = auth;

  // Availability changes are a few taps a shift. 20 a minute absorbs retries and
  // a rider fiddling with break lengths while capping a runaway client.
  const limit = await rateLimit(`rider-status:${profile.id}`, 20, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  let body: { action?: unknown; minutes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const action = ACTIONS.find((a) => a === body.action);
  if (!action) return NextResponse.json({ error: "invalid_action" }, { status: 400 });

  // Shape here (a number, or an explicit null); which numbers are allowed is the
  // rules' call. A missing `minutes` on a break is not "until resumed" — that
  // has to be asked for with null.
  let minutes: number | null | undefined;
  if (action === "break") {
    if (body.minutes !== null && typeof body.minutes !== "number") {
      return NextResponse.json({ error: "invalid_minutes" }, { status: 400 });
    }
    minutes = body.minutes;
  }

  try {
    const result = await setRiderAvailability(profile.id, action, minutes);
    if (!result.ok) {
      const status = result.error === "invalid_minutes" ? 400 : 409;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({
      availability: result.next,
      phase: riderPhase(result.next, new Date()),
    });
  } catch (e) {
    return riderRouteError(e, { route: "/api/rider/status", method: "POST", riderId: profile.id });
  }
}
