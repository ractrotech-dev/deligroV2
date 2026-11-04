import Link from "next/link";
import { Check } from "lucide-react";
import { StatusBadge } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { ORDER_STATUS, STATUS_TONE } from "@/components/admin/order-status";
import { OrderIntervention } from "@/components/admin/order-intervention";
import { formatINR, formatLateness } from "@/lib/utils/format";
import { formatDateTime } from "@/lib/utils/relative-time";
import { cashDue } from "@/lib/wallet/money";
import type { AdminOrderDetail } from "@/lib/data-access/admin-orders";
import { cn } from "@/lib/utils/cn";

/**
 * One order, reduced to what an operator acts on, in the order they act: the
 * controls, where it is, then who and where and what it cost, as tables.
 *
 * Shared by the side panel on Orders (so a list of many orders stays in view
 * while one is open) and the order's own page (deep links, alerts). Anything
 * not on this list — rider GPS provenance, per-stage database stamps — is
 * deliberately left off: it answered questions nobody on the desk was asking.
 */
export function OrderSummary({
  order,
  compact = false,
}: Readonly<{
  order: AdminOrderDetail;
  /** The side panel: tighter spacing, tables stacked, no repeated total in the header. */
  compact?: boolean;
}>) {
  return (
    <div className={cn("flex flex-col", compact ? "gap-5" : "gap-6")}>
      {compact ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={STATUS_TONE[order.status]}>
            {ORDER_STATUS[order.status].label}
          </StatusBadge>
          {order.lateByMinutes !== null ? (
            <StatusBadge tone="red">{formatLateness(order.lateByMinutes)}</StatusBadge>
          ) : null}
        </div>
      ) : null}

      <div className="border-b border-[color:var(--c-divider)] pb-4">
        <OrderIntervention orderId={order.id} dbStatus={order.dbStatus} />
      </div>

      <Steps order={order} />

      <div className={cn("grid items-start gap-5", !compact && "@5xl:grid-cols-2")}>
        <DetailsTable order={order} />
        <MoneyTable order={order} />
      </div>
    </div>
  );
}

type DetailRow = { label: string; value: React.ReactNode };

const DETAIL_COLUMNS: Column<DetailRow>[] = [
  {
    key: "label",
    header: "Details",
    width: "w-[104px]",
    cell: (r) => <span className="text-[13px] text-muted">{r.label}</span>,
  },
  {
    key: "value",
    header: "",
    cell: (r) => <div className="text-[13.5px] text-ink">{r.value}</div>,
  },
];

function Phone({ number }: Readonly<{ number: string | null | undefined }>) {
  if (!number) return null;
  return (
    <a href={`tel:${number}`} className="text-data mt-0.5 block text-[12.5px] text-muted hover:text-accent-ink">
      {number}
    </a>
  );
}

