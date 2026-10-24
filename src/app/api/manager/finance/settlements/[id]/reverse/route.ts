import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getSettlementFor } from "@/lib/data-access/manager-finance";
import { getPaymentRequest } from "@/lib/data-access/payment-requests";
import { viewerOf } from "@/lib/data-access/manager-riders";
import { requestSettlementReversal } from "@/lib/data-access/settlement-requests";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/finance/settlements/[id]/reverse — ask for a PAID
 * settlement to be reversed (its transfer did not reach the vendor). Body:
 * { reason (3–500), clientActionId }. Nothing changes until a different
 * person approves the request (POST /api/manager/payments/requests/[id]/decide),
 * which voids the payout so its orders can be paid again (0156).
 *
 * Needs manager.finance.view + manager.finance.initiate_payment. Out of the
 * manager's zones → 404.
 * → 201 { request: PaymentRequest }   → 400 reason_required | bad_request   → 403 permission_denied
 * → 404 not_found   → 409 not_paid | duplicate_pending
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.profile.role !== "admin" && ctx.permissions["manager.finance.initiate_payment"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.finance.initiate_payment" }, { status: 403 });
  }
  const limited = await managerWriteLimit(ctx, "settlement-reverse");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJsonObject(request);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const clientActionId = typeof body?.clientActionId === "string" ? body.clientActionId.trim() : "";
  if (clientActionId.length < 8 || clientActionId.length > 100) return NextResponse.json({ error: "bad_request", field: "clientActionId" }, { status: 400 });
  if (reason.length < 3 || reason.length > 500) return NextResponse.json({ error: "reason_required", field: "reason" }, { status: 400 });

  try {
    const found = await getSettlementFor(ctx.scope, id.toLowerCase(), () => Promise.resolve({ stale: false, freshNet: 0 }));
    if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const res = await requestSettlementReversal(ctx.profile.id, id.toLowerCase(), reason, clientActionId);
    if (!res.ok) return NextResponse.json({ error: res.error, ...(res.extra ?? {}) }, { status: res.status });
    const req = await getPaymentRequest(ctx.scope, res.value.request_id, viewerOf(ctx));
    return NextResponse.json({ request: req }, { status: res.value.replayed ? 200 : 201 });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
