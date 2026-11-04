import { requireRole } from "@/lib/auth";
import { cashDue } from "@/lib/wallet/money";
import Link from "next/link";
import { X } from "lucide-react";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { formatINR } from "@/lib/utils/format";
import { ADMIN_ORDERS, type AdminOrderRow } from "@/lib/roles-data";
import {
  getAdminOrderDetail,
  listOrdersPage,
  type AdminOrderDetail,
  type AdminOrderFilters,
  type AdminOrdersPage,
} from "@/lib/data-access/admin-orders";
import { UNASSIGNED_AFTER_MIN } from "@/lib/dispatch/thresholds";
import { pageCountOf, toPage } from "@/lib/utils/paging";
import { OrderSummary } from "@/components/admin/order-summary";
import { OrderStageSelect } from "@/components/admin/order-stage-select";
import {
  Empty,
  Figure,
  FigureRow,
  LiveBadge,
  PageHeader,
  StatusText,
  Tabs,
  Toolbar,
} from "@/components/admin/console";
import {
  ORDER_STATUS,
  ORDER_STATUS_ORDER,
  STATUS_TONE,
} from "@/components/admin/order-status";
import {
  DataTable,
  TableFooter,
  type Column,
} from "@/components/admin/data-table";
import {
  FilterForm,
  FilterReset,
  FilterSubmit,
  SearchField,
} from "@/components/admin/admin-filters";
import { SelectFilter } from "@/components/admin/select-filter";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Admin → Orders. WEB. Opens on the orders still moving, late ones first; "All
 * orders" (`?view=all`) adds what has finished, newest first.
 *
 * Search and every filter run in the database (`listOrdersPage`), so they reach
 * every order ever placed, and the stage counts are true. The figures in progress,
 * running late and cancelled are counts across the whole filter; value and
 * earnings are added up from the rows on screen, and say so.
 *
 * A row opens its order in a side panel (`?open=`), so the list stays in view
 * while one order is worked on; "Full page" is the same `OrderSummary` on its own
 * route. A live order's stage is a dropdown that moves it (`OrderStageSelect`, the
 * same server actions as the panel's controls).
 *
 * Search, filters and the open order live in the URL, so a view is reloadable and
 * shareable. The refresh runs only on the first page of an unsearched list: that
 * is the live view, and it keeps a search or old pages from re-reading the table
 * for nothing.
 */

/** Matches the AutoRefresh interval below; stated in the UI, not implied. */
const REFRESH_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT: AdminOrderRow["status"][] = ["PLACED", "KITCHEN", "READY", "ON_THE_WAY"];

type Search = {
  q?: string;
  status?: string;
  vendor?: string;
  payment?: string;
  rider?: string;
  page?: string;
  /** "all" shows finished orders too; anything else is the live view. */
  view?: string;
  /** The order open in the side panel. */
  open?: string;
};

/** READY reads as Preparing, so the Preparing stage carries both. */
function inStage(status: AdminOrderRow["status"], stage: AdminOrderRow["status"]): boolean {
  return status === stage || (stage === "KITCHEN" && status === "READY");
}

/** How many dish lines to print before collapsing the rest into a count. */
const ITEM_LINES = 2;

/**
 * What was ordered, at a glance.
 *
 * Two lines then "+N more" rather than the whole basket: a nine-line order would
 * set the row height for the entire table, and the operator reading this is
 * scanning for "is this the biryani order" — the first couple of dishes answer
 * that, and the row opens for the rest. The full list is on the `title`
 * attribute, so hovering gives it without a navigation.
 *
 * Says nothing at all when there are no named lines. Legacy imported orders can
 * arrive with unnamed items, and "0 items" would be a claim about the order
 * rather than about what we know of it.
 */
