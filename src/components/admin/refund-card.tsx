"use client";

import { useState, useTransition } from "react";
import { Check, X, LoaderCircle, Banknote, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/roles/role-ui";
import { formatINR } from "@/lib/utils/format";
import { decideRefundAction, releaseRefundClaimAction } from "@/app/admin/actions";
import type { RefundRow } from "@/lib/data-access/refunds";
import { shortOrderId } from "@/lib/utils/order-map";

/**
 * One refund. Approve/Deny hit the database — see app/admin/actions.ts.
 *
 * The card says what it is asking the admin to decide, because approving is no
 * longer only a status change: on an order paid online it moves real money
 * through Razorpay, and on a cash order it moves none at all and leaves a human
 * to hand it back. Those are different jobs and the button used to look
 * identical for both.
 */

const ORIGIN_LABELS: Record<RefundRow["origin"], string> = {
  customer: "Customer asked",
  vendor_rejected: "Restaurant declined the order",
  admin: "Raised by an admin",
  manager: "Raised by a manager",
  system: "Raised automatically",
};

// Deliberately four cases, not two. "Cash order" on a row where we simply
// don't know how it was paid is a guess about money, and this screen exists
// because someone acted on one of those.
function paymentLabelFor(r: RefundRow, paidOnline: boolean): string {
  if (paidOnline) return "Paid online";
  if (r.paymentMethod === "online") return "Online · unpaid";
  if (r.paymentMethod === "cod") return "Cash order";
  return "Payment method not recorded";
}

function decisionNote(r: RefundRow, paidOnline: boolean): string {
  if (r.status === "pending") {
    return paidOnline
      ? `Approving returns ${formatINR(r.amount)} to the customer through Razorpay.`
      : "No online payment to reverse — approving records the decision, the money still goes back by hand.";
  }
  if (r.status === "denied") return "Denied. Nothing was returned.";
  if (r.settledAt) {
    const refundIdSuffix = r.providerRefundId ? ` · ${r.providerRefundId}` : "";
    return `Refunded through Razorpay${refundIdSuffix}.`;
  }
  if (r.providerRefundId) {
    return `Sent to Razorpay and not settled yet · ${r.providerRefundId}.`;
  }
  return "Approved. Settle this one off-platform — nothing was sent to a gateway.";
}

/** Which order, whose, why — and how much of it is coming back. */
function RefundSummary({
  refund: r,
  partial,
}: Readonly<{ refund: RefundRow; partial: boolean }>) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-data font-semibold">
          {shortOrderId(r.orderId)}
          {r.customerName ? (
            <span className="text-sm font-normal text-muted">
              {" "}
              · {r.customerName}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted">
          {r.reason ?? "No reason given"}
          {r.restaurantName ? ` · ${r.restaurantName}` : ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <span className="text-data font-semibold">{formatINR(r.amount)}</span>
        {/* Only shown when the two differ — repeating the same number twice
            teaches an admin to stop reading it. */}
        {partial ? (
          <p className="text-xs text-muted">
            of {formatINR(r.orderTotal as number)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** How the order was paid, which decides what Approve actually does. */
function PaymentChip({
  paidOnline,
  label,
}: Readonly<{ paidOnline: boolean; label: string }>) {
  return (
    <span
      className={
        paidOnline
          ? "inline-flex items-center gap-1 rounded-full bg-green/15 px-2 py-0.5 text-green"
          : "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-muted"
      }
    >
      {paidOnline ? (
        <CreditCard className="size-3" />
      ) : (
        <Banknote className="size-3" />
      )}
      {label}
    </span>
  );
}

export function RefundCard({ refund: r }: Readonly<{ refund: RefundRow }>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // Every refund decision is audited with its reason (0156).
  const [reason, setReason] = useState("");
  // A refund whose Razorpay outcome was never heard stays claimed until an
  // admin has checked the dashboard; the reason box says what they checked.
  const [stuck, setStuck] = useState(false);

  const decide = (decision: "approved" | "denied") =>
    startTransition(async () => {
      setError(null);
      setWarning(null);
      if (reason.trim().length < 3) {
        setError("Write a short reason first.");
        return;
      }
      const result = await decideRefundAction(r.id, decision, reason.trim());
      if (!result.ok) {
        setError(result.error ?? "Failed");
        setStuck(result.code === "in_progress" || result.code === "gateway_unknown");
      } else if (result.warning) setWarning(result.warning);
    });

  const release = () =>
    startTransition(async () => {
      setError(null);
      if (reason.trim().length < 3) {
        setError("Write what you checked in Razorpay first.");
        return;
      }
      const result = await releaseRefundClaimAction(r.id, reason.trim());
      if (!result.ok) setError(result.error ?? "Failed");
      else {
        setStuck(false);
        setWarning("Released. You can decide this refund again.");
      }
    });

  // Only a captured online payment can come back through the gateway. Anything
  // else — cash, an unpaid online order, a database that predates 0025 and
  // cannot say — is settled off-platform by hand.
  const paidOnline = r.paymentMethod === "online" && r.paymentStatus === "paid";
  const partial = r.orderTotal !== null && r.amount !== r.orderTotal;

  const paymentLabel = paymentLabelFor(r, paidOnline);

  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <RefundSummary refund={r} partial={partial} />

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">
          {ORIGIN_LABELS[r.origin] ?? ORIGIN_LABELS.customer}
        </span>
        <PaymentChip paidOnline={paidOnline} label={paymentLabel} />
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted">
        {decisionNote(r, paidOnline)}
      </p>

      {warning ? (
        <p className="mt-2 rounded-lg bg-deal-soft px-2.5 py-2 text-xs leading-relaxed font-medium text-deal">
          {warning}
        </p>
      ) : null}

      {r.status === "pending" ? (
        <label className="mt-3 block text-xs font-semibold text-muted">
          Reason for the decision{" "}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            placeholder="e.g. Item missing, confirmed with the shop"
            className="mt-1 block w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm font-normal text-ink"
          />
        </label>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        {error ? (
          <span className="text-xs font-semibold text-deal">{error}</span>
        ) : (
          <span className="text-xs text-muted">
            {r.status === "pending"
              ? "Awaiting a decision"
              : "Decision recorded"}
          </span>
        )}

        {r.status !== "pending" ? (
          <Pill tone={r.status === "approved" ? "green" : "muted"}>
            {r.status === "approved" ? "Approved" : "Denied"}
          </Pill>
        ) : (
          <div className="flex gap-2">
            {stuck ? (
              <Button variant="outline" size="sm" disabled={pending} onClick={release}>
                Nothing was sent — release
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => decide("denied")}
            >
              <X className="size-4" /> Deny
            </Button>
            <Button size="sm" disabled={pending} onClick={() => decide("approved")}>
              {pending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Approve
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
