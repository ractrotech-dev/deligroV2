"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatINR } from "@/lib/utils/format";
import {
  PayoutOrderRow,
  type PayoutRowStatus,
} from "@/components/admin/payout-breakdown";
import { setOrderPaidAction } from "@/app/admin/settlements/actions";
import type { OrderPayoutRow } from "@/lib/data-access/admin-settlements";

function statusOf(row: OrderPayoutRow): PayoutRowStatus {
  if (!row.paid) return "unpaid";
  return row.settlementStatus === "draft" ? "waiting" : "paid";
}

/**
 * One delivered order. The row itself shows only the amount and its status;
 * paying this order alone, or undoing a payment, lives inside it, because the
 * usual job is the one big Pay button at the top of the page.
 *
 * Paying is never done by one person (0156): this asks for approval. Undoing a
 * paid order asks for a reversal someone else approves. A refusal from the server
 * is shown as it is, so the operator learns why.
 */
export function OrderPayoutRowCard({
  row,
  commissionPct,
  commissionGstPct,
}: Readonly<{
  row: OrderPayoutRow;
  commissionPct: number;
  commissionGstPct: number;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const status = statusOf(row);

  const payThisOrder = () => {
    if (
      !window.confirm(
        `Pay ${formatINR(row.contribution)} for order ${row.code} on its own?\n\nAnother admin, or a manager who can approve payments, approves it.`
      )
    ) {
      return;
    }
    setMessage(null);
    start(async () => {
      const res = await setOrderPaidAction(row.orderId, true);
      if (!res.ok) setMessage(res.error);
      router.refresh();
    });
  };

  const undo = () => {
    const reason = window.prompt(
      `Mark order ${row.code} as unpaid?\n\nIf the money was already sent, someone else approves this first. Why are you undoing it?`,
      ""
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      setMessage("Say why this order should be unpaid.");
      return;
    }
    setMessage(null);
    start(async () => {
      const res = await setOrderPaidAction(row.orderId, false, reason.trim());
      if (!res.ok) setMessage(res.error);
      else if (res.reversalRequested) {
        setMessage("Sent for approval. The order stays paid until someone else approves.");
      }
      router.refresh();
    });
  };

  return (
    <PayoutOrderRow
      line={row}
      status={status}
      commissionPct={commissionPct}
      commissionGstPct={commissionGstPct}
    >
      {message ? (
        <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px] font-medium text-ink">
          {message}
        </p>
      ) : null}

      {row.paid && row.paymentRef ? (
        <p className="text-[12.5px] text-muted">Payment reference {row.paymentRef}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {status === "unpaid" && row.contribution > 0 ? (
          <button
            type="button"
            onClick={payThisOrder}
            disabled={pending}
            className="c-btn c-btn-outline press min-h-10 disabled:opacity-50"
          >
            Pay only this order
          </button>
        ) : null}
        {row.settlementId ? (
          <Link
            href={`/admin/settlements/${row.settlementId}`}
            className="c-btn c-btn-outline press min-h-10"
          >
            See the payment
          </Link>
        ) : null}
        {row.paid ? (
          <button
            type="button"
            onClick={undo}
            disabled={pending}
            className="c-btn c-btn-quiet press min-h-10 disabled:opacity-50"
          >
            Undo
          </button>
        ) : null}
      </div>
    </PayoutOrderRow>
  );
}