function ItemsCell({
  items,
  count,
}: Readonly<{
  items?: { name: string; qty: number }[];
  count?: number;
}>) {
  if (!items || items.length === 0) {
    return <span className="text-[11.5px] text-[color:var(--c-faint)]">—</span>;
  }

  const shown = items.slice(0, ITEM_LINES);
  const hidden = items.length - shown.length;
  const full = items.map((i) => `${i.qty} × ${i.name}`).join(", ");

  return (
    <div className="min-w-0" title={full}>
      {shown.map((item, i) => (
        <p
          key={`${item.name}-${i}`}
          className="truncate text-[12px] leading-[1.45] text-ink"
        >
          <span className="text-data font-semibold text-muted">{item.qty}×</span>{" "}
          {item.name}
        </p>
      ))}
      {hidden > 0 ? (
        <p className="text-[11px] font-medium text-muted">
          +{hidden} more{count ? ` · ${count} items` : ""}
        </p>
      ) : null}
    </div>
  );
}

/** How the order is being paid, in one word or two. */
function paymentWord(o: { paymentMethod?: string; total: number; pointsUsed?: number }): string {
  if (o.paymentMethod === "online") return "Online";
  if (!o.pointsUsed) return "Cash";
  return cashDue(o.total, o.pointsUsed) > 0 ? "Cash and points" : "Points";
}

/** The line under the payment method: what is still owed, if anything. */
function PaymentNote({ order: o }: Readonly<{ order: AdminOrderRow }>) {
  if (
    o.paymentMethod === "cod" &&
    o.status === "DELIVERED" &&
    o.paymentStatus === "pending"
  ) {
    // Delivered cash: the rider confirmed collection at the door, so
    // "pending" read as unpaid while the rider's own screen said
    // "CASH COLLECTED". payment_status deliberately stays 'pending'
    // until the handover chain reconciles it (0047 and the note in
    // advanceDelivery) — this changes the word, not the money.
    return <p className="truncate text-[12px] text-muted">Collected</p>;
  }
  if (o.paymentStatus && o.paymentStatus !== "paid") {
    return (
      <p
        className={
          o.paymentStatus === "failed"
            ? "truncate text-[12px] font-semibold text-deal"
            : "truncate text-[12px] text-[color:var(--c-ink-amber)]"
        }
      >
        {o.paymentStatus === "failed" ? "Failed" : "Not paid yet"}
      </p>
    );
  }
  return null;
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const sp = await searchParams;
  const asked = ORDER_STATUS_ORDER.includes(sp.status as AdminOrderRow["status"])
    ? (sp.status as AdminOrderRow["status"])
    : null;
  const filters: AdminOrderFilters = {
    q: (sp.q ?? "").trim(),
    // READY has no choice of its own: it reads as Preparing.
    status: asked === "READY" ? "KITCHEN" : asked,
    vendorId: UUID.test(sp.vendor ?? "") ? (sp.vendor as string).toLowerCase() : "",
    payment: sp.payment === "cod" || sp.payment === "online" || sp.payment === "failed" ? sp.payment : "",
    noRider: sp.rider === "none",
    liveOnly: sp.view !== "all",
    page: toPage(sp.page),
  };

  if (!isSupabaseConfigured) {
    return renderOrders(demoPage(filters), filters, null);
  }

  // The side panel's order. A bad or stale id just leaves the panel closed.
  const openId = UUID.test(sp.open ?? "") ? (sp.open as string) : "";
  const [view, opened] = await Promise.all([
    listOrdersPage(filters),
    openId ? getAdminOrderDetail(openId).catch(() => null) : Promise.resolve(null),
  ]);
  return renderOrders(view, filters, opened);
}

/** The seed rows, with no database behind them to filter or page. */
function demoPage(f: AdminOrderFilters): AdminOrdersPage {
  const rows = ADMIN_ORDERS.filter(
    (o) =>
      (!f.status || inStage(o.status, f.status)) &&
      (!f.liveOnly || IN_FLIGHT.includes(o.status))
  );
  const counts = Object.fromEntries(
    ORDER_STATUS_ORDER.map((s) => [s, ADMIN_ORDERS.filter((o) => o.status === s).length])
  ) as AdminOrdersPage["counts"];
  return {
    rows,
    page: 1,
    pageSize: rows.length || 1,
    total: rows.length,
    counts,
    late: 0,
    worstLate: 0,
    vendors: [],
    searchCapped: false,
  };
}

/** The database status behind a live row's stage, for the stage dropdown. */
const DB_STATUS: Partial<Record<AdminOrderRow["status"], string>> = {
  PLACED: "placed",
  KITCHEN: "kitchen",
  READY: "ready",
  ON_THE_WAY: "on_the_way",
};

