import Link from "next/link";
import { StatusDot } from "@/components/admin/console";
import { DataTable, type Column } from "@/components/admin/data-table";
import { ORDER_STATUS, STATUS_TONE } from "@/components/admin/order-status";
import { OrderMore, OrderNext, OrderRider } from "@/components/admin/order-desk-controls";
import { formatINR } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { DeskOrder } from "@/lib/data-access/admin-dispatch";

/**
 * The dashboard's two views of the orders still moving: a board with a column per
 * stage, and a table. Same rows and same buttons (order-desk-controls). Server
 * rendered, so a refresh brings new orders in without losing an open dialog.
 *
 * The board's columns are flat, ruled with hairlines rather than boxed: a late
 * order is the one thing on this screen allowed to stand out, and it does that
 * with a red rule and a red time.
 */

const STAGES: DeskOrder["status"][] = ["PLACED", "KITCHEN", "READY", "ON_THE_WAY"];

/** How long since it was placed, for an order that is not late. */
function waited(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
}

function Timing({ order }: Readonly<{ order: DeskOrder }>) {
  return order.lateByMinutes > 0 ? (
    <span className="text-data whitespace-nowrap text-[12.5px] font-bold text-deal">
      {order.lateByMinutes} min late
    </span>
  ) : (
    <span className="text-data whitespace-nowrap text-[11.5px] text-muted">{waited(order.placedAtIso)}</span>
  );
}

function Items({ order }: Readonly<{ order: DeskOrder }>) {
  if (!order.items.length) return null;
  const shown = order.items.slice(0, 2);
  const more = order.items.length - shown.length;
  return (
    <div className="min-w-0" title={order.items.map((i) => `${i.qty} × ${i.name}`).join(", ")}>
      {shown.map((item, i) => (
        <p key={`${item.name}-${i}`} className="truncate text-[12px] leading-[1.45] text-muted">
          {item.qty} × {item.name}
        </p>
      ))}
      {more > 0 ? <p className="text-[11px] text-muted">and {more} more</p> : null}
    </div>
  );
}

function Payment({ order }: Readonly<{ order: DeskOrder }>) {
  const failed = order.paymentStatus === "failed";
  return (
    <span className={cn("block text-[11.5px] leading-tight", failed ? "font-semibold text-deal" : "text-muted")}>
      {failed ? "Payment failed" : order.paymentMethod === "online" ? "Paid online" : order.paymentMethod ? "Cash" : ""}
    </span>
  );
}

function CodeLink({ order }: Readonly<{ order: DeskOrder }>) {
  return (
    <Link
      href={`/admin/orders/${order.id}`}
      prefetch={false}
      className="text-data text-[11.5px] font-semibold text-ink hover:text-accent-ink"
    >
      {order.code}
    </Link>
  );
}

function BoardRow({ order }: Readonly<{ order: DeskOrder }>) {
  const late = order.lateByMinutes > 0;
  return (
    <li
      className={cn(
        "space-y-1.5 border-t border-[color:var(--c-divider)] px-3 py-3",
        late && "bg-deal/[0.06] shadow-[inset_3px_0_0_0_var(--deal)]"
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <CodeLink order={order} />
        <Timing order={order} />
      </div>
      <p className="truncate text-[13.5px] font-semibold leading-tight text-ink" title={order.restaurant}>
        {order.restaurant}
      </p>
      <Items order={order} />
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[12px] text-ink" title={order.customer}>
            {order.customer}
          </span>
          <span className="text-data shrink-0 text-[12.5px] font-semibold text-ink">{formatINR(order.total)}</span>
        </div>
        <Payment order={order} />
      </div>
      <OrderRider order={order} />
      <div className="flex flex-wrap items-start justify-between gap-1.5 pt-0.5">
        <OrderNext order={order} />
        <OrderMore order={order} />
      </div>
    </li>
  );
}

export function OrderBoard({ orders }: Readonly<{ orders: DeskOrder[] }>) {
  return (
    <div className="grid grid-cols-4 divide-x divide-[color:var(--c-divider)] border-y border-[color:var(--c-divider)]">
      {STAGES.map((stage) => {
        const inStage = orders.filter((o) => o.status === stage);
        return (
          <section key={stage} aria-label={ORDER_STATUS[stage].label} className="min-w-0">
            <header className="flex items-center gap-2 px-3 py-2.5">
              <StatusDot tone={STATUS_TONE[stage]} />
              <h3 className="text-[13px] font-semibold text-ink">{ORDER_STATUS[stage].short}</h3>
              <span className="text-data ml-auto text-[14px] font-bold tabular-nums text-ink">{inStage.length}</span>
            </header>
            {inStage.length ? (
              <ul>
                {inStage.map((o) => (
                  <BoardRow key={o.id} order={o} />
                ))}
              </ul>
            ) : (
              <p className="border-t border-[color:var(--c-divider)] px-3 py-3 text-[12px] text-[color:var(--c-faint)]">
                None here
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

const COLUMNS: Column<DeskOrder>[] = [
  { key: "code", header: "Order", width: "w-[96px]", cell: (o) => <CodeLink order={o} /> },
  {
    key: "stage",
    header: "Stage",
    width: "w-[112px]",
    cell: (o) => (
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone={STATUS_TONE[o.status]} />
        <span className="text-[12px] text-ink">{ORDER_STATUS[o.status].short}</span>
      </span>
    ),
  },
  { key: "time", header: "Waiting", width: "w-[104px]", cell: (o) => <Timing order={o} /> },
  {
    key: "shop",
    header: "Shop",
    width: "w-[170px]",
    cell: (o) => (
      <p className="truncate text-[12.5px] font-medium text-ink" title={o.restaurant}>
        {o.restaurant}
      </p>
    ),
  },
  { key: "items", header: "Items", width: "w-[200px]", cell: (o) => <Items order={o} /> },
  {
    key: "customer",
    header: "Customer",
    cell: (o) => (
      <div className="min-w-0">
        <p className="truncate text-[12.5px] text-ink">{o.customer}</p>
        <Payment order={o} />
      </div>
    ),
  },
  { key: "rider", header: "Rider", width: "w-[170px]", cell: (o) => <OrderRider order={o} /> },
  {
    key: "total",
    header: "Value",
    align: "right",
    width: "w-[80px]",
    cell: (o) => <span className="text-data text-[12.5px] font-semibold">{formatINR(o.total)}</span>,
  },
  {
    key: "actions",
    header: "",
    align: "right",
    width: "w-[200px]",
    cell: (o) => (
      <div className="flex items-start justify-end gap-1.5">
        <OrderNext order={o} />
        <OrderMore order={o} />
      </div>
    ),
  },
];

export function OrderList({ orders, empty }: Readonly<{ orders: DeskOrder[]; empty: React.ReactNode }>) {
  return (
    <DataTable
      caption="Orders still moving"
      columns={COLUMNS}
      rows={orders}
      rowKey={(o) => o.id}
      rowTone={(o) => (o.lateByMinutes > 0 ? "alert" : null)}
      minWidth={1160}
      empty={empty}
    />
  );
}
