import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getRiderForManager, viewerOf } from "@/lib/data-access/manager-riders";
import { actOnRider } from "@/lib/data-access/manager-rider-actions";
import { RIDER_ACTION_PERMISSION, parseRiderActionBody } from "@/lib/ops/rider-actions";
import type { OpsResult } from "@/lib/ops/order-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/riders/[id]/actions — approve, reject, suspend or
 * reactivate a rider, take them offline, verify or reject one of their
 * documents, or record a bonus / deduction / adjustment (§5.2, §5.3, §5.13).
 * Body and answers: the Phase 5 plan's API contract.
 *
 * Status actions need the rider's current verification or account status as
 * `expected` (two managers deciding at once: the second gets 409 stale) and a
 * 3–300 character reason. Suspension and taking offline are refused while the
 * rider carries an order (409 active_delivery, with the order codes — reassign
 * first). The change and its audit row are one RPC (0151) that re-checks the
 * zone in the database; a replayed clientActionId answers 200 and changes
 * nothing. 60 writes a minute per manager.
 *
 * → 200 { ok: true, rider: RiderDetail | null }   (null: done, but the re-read failed — refetch)
 * → 400 bad_request (field) | reason_required | remarks_required   → 403 permission_denied
 * → 404 not_found   → 409 stale | documents_unverified | active_delivery | invalid_transition | already_decided
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.riders.view");
  if (ctx instanceof Response) return ctx;

  const limited = await managerWriteLimit(ctx, "rider-writes");
  if (limited) return limited;

  const { id: rawId } = await params;
  if (!isUuid(rawId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const id = rawId.toLowerCase();

  const parsed = parseRiderActionBody(await readJsonObject(request));
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error }, { status: parsed.status });
  }
  const permission = RIDER_ACTION_PERMISSION[parsed.action.action];
  if (ctx.permissions[permission] !== true) {
    return NextResponse.json({ error: "permission_denied", permission }, { status: 403 });
  }

  let result: OpsResult;
  try {
    result = await actOnRider(ctx, id, parsed.action);
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });

  try {
    const rider = await getRiderForManager(ctx.scope, id, viewerOf(ctx), new Date());
    return NextResponse.json({ ok: true, rider });
  } catch {
    // The action is done; only the re-read failed. Say so rather than 500 the change.
    return NextResponse.json({ ok: true, rider: null });
  }
}
