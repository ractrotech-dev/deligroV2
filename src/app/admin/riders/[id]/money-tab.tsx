import Link from "next/link";
import { Section, MetricRow, FigureRow, Figure, StatusText, Empty, type MetricItem } from "@/components/admin/console";
import { DataTable, TableFooter, type Column } from "@/components/admin/data-table";
import { fieldCls } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import type { RiderMoney } from "@/lib/data-access/admin-riders";
import { deliveryDetail, formatDay, formatMoney } from "@/lib/rider/admin-money";
import type { EarningRecord } from "@/lib/rider/earnings-math";
import { AdjustmentForm, PayoutForm } from "./money-forms";

/**
 * The rider's Money tab: where they stand, what to pay, what was paid, and the
 * ledger line by line.
 *
 * Riders are salaried (P3-R11): salary, bonuses, incentives, deductions and
 * payouts are the ledger, and the ₹0 per-delivery rows the dormant rate card
 * writes are left out of the records table and the payout preview.
 *
 * Read-only apart from the two forms. The ledger is append-only (0083), so no
 * record has an edit control - a mistake is corrected with another entry - and
 * the automatic reversals the database writes when a delivery is corrected are
 * marked as such and are simply rows like the rest.
 */

const KIND_LABEL: Record<EarningRecord["kind"], string> = {
  delivery: "Delivery",
  incentive: "Incentive",
  bonus: "Bonus",
  adjustment: "Adjustment",
  deduction: "Deduction",
  salary: "Salary",
};

const isReversal = (r: EarningRecord) => r.kind === "adjustment" && r.reversesId !== null;

function detailOf(r: EarningRecord): string {
  if (r.kind === "delivery") return deliveryDetail(r);
  if (isReversal(r)) return `The delivery was corrected, so its pay is taken back${r.orderCode ? ` (${r.orderCode})` : ""}.`;
  if (r.kind === "incentive") return r.note ?? "Incentive target reached";
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
    key: "type",
    header: "Type",
    role: "title",
    width: "w-[190px]",
    cell: (r) => (
      <span className="flex min-w-0 flex-col gap-0.5">
        {isReversal(r) ? (
          <StatusText tone="blue">Automatic reversal</StatusText>
        ) : (
          <span className="text-[13px] font-semibold">{KIND_LABEL[r.kind]}</span>
        )}
        {r.reversed ? <StatusText tone="red">Reversed</StatusText> : null}
      </span>
    ),
  },
  {
    key: "order",
    header: "Order",
    width: "w-[110px]",
    cell: (r) =>
      r.orderId ? (
        <Link href={`/admin/orders/${r.orderId}`} className="text-data text-[12px] font-semibold text-accent-ink hover:underline">
          {r.orderCode}
        </Link>
      ) : (
        <span className="text-[12px] text-muted">-</span>
      ),
  },
  {
    key: "detail",
    header: "Detail",
    cell: (r) => <span className="block min-w-0 whitespace-normal break-words text-[12px] leading-snug text-muted">{detailOf(r)}</span>,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    role: "trailing",
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
    header: "Payment",
    width: "w-[200px]",
    cell: (r) =>
      r.status === "paid" ? (
        <span className="flex min-w-0 flex-col">
          <StatusText tone="green">Paid {r.settledOn ? formatDay(r.settledOn) : ""}</StatusText>
          {r.reference ? <span className="text-data truncate text-[11px] text-muted">{r.reference}</span> : null}
        </span>
      ) : (
        <StatusText tone="amber">Pending</StatusText>
      ),
  },
];

type Payout = RiderMoney["payouts"][number];

const payoutColumns: Column<Payout>[] = [
  {
    key: "paidOn",
    header: "Paid on",
    role: "title",
    width: "w-[120px]",
    cell: (p) => <span className="text-data text-[12.5px] font-semibold">{formatDay(p.paidOn)}</span>,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    role: "trailing",
    width: "w-[120px]",
    cell: (p) => <span className="text-data text-[13px] font-semibold tabular-nums">{formatMoney(p.amount)}</span>,
  },
  {
    key: "method",
    header: "Method",
    width: "w-[110px]",
    cell: (p) => <span className="text-[12.5px] capitalize">{p.method === "upi" ? "UPI" : p.method}</span>,
  },
  {
    key: "reference",
    header: "Reference",
    cell: (p) => <span className="text-data text-[12px] text-muted">{p.reference ?? "-"}</span>,
  },
  {
    key: "periodEnd",
    header: "Settled up to",
    width: "w-[130px]",
    cell: (p) => <span className="text-data whitespace-nowrap text-[12px] text-muted">{formatDay(p.periodEnd)}</span>,
  },
  {
    key: "items",
    header: "Items",
    align: "right",
    width: "w-[80px]",
    cell: (p) => <span className="text-data text-[12.5px] tabular-nums">{p.items}</span>,
  },
];

