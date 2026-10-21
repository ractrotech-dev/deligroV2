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
    return NextResponse.json(await getLiveSnapshot(narrowScope(ctx.scope, zone), new Date()));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
