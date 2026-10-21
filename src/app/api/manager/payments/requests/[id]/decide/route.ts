import { NextResponse } from "next/server";
import { managerApiContext, managerWriteLimit, readJsonObject } from "@/lib/auth/manager-api.server";
import { isUuid } from "@/lib/auth/manager-scope";
import { decidePaymentRequest } from "@/lib/data-access/payment-requests";
import { parseDecideBody } from "@/lib/ops/payment-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/manager/payments/requests/[id]/decide — the checker approves (with
 * the transaction reference) or rejects (with a note); the requester may cancel
 * their own pending request.
 *
 * Approve needs manager.finance.approve_payment (admins always pass); cancel
 * needs manager.finance.initiate_payment; reject needs approve_payment. The
 * database refuses the requester on approve/reject whatever the switches
 * (`same_person`, 0152). Approval re-computes the amount: 409 amount_changed
 * with the new figure until the approver re-sends `confirmAmount` equal to it.
 *
 * → 200 { request: PaymentRequest }   → 400 reference_required | note_required | bad_request
 * → 403 same_person | not_requester | permission_denied   → 404 not_found
 * → 409 amount_changed | already_decided | nothing_to_pay
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await managerApiContext("manager.finance.view");
  if (ctx instanceof Response) return ctx;
  const limited = await managerWriteLimit(ctx, "payment-writes");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = parseDecideBody(await readJsonObject(request), new Date());
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: parsed.status });

  const isAdmin = ctx.profile.role === "admin";
  const needed = parsed.input.decision === "cancel" ? "manager.finance.initiate_payment" : "manager.finance.approve_payment";
  if (!isAdmin && ctx.permissions[needed] !== true) {
    return NextResponse.json({ error: "permission_denied", permission: needed }, { status: 403 });
  }

  try {
    const result = await decidePaymentRequest(ctx, id.toLowerCase(), parsed.input);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json({ request: result.value });
  } catch {
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
}
