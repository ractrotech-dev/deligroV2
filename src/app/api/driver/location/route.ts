import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordRiderFix } from "@/lib/data-access/rider-status";

/**
 * POST /api/driver/location  { lat, lng }
 *
 * The rider's device saying where it actually is. Until this existed the only
 * thing that had ever written deliveries.driver_lat/lng was `acceptDelivery`,
 * with a constant offset from the centre of Bemetara — so the courier the
 * customer watched crossing their map was a drawing.
 *
 * There is deliberately no delivery id in the body. The row to write is derived
 * from the session (the caller's own delivery, still in flight), so a rider has
 * no way to address another rider's position: it isn't a check that could be
 * skipped, there is simply no parameter for it.
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The board posts at most one fix every 10 s while a delivery is in flight, so
  // roughly 6 a minute. 30 leaves headroom for the app open in two tabs, a burst
  // of retries after a tunnel, and clock skew — while still capping a runaway
  // `watchPosition` loop (a broken client can fire on every sensor reading, several
  // times a second) at one database write every two seconds. Keyed on the driver,
  // who is by definition authenticated here.
  const limit = await rateLimit(`driver-location:${user.id}`, 30, 60_000);
  if (!limit.ok) return tooManyRequests(limit);

  // Role check before the write path: reportDriverLocation runs on the
  // service-role client, so nothing below this line is filtered by RLS. A failed
  // profile read leaves `role` undefined and is refused, not waved through.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "driver") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { lat?: unknown; lng?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Shape here, plausibility in the data-access layer. JSON will happily carry
  // a string "21.7" or a null, and neither is a position.
  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return NextResponse.json({ error: "invalid_position" }, { status: 400 });
  }

  try {
    // The same writer as /api/rider/location: the delivery's position for the
    // customer's map, and — for a rider who is online — the presence fix
    // (rider_status.last_fix_at) that dispatch and the manager's picker read.
    // Without it a rider still on this older client read as `stale_fix` to
    // everyone and could not be assigned.
    const result = await recordRiderFix(user.id, body.lat, body.lng);
    if (!result.ok && result.error === "invalid_position") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (!result.ok && result.error === "delivery_failed") {
      return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
    // ok, or presence_failed (a database without 0081): the delivery position
    // landed, which is all this route ever promised. `active: false` means the
    // delivery ended while the device was still watching; the client stops
    // reporting on this answer rather than being told off with an error.
    return NextResponse.json({ ok: true, active: result.active });
  } catch {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
