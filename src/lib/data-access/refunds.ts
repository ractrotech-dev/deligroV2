import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { RazorpayError, toPaise } from "@/lib/payments/razorpay";
import { refundRazorpayPayment } from "@/lib/payments/refunds";
import {
  createSettlementCorrection,
  findSettlementForOrder,
  flagSettlementForRefund,
} from "@/lib/data-access/admin-settlements";
import { shortOrderId } from "@/lib/utils/order-map";
import { isMissingFunction } from "@/lib/data-access/rpc-fallback";
import { approvalExceedsTotal, gatewayRoomPaise, isFullyRefunded } from "@/lib/refunds/partials";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { PaymentMethod, PaymentStatus } from "@/types";

/**
 * The refund queue, for real.
 *
 * The admin refunds screen used to render three invented refunds, and its
 * Approve button only set local React state — it rendered "Approved · logged"
 * and nothing was approved, and nothing was logged. An admin could believe they
 * had settled a customer's ₹660 and be wrong.
 *
 * Two things were still missing after that was fixed, and this file now carries
 * both:
 *
 *   1. Nothing ever WROTE to `refunds`. The table has existed since 0001 with no
 *      request path and no automatic refund, so the queue an admin was asked to
 *      work could only ever be empty. `queueRefundForOrder` (cancellations, a
 *      vendor declining) and `requestRefund` (the customer asking) fill it.
 *   2. Approving returned no money. Now that an order can actually be paid
 *      (0025), approving a refund on an order paid online calls Razorpay and
 *      records what the gateway said — and if the gateway refuses, the request
 *      stays pending rather than being marked settled. A refund the app claims
 *      to have made and hasn't is worse than one it never offered.
 *
 * The status vocabulary is the database's: `refund_status` is
 * ('pending','approved','denied'). This file used to say 'rejected', which no
 * Postgres enum has ever accepted — every deny failed at the database while the
 * UI reported the decision as recorded.
 *
 * Decision writes go through RLS ("refunds — admin decide", 0001), so a non-admin
 * cannot decide a refund even if this code were called from the wrong place.
 */

export type RefundStatus = "pending" | "approved" | "denied";

/** Who or what caused the refund to exist (0026). */
export type RefundOrigin = "customer" | "vendor_rejected" | "admin" | "manager" | "system";

export interface RefundRow {
  id: string;
  orderId: string;
  amount: number;
  reason: string | null;
  status: RefundStatus;
  createdAt: string;
  customerName: string | null;
  restaurantName: string | null;
  /**
   * 0026. Reads 'customer' on a database that predates the column, which is
   * what every row written before it was — there was no other way in.
   */
  origin: RefundOrigin;
  /** The order's own total, so the queue can show the ask against the bill. */
  orderTotal: number | null;
  /** 0025. Null when the database predates the payment columns. */
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  /** Razorpay's refund id — present only once the gateway accepted the refund. */
  providerRefundId: string | null;
  /** When Razorpay reported the refund PROCESSED. Null while it is in flight. */
  settledAt: string | null;
}

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

interface Row {
  id: string;
  order_id: string;
  amount: number;
  reason: string | null;
  status: RefundStatus;
  created_at: string;
  origin?: string | null;
  provider_refund_id?: string | null;
  settled_at?: string | null;
  orders?: {
    total?: number | null;
    payment_method?: string | null;
    payment_status?: string | null;
    profiles?: { full_name: string | null } | null;
    restaurants?: { name: string | null } | null;
  } | null;
}

function first<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

interface SelectFlags {
  /** refunds.origin & friends — 0026. */
  provenance: boolean;
  /** orders.payment_method / payment_status — 0025. */
  payment: boolean;
}

function select(flags: SelectFlags): string {
  return [
    "id, order_id, amount, reason, status, created_at",
    flags.provenance ? ", origin, provider_refund_id, settled_at" : "",
    ", orders ( total",
    flags.payment ? ", payment_method, payment_status" : "",
    ", profiles:customer_id ( full_name )",
    ", restaurants ( name ) )",
  ].join("");
}

/**
 * List the queue, narrowing the column list on a database that predates 0025 or
 * 0026.
 *
 * Same shape as the orders queries: each optional group is dropped
 * independently and remembered, so an environment missing one migration still
 * gets everything the other provides. An admin looking at a half-migrated
 * install sees the refunds with less provenance — never an empty screen, which
 * is the failure mode that made the old fake queue believable.
 */
