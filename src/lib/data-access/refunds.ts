import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { RazorpayError, toPaise } from "@/lib/payments/razorpay";
import { refundRazorpayPayment } from "@/lib/payments/refunds";
import {
  createSettlementCorrection,
  findSettlementForOrder,
  flagSettlementForRefund,
} from "@/lib/data-access/admin-settlements";
import { shortOrderId } from "@/lib/utils/order-map";
import { classifyGatewayFailure } from "@/lib/payments/refund-failure";
import { approvalExceedsTotal, gatewayRoomPaise } from "@/lib/refunds/partials";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { PaymentStatus } from "@/types";

/**
 * What is left of refunds: deciding one through the payment gateway.
 *
 * The rule book says no refunds for customers or vendors, so nothing creates a refund
 * any more (0191 refuses new rows) and NO route, action or screen calls anything in
 * this file. It stays because online payment is not live yet and what happens to
 * online money on a cancel is the owner's open question: this is the tested,
 * one-call-only path to Razorpay if the answer needs it. Do not wire it to a screen
 * without a rule from the owner.
 *
 * Old records are read through reports (`ops_report_refunds_adjustments`) and the
 * settlement maths; neither comes through here.
 */

export type RefundStatus = "pending" | "approved" | "denied";

/**
 * `origin`, `requested_by`, `provider_refund_id` and `settled_at` arrive
 * together in one ALTER TABLE (0026), so one probe answers for all four.
 */
const REFUND_PROVENANCE = "refunds.origin";
/**
 * `payment_method` / `payment_status` arrive together in 0025. Same key the
 * orders queries use, on purpose: one probe, one answer, app-wide.
 */
const ORDER_PAYMENT = "orders.payment_method";

interface RefundableOrder {
  total: number;
  paymentStatus: PaymentStatus | null;
}

/**
 * The order behind a refund, with its payment state when this database has one.
 *
 * Returns `paymentStatus: null` on a pre-0025 install — not 'pending', because
 * "we cannot tell" and "we know it is unpaid" are different claims and only one
 * of them is true there.
 */
async function readRefundableOrder(
  admin: ReturnType<typeof createAdminClient>,
  orderId: string
): Promise<RefundableOrder | null> {
  let withPayment = !columnKnownMissing(ORDER_PAYMENT);

  const run = (columns: string) =>
    admin.from("orders").select(columns).eq("id", orderId).maybeSingle();

  let { data, error } = await run(
    withPayment ? "id, total, payment_status" : "id, total"
  );

  if (error && isMissingColumn(error) && withPayment) {
    rememberColumn(ORDER_PAYMENT, false);
    withPayment = false;
    ({ data, error } = await run("id, total"));
  }

  if (error) throw error;
  if (!data) return null;
  if (withPayment) rememberColumn(ORDER_PAYMENT, true);

  const row = data as unknown as {
    total?: number | null;
    payment_status?: string | null;
  };
  return {
    total: Number(row.total ?? 0),
    paymentStatus: withPayment
      ? ((row.payment_status ?? "pending") as PaymentStatus)
      : null,
  };
}

/** Amounts of this order's approved refunds (whole rupees). Service role: called below an admin check. */
async function approvedRefundAmounts(orderId: string): Promise<number[]> {
  const { data, error } = await createAdminClient()
    .from("refunds")
    .select("amount")
    .eq("order_id", orderId)
    .eq("status", "approved");
  if (error) throw error;
  return ((data ?? []) as { amount: number | null }[]).map((r) => Number(r.amount ?? 0));
}

/* ============================================================
   Deciding
   ============================================================ */

export type RefundDecisionError =
  | "unauthorized"
  | "not_pending"
  | "in_progress"
  | "reason_required"
  | "amount_exceeds_payment"
  | "gateway_failed"
  | "gateway_unknown"
  | "gateway_paid"
  | "record_failed"
  | "recorded_failed_after_gateway";

export type RefundDecision =
  | {
      ok: true;
      orderId: string;
      approved: boolean;
      /** True only when Razorpay reported the money PROCESSED back. */
      settled: boolean;
      /**
       * Set when this order's payout was already booked into a settlement —
       * draft or paid — at the moment the refund was approved. There is no
       * automatic clawback (see `flagSettlementForRefund`'s own comment); this
       * is the caller's cue to surface that to the admin immediately, on top
       * of the note already written onto the settlement itself.
       */
      settlementWarning?: string | null;
    }
  | { ok: false; error: RefundDecisionError };