function DetailsTable({ order }: Readonly<{ order: AdminOrderDetail }>) {
  const rider = order.delivery?.rider ?? null;
  const rows: DetailRow[] = [
    {
      label: "Customer",
      value: order.customer ? (
        <>
          <Link
            href={`/admin/customers/${order.customer.id}`}
            className="font-medium hover:text-accent-ink hover:underline"
          >
            {order.customer.name}
          </Link>
          <Phone number={order.customer.phone} />
        </>
      ) : (
        <span className="text-muted">Profile removed</span>
      ),
    },
    {
      label: "Address",
      value:
        order.address.label || order.address.line ? (
          <>
            {order.address.label ? (
              <span className="block font-medium">{order.address.label}</span>
            ) : null}
            {order.address.line ? (
              <span className="block text-[12.5px] leading-snug text-muted">{order.address.line}</span>
            ) : null}
          </>
        ) : (
          <span className="text-muted">No address</span>
        ),
    },
    {
      label: "Shop",
      value: order.restaurant ? (
        <Link
          href={`/admin/vendors/${order.restaurant.id}`}
          className="font-medium hover:text-accent-ink hover:underline"
        >
          {order.restaurant.name}
        </Link>
      ) : (
        <span className="text-muted">No longer listed</span>
      ),
    },
    {
      label: "Rider",
      value: rider?.name ? (
        <>
          <span className="font-medium">{rider.name}</span>
          <Phone number={rider.phone} />
        </>
      ) : (
        <span className="text-[color:var(--c-ink-amber)]">Not assigned</span>
      ),
    },
    {
      label: "Payment",
      value: (
        <>
          {paymentMethodLabel(order)}
          {order.paymentKnown && order.paymentStatus ? (
            <span className={paymentClass(order.paymentStatus)}>{paymentLabel(order)}</span>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <DataTable
      caption="Order details"
      columns={DETAIL_COLUMNS}
      rows={rows}
      rowKey={(r) => r.label}
      minWidth={0}
    />
  );
}

type MoneyRow = { key: string; label: string; qty?: number; price?: number; amount: number | null; charge?: boolean };

const MONEY_COLUMNS: Column<MoneyRow>[] = [
  {
    key: "item",
    header: "Item",
    cell: (r) => (
      <span className={cn("text-[13.5px]", r.charge ? "text-muted" : "text-ink")}>{r.label}</span>
    ),
  },
  {
    key: "qty",
    header: "Qty",
    align: "right",
    width: "w-[56px]",
    cell: (r) => <span className="text-data text-[13px] text-muted">{r.qty ?? ""}</span>,
  },
  {
    key: "price",
    header: "Price",
    align: "right",
    width: "w-[84px]",
    cell: (r) => (
      <span className="text-data text-[13px] text-muted">
        {r.price === undefined ? "" : formatINR(r.price)}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    width: "w-[96px]",
    cell: (r) => (
      <span className={cn("text-data text-[13.5px]", r.charge ? "text-muted" : "font-medium text-ink")}>
        {/* Null: this database has no such column, which is not the same as ₹0. */}
        {r.amount === null ? "—" : formatINR(r.amount)}
      </span>
    ),
  },
];

function MoneyTable({ order }: Readonly<{ order: AdminOrderDetail }>) {
  const rows: MoneyRow[] = [
    ...order.items.map((item, i) => ({
      key: `item-${i}`,
      label: item.name,
      qty: item.qty,
      price: item.price,
      amount: item.qty * item.price,
    })),
    { key: "subtotal", label: "Subtotal", amount: order.subtotal, charge: true },
    { key: "delivery", label: "Delivery fee", amount: order.deliveryFee, charge: true },
    { key: "tax", label: "Tax", amount: order.taxAmount, charge: true },
    { key: "tip", label: "Tip", amount: order.tip, charge: true },
  ];

  return (
    <DataTable
      caption="What the customer pays"
      columns={MONEY_COLUMNS}
      rows={rows}
      rowKey={(r) => r.key}
      minWidth={0}
      totals={{
        label: "Total",
        cells: {
          amount: <span className="text-data text-[15px] font-bold">{formatINR(order.total)}</span>,
        },
      }}
    />
  );
}

/** How it is being paid, with wallet points split out of the cash (0198). */
function paymentMethodLabel(
  order: Pick<AdminOrderDetail, "paymentMethod" | "total" | "pointsUsed">
): string {
  if (order.paymentMethod === "online") return "Online";
  if (order.paymentMethod === "cod") {
    if (order.pointsUsed > 0) {
      const due = cashDue(order.total, order.pointsUsed);
      return due > 0
        ? `${formatINR(order.pointsUsed)} points, ${formatINR(due)} cash`
        : `${formatINR(order.pointsUsed)} points, no cash`;
    }
    return "Cash on delivery";
  }
  return "Not recorded";
}

function paymentLabel(order: AdminOrderDetail): string {
  if (order.paymentStatus === "paid") return "Paid";
  if (order.paymentStatus === "failed") return "Failed";
  // Delivered cash: the rider collected it at the door. payment_status stays
  // 'pending' until the handover chain reconciles it (0047), so the word
  // changes, not the money.
  if (order.paymentMethod === "cod" && order.status === "DELIVERED") return "Collected";
  return "Not paid yet";
}

function paymentClass(status: NonNullable<AdminOrderDetail["paymentStatus"]>): string {
  if (status === "paid") return "ml-2 font-semibold text-green";
  if (status === "failed") return "ml-2 font-semibold text-deal";
  return "ml-2 font-semibold text-[color:var(--c-ink-amber)]";
}

/**
 * The progress bar: placed, preparing, picked up, delivered, joined by a line that
 * fills as the order moves. "Ready" and "rider assigned" are kitchen and dispatch
 * detail, folded into Preparing. Reached-ness comes from the status, not the
 * timestamps, so an order on a database without a stamp still reads as having moved.
 */
function Steps({ order }: Readonly<{ order: AdminOrderDetail }>) {
  if (order.status === "CANCELLED") {
    return (
      <p className="text-[13.5px] font-semibold text-deal">
        Cancelled
        {order.cancelledAt ? (
          <span className="ml-2 font-normal text-muted">
            {formatDateTime(order.cancelledAt)}
          </span>
        ) : null}
      </p>
    );
  }

  const reached: Record<AdminOrderDetail["status"], number> = {
    PLACED: 0,
    KITCHEN: 1,
    READY: 1,
    ON_THE_WAY: 2,
    DELIVERED: 3,
    CANCELLED: 0,
  };
  const at = reached[order.status];
  const delivered = order.status === "DELIVERED";
  const steps = [
    { label: "Order placed", time: order.createdAt },
    { label: "Preparing", time: order.acceptedAt },
    { label: "Picked up", time: order.delivery?.pickedUpAt ?? null },
    { label: "Delivered", time: order.delivery?.deliveredAt ?? null },
  ];

  return (
    <ol className="grid grid-cols-4" aria-label="Order progress">
      {steps.map((s, i) => {
        const done = i < at || delivered;
        const current = i === at && !delivered;
        return (
          <li
            key={s.label}
            aria-current={current ? "step" : undefined}
            className="relative flex min-w-0 flex-col items-center px-1 text-center"
          >
            {i < steps.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "absolute left-1/2 top-[13px] h-[3px] w-full",
                  i < at || delivered ? "bg-green" : "bg-[color:var(--c-divider)]"
                )}
              />
            ) : null}
            <span
              className={cn(
                "relative grid size-7 place-items-center rounded-full border-2",
                done && "border-green bg-green text-surface",
                current && "border-green bg-surface",
                !done && !current && "border-[color:var(--c-divider)] bg-surface"
              )}
            >
              {done ? <Check className="size-4" strokeWidth={3} /> : null}
              {current ? <span className="size-2.5 rounded-full bg-green" /> : null}
            </span>
            <p
              className={cn(
                "mt-2 text-[13px] font-semibold",
                done || current ? "text-ink" : "text-muted"
              )}
            >
              {s.label}
            </p>
            <p className="text-data mt-0.5 truncate text-[12px] text-muted">
              {s.time && (done || current) ? formatDateTime(s.time) : current ? "Now" : ""}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