function renderOrders(
  view: AdminOrdersPage,
  f: AdminOrderFilters,
  opened: AdminOrderDetail | null
) {
  const orders = view.rows;

  const href = (next: Partial<Search>) => {
    const merged: Search = {
      q: f.q || undefined,
      status: f.status ?? undefined,
      vendor: f.vendorId || undefined,
      payment: f.payment || undefined,
      rider: f.noRider ? "none" : undefined,
      view: f.liveOnly ? undefined : "all",
      page: view.page > 1 ? String(view.page) : undefined,
      open: opened?.id,
      ...next,
    };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) usp.set(k, v);
    const query = usp.toString();
    return query ? `/admin/orders?${query}` : "/admin/orders";
  };

  /* The counts cover everything *except* the stage filter, so switching stage does
     not make the other counts jump around. */
  const liveCount = IN_FLIGHT.reduce((sum, s) => sum + view.counts[s], 0);
  const allCount = ORDER_STATUS_ORDER.reduce((sum, s) => sum + view.counts[s], 0);

  // The stage filter is a dropdown beside vendor and payment, not a second tab
  // strip. A stage with nothing in it is only offered while it is the one selected.
  const stageOptions = [
    { value: "", label: `All stages (${f.liveOnly ? liveCount : allCount})` },
    ...ORDER_STATUS_ORDER.filter(
      (s) => s !== "READY" && (!f.liveOnly || IN_FLIGHT.includes(s) || s === f.status)
    )
      .map((s) => ({
        s,
        count: ORDER_STATUS_ORDER.reduce((n, k) => n + (inStage(k, s) ? view.counts[k] : 0), 0),
      }))
      .filter(({ s, count }) => count > 0 || s === f.status)
      .map(({ s, count }) => ({ value: s, label: `${ORDER_STATUS[s].short} (${count})` })),
  ];

  const inFlight = IN_FLIGHT.reduce(
    (sum, s) => sum + (!f.status || inStage(s, f.status) ? view.counts[s] : 0),
    0
  );
  const late = view.late;
  const worst = view.worstLate;
  const cancelled = !f.status || f.status === "CANCELLED" ? view.counts.CANCELLED : 0;
  const value = orders.reduce((sum, o) => sum + o.total, 0);
  const earned = orders.reduce((sum, o) => sum + (o.profit ?? 0), 0);

  const orderCol: Column<AdminOrderRow> = {
    key: "code",
    header: "Order",
    width: "w-[150px]",
    cell: (o) => (
      <div className="min-w-0">
        <p className="text-data text-[13px] font-semibold text-ink">{o.code}</p>
        <p className="text-data whitespace-nowrap text-[12px] text-muted">
          {o.placedAt}
        </p>
      </div>
    ),
  };
  const stageCol: Column<AdminOrderRow> = {
    key: "status",
    header: "Stage",
    width: "w-[160px]",
    cell: (o) => (
      <span className="inline-flex flex-col gap-0.5">
        {o.id && DB_STATUS[o.status] && isSupabaseConfigured ? (
          <OrderStageSelect orderId={o.id} dbStatus={DB_STATUS[o.status]!} />
        ) : (
          <StatusText tone={STATUS_TONE[o.status]}>{ORDER_STATUS[o.status].short}</StatusText>
        )}
        {o.lateByMinutes ? (
          <span className="text-data text-[12px] font-semibold text-deal">
            {o.lateByMinutes}m late
          </span>
        ) : null}
      </span>
    ),
  };
  const totalCol: Column<AdminOrderRow> = {
    key: "total",
    header: "Total",
    align: "right",
    width: "w-[96px]",
    cell: (o) => (
      <span className="text-data text-[13.5px] font-semibold">{formatINR(o.total)}</span>
    ),
  };

  const twoLines = (top: React.ReactNode, bottom?: React.ReactNode) => (
    <div className="min-w-0">
      <p className="truncate text-[13.5px] text-ink">{top}</p>
      {bottom ? <p className="truncate text-[12px] text-muted">{bottom}</p> : null}
    </div>
  );

  // Everything an operator acts on, one row per order, so most questions are
  // answered without opening anything. With an order open beside it the list
  // keeps only what finds the next one.
  const columns: Column<AdminOrderRow>[] = opened
    ? [
        orderCol,
        {
          key: "customer",
          header: "Customer",
          cell: (o) => <p className="truncate text-[13.5px] text-ink">{o.customer}</p>,
        },
        stageCol,
        totalCol,
      ]
    : [
        orderCol,
        {
          key: "customer",
          header: "Customer",
          width: "w-[170px]",
          cell: (o) => twoLines(o.customer, o.customerPhone),
        },
        {
          key: "address",
          header: "Deliver to",
          width: "w-[220px]",
          cell: (o) =>
            o.address ? (
              <p className="line-clamp-2 text-[12.5px] leading-snug text-ink" title={o.address}>
                {o.address}
              </p>
            ) : (
              <span className="text-[12px] text-[color:var(--c-faint)]">—</span>
            ),
        },
        {
          key: "restaurant",
          header: "Shop",
          width: "w-[160px]",
          cell: (o) => twoLines(o.restaurant),
        },
        {
          key: "rider",
          header: "Rider",
          width: "w-[150px]",
          cell: (o) =>
            o.rider ? (
              twoLines(o.rider, o.riderPhone)
            ) : IN_FLIGHT.includes(o.status) ? (
              <span className="text-[13px] text-[color:var(--c-ink-amber)]">Not assigned</span>
            ) : (
              <span className="text-[12px] text-[color:var(--c-faint)]">—</span>
            ),
        },
        {
          key: "items",
          header: "Items",
          width: "w-[200px]",
          cell: (o) => <ItemsCell items={o.items} count={o.itemCount} />,
        },
        {
          // A failed or unpaid payment is the thing here most likely to need a
          // person, so it is stated in the warning tone under the method.
          key: "payment",
          header: "Payment",
          width: "w-[120px]",
          cell: (o) =>
            o.paymentMethod ? (
              <div className="min-w-0">
                <p className="truncate text-[13px] text-ink">{paymentWord(o)}</p>
                <PaymentNote order={o} />
              </div>
            ) : (
              <span className="text-[12px] text-[color:var(--c-faint)]">—</span>
            ),
        },
        stageCol,
        totalCol,
      ];

  const filtered = Boolean(f.q || f.status || f.vendorId || f.payment || f.noRider);
  const totalPages = pageCountOf(view.total, view.pageSize);
  const live = isSupabaseConfigured && view.page === 1 && !f.q;
  const resetHref = f.liveOnly ? "/admin/orders" : "/admin/orders?view=all";
  const updates = live ? ` Updates every ${Math.round(REFRESH_MS / 1000)} seconds.` : "";

  return (
    <>
      {live ? <AutoRefresh interval={REFRESH_MS} /> : null}

      <PageHeader
        title="Orders"
        description={
          f.liveOnly
            ? `Every order still moving.${updates}`
            : `Every order, what is still moving first.${updates}`
        }
        status={<LiveBadge label={inFlight > 0 ? `${inFlight} in flight` : "All settled"} />}
      />

      <Toolbar>
        <FilterForm
          action="/admin/orders"
          carry={{ view: f.liveOnly ? undefined : "all" }}
        >
          <SearchField
            defaultValue={f.q}
            placeholder="Order code, customer, vendor or dish"
          />
          <SelectFilter
            // Keyed on the view: switching Live / All drops the stage, and an
            // uncontrolled select would otherwise keep showing the old one.
            key={`stage-${f.liveOnly ? "live" : "all"}`}
            name="status"
            label="Filter by stage"
            value={f.status ?? ""}
            options={stageOptions}
          />
          <SelectFilter
            name="vendor"
            label="Filter by vendor"
            value={f.vendorId}
            options={[
              { value: "", label: "All vendors" },
              ...view.vendors.map((v) => ({ value: v.id, label: v.name })),
            ]}
          />
          <SelectFilter
            name="payment"
            label="Filter by payment method"
            value={f.payment}
            options={[
              { value: "", label: "Any payment" },
              { value: "cod", label: "Cash on delivery" },
              { value: "online", label: "Paid online" },
              { value: "failed", label: "Payment failed" },
            ]}
          />
          <SelectFilter
            name="rider"
            label="Filter by rider"
            value={f.noRider ? "none" : ""}
            options={[
              { value: "", label: "Any rider" },
              { value: "none", label: `No rider after ${UNASSIGNED_AFTER_MIN} minutes` },
            ]}
          />
          <FilterSubmit />
        </FilterForm>
        {filtered ? <FilterReset href={resetHref} /> : null}
      </Toolbar>

      {/* Switching view keeps the search and the filters but drops the stage,
          which may not exist on the other side (Delivered is never live). */}
      <Tabs
        label="Which orders"
        active={href({ status: undefined, page: undefined, open: undefined })}
        items={[
          {
            href: href({ view: undefined, status: undefined, page: undefined, open: undefined }),
            label: "Live orders",
            count: liveCount,
          },
          {
            href: href({ view: "all", status: undefined, page: undefined, open: undefined }),
            label: "All orders",
            count: allCount,
          },
        ]}
      />

      {view.searchCapped ? (
        <p className="text-[12.5px] font-medium text-[color:var(--c-ink-amber)]">
          That search matches a lot, so only some of it is listed. Add more words to narrow it.
        </p>
      ) : null}

      <FigureRow>
        <Figure label="In progress" value={inFlight} />
        <Figure
          label="Running late"
          value={late}
          note={late > 0 ? `Worst is ${worst} min over` : undefined}
        />
        <Figure label="Cancelled" value={cancelled} note="All time" />
        <Figure label="Order value" value={formatINR(value)} note="On this page" />
        <Figure label="You earn" value={formatINR(earned)} note="On this page" />
      </FigureRow>

      <div
        className={
          opened
            ? "grid items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_440px]"
            : undefined
        }
      >
        <div className="min-w-0">
          <DataTable
            caption="Orders"
            columns={columns}
            rows={orders}
            rowKey={(o) => o.id ?? o.code}
            // The demo seed rows have no id and therefore nothing to open.
            rowHref={(o) => (o.id ? href({ open: o.id }) : null)}
            selectedKey={opened?.id ?? null}
            rowTone={(o) => ((o.lateByMinutes ?? 0) > 0 ? "alert" : null)}
            // Wide enough that the dish names are not the first thing squeezed,
            // which would defeat the point of showing them.
            minWidth={opened ? 520 : 1500}
            footer={
              <TableFooter
                page={view.page}
                totalPages={totalPages}
                hrefFor={(p) => href({ page: p > 1 ? String(p) : undefined })}
                summary={`${view.total} ${f.liveOnly ? "live " : ""}order${view.total === 1 ? "" : "s"}`}
              />
            }
            empty={
              filtered && f.liveOnly ? (
                <Empty action={{ href: href({ view: "all", status: undefined, page: undefined, open: undefined }), label: "Search all orders" }}>
                  No live orders match.
                </Empty>
              ) : filtered ? (
                <Empty action={{ href: resetHref, label: "Clear filters" }}>
                  No orders match.
                </Empty>
              ) : f.liveOnly ? (
                <Empty action={{ href: "/admin/orders?view=all", label: "See all orders" }}>
                  Nothing in flight right now. New orders appear here as they come in.
                </Empty>
              ) : (
                <Empty>
                  No orders yet. New ones appear here as they come in.
                </Empty>
              )
            }
          />
        </div>
        {opened ? (
          <aside
            className="self-start rounded-[var(--c-r)] border border-line bg-surface p-5 @5xl:sticky @5xl:top-4"
            aria-label={`Order ${opened.code}`}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-data text-[17px] font-bold">{opened.code}</p>
                <p className="text-[12.5px] text-muted">Placed {opened.placedAt}</p>
              </div>
              <div className="flex items-center gap-1">
                <Link
                  href={`/admin/orders/${opened.id}`}
                  prefetch={false}
                  className="c-btn c-btn-outline"
                >
                  Full page
                </Link>
                <Link
                  href={href({ open: undefined })}
                  className="grid size-8 place-items-center rounded-md text-muted hover:bg-[var(--c-hover)] hover:text-ink"
                  aria-label="Close order"
                >
                  <X className="size-4" />
                </Link>
              </div>
            </div>
            <OrderSummary order={opened} compact />
          </aside>
        ) : null}
      </div>
    </>
  );
}