interface PendingRefund {
  id: string;
  orderId: string;
  amount: number;
  /** Whether this database has the 0026 provenance columns to write into. */
  provenance: boolean;
}

/**
 * Read the refund being decided, and learn on the way whether this database can
 * record a gateway refund id at all.
 *
 * The probe is folded into the read deliberately. Knowing BEFORE the gateway
 * call whether `provider_refund_id` exists is what keeps us from moving money we
 * would then be unable to prove we moved — and an unprovable refund is one an
 * admin will eventually be asked to make a second time.
 */
async function readPendingRefund(
  supabase: ReturnType<typeof createAdminClient>,
  id: string
): Promise<PendingRefund | null> {
  const run = (columns: string) =>
    supabase.from("refunds").select(columns).eq("id", id).maybeSingle();

  let withProvenance = !columnKnownMissing(REFUND_PROVENANCE);
  let { data, error } = await run(
    withProvenance
      ? "id, order_id, amount, status, provider_refund_id"
      : "id, order_id, amount, status"
  );

  if (error && isMissingColumn(error) && withProvenance) {
    rememberColumn(REFUND_PROVENANCE, false);
    withProvenance = false;
    ({ data, error } = await run("id, order_id, amount, status"));
  }

  if (error) throw error;
  if (!data) return null;
  if (withProvenance) rememberColumn(REFUND_PROVENANCE, true);

  const row = data as unknown as {
    id: string;
    order_id: string;
    amount: number | null;
    status: string;
  };
  if (row.status !== "pending") return null;

  return {
    id: row.id,
    orderId: row.order_id,
    amount: Number(row.amount ?? 0),
    provenance: withProvenance,
  };
}

interface GatewaySettlement {
  /** Razorpay's refund id, or null when this one is settled off-platform. */
  refundId: string | null;
  /** ISO timestamp, set only when the gateway PROCESSED the refund. */
  settledAt: string | null;
  /** The payments row to mirror onto, when there was one. */
  paymentRowId: string | null;
}

const MANUAL_SETTLEMENT: GatewaySettlement = {
  refundId: null,
  settledAt: null,
  paymentRowId: null,
};

/** The captured Razorpay payment behind an order, if there is one. */
async function capturedRazorpayPayment(
  orderId: string
): Promise<{ id: string; provider_payment_id: string | null; amount_paise: number } | null> {
  const { data, error } = await createAdminClient()
    .from("payments")
    .select("id, provider_payment_id, amount_paise")
    .eq("order_id", orderId)
    .eq("provider", "razorpay")
    .eq("status", "paid")
    .not("provider_payment_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    provider_payment_id: (data.provider_payment_id as string | null) ?? null,
    amount_paise: Number(data.amount_paise ?? 0),
  };
}

/**
 * Return the money for an approved refund, when there is a gateway payment to
 * return it through.
 *
 * Everything that is NOT an online payment we actually captured settles off
 * platform: a cash order was handed over in notes, and an approval records the
 * decision while a human still hands the money back. That case returns
 * MANUAL_SETTLEMENT — no refund id, no settled_at — so nothing downstream can
 * mistake "approved" for "returned".
 *
 * The service-role client is used for the payments lookup because `payments`
 * grants no INSERT/UPDATE to any browser key at all (0025); the authorization
 * for this path is `requireRole("admin")` in the Server Action above it, plus
 * the RLS-scoped read of the refund row that got us here.
 */
async function settleApprovedRefund(
  refund: PendingRefund
): Promise<
  | { ok: true; settlement: GatewaySettlement }
  | { ok: false; error: RefundDecisionError; definite: boolean }
