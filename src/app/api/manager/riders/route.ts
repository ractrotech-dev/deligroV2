import { NextResponse } from "next/server";
import { managerApiContext } from "@/lib/auth/manager-api.server";
import { listRidersForManager } from "@/lib/data-access/manager-riders";
import { parseRiderQuery } from "@/lib/ops/rider-contract";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/riders — every rider who shares one of the manager's zones
 * (§5.1), with live state (§5.4–§5.6), by name, keyset-paged.
 *
 * Query: q (name, rider ID, or 4+ phone digits), state (comma list of
 * online | available | on_delivery | break | stale | offline), verification,
 * account, zone, filter (needs_review | expiring), cursor, limit (1–100, 50).
 *
 * → 200 { items: RiderListItem[], nextCursor, counts }
 * → 400 { error: "bad_request", field }   → 500 { error: "load_failed" }
 * Contract: docs/superpowers/plans/2026-10-21-manager-app-phase-5-riders.md.
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;

  const parsed = parseRiderQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: "bad_request", field: parsed.field }, { status: 400 });

  try {
    return NextResponse.json(await listRidersForManager(ctx.scope, parsed.query, new Date()));
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}
