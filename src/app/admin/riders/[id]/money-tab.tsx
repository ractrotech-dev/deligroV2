import Link from "next/link";
import { Section, MetricRow, StatusText, Empty, type MetricItem } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { fieldCls } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import type { RiderMoney } from "@/lib/data-access/admin-riders";
import { PAYOUT_METHOD_LABELS, RECORD_KIND_LABEL, deliveryDetail, formatDay, formatMoney, type PayoutMethod } from "@/lib/rider/admin-money";
import type { EarningRecord } from "@/lib/rider/earnings-math";
import { AdjustmentForm, PayoutForm } from "./money-forms";

/**
 * The rider's Salary tab: what they are to be paid, the two steps that get them
 * paid (add salary, then pay), and the history.
 *
 * Riders are on a fixed salary (rule book). Old bonus and incentive rows stay
 * on the ledger below, shown as "Older pay". Salary, deductions and
 * payments are the ledger, and the ₹0 per-delivery rows the dormant rate card
 * writes are left out of the history table and the payment preview.
 *
 * Read-only apart from the two forms. The ledger is append-only (0083), so no
 * record has an edit control - a mistake is corrected with another entry - and
 * the automatic reversals the database writes when a delivery is corrected are
 * marked as such and are simply rows like the rest.
 */

const isReversal = (r: EarningRecord) => r.kind === "adjustment" && r.reversesId !== null;

function detailOf(r: EarningRecord): string {
  if (r.kind === "delivery") return deliveryDetail(r);
  if (isReversal(r)) return "The delivery was corrected, so its pay is taken back.";
  if (r.kind === "incentive") return r.note ?? "Older pay";
  return r.note ?? "";
}

