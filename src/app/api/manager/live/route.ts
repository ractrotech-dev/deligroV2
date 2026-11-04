import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { isUuid, narrowScope } from "@/lib/auth/manager-scope";
import { getLiveSnapshot } from "@/lib/data-access/manager-live";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/live?zone=<uuid> — the live operations snapshot (§6):
 * riders on the map with their state and last-fix age, active orders by lane,
 * unassigned and delayed queues with reasons, and the signals (rider inactive,
 * delivery failed, delayed, unassigned, prep delayed) Phase 8's alerts read.
 * `riders` is empty without manager.riders.view; a rider's `phone` is null without
 * manager.call_customer.
 *
 * → 200 LiveSnapshot   → 400 { error: "bad_request", field: "zone" }
 * → 500 { error: "load_failed" }
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.live.view");
  if (ctx instanceof Response) return ctx;

  const zone = new URL(request.url).searchParams.get("zone");
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });

  try {
    const snapshot = await getLiveSnapshot(narrowScope(ctx.scope, zone), new Date());
    // The Live tab has its own switch; where riders are and how to call them have
    // theirs. Lanes and queues stay either way.
    const canCall = ctx.permissions["manager.call_customer"] === true;
    const canSeeRiders = ctx.permissions["manager.riders.view"] === true;
    return NextResponse.json({
      ...snapshot,
      riders: canSeeRiders ? snapshot.riders.map((r) => (canCall ? r : { ...r, phone: null })) : [],
    });
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
