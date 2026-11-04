"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Empty, Panel, StatusText } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { markShopsPaidAction, voidSettlementAction } from "@/app/admin/settlements/actions";
import { MarkPaidDialog, markPaidOutcome } from "@/app/admin/settlements/mark-paid-dialog";
import { PaymentRowActions } from "@/app/admin/settlements/payment-row-actions";
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_TONE } from "@/app/admin/settlements/payment-status";
import { shopFlag, waitingWords } from "@/app/admin/settlements/shops-table";
import type { SettlementListItem, VendorSettlementQueueRow } from "@/lib/data-access/admin-settlements";
import { formatINR } from "@/lib/utils/format";

/** An unfinished payment, with what it would come to if worked out today. */
export interface OpenDraft {
  id: string;
  stored: number;
  fresh: number;
  stale: boolean;
}

const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function signedINR(n: number): string {
  return `${n < 0 ? "−" : ""}${formatINR(Math.abs(n))}`;
}

const HISTORY_COLUMNS: Column<SettlementListItem>[] = [
  {
    key: "dates",
    header: "Dates",
    cell: (r) => <span className="text-data text-[12.5px] text-muted">{r.periodLabel}</span>,
  },
  {
    key: "orders",
    header: "Orders",
    width: "w-[80px]",
    cell: (r) => <span className="text-data text-[12.5px] tabular-nums text-muted">{r.orderCount}</span>,
  },
  {
    key: "status",
    header: "Status",
    width: "w-[130px]",
    cell: (r) => <StatusText tone={PAYMENT_STATUS_TONE[r.status]}>{PAYMENT_STATUS_LABEL[r.status]}</StatusText>,
  },
  {
    key: "paid",
    header: "Paid on",
    width: "w-[120px]",
    cell: (r) => (
      <span className="text-data text-[12.5px] text-muted">{r.paidAt ? dayFmt.format(new Date(r.paidAt)) : "—"}</span>
    ),
  },
  {
    key: "reference",
    header: "Reference",
    cell: (r) => <span className="text-data text-[12.5px] text-muted">{r.paymentRef ?? "—"}</span>,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    width: "w-[110px]",
    cell: (r) => (
      <span className={`text-data text-[13px] font-semibold tabular-nums ${r.netPayable < 0 ? "text-deal" : "text-ink"}`}>
        {signedINR(r.netPayable)}
      </span>
    ),
  },
  {
    key: "actions",
    header: "",
    align: "right",
    width: "w-[210px]",
    cell: (r) => <PaymentRowActions id={r.id} status={r.status} netPayable={r.netPayable} />,
  },
];

/**
 * What this shop is owed right now, and the button that settles it. Money moves by
 * bank, UPI or cash outside the app: this records that it was sent, on the same
 * audited path as the Settlements screen, including its approval rule.
 */
