import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { listSettlementsFor, settlementSummaryFor, shopInScope, type SettlementStatusFilter } from "@/lib/data-access/manager-finance";
import { createVendorSettlementRequest } from "@/lib/data-access/payment-requests";
import { parseFinanceRange, parseInitiateBody } from "@/lib/ops/finance-contract";
import { badRequest, cursorParam, financeReadLimit, loadFailed } from "@/lib/manager/finance-route";

export const dynamic = "force-dynamic";

const STATUSES: SettlementStatusFilter[] = ["draft", "paid", "void", "pending_approval"];

/**
 * GET /api/manager/finance/settlements?status&vendor&from&to&zone&cursor —
 * settlement history in the manager's zones (§7 tracking 6–7), newest first.
 * `from`/`to` filter paid_at for `paid`, created_at otherwise (both optional:
 * no range = all time). `pending_approval` = drafts with a pending request.
 *
 * Needs manager.finance.view.
 * → 200 { items: SettlementSummary[], nextCursor, totals: { netPayable, count } }   → 400   → 403
 */
export async function GET(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await financeReadLimit(ctx);
  if (limited) return limited;

  const p = new URL(request.url).searchParams;
  const status = p.get("status");
  if (status && !STATUSES.includes(status as SettlementStatusFilter)) return badRequest("status");
  const vendor = p.get("vendor");
  if (vendor && !isUuid(vendor)) return badRequest("vendor");
  let range = null;
  let zone: string | null = null;
  if (p.has("from") || p.has("to")) {
    const q = parseFinanceRange(p, new Date());
    if (!q.ok) return NextResponse.json({ error: q.error, ...(q.field ? { field: q.field } : {}) }, { status: 400 });
    range = q.range;
    zone = q.zone;
  } else {
    zone = p.get("zone");
    if (zone && !isUuid(zone)) return badRequest("zone");
  }
  const cursor = cursorParam(p);
  if (cursor instanceof Response) return cursor;

  try {
    return NextResponse.json(await listSettlementsFor(ctx.scope, {
      status: (status as SettlementStatusFilter) || null,
      vendorId: vendor ? vendor.toLowerCase() : null,
      range,
      zone: zone ? zone.toLowerCase() : null,
      cursor,
    }));
  } catch {
    return loadFailed();
  }
}

/**
 * POST /api/manager/finance/settlements — initiate a vendor settlement (the
 * maker): a draft for a period (`from`/`to`) or one delivered order
 * (`orderId`), put up for approval. A different person approves it through
 * POST /api/manager/payments/requests/[id]/decide. No vendor payment is made by
 * one person (migration 0156).
 *
 * Needs manager.finance.view + manager.finance.initiate_payment. 60 writes a minute.
 * → 201 { settlement: SettlementSummary, request: PaymentRequest }
 * → 400 bad_request | bad_range   → 403 permission_denied   → 404 not_found
 * → 409 nothing_to_pay | negative_net | duplicate_pending | already_settled
 */
export async function POST(request: Request) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.profile.role !== "admin" && ctx.permissions["manager.finance.initiate_payment"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.finance.initiate_payment" }, { status: 403 });
  }
  const limited = await managerWriteLimit(ctx, "payment-writes");
  if (limited) return limited;

  const parsed = parseInitiateBody(await readJsonObject(request), new Date());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: parsed.status });

  try {
    if (!(await shopInScope(ctx.scope, parsed.input.vendorId))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const result = await createVendorSettlementRequest(ctx, parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    const settlement = await settlementSummaryFor(ctx.scope, result.value.settlementId);
    return NextResponse.json({ settlement, request: result.value.request }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