export async function listRefunds(limit = 50): Promise<RefundRow[]> {
  const supabase = await createClient();

  const flags: SelectFlags = {
    provenance: !columnKnownMissing(REFUND_PROVENANCE),
    payment: !columnKnownMissing(ORDER_PAYMENT),
  };

  const run = (columns: string) =>
    supabase
      .from("refunds")
      .select(columns)
      // Pending first — that's the work; decided ones are just history. The
      // enum orders pending < approved < denied, so ascending is the queue.
      .order("status", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(limit);

  // `isMissingColumn` doesn't say WHICH column is missing, so drop the newest
  // migration's group first and re-probe rather than guessing.
  const groups: Array<{ key: keyof SelectFlags; column: string }> = [
    { key: "provenance", column: REFUND_PROVENANCE },
    { key: "payment", column: ORDER_PAYMENT },
  ];

  let rows: unknown[] = [];
  let answered = false;

  for (const { key, column } of groups) {
    if (!flags[key]) continue;

    const { data, error } = await run(select(flags));
    if (!error) {
      const present = groups.filter((g) => flags[g.key]);
      for (const g of present) rememberColumn(g.column, true);
      rows = (data ?? []) as unknown[];
      answered = true;
      break;
    }
    if (!isMissingColumn(error)) throw error;

    rememberColumn(column, false);
    flags[key] = false;
  }

  // Reached when every optional group has been ruled out — the bare query the
  // schema is guaranteed to support since 0001.
  if (!answered) {
    const { data, error } = await run(select(flags));
    if (error) throw error;
    rows = (data ?? []) as unknown[];
  }

  return (rows as unknown as Row[]).map((r) => {
    const order = first(r.orders);
    return {
      id: r.id,
      orderId: r.order_id,
      amount: r.amount,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
      customerName: first(order?.profiles)?.full_name ?? null,
      restaurantName: first(order?.restaurants)?.name ?? null,
      origin: (r.origin ?? "customer") as RefundOrigin,
      orderTotal: order?.total ?? null,
      paymentMethod: (order?.payment_method as PaymentMethod | null) ?? null,
      paymentStatus: (order?.payment_status as PaymentStatus | null) ?? null,
      providerRefundId: r.provider_refund_id ?? null,
      settledAt: r.settled_at ?? null,
    };
  });
}

/* ============================================================
   Filling the queue
   ============================================================ */

function notQueued(): { queued: boolean; amount: number } {
  return { queued: false, amount: 0 };
}

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

/**
 * Queue a refund for an order that has already been paid for.
 *
 * Called from the transitions that take an order away from a customer who has
 * paid — they cancel it, or the restaurant declines it. Those paths are
 * server-side and have already established who the actor is, which is why this
 * writes with `createAdminClient()`: the refunds INSERT policy is written for a
 * customer requesting their own refund, and a vendor-declined refund is not
 * that. The authorization for every call therefore sits above it in the same
 * path (route handler ownership check / vendor order-ownership check), per the
 * service-role rule in AGENTS.md.
 *
 * Refunds what is left of the order total (with 0142: the total less refunds
 * already approved or open — an open item refund is topped up), and only when
 * there is money to give back:
 *
 *   - `payment_status = 'paid'` is the only state that qualifies. A COD order
 *     nobody has collected on, an online order abandoned at checkout, and an
 *     order already refunded all return queued:false — there is nothing to
 *     return, and a queue full of ₹0 non-refunds is how an operator learns to
 *     stop reading it.
 *   - a database predating 0025 has no payment columns at all, so it cannot
 *     have recorded a payment: queued:false rather than a thrown error.
 *
 * Idempotent. 0026 adds a unique partial index allowing one pending refund per
 * order; a second call loses the race with a 23505 and reports queued:false,
 * which is the truth — this call queued nothing, because a request is already
 * open. `amount` is what THIS call queued, so it is 0 whenever queued is false.
 */
export async function queueRefundForOrder(
  orderId: string,
  opts: {
    origin: RefundOrigin;
    reason?: string;
    requestedBy?: string | null;
  }
): Promise<{ queued: boolean; amount: number }> {
  const admin = createAdminClient();

  // 0142's rule, in one transaction: paid orders only, the rest of the total
  // (an open item refund is topped up rather than blocking this one, and an
  // approved one is counted), never more than was paid. The code below is the
  // same idea for a database without 0142, where a refund is always the whole order.
  const { data: queued, error: rpcError } = await admin.rpc("queue_order_refund", {
    p_order: orderId,
    p_amount: null,
    p_reason: opts.reason ?? null,
    p_origin: opts.origin,
    p_requested_by: opts.requestedBy ?? null,
  });
  if (!rpcError) {
    const amount = Number((queued as { amount?: number } | null)?.amount ?? 0);
    return amount > 0 ? { queued: true, amount } : notQueued();
  }
  if (!isMissingFunction(rpcError)) throw rpcError;

  const order = await readRefundableOrder(admin, orderId);
  if (!order) return notQueued();
  if (order.paymentStatus !== "paid") return notQueued();
  if (order.total <= 0) return notQueued();

  // Cheap pre-check, and it covers more than the index does. The unique index
  // is the real guard against a duplicate PENDING request, but it only exists
  // from 0026 and says nothing about an already-approved one. Nothing here does
  // partial refunds — a refund is always the whole order — so one decided
  // refund is the end of it.
  const { data: open } = await admin
    .from("refunds")
    .select("id")
    .eq("order_id", orderId)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle();
  if (open) return notQueued();

  const insert = (withProvenance: boolean) =>
    admin.from("refunds").insert({
      order_id: orderId,
      amount: order.total,
      reason: opts.reason ?? null,
      status: "pending",
      ...(withProvenance
        ? { origin: opts.origin, requested_by: opts.requestedBy ?? null }
        : {}),
    });

  let withProvenance = !columnKnownMissing(REFUND_PROVENANCE);
  let { error } = await insert(withProvenance);

  if (error && isMissingColumn(error) && withProvenance) {
    // Pre-0026: the row still belongs in the queue, it just cannot say where it
    // came from. An admin with a refund request and no provenance can still do
    // their job; an admin with no request cannot.
    rememberColumn(REFUND_PROVENANCE, false);
    withProvenance = false;
    ({ error } = await insert(false));
  }

  if (error) {
    // refunds_one_open_per_order (0026) — someone got there first, which is
    // exactly the outcome we wanted, so it is not an error.
    if ((error as { code?: string }).code === "23505") return notQueued();
    throw error;
  }

  if (withProvenance) rememberColumn(REFUND_PROVENANCE, true);
  return { queued: true, amount: order.total };
}

/** An order can only be refunded once it has finished, one way or the other. */
const REQUESTABLE = new Set(["delivered", "cancelled"]);

export interface RefundRequestResult {
  ok: boolean;
  error?:
    | "unauthorized"
    | "not_found"
    | "invalid_state"
    | "already_requested"
    | "server_error";
}

/**
 * The customer asking for their money back.
 *
 * Runs on the caller's own session, so RLS is the boundary and this is the
 * second lock rather than the only one: the order read returns nothing for
 * someone else's order (indistinguishable from one that does not exist), and
 * the "refunds — customer request" policy re-checks ownership and, since 0026,
 * that the amount does not exceed the order total.
 *
 * The amount is `orders.total`, read here from the database. It is never taken
 * from the caller — a refund is the one number a customer has an obvious
 * incentive to choose themselves.
 */
export async function requestRefund(
  orderId: string,
  reason?: string
): Promise<RefundRequestResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, total, status")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return { ok: false, error: "server_error" };
  // Not theirs and does not exist are the same answer on purpose.
  if (!order) return { ok: false, error: "not_found" };

  if (!REQUESTABLE.has(String(order.status))) {
    return { ok: false, error: "invalid_state" };
  }
  if (Number(order.total ?? 0) <= 0) {
    return { ok: false, error: "invalid_state" };
  }

  // Same pre-check as queueRefundForOrder, for the same reasons: the unique
  // index only exists from 0026, refresh-spamming the button must not bury the
  // queue under copies of one claim, and an order that has already had a refund
  // approved has had its refund.
  const { data: open } = await supabase
    .from("refunds")
    .select("id")
    .eq("order_id", orderId)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle();
  if (open) return { ok: false, error: "already_requested" };

  const insert = (withProvenance: boolean) =>
    supabase.from("refunds").insert({
      order_id: orderId,
      amount: order.total,
      reason: reason?.trim().slice(0, 500) || null,
      status: "pending",
      ...(withProvenance
        ? { origin: "customer", requested_by: user.id }
        : {}),
    });

  let withProvenance = !columnKnownMissing(REFUND_PROVENANCE);
  let { error } = await insert(withProvenance);

  if (error && isMissingColumn(error) && withProvenance) {
    rememberColumn(REFUND_PROVENANCE, false);
    withProvenance = false;
    ({ error } = await insert(false));
  }

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return { ok: false, error: "already_requested" };
    // 42501 is the policy refusing the write. We already read the order under
    // the same session, so this should be unreachable — answer it like a
    // missing order rather than confirming the row is there but off-limits.
    if (code === "42501") return { ok: false, error: "not_found" };
    return { ok: false, error: "server_error" };
  }

  if (withProvenance) rememberColumn(REFUND_PROVENANCE, true);
  return { ok: true };
}

