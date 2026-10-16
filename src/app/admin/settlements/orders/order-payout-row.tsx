"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import { formatINR } from "@/lib/utils/format";
import {
  OrderPayoutBreakdown,
  payWord,
} from "@/components/admin/payout-breakdown";
import { setOrderPaidAction } from "@/app/admin/settlements/actions";
import type { OrderPayoutRow } from "@/lib/data-access/admin-settlements";

/**
 * One delivered order, with the Paid / Unpaid control and its full breakdown.
 *
 * The dropdown is a real `<select>` rather than a switch: "Paid" and "Unpaid"
 * are the two words the operator is thinking in, and a switch would have to be
 * labelled with one of them anyway while hiding the other.
 *
 * Marking Paid is not undoable in one click when the order sits inside a batch —
 * the server refuses and says to void the batch instead. That refusal is
 * surfaced here rather than silently reverting the control, so the operator
 * learns why rather than watching a dropdown snap back.
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
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: string) => {
    const paid = next === "paid";
    if (paid === row.paid) return;
    setError(null);

    if (paid) {
      const ref = window.prompt(
        `Pay ${formatINR(Math.abs(row.contribution))} for order ${row.code} now?\n\nEnter the UPI / bank reference if you have one — you can leave it blank and add it later.`,
        ""
      );
      // Cancel returns null; an empty string is a deliberate "no reference yet".
      if (ref === null) return;
      start(async () => {
        const res = await setOrderPaidAction(row.orderId, true, ref.trim());
        if (!res.ok) setError(res.error);
        router.refresh();
      });
      return;
    }

    if (
      !window.confirm(
        `Mark order ${row.code} as unpaid?\n\nIt will go back into this shop's next settlement.`
      )
    ) {
      return;
    }
    start(async () => {
      const res = await setOrderPaidAction(row.orderId, false);
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  };

  const amount = Math.abs(row.contribution);
  const shopIsOwed = row.contribution >= 0;
  const youEarn = row.commission + row.commissionGst + row.otherCharges;

  return (
    <li className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="press flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={open}
        >
          <span className="min-w-0 flex-1">
            <span className="text-data block truncate text-[13px] font-semibold text-ink">
              {row.code}
            </span>
            <span className="block truncate text-[11.5px] text-muted">
              {new Date(row.deliveredAt).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                timeZone: "Asia/Kolkata",
              })}{" "}
              · {payWord(row)} · customer paid {formatINR(row.orderTotal)} · you
              earn {formatINR(youEarn)}
            </span>
          </span>
          {open ? (
            <ChevronUp className="size-4 shrink-0 text-muted" />
          ) : (
            <ChevronDown className="size-4 shrink-0 text-muted" />
          )}
        </button>

        <div className="text-right">
          <p
            className={`text-data text-[14px] font-bold tabular-nums ${
              shopIsOwed ? "text-ink" : "text-deal"
            }`}
          >
            {shopIsOwed ? "" : "− "}
            {formatINR(amount)}
          </p>
          <p className="text-[10.5px] text-muted">
            {shopIsOwed ? "shop gets" : "platform collects"}
          </p>
        </div>

        <select
          value={row.paid ? "paid" : "unpaid"}
          disabled={pending}
          onChange={(e) => change(e.target.value)}
          aria-label={`Payout status for order ${row.code}`}
          className={
            "h-9 shrink-0 rounded-xl border px-2.5 text-[12.5px] font-semibold " +
            (row.paid
              ? "border-green/40 bg-green/10 text-green"
              : "border-line bg-surface-2 text-muted")
          }
        >
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      {error ? (
        <p className="mx-3 mb-3 rounded-lg border border-deal/30 bg-deal/10 px-3 py-2 text-[12.5px] font-medium text-deal">
          {error}
        </p>
      ) : null}

      {row.paid && row.settlementId ? (
        <p className="border-t border-line px-3 py-2 text-[11.5px] text-muted">
          {row.settlementKind === "instant"
            ? "Paid early, on its own."
            : "Paid as part of a settlement batch."}{" "}
          {row.paymentRef ? `Ref ${row.paymentRef}. ` : ""}
          <Link
            href={`/admin/settlements/${row.settlementId}`}
            className="font-medium text-accent-ink"
          >
            View statement
          </Link>
        </p>
      ) : null}

      {open ? (
        <div className="border-t border-line p-3">
          <OrderPayoutBreakdown
            line={row}
            commissionPct={commissionPct}
            commissionGstPct={commissionGstPct}
          />
        </div>
      ) : null}
    </li>
  );
}
