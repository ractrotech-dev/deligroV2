"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { captureError } from "@/lib/obs/emit";
import { adminPaymentContext } from "@/lib/data-access/admin-rider-payments";
import { decidePaymentRequest, getPaymentRequest } from "@/lib/data-access/payment-requests";
import { parseDecideBody } from "@/lib/ops/payment-actions";
import { riderPaymentMessage } from "@/lib/rider/admin-money";

/**
 * Decide a rider's payment request: the same `decidePaymentRequest` the manager
 * route calls, on the same parser. The database refuses anything it should
 * (0152): the requester deciding without the one-admin switch, an approval with
 * no reference, a self-approval with no reason. An amount that changed since the
 * request comes back to be confirmed, and is paid only once it has been.
 */

export interface DecideResult {
  ok: boolean;
  error?: string;
  /** The amount is now this: approving again, with it confirmed, pays it. */
  newAmount?: number;
}

export async function decideRiderPaymentAction(input: {
  requestId: string;
  decision: "approve" | "reject" | "cancel";
  reference?: string;
  paidOn?: string;
  confirmAmount?: number | null;
  note?: string;
}): Promise<DecideResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`rider-payout:${admin.id}`, 20, 60_000);
  if (!limit.ok) return { ok: false, error: "Too many changes in a minute. Wait a moment and try again." };
  if (!isSupabaseConfigured) return { ok: false, error: "Demo mode: connect Supabase to pay riders. Nothing was saved." };

  const parsed = parseDecideBody(
    {
      clientActionId: crypto.randomUUID(),
      decision: input.decision,
      reference: input.reference,
      paidOn: input.paidOn || null,
      confirmAmount: input.confirmAmount ?? null,
      note: input.note,
    },
    new Date()
  );
  if (!parsed.ok) return { ok: false, error: riderPaymentMessage(parsed.error === "bad_request" ? parsed.field ?? "bad_request" : parsed.error) };

  const ctx = adminPaymentContext(admin);
  try {
    // This screen decides rider payments only: a shop payment has its own page
    // and its own path, which re-checks the amount against today's refunds.
    const request = await getPaymentRequest(ctx.scope, input.requestId, { id: admin.id, perms: {}, isAdmin: true });
    if (!request || request.kind !== "rider_payout") return { ok: false, error: riderPaymentMessage("not_found") };

    const result = await decidePaymentRequest(ctx, input.requestId, parsed.input);
    if (!result.ok) {
      const amount = Number(result.extra?.amount);
      return {
        ok: false,
        error: riderPaymentMessage(result.error, { amount }),
        ...(result.error === "amount_changed" ? { newAmount: amount } : {}),
      };
    }
    revalidatePath("/admin/riders/payments");
    revalidatePath(`/admin/riders/${request.subject.id}`);
    revalidatePath("/admin/riders");
    return { ok: true };
  } catch (e) {
    captureError(e, { source: "admin-riders/payment-decision", attrs: { event: "payment_decision_failed", requestId: input.requestId } });
    return { ok: false, error: riderPaymentMessage("action_failed") };
  }
}