> {
  if (!refund.provenance) {
    // Pre-0026: nowhere to write the gateway's refund id, so we do not ask for
    // one. Approving still records the decision; the money goes back by hand.
    return { ok: true, settlement: MANUAL_SETTLEMENT };
  }

  const admin = createAdminClient();

  const order = await readRefundableOrder(admin, refund.orderId);
  // Only a captured online payment can be reversed through Razorpay. 'paid' is
  // the single state that means we are holding the customer's money.
  if (order?.paymentStatus !== "paid") {
    return { ok: true, settlement: MANUAL_SETTLEMENT };
  }

  const payment = await capturedRazorpayPayment(refund.orderId);

  // No payments table (pre-0025) or no captured row: the order says paid and
  // the ledger cannot say through what. Fall back to a hand settlement rather
  // than guess at a payment id — this is reconciliation work, not a refund we
  // can automate.
  if (!payment?.provider_payment_id) {
    return { ok: true, settlement: MANUAL_SETTLEMENT };
  }

  const amountPaise = toPaise(refund.amount);
  if (amountPaise <= 0) {
    return { ok: true, settlement: MANUAL_SETTLEMENT };
  }
  // An order can carry more than one refund (an item, then the rest), so what
  // the gateway can still return is the capture less what it already returned.
  // Every refund the gateway already paid on this order counts — including one
  // still pending because its decision was not recorded yet (0156's claim).
  const { data: earlier } = await admin
    .from("refunds")
    .select("amount")
    .eq("order_id", refund.orderId)
    .neq("id", refund.id)
    .not("provider_refund_id", "is", null);
  const alreadyPaise = ((earlier ?? []) as { amount: number | null }[]).map((r) => toPaise(Number(r.amount ?? 0)));
  if (amountPaise > gatewayRoomPaise(Number(payment.amount_paise ?? 0), alreadyPaise)) {
    // Refusing rather than clamping: a request for more than was captured means
    // the two records disagree, and quietly refunding the smaller number would
    // hide that while telling the customer they were made whole.
    return { ok: false, error: "amount_exceeds_payment", definite: true };
  }

  try {
    const result = await refundRazorpayPayment({
      providerPaymentId: String(payment.provider_payment_id),
      amountPaise,
      notes: { deligro_order_id: refund.orderId, deligro_refund_id: refund.id },
    });
    return {
      ok: true,
      settlement: {
        refundId: result.id,
        // 'pending' at Razorpay means committed but not yet in the customer's
        // account. The refund id is recorded either way — that is what stops a
        // second attempt — but settled_at waits for 'processed'.
        settledAt: result.settled ? new Date().toISOString() : null,
        paymentRowId: String(payment.id),
      },
    };
  } catch (err) {
    // A definite refusal moved nothing; anything else (a network failure, a
    // 5xx) may have moved money we never heard about. The caller keeps the
    // claim then: Razorpay offers no idempotency key on refunds, so only a
    // human who has checked the dashboard may let it be tried again.
    if (!(err instanceof RazorpayError)) {
      console.error("[decideRefund] gateway refund failed", err);
    }
    return { ok: false, error: "gateway_failed", definite: classifyGatewayFailure(err) === "definite" };
  }
}

/**
 * Decide a refund — for an admin, or a manager with manager.finance.adjust in
 * the order's zone (callers authorise and scope first; ops_decide_refund checks
 * the zone again).
 *
 * Approving is not just a status change: for an order paid online it calls
 * Razorpay first and only records the approval if the gateway honoured it. A
 * failed gateway call leaves the request pending and returns an error, so the
 * queue never shows a settled refund the customer has not been paid. The
 * decision, decided_by/decided_at, the gateway's refund id and the audit row
 * are then written by one audited RPC (0156), with the reason.
 *
 * One gateway call per refund, ever (Razorpay offers no idempotency key on
 * refunds): the refund is claimed in the database before the call
 * (ops_claim_refund), the gateway's refund id is written onto it the moment
 * Razorpay answers, and a retry after a lost decision resumes from that id
 * instead of calling again. A claim whose outcome is unknown stays held until
 * an admin has checked the Razorpay dashboard and released it.
 *
 * Returns the order id so the caller can notify the customer — the decision and
 * the message about it belong to different layers.
 */
