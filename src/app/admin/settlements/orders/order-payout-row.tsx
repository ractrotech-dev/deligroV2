"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusText, type Tone } from "@/components/admin/console";
import type { Column } from "@/components/admin/data-table";
import { PayoutLinesTable } from "@/components/admin/payout-breakdown";
import { setOrderPaidAction } from "@/app/admin/settlements/actions";
import type { OrderPayoutRow } from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";

function statusOf(row: OrderPayoutRow): { tone: Tone; word: string } {
  if (!row.paid) return { tone: "neutral", word: "Unpaid" };
  if (row.settlementStatus === "draft") return { tone: "amber", word: "Waiting" };
  return { tone: "green", word: "Paid" };
}

/**
 * Paying one order alone, or undoing it. The usual job is the Pay button at the
 * top of the page, so these stay quiet.
 *
 * Paying one order makes it its own payment and opens it, where it is finished
 * with the reference. Only an order that is its own payment can be undone from
 * here: one in a payment with other orders can't come out alone, because that
 * payment's total would no longer add up. So that row offers no Undo at all, and
 * points to the payment's own Cancel or reversal. A refusal from the server is
 * shown as it is, so the operator learns why.
 */
function canUndoHere(row: OrderPayoutRow): boolean {
  return row.paid && row.settlementKind === "instant";
}

function OrderRowActions({ row }: Readonly<{ row: OrderPayoutRow }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const payThisOrder = () => {
    if (
      !window.confirm(
        `Pay ${formatINR(row.contribution)} for order ${row.code} on its own?\n\nIt becomes its own payment, and you finish it on the next page.`
      )
    ) {
      return;
    }
    setMessage(null);
    start(async () => {
      const res = await setOrderPaidAction(row.orderId, true);
      if (!res.ok) {
        setMessage(res.error);
        router.refresh();
        return;
      }
      if (res.id) router.push(`/admin/settlements/${res.id}`);
      else router.refresh();
    });
  };

  const undo = () => {
    const reason = window.prompt(
      row.settlementStatus === "draft"
        ? `Cancel the payment for order ${row.code}? The order goes back to unpaid.\n\nWhy are you cancelling it?`
        : `Reverse the payment for order ${row.code}?\n\nIt stays paid until the reversal is approved on the payment's page. Why are you reversing it?`,
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
        setMessage("Reversal asked for. It stays paid until it is approved on the payment's page.");
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
        {!row.paid && row.contribution > 0 ? (
          <button
            type="button"
            onClick={payThisOrder}
            disabled={pending}
            className="c-btn-affirm disabled:opacity-50"
          >
            Pay this order
          </button>
        ) : null}
        {row.settlementId ? (
          <Link
            href={`/admin/settlements/${row.settlementId}`}
            className="c-btn-affirm"
          >
            See payment
          </Link>
        ) : null}
        {canUndoHere(row) ? (
          <button
            type="button"
            onClick={undo}
            disabled={pending}
            className="c-btn-quiet disabled:opacity-50"
          >
            Undo
          </button>
        ) : null}
      </div>
      {row.paid && !canUndoHere(row) ? (
        <p className="max-w-[240px] text-right text-[11.5px] text-muted">
          To undo, open the payment. It holds other orders too.
        </p>
      ) : null}
      {message ? (
        <p className="max-w-[240px] text-right text-[11.5px] font-medium text-deal">
          {message}
        </p>
      ) : null}
    </div>
  );
}

const EXTRA_COLUMNS: Column<OrderPayoutRow>[] = [
  {
    key: "status",
    header: "Status",
    cell: (row) => {
      const { tone, word } = statusOf(row);
      return <StatusText tone={tone}>{word}</StatusText>;
    },
  },
  {
    key: "actions",
    header: "",
    align: "right",
    cell: (row) => <OrderRowActions row={row} />,
  },
];

/** One shop's delivered orders, each with its sum, status and actions. */
export function OrderPayoutsTable({
  rows,
  commissionPct,
  commissionGstPct,
  empty,
}: Readonly<{
  rows: OrderPayoutRow[];
  commissionPct: number;
  commissionGstPct: number;
  empty: ReactNode;
}>) {
  return (
    <PayoutLinesTable
      lines={rows}
      commissionPct={commissionPct}
      commissionGstPct={commissionGstPct}
      extraColumns={EXTRA_COLUMNS}
      empty={empty}
    />
  );
}
