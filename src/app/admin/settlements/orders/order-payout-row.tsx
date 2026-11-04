"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusText, type Tone } from "@/components/admin/console";
import type { Column } from "@/components/admin/data-table";
import { PayoutLinesTable } from "@/components/admin/payout-breakdown";
import { markOrdersPaidAction, setOrderPaidAction } from "@/app/admin/settlements/actions";
import type { OrderPayoutRow } from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";
import { MarkPaidDialog, markPaidOutcome } from "../mark-paid-dialog";

function statusOf(row: OrderPayoutRow): { tone: Tone; word: string } {
  if (!row.paid) return { tone: "neutral", word: "Unpaid" };
  if (row.settlementStatus === "draft") return { tone: "amber", word: "Waiting" };
  return { tone: "green", word: "Paid" };
}

/**
 * Marking one order paid or unpaid.
 *
 * A marked order becomes its own payment. Only an order that is its own payment can
 * be undone from here: one in a payment with other orders can't come out alone,
 * because that payment's total would no longer add up. So that row offers no undo
 * at all, and points to the payment's own Cancel or reversal. A refusal from the
 * server is shown as it is, so the operator learns why.
 */
function canUndoHere(row: OrderPayoutRow): boolean {
  return row.paid && row.settlementKind === "instant";
}

function isSelectable(row: OrderPayoutRow): boolean {
  return !row.paid && row.contribution > 0;
}

function OrderRowActions({
  row,
  onMark,
}: Readonly<{ row: OrderPayoutRow; onMark: (rows: OrderPayoutRow[]) => void }>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

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
        {isSelectable(row) ? (
          <button type="button" onClick={() => onMark([row])} className="c-btn-affirm">
            Mark as paid
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
            Mark as unpaid
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

/** One shop's delivered orders, each with its sum, status and actions; tick several to mark them together. */
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
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState<OrderPayoutRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const selectable = rows.filter(isSelectable);
  const chosen = selectable.filter((r) => selected.has(r.orderId));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const chosenTotal = chosen.reduce((sum, r) => sum + r.contribution, 0);
  const total = marking?.reduce((sum, r) => sum + r.contribution, 0) ?? 0;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const leadColumns: Column<OrderPayoutRow>[] = [
    {
      key: "select",
      header: "",
      width: "w-[40px]",
      cell: (row) =>
        isSelectable(row) ? (
          <input
            type="checkbox"
            checked={selected.has(row.orderId)}
            onChange={() => toggle(row.orderId)}
            aria-label={`Select order ${row.code}`}
            className="size-4 accent-[var(--accent)]"
          />
        ) : null,
    },
  ];
  const extraColumns: Column<OrderPayoutRow>[] = [
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
      cell: (row) => <OrderRowActions row={row} onMark={setMarking} />,
    },
  ];

  return (
    <div className="space-y-2">
      {selectable.length > 0 ? (
        <div className="flex min-h-9 flex-wrap items-center gap-3 text-[12.5px]">
          <label className="inline-flex items-center gap-2 font-medium text-muted">
            <input
              type="checkbox"
              checked={allChosen}
              onChange={() =>
                setSelected(allChosen ? new Set() : new Set(selectable.map((r) => r.orderId)))
              }
              className="size-4 accent-[var(--accent)]"
            />
            Select all
          </label>
          {chosen.length > 0 ? (
            <>
              <span className="text-ink">
                {chosen.length} selected,{" "}
                <span className="text-data font-semibold tabular-nums">{formatINR(chosenTotal)}</span>
              </span>
              <button type="button" onClick={() => setMarking(chosen)} className="c-btn c-btn-dark">
                Mark selected as paid
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {notice ? <p className="text-[12.5px] font-medium text-green">{notice}</p> : null}
      {problem ? <p className="text-[12.5px] font-medium text-deal">{problem}</p> : null}

      <PayoutLinesTable
        lines={rows}
        commissionPct={commissionPct}
        commissionGstPct={commissionGstPct}
        leadColumns={leadColumns}
        extraColumns={extraColumns}
        empty={empty}
      />

      {marking ? (
        <MarkPaidDialog
          key={marking.map((r) => r.orderId).join()}
          title="Mark as paid"
          summary={
            marking.length === 1
              ? `Order ${marking[0].code}: ${formatINR(total)}. Mark this only after the money has been sent.`
              : `${marking.length} orders, ${formatINR(total)} in all, with the same reference. Each becomes its own payment. Mark these only after the money has been sent.`
          }
          onClose={() => setMarking(null)}
          onSubmit={async (paymentRef, note) => {
            const res = await markOrdersPaidAction(
              marking.map((r) => r.orderId),
              paymentRef,
              note
            );
            if (!res.ok) return res.error;
            const outcome = markPaidOutcome(
              res,
              "order",
              (id) => marking.find((r) => r.orderId === id)?.code ?? "An order"
            );
            setNotice(outcome.notice);
            setProblem(outcome.problem);
            setSelected(new Set());
            setMarking(null);
            router.refresh();
            return null;
          }}
        />
      ) : null}
    </div>
  );
}