export function SettleNow({
  shopName,
  row,
  drafts,
  partial,
}: Readonly<{
  shopName: string;
  row: VendorSettlementQueueRow | null;
  drafts: OpenDraft[];
  /** The queue hit its scan cap, so the figure may be low. */
  partial: boolean;
}>) {
  const router = useRouter();
  const [marking, setMarking] = useState(false);
  const [updating, setUpdating] = useState<OpenDraft | null>(null);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const net = row?.netPayable ?? 0;
  const orders = row?.orderCount ?? 0;
  const restaurantId = row?.restaurantId ?? "";
  const flag = row && orders > 0 ? shopFlag(row) : null;

  const updateDraft = () =>
    start(async () => {
      if (!updating) return;
      setProblem(null);
      const res = await voidSettlementAction(
        updating.id,
        "Out of date: worked out under an old rule. Cancelled so the orders can be settled at the current amount."
      );
      setUpdating(null);
      if (!res.ok) {
        setProblem(res.error);
        return;
      }
      setNotice(`Updated. ${shopName} can now be settled at the correct amount.`);
      router.refresh();
    });

  return (
    <Panel>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-muted">To settle</p>
          <p className={`text-data mt-1 text-[28px] font-bold leading-none tracking-[-0.02em] ${net < 0 ? "text-deal" : "text-ink"}`}>
            {signedINR(net)}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
            {orders > 0 && row ? (
              <span>
                {orders} order{orders === 1 ? "" : "s"}, waiting {waitingWords(row).toLowerCase()}
              </span>
            ) : (
              <span>No delivered orders waiting to be settled</span>
            )}
            {flag ? <StatusText tone={flag.tone}>{flag.text}</StatusText> : null}
            {row?.lastPaidAt ? <span>Last paid {dayFmt.format(new Date(row.lastPaidAt))}</span> : null}
            {partial ? <span>This may be low: not every order could be read.</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {orders > 0 ? (
            <Link href={`/admin/settlements/orders?vendor=${restaurantId}&state=unpaid`} className="c-btn c-btn-outline">
              See orders
            </Link>
          ) : null}
          <button
            type="button"
            disabled={net <= 0}
            onClick={() => {
              setNotice(null);
              setProblem(null);
              setMarking(true);
            }}
            className="c-btn c-btn-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            Make settlement
          </button>
        </div>
      </div>

      {drafts.map((d) => (
        <div
          key={d.id}
          className="mt-3 flex items-center justify-between gap-4 border-t border-[color:var(--c-divider)] pt-3 text-[13px]"
        >
          {d.stale ? (
            <p className="min-w-0 text-ink">
              <span className="font-semibold">An unfinished payment is out of date.</span>{" "}
              <span className="text-muted">
                It shows <span className="text-data">{signedINR(d.stored)}</span>, and the correct amount is now{" "}
                <span className="text-data font-semibold text-ink">{signedINR(d.fresh)}</span>. Its orders can&apos;t be settled until it is updated.
              </span>
            </p>
          ) : (
            <p className="min-w-0 text-ink">
              <span className="font-semibold">A payment of <span className="text-data">{signedINR(d.stored)}</span> is not finished.</span>
            </p>
          )}
          {d.stale ? (
            <button type="button" onClick={() => setUpdating(d)} disabled={pending} className="c-btn c-btn-outline shrink-0 disabled:opacity-50">
              Update amount
            </button>
          ) : (
            <Link href={`/admin/settlements/${d.id}`} className="c-btn c-btn-outline shrink-0">
              Open payment
            </Link>
          )}
        </div>
      ))}

      {notice ? <p className="mt-2 text-[12.5px] font-medium text-green">{notice}</p> : null}
      {problem ? <p role="alert" className="mt-2 text-[12.5px] font-medium text-deal">{problem}</p> : null}

      {marking && row ? (
        <MarkPaidDialog
          title="Make settlement"
          summary={`${shopName}: ${formatINR(net)} for ${orders} order${orders === 1 ? "" : "s"}. Do this only after the money has been sent.`}
          onClose={() => setMarking(false)}
          onSubmit={async (paymentRef, note) => {
            const res = await markShopsPaidAction([row.restaurantId], paymentRef, note);
            if (!res.ok) return res.error;
            const outcome = markPaidOutcome(res, "payment", () => shopName);
            if (outcome.problem) return outcome.problem;
            setNotice(outcome.notice);
            setMarking(false);
            router.refresh();
            return null;
          }}
        />
      ) : null}

      <ConfirmDialog
        open={updating !== null}
        title="Update this payment's amount?"
        message={
          updating
            ? `This cancels the unfinished ${signedINR(updating.stored)} payment, which is kept in the history. No money moves. Its orders go back to waiting, at the correct ${signedINR(updating.fresh)}, and you can then make the settlement.`
            : null
        }
        confirmLabel="Update amount"
        busy={pending}
        onConfirm={updateDraft}
        onClose={() => setUpdating(null)}
      />
    </Panel>
  );
}

/** Every payment to this shop, newest first. */
export function PaymentHistory({ rows, limit }: Readonly<{ rows: SettlementListItem[]; limit: number }>) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold text-ink">Payment history</h2>
        {rows.length >= limit ? (
          <span className="text-[12px] text-muted">
            Latest {limit}.{" "}
            <Link href="/admin/settlements" className="font-semibold text-accent-ink hover:underline">
              All payments
            </Link>
          </span>
        ) : null}
      </div>
      <DataTable
        dense
        caption="Payment history"
        columns={HISTORY_COLUMNS}
        rows={rows}
        rowKey={(r) => r.id}
        empty={<Empty>No payments to this shop yet.</Empty>}
      />
    </div>
  );
}