export async function decideRefund(
  actor: { id: string },
  id: string,
  decision: Exclude<RefundStatus, "pending">,
  reason: string,
  clientActionId?: string | null
): Promise<RefundDecision> {
  if (!actor.id) return { ok: false, error: "unauthorized" };
  const why = reason.trim();
  if (why.length < 3 || why.length > 300) return { ok: false, error: "reason_required" };

  // Service role: the caller has already authorised (admin, or a manager whose
  // scope holds this refund's order); the RPCs below re-check the zone.
  const supabase = createAdminClient();
  const refund = await readPendingRefund(supabase, id);
  // Missing and already-decided are the same answer: there is no pending
  // refund by this id to act on.
  if (!refund) return { ok: false, error: "not_pending" };

  let refundId: string | null = null;
  let settledAt: string | null = null;

  // Denying moves no money, so it needs no claim and no gateway call —
  // ops_decide_refund itself refuses while someone else's gateway call is out.
  if (decision === "approved") {
    // One gateway call per refund, ever (0156): the claim is taken in the
    // database before Razorpay is asked, and Razorpay's refund id is written
    // onto the still-pending refund the moment it answers.
    const { data: claimed, error: claimError } = await supabase.rpc("ops_claim_refund", { p_actor: actor.id, p_refund: id });
    if (claimError) {
      const m = (claimError.message ?? "").trim();
      if (m === "already_decided") return { ok: false, error: "not_pending" };
      if (m === "forbidden") return { ok: false, error: "unauthorized" };
      throw claimError;
    }
    const claim = claimed as { state: "fresh" | "held" | "resume"; provider_refund_id?: string | null };
    // Someone's call is out, or its answer was lost: an admin checks the
    // Razorpay dashboard and releases the claim before anyone tries again.
    if (claim.state === "held") return { ok: false, error: "in_progress" };

    if (claim.state === "resume") {
      // The gateway already returned this money; only the decision is left to
      // record. Never call Razorpay again.
      refundId = claim.provider_refund_id ?? null;
    } else {
      const release = (why: string) =>
        supabase.rpc("ops_release_refund_claim", {
          p_actor: actor.id, p_refund: id, p_reason: why, p_client_action_id: crypto.randomUUID(),
        });

      // guard_refund_total (0142) would refuse this approval after the gateway
      // had already paid it; ask the same question first, so no money moves
      // for a refund that cannot be recorded.
      const approved = await approvedRefundAmounts(refund.orderId);
      const order = await readRefundableOrder(createAdminClient(), refund.orderId);
      if (order && approvalExceedsTotal({ total: order.total, approved, amount: refund.amount })) {
        await release("The refund is larger than the order");
        return { ok: false, error: "amount_exceeds_payment" };
      }

      const outcome = await settleApprovedRefund(refund);
      if (!outcome.ok) {
        if (!outcome.definite) return { ok: false, error: "gateway_unknown" };
        await release("The gateway refused the refund; nothing was returned");
        return { ok: false, error: outcome.error };
      }
      ({ refundId, settledAt } = outcome.settlement);

      if (refundId) {
        const { error: recordError } = await supabase.rpc("ops_record_refund_gateway", {
          p_actor: actor.id, p_refund: id, p_provider_refund_id: refundId, p_settled_at: settledAt,
        });
        if (recordError) {
          // The worst case in this file: Razorpay returned the money and we
          // could not write even its id down. The claim stays (nobody can pay
          // again); an admin reconciles it from this log line.
          console.error(`[decideRefund] refund ${id} settled at Razorpay as ${refundId} but its id could not be recorded`, recordError);
          return { ok: false, error: "recorded_failed_after_gateway" };
        }
      } else {
        // Settled by hand (cash, or nothing captured to reverse): no gateway
        // call happened, so the claim has nothing to protect any more.
        settledAt = null;
      }
    }
  }

  // One audited write: status, decided_by/at, the gateway id (when the
  // provenance columns exist and the gateway was called) and the audit row.
  const { error } = await supabase.rpc("ops_decide_refund", {
    p_actor: actor.id,
    p_refund: id,
    p_decision: decision === "approved" ? "approve" : "deny",
    p_reason: why,
    p_provider_refund_id: refund.provenance && refundId ? refundId : null,
    p_settled_at: refund.provenance && refundId ? settledAt : null,
    p_client_action_id: clientActionId ?? crypto.randomUUID(),
  });

  // Razorpay returned the money and its id is on the refund, but the decision
  // itself did not save. Retrying is safe: the next attempt's claim answers
  // `resume` and records the decision without calling the gateway again.
  if (error && refundId) {
    console.error(`[decideRefund] refund ${id} settled at Razorpay as ${refundId} but the decision could not be recorded`, error);
    return { ok: false, error: "record_failed" };
  }
  if (error) {
    const m = (error.message ?? "").trim();
    // Lost the race to someone else, and no money moved on this call — their
    // decision stands.
    if (m === "already_decided") return { ok: false, error: "not_pending" };
    if (m === "in_progress") return { ok: false, error: "in_progress" };
    if (m === "gateway_paid") return { ok: false, error: "gateway_paid" };
    if (m === "forbidden") return { ok: false, error: "unauthorized" };
    if (m === "reason_required") return { ok: false, error: "reason_required" };
    throw error;
  }

  // Marking the order and its gateway payment `refunded` — once the approved refunds cover the
  // total — is part of the decision itself now (ops_decide_refund, 0156): the same transaction as
  // the audit row, not a follow-up write that could fail on its own (review #20).

  // An approved refund moves money back out. If this order's payout was
  // already booked into a settlement — draft or paid — that settlement's
  // total now overstates what the vendor should actually receive/kept.
  //
  //   * Paid: nothing about that settlement can change (money already sent),
  //     so createSettlementCorrection (0048) records an outstanding debit
  //     against this vendor's NEXT settlement — the actual clawback, not just
  //     a note that one is owed.
  //   * Draft: still recoverable natively by voiding and rebuilding it, which
  //     prices the refund correctly through the normal per-line arithmetic —
  //     no correction row needed there. flagSettlementForRefund's note is the
  //     prompt to do that.
  let settlementWarning: string | null = null;
  if (decision === "approved") {
    try {
      const ref = await findSettlementForOrder(refund.orderId);
      if (ref && ref.status !== "void") {
        if (ref.status === "paid") {
          const correction = await createSettlementCorrection({
            orderId: refund.orderId,
            refundId: id,
            createdBy: actor.id,
          });
          if (!correction.ok) {
            settlementWarning = `The shop was already paid for this order (payment #${shortOrderId(ref.id)}), and taking it back automatically failed. See the note on that payment and take it off the shop's next payment by hand.`;
          } else if (correction.amount > 0) {
            settlementWarning = `The shop was already paid for this order (payment #${shortOrderId(ref.id)}). ₹${correction.amount} comes off its next payment.`;
          } else {
            settlementWarning = `The shop was already paid for this order (payment #${shortOrderId(ref.id)}). This refund doesn't change what the shop gets.`;
          }
        } else {
          settlementWarning = `This order is in a payment that isn't finished (#${shortOrderId(ref.id)}). Its amount is corrected when someone approves it.`;
        }
        await flagSettlementForRefund(
          ref.id,
          `Refund ${id} (₹${refund.amount}) approved for order ${refund.orderId} on ${new Date().toISOString()}, after this settlement was ${ref.status === "paid" ? "paid" : "drafted"}.`
        );
      }
    } catch (err) {
      // Never let a failure here read back as the refund itself failing —
      // the money has already moved by this point.
      console.error(
        `[decideRefund] could not check settlement membership for order ${refund.orderId}`,
        err
      );
    }
  }

  return {
    ok: true,
    orderId: refund.orderId,
    approved: decision === "approved",
    settled: Boolean(settledAt),
    settlementWarning,
  };
}

/**
 * Give back a refund claim whose gateway outcome was never heard (admins
 * only, after checking the Razorpay dashboard; a reason is required and
 * audited). Refused once the gateway's refund id is on the refund.
 */
export async function releaseRefundClaim(
  actor: { id: string },
  id: string,
  reason: string
): Promise<{ ok: true } | { ok: false; error: "gateway_paid" | "reason_required" | "unauthorized" }> {
  const { error } = await createAdminClient().rpc("ops_release_refund_claim", {
    p_actor: actor.id, p_refund: id, p_reason: reason.trim(), p_client_action_id: crypto.randomUUID(),
  });
  if (!error) return { ok: true };
  const m = (error.message ?? "").trim();
  if (m === "gateway_paid") return { ok: false, error: "gateway_paid" };
  if (m === "reason_required") return { ok: false, error: "reason_required" };
  if (m === "forbidden") return { ok: false, error: "unauthorized" };
  throw error;
}