/* ============================================================
   Deciding
   ============================================================ */

export type RefundDecisionError =
  | "unauthorized"
  | "not_pending"
  | "amount_exceeds_payment"
  | "gateway_failed"
  | "record_failed";

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
  supabase: Awaited<ReturnType<typeof createClient>>,
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
  | { ok: false; error: RefundDecisionError }
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

  const { data: payment, error: paymentError } = await admin
    .from("payments")
    .select("id, provider_payment_id, amount_paise")
    .eq("order_id", refund.orderId)
    .eq("provider", "razorpay")
    .eq("status", "paid")
    .not("provider_payment_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // No payments table (pre-0025) or no captured row: the order says paid and
  // the ledger cannot say through what. Fall back to a hand settlement rather
  // than guess at a payment id — this is reconciliation work, not a refund we
  // can automate.
  if (paymentError || !payment?.provider_payment_id) {
    return { ok: true, settlement: MANUAL_SETTLEMENT };
  }

  const amountPaise = toPaise(refund.amount);
  if (amountPaise <= 0) {
    return { ok: true, settlement: MANUAL_SETTLEMENT };
  }
  // An order can carry more than one refund (an item, then the rest), so what
  // the gateway can still return is the capture less what it already returned.
  const { data: earlier } = await admin
    .from("refunds")
    .select("amount")
    .eq("order_id", refund.orderId)
    .eq("status", "approved")
    .not("provider_refund_id", "is", null);
  const alreadyPaise = ((earlier ?? []) as { amount: number | null }[]).map((r) => toPaise(Number(r.amount ?? 0)));
  if (amountPaise > gatewayRoomPaise(Number(payment.amount_paise ?? 0), alreadyPaise)) {
    // Refusing rather than clamping: a request for more than was captured means
    // the two records disagree, and quietly refunding the smaller number would
    // hide that while telling the customer they were made whole.
    return { ok: false, error: "amount_exceeds_payment" };
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
    // Includes an unconfigured gateway and a network failure, both of which
    // leave us unable to say the money moved. The refund stays pending and the
    // admin is told, because the retry is theirs to decide: Razorpay offers no
    // idempotency key on refunds, so an automatic retry can pay twice.
    if (!(err instanceof RazorpayError)) {
      console.error("[decideRefund] gateway refund failed", err);
    }
    return { ok: false, error: "gateway_failed" };
  }
}

