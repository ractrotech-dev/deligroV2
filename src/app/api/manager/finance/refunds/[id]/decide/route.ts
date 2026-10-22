import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { getRefundFor } from "@/lib/data-access/manager-finance";
import { decideRefund } from "@/lib/data-access/refunds";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyRefundDecided } from "@/lib/notifications/order-events";
import { parseRefundDecideBody } from "@/lib/ops/finance-contract";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/finance/refunds/[id]/decide — approve or deny a refund,
 * with a reason (3–300). Approving an online-paid order returns the money
 * through the gateway first; the decision, decided_by and the audit row are
 * then one transaction (ops_decide_refund, 0156). Settlement effects follow
 * (a correction when the order's payout was already paid; a note on a draft).
 *
 * Needs manager.finance.view + manager.finance.adjust; the refund's order must
 * be in the manager's zones (else 404).
 * → 200 { refund: RefundItem }   → 400 reason_required | bad_request   → 403 permission_denied   → 404 not_found
 * → 409 already_decided | in_progress | amount_exceeds_payment
 * → 502 gateway_failed (nothing moved, still pending) | effect_failed (money returned, decision NOT saved — do not retry blindly)
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  if (ctx.profile.role !== "admin" && ctx.permissions["manager.finance.adjust"] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: "manager.finance.adjust" }, { status: 403 });
  }
  const limited = await managerWriteLimit(ctx, "refund-decide");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const parsed = parseRefundDecideBody(await readJsonObject(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: parsed.status });

  try {
    const refundId = id.toLowerCase();
    const current = await getRefundFor(ctx.scope, refundId);
    if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (current.status !== "pending") return NextResponse.json({ error: "already_decided" }, { status: 409 });

    const decision = parsed.input.decision === "approve" ? "approved" : "denied";
    const result = await decideRefund({ id: ctx.profile.id }, refundId, decision, parsed.input.reason, parsed.input.clientActionId);
    if (!result.ok) {
      switch (result.error) {
        case "not_pending": return NextResponse.json({ error: "already_decided" }, { status: 409 });
        case "in_progress": return NextResponse.json({ error: "in_progress" }, { status: 409 });
        case "reason_required": return NextResponse.json({ error: "reason_required", field: "reason" }, { status: 400 });
        case "amount_exceeds_payment": return NextResponse.json({ error: "amount_exceeds_payment" }, { status: 409 });
        case "gateway_failed": return NextResponse.json({ error: "gateway_failed", refundId }, { status: 502 });
        case "record_failed": return NextResponse.json({ error: "effect_failed", refundId }, { status: 502 });
        default: return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
    }
    deferNotify(() => notifyRefundDecided(result.orderId, result.approved));
    const refund = await getRefundFor(ctx.scope, refundId);
    return NextResponse.json({ refund });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