const columns: Column<EarningRecord>[] = [
  {
    key: "date",
    header: "Date",
    width: "w-[110px]",
    cell: (r) => <span className="text-data whitespace-nowrap text-[12px] text-muted">{formatDay(r.date)}</span>,
  },
  {
    key: "what",
    header: "What",
    cell: (r) => (
      <span className="block min-w-0 whitespace-normal break-words text-[12px] leading-snug text-muted">
        <span className="text-[13px] font-semibold text-ink">{isReversal(r) ? "Taken back" : RECORD_KIND_LABEL[r.kind]}</span>
        {detailOf(r) ? ` · ${detailOf(r)}` : ""}
        {r.orderId ? (
          <>
            {" · "}
            <Link href={`/admin/orders/${r.orderId}`} className="text-data font-semibold text-accent-ink hover:underline">
              {r.orderCode}
            </Link>
          </>
        ) : null}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    width: "w-[110px]",
    cell: (r) => (
      <span
        className={
          r.reversed
            ? "text-data text-[13px] tabular-nums text-muted line-through"
            : r.amount < 0
              ? "text-data text-[13px] font-semibold tabular-nums text-deal"
              : "text-data text-[13px] font-semibold tabular-nums"
        }
      >
        {formatMoney(r.amount)}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    width: "w-[170px]",
    cell: (r) =>
      r.reversed ? (
        <StatusText tone="red">Reversed</StatusText>
      ) : r.status === "paid" ? (
        <StatusText tone="green">Paid {r.settledOn ? formatDay(r.settledOn) : ""}</StatusText>
      ) : (
        <StatusText tone="amber">Not paid yet</StatusText>
      ),
  },
];

type Payout = RiderMoney["payouts"][number];

const methodLabel = (m: string) => PAYOUT_METHOD_LABELS[m as PayoutMethod] ?? m;

const payoutColumns: Column<Payout>[] = [
  {
    key: "paidOn",
    header: "Paid on",
    width: "w-[120px]",
    cell: (p) => <span className="text-data text-[12.5px] font-semibold">{formatDay(p.paidOn)}</span>,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    width: "w-[120px]",
    cell: (p) => <span className="text-data text-[13px] font-semibold tabular-nums">{formatMoney(p.amount)}</span>,
  },
  {
    key: "method",
    header: "How",
    width: "w-[130px]",
    cell: (p) => <span className="text-[12.5px]">{methodLabel(p.method)}</span>,
  },
  {
    key: "reference",
    header: "Reference",
    cell: (p) => <span className="text-data text-[12px] text-muted">{p.reference ?? "-"}</span>,
  },
];

export function MoneyTab({
  riderId,
  money,
  today,
  cursor,
  payTo = null,
  mayPayNow = false,
  waiting = null,
}: Readonly<{
  riderId: string;
  money: RiderMoney;
  today: string;
  /** The cursor the current page of records was read from. */
  cursor: string | null;
  /**
   * The approved payout account, masked, and whether the rider has asked to
   * change it (0086). A payment goes to the approved one until the change is
   * approved on the Details tab (Review Focus 3). Null before 0086.
   */
  payTo?: { masked: string | null; changePending: boolean } | null;
  /** The one-admin rule is on: this admin records the payment here, in one step. */
  mayPayNow?: boolean;
  /** A payment already waiting for this rider. */
  waiting?: { amount: number; askedBy: string } | null;
}>) {
  const { summary: s, range } = money;
  const base = `/admin/riders/${riderId}?tab=salary`;
  const rangeQuery = `&from=${range.from}&to=${range.to}`;

  const tiles: MetricItem[] = [
    {
      label: "To pay",
      value: formatMoney(s.pending),
      note: s.pending < 0 ? "Older deductions are more than the salary" : s.pending === 0 ? "Nothing owed" : "Not paid yet",
    },
    {
      label: "Paid so far",
      value: formatMoney(s.paid),
      note: s.lastPayout ? `Last ${formatMoney(s.lastPayout.amount)} on ${formatDay(s.lastPayout.paidOn)}` : "No payment yet",
    },
    ...(payTo
      ? [{ label: "Pays to", value: payTo.masked ?? "No account yet", note: payTo.masked ? "The rider's payout account" : "Add it on the Details tab" }]
      : []),
  ];

  return (
    <div className="space-y-5">
      <MetricRow items={tiles} />

      {payTo?.changePending ? (
        <p className="text-[12.5px]">
          <Link href={`/admin/riders/${riderId}?tab=details`} className="hover:underline">
            <StatusText tone="amber">The rider asked to change this account. Decide it on the Details tab.</StatusText>
          </Link>
        </p>
      ) : null}

      <div className="grid items-start gap-4 grid-cols-2">
        <AdjustmentForm driverId={riderId} today={today} />
        <PayoutForm
          driverId={riderId}
          today={today}
          pending={money.pending.map((r) => ({ id: r.id, kind: r.kind, date: r.date, amount: r.amount, reversesId: r.reversesId, note: r.note }))}
          mayPayNow={mayPayNow}
          waiting={waiting}
        />
      </div>

      <Section
        title="Payments made"
        actions={
          <Link href="/admin/riders/payments" className="text-[12px] font-semibold text-accent-ink hover:underline">
            All rider salaries
          </Link>
        }
      >
        <DataTable
          caption="Payments made"
          columns={payoutColumns}
          rows={money.payouts}
          rowKey={(p) => p.id}
          minWidth={720}
          empty={<Empty>No payment has been recorded for this rider yet.</Empty>}
        />
      </Section>

      <Section
        title="Salary history"
        meta={`${formatDay(range.from)} to ${formatDay(range.to)}`}
        actions={
          <form action={`/admin/riders/${riderId}`} method="get" className="flex items-center gap-2">
            <input type="hidden" name="tab" value="salary" />
            <input type="date" name="from" aria-label="From" defaultValue={range.from} max={today} className={fieldCls} />
            <input type="date" name="to" aria-label="To" defaultValue={range.to} max={today} className={fieldCls} />
            <Button type="submit" variant="outline" size="sm">
              Show
            </Button>
          </form>
        }
      >
        {money.rangeFellBack ? (
          <p className="text-xs text-muted">That date range wasn&apos;t valid (up to 366 days), so the last 31 days are shown.</p>
        ) : null}

        <DataTable
          caption="Salary history"
          columns={columns}
          rows={money.records}
          rowKey={(r) => `${r.kind}:${r.id}`}
          minWidth={720}
          footer={
            cursor || money.nextCursor ? (
              <nav className="flex items-center justify-end gap-1.5" aria-label="History pages">
                {cursor ? (
                  <Link href={`${base}${rangeQuery}`} className="rounded-[7px] border border-line bg-surface px-2.5 py-1 text-xs font-semibold hover:border-[var(--c-border-hover)]">
                    Back to newest
                  </Link>
                ) : null}
                {money.nextCursor ? (
                  <Link href={`${base}${rangeQuery}&cursor=${money.nextCursor}`} className="rounded-[7px] border border-line bg-surface px-2.5 py-1 text-xs font-semibold hover:border-[var(--c-border-hover)]">
                    Older
                  </Link>
                ) : null}
              </nav>
            ) : undefined
          }
          empty={<Empty>Nothing added between these dates.</Empty>}
        />
      </Section>
    </div>
  );
}
