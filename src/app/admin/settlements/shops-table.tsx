"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusText, type Tone } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { markShopsPaidAction } from "@/app/admin/settlements/actions";
import type { VendorSettlementQueueRow } from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";
import { MarkPaidDialog, markPaidOutcome } from "./mark-paid-dialog";

export function waitingWords(r: VendorSettlementQueueRow): string {
  if (r.orderCount === 0) return "—";
  if (r.waitingDays <= 0) return "Today";
  return `${r.waitingDays} day${r.waitingDays === 1 ? "" : "s"}`;
}

/** The one thing to chase on a shop's row, if there is one. */
export function shopFlag(r: VendorSettlementQueueRow): { tone: Tone; text: string } {
  if (r.netPayable > 0 && !r.hasPayoutDetails) {
    return { tone: "red", text: "No bank details" };
  }
  if (r.openDrafts > 0) return { tone: "amber", text: "Payment not finished" };
  if (r.netPayable < 0) return { tone: "red", text: "Owes you" };
  if (r.overdue) return { tone: "red", text: "Late" };
  return { tone: "neutral", text: "Ready" };
}

/**
 * Who is owed what. "Open" shows the orders behind a figure; "Mark as paid" records
 * money already sent by hand, for one shop or for every ticked one. Only a shop that
 * is owed money can be ticked: there is nothing to record for the others.
 */
export function ShopsToPayTable({
  rows,
  footer,
}: Readonly<{
  rows: VendorSettlementQueueRow[];
  footer?: ReactNode;
}>) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState<VendorSettlementQueueRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const payable = rows.filter((r) => r.netPayable > 0);
  // Only rows still on screen: a shop paid a moment ago drops out of the choice.
  const chosen = payable.filter((r) => selected.has(r.restaurantId));
  const allChosen = payable.length > 0 && chosen.length === payable.length;
  const chosenTotal = chosen.reduce((sum, r) => sum + r.netPayable, 0);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: Column<VendorSettlementQueueRow>[] = [
    {
      key: "select",
      header: "",
      width: "w-[40px]",
      cell: (r) =>
        r.netPayable > 0 ? (
          <input
            type="checkbox"
            checked={selected.has(r.restaurantId)}
            onChange={() => toggle(r.restaurantId)}
            aria-label={`Select ${r.restaurantName}`}
            className="size-4 accent-[var(--accent)]"
          />
        ) : null,
    },
    {
      key: "shop",
      header: "Shop",
      cell: (r) => (
        <span className="text-[13px] font-semibold text-ink">{r.restaurantName}</span>
      ),
    },
    {
      key: "orders",
      header: "Orders",
      width: "w-[90px]",
      cell: (r) => (
        <span className="text-data text-[12.5px] tabular-nums text-muted">{r.orderCount}</span>
      ),
    },
    {
      key: "waiting",
      header: "Waiting",
      width: "w-[100px]",
      cell: (r) => (
        <span className="text-data text-[12.5px] tabular-nums text-muted">{waitingWords(r)}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[170px]",
      cell: (r) => {
        const flag = shopFlag(r);
        return <StatusText tone={flag.tone}>{flag.text}</StatusText>;
      },
    },
    {
      key: "amount",
      header: "Send",
      align: "right",
      width: "w-[120px]",
      cell: (r) => (
        <span
          className={`text-data text-[14px] font-bold tabular-nums ${
            r.netPayable < 0 ? "text-deal" : "text-ink"
          }`}
        >
          {formatINR(Math.abs(r.netPayable))}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[210px]",
      cell: (r) => (
        <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
          <Link
            href={`/admin/settlements/orders?vendor=${r.restaurantId}&state=unpaid`}
            className="c-btn-quiet"
          >
            Open
          </Link>
          {r.netPayable > 0 ? (
            <button type="button" onClick={() => setMarking([r])} className="c-btn-affirm">
              Mark as paid
            </button>
          ) : null}
        </span>
      ),
    },
  ];

  const total = marking?.reduce((sum, r) => sum + r.netPayable, 0) ?? 0;

  return (
    <div className="space-y-2">
      {payable.length > 0 ? (
        <div className="flex min-h-9 flex-wrap items-center gap-3 text-[12.5px]">
          <label className="inline-flex items-center gap-2 font-medium text-muted">
            <input
              type="checkbox"
              checked={allChosen}
              onChange={() =>
                setSelected(allChosen ? new Set() : new Set(payable.map((r) => r.restaurantId)))
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

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.restaurantId}
        caption="Shops to pay"
        rowTone={(r) =>
          r.overdue || (r.netPayable > 0 && !r.hasPayoutDetails) ? "alert" : null
        }
        footer={footer}
      />

      {marking ? (
        <MarkPaidDialog
          key={marking.map((r) => r.restaurantId).join()}
          title="Mark as paid"
          summary={
            marking.length === 1
              ? `${marking[0].restaurantName}: ${formatINR(total)} for ${marking[0].orderCount} order${marking[0].orderCount === 1 ? "" : "s"}. Mark this only after the money has been sent.`
              : `${marking.length} shops, ${formatINR(total)} in all, with the same reference. Mark these only after the money has been sent.`
          }
          onClose={() => setMarking(null)}
          onSubmit={async (paymentRef, note) => {
            const res = await markShopsPaidAction(
              marking.map((r) => r.restaurantId),
              paymentRef,
              note
            );
            if (!res.ok) return res.error;
            const outcome = markPaidOutcome(
              res,
              "shop",
              (id) => marking.find((r) => r.restaurantId === id)?.restaurantName ?? "A shop"
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