export function MoneyTab({
  riderId,
  money,
  today,
  cursor,
}: Readonly<{
  riderId: string;
  money: RiderMoney;
  today: string;
  /** The cursor the current page of records was read from. */
  cursor: string | null;
}>) {
  const { summary: s, range } = money;
  const base = `/admin/riders/${riderId}?tab=money`;
  const rangeQuery = `&from=${range.from}&to=${range.to}`;

  const tiles: MetricItem[] = [
    {
      label: "Owed - not yet paid",
      value: formatMoney(s.pending),
      note: s.pending < 0 ? "Deductions outweigh earnings" : s.pending === 0 ? "All settled" : "Pending payout",
    },
    { label: "Earned today", value: formatMoney(s.today), note: "Deliveries and incentives" },
    { label: "This week", value: formatMoney(s.week), note: "From Monday" },
    { label: "This month", value: formatMoney(s.month) },
    {
      label: "Paid out",
      value: formatMoney(s.paid),
      note: s.lastPayout ? `Last ${formatMoney(s.lastPayout.amount)} on ${formatDay(s.lastPayout.paidOn)}` : "No payout yet",
    },
  ];

  // Everything the Add form's order box can suggest: this rider's orders in view.
  const orderCodes = [
    ...new Set(money.records.filter((r) => r.kind === "delivery" && r.orderCode).map((r) => (r.orderCode as string).slice(1))),
  ];

  return (
    <div className="space-y-5">
      <MetricRow items={tiles} />

      <FigureRow>
        <Figure label="Total earned" value={formatMoney(s.total)} note={`${s.deliveriesCounted} ${s.deliveriesCounted === 1 ? "delivery" : "deliveries"} counted`} />
        {s.perDeliveryAvg === null ? (
          <Figure label="Per delivery" value="Salaried" note="Not paid per delivery" />
        ) : (
          <Figure label="Per delivery" value={formatMoney(s.perDeliveryAvg)} note="Average, live deliveries" />
        )}
        <Figure label="Incentives" value={formatMoney(s.incentives)} />
        <Figure label="Bonuses" value={formatMoney(s.bonuses)} />
        <Figure label="Salary" value={formatMoney(s.salary)} />
        <Figure label="Adjustments" value={formatMoney(s.adjustments)} note="Plus or minus" />
        <Figure label="Deductions" value={formatMoney(s.deductions)} note="Subtracted" />
      </FigureRow>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <PayoutForm
          driverId={riderId}
          today={today}
          pending={money.pending.map((r) => ({ id: r.id, kind: r.kind, date: r.date, amount: r.amount, reversesId: r.reversesId }))}
        />
        <AdjustmentForm driverId={riderId} today={today} orderCodes={orderCodes} />
      </div>

      <Section title="Records" meta={`${formatDay(range.from)} to ${formatDay(range.to)}`}>
        <form action={`/admin/riders/${riderId}`} method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="money" />
          <label className="block">
            <span className="text-[11.5px] font-semibold text-muted">From</span>
            <input type="date" name="from" defaultValue={range.from} max={today} className={`${fieldCls} mt-1`} />
          </label>
          <label className="block">
            <span className="text-[11.5px] font-semibold text-muted">To</span>
            <input type="date" name="to" defaultValue={range.to} max={today} className={`${fieldCls} mt-1`} />
          </label>
          <Button type="submit" variant="outline" size="sm">
            Show
          </Button>
        </form>
        {money.rangeFellBack ? (
          <p className="text-xs text-muted">That date range wasn&apos;t valid (up to 366 days), so the last 31 days are shown.</p>
        ) : null}

        <DataTable
          caption="Earning records"
          columns={columns}
          rows={money.records}
          rowKey={(r) => `${r.kind}:${r.id}`}
          minWidth={900}
          footer={
            <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Records pages">
              <span className="text-xs text-muted">
                {money.records.length} {money.records.length === 1 ? "record" : "records"} shown, newest first
              </span>
              <span className="flex items-center gap-1.5">
                {cursor ? (
                  <Link href={`${base}${rangeQuery}`} className="press rounded-[7px] border border-line bg-surface px-2.5 py-1 text-xs font-semibold hover:border-[var(--c-border-hover)]">
                    Back to newest
                  </Link>
                ) : null}
                {money.nextCursor ? (
                  <Link href={`${base}${rangeQuery}&cursor=${money.nextCursor}`} className="press rounded-[7px] border border-line bg-surface px-2.5 py-1 text-xs font-semibold hover:border-[var(--c-border-hover)]">
                    Older records
                  </Link>
                ) : null}
              </span>
            </nav>
          }
          empty={<Empty>No records between these dates.</Empty>}
        />
      </Section>

      <Section title="Payouts" meta={`${money.payouts.length} recorded`}>
        <DataTable
          caption="Payouts"
          columns={payoutColumns}
          rows={money.payouts}
          rowKey={(p) => p.id}
          minWidth={720}
          footer={
            <TableFooter
              page={1}
              totalPages={1}
              hrefFor={() => base}
              summary={`${money.payouts.length} ${money.payouts.length === 1 ? "payout" : "payouts"}, newest first`}
            />
          }
          empty={<Empty>No payout has been recorded for this rider yet.</Empty>}
        />
      </Section>
    </div>
  );
}
