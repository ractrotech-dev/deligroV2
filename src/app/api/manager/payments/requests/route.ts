import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { viewerOf } from "@/lib/data-access/manager-riders";
import { createRiderPayoutRequest, listPaymentRequests } from "@/lib/data-access/payment-requests";
import { decodeTimeCursor } from "@/lib/ops/rider-contract";
import { parsePayoutRequestBody } from "@/lib/ops/payment-actions";

export const dynamic = "force-dynamic";

const STATUSES = ["pending_approval", "approved", "rejected", "cancelled"] as const;

/**
 * GET /api/manager/payments/requests — maker–checker payment requests in the
 * manager's zones (§5.13, §7). Query: status, kind, zone, mine=1, cursor.
 * Needs manager.finance.view. Each item says whether THIS viewer can decide it
 * (`canDecide`: holds approve_payment and did not request it).
 *
 * → 200 { items: PaymentRequest[], nextCursor, counts }   → 400 bad_request   → 403 permission_denied
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;

  const p = new URL(request.url).searchParams;
  const status = p.get("status");
  if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) return NextResponse.json({ error: "bad_request", field: "status" }, { status: 400 });
  const kind = p.get("kind");
  if (kind && kind !== "rider_payout" && kind !== "vendor_settlement" && kind !== "settlement_reversal") return NextResponse.json({ error: "bad_request", field: "kind" }, { status: 400 });
  const zone = p.get("zone");
  if (zone && !isUuid(zone)) return NextResponse.json({ error: "bad_request", field: "zone" }, { status: 400 });
  const rawCursor = p.get("cursor");
  const cursor = rawCursor ? decodeTimeCursor(rawCursor) : null;
  if (rawCursor && (!cursor || !isUuid(cursor.id))) return NextResponse.json({ error: "bad_request", field: "cursor" }, { status: 400 });

  try {
    return NextResponse.json(
      await listPaymentRequests(ctx.scope, viewerOf(ctx), {
        status: (status as (typeof STATUSES)[number]) || null,
        kind: (kind as "rider_payout" | "vendor_settlement" | "settlement_reversal") || null,
        zone: zone ? zone.toLowerCase() : null,
        mine: p.get("mine") === "1",
        cursor,
      })
    );
  } catch {
    return NextResponse.json({ error: "load_failed" }, { status: 500 });
  }
}

/**
 * POST /api/manager/payments/requests — put a rider payout up for approval
 * (the maker). Riders are salaried: `salaryAmount` is the salary for the
 * period; any unpaid ledger rows up to `periodEnd` are included. A different
 * person approves it (POST …/[id]/decide).
 *
 * Needs manager.finance.initiate_payment (and finance.view). 60 writes a minute.
 * → 201 { request: PaymentRequest }   → 400 bad_request   → 403 permission_denied
 * → 404 not_found   → 409 nothing_to_pay | duplicate_pending
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.permissions["manager.finance.initiate_payment"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.finance.initiate_payment" }, { status: 403 });
  }
  const limited = await managerWriteLimit(ctx, "payment-writes");
  if (limited) return limited;

  const parsed = parsePayoutRequestBody(await readJsonObject(request), new Date());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: parsed.status });

  try {
    const result = await createRiderPayoutRequest(ctx, parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ request: result.value }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