/**
 * Decide a refund. Records *who* decided it (decided_by), which is the part the
 * old screen claimed to do — "every admin action here is logged" — and didn't.
 *
 * Approving is not just a status change: for an order paid online it calls
 * Razorpay first and only records the approval if the gateway honoured it. A
 * failed gateway call leaves the request pending and returns an error, so the
 * queue never shows a settled refund the customer has not been paid.
 *
 * Returns the order id so the caller can notify the customer — the decision and
 * the message about it belong to different layers.
 */
export async function decideRefund(
  id: string,
  decision: Exclude<RefundStatus, "pending">
): Promise<RefundDecision> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  // RLS ("refunds — read", 0001) scopes this to the order's customer or an
  // admin; the Server Action above has already required the admin role.
  const refund = await readPendingRefund(supabase, id);
  // Missing and already-decided are the same answer: there is no pending
  // refund by this id to act on.
  if (!refund) return { ok: false, error: "not_pending" };

  // guard_refund_total (0142) would refuse this approval after the gateway had
  // already paid it; ask the same question first, so no money moves for a
  // refund that cannot be recorded.
  if (decision === "approved") {
    const approved = await approvedRefundAmounts(refund.orderId);
    const order = await readRefundableOrder(createAdminClient(), refund.orderId);
    if (order && approvalExceedsTotal({ total: order.total, approved, amount: refund.amount })) {
      return { ok: false, error: "amount_exceeds_payment" };
    }
  }

  // Denying moves no money, so it needs no gateway call — only approving does.
  const outcome =
    decision === "approved"
      ? await settleApprovedRefund(refund)
      : ({ ok: true, settlement: MANUAL_SETTLEMENT } as const);

  if (!outcome.ok) return { ok: false, error: outcome.error };
  const { refundId, settledAt, paymentRowId } = outcome.settlement;

  const { data: decided, error } = await supabase
    .from("refunds")
    .update({
      status: decision,
      decided_by: user.id,
      // `readPendingRefund` already established whether these columns exist,
      // which is why there is no fallback retry here: if they were missing, the
      // gateway was never called and refundId is null.
      ...(refund.provenance && refundId
        ? { provider_refund_id: refundId, settled_at: settledAt }
        : {}),
    })
    .eq("id", id)
    // Only a pending refund can be decided — never silently flip a settled one.
    // Returning the row is how we tell "written" from "someone decided it in
    // the last few milliseconds": an UPDATE that matches nothing is not an
    // error, and on the approve path it is the difference between a refund we
    // recorded and one we only paid.
    .eq("status", "pending")
    .select("id");

  // The worst case in this file: Razorpay returned the money and we could not
  // write that down. Say so plainly rather than report a failure the admin
  // would reasonably answer by approving again.
  const missed = error !== null || !decided || decided.length === 0;
  if (missed && refundId) {
    console.error(
      `[decideRefund] refund ${id} settled at Razorpay as ${refundId} but the row could not be updated`,
      error
    );
    return { ok: false, error: "record_failed" };
  }
  if (error) throw error;
  // Lost the race to another admin, and no money moved on this call — their
  // decision stands.
  if (!decided || decided.length === 0) {
    return { ok: false, error: "not_pending" };
  }

  if (paymentRowId) {
    await mirrorRefundOntoLedger(refund.orderId, paymentRowId);
  }

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
            createdBy: user.id,
          });
          if (!correction.ok) {
            settlementWarning = `This order's payout was already settled and paid (settlement #${shortOrderId(ref.id)}). The automatic correction could not be recorded: see the note on that settlement and reconcile this one by hand.`;
          } else if (correction.amount > 0) {
            settlementWarning = `This order's payout was already settled and paid (settlement #${shortOrderId(ref.id)}). ₹${correction.amount} has been recorded as an outstanding correction, recovered from this vendor's next settlement.`;
          } else {
            settlementWarning = `This order's payout was already settled and paid (settlement #${shortOrderId(ref.id)}). No correction was needed: this order's vendor entitlement was unaffected by the refund.`;
          }
        } else {
          settlementWarning = `This order is in an unpaid draft settlement (#${shortOrderId(ref.id)}). Void and rebuild that settlement so it reflects the refund before paying it.`;
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
 * Follow the refund through to the payment records.
 *
 * Runs after the refund row is written, never before: that row is what stops a
 * second gateway call, so it is the one write that must land first. These two
 * are the mirror the rest of the app reads (`orders.payment_status` gates the
 * kitchen board), and a failure here is a reconciliation job rather than a
 * reason to tell the admin their approved-and-settled refund failed.
 *
 * Service role because `payments` accepts writes from nothing else (0025); the
 * admin role check sits above this in the same path.
 */
async function mirrorRefundOntoLedger(
  orderId: string,
  paymentRowId: string
): Promise<void> {
  const admin = createAdminClient();

  // A partial refund (an unavailable item) leaves the order paid: it is only
  // `refunded` once its refunds cover the total. Marking it refunded early
  // would also stop the next refund going back through the gateway.
  const [order, approved] = await Promise.all([
    readRefundableOrder(admin, orderId),
    approvedRefundAmounts(orderId),
  ]);
  if (order && !isFullyRefunded({ total: order.total, approved })) return;

  const { error: paymentError } = await admin
    .from("payments")
    .update({ status: "refunded" })
    .eq("id", paymentRowId);

  const { error: orderError } = await admin
    .from("orders")
    .update({ payment_status: "refunded" })
    .eq("id", orderId);

  if (paymentError || orderError) {
    console.error(
      `[decideRefund] order ${orderId} was refunded but its payment records could not be updated`,
      paymentError ?? orderError
    );
  }
}
