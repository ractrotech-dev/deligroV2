import { requireRole } from "@/lib/auth";
import { cashDue } from "@/lib/wallet/money";
import Link from "next/link";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { formatINR } from "@/lib/utils/format";
import { ADMIN_ORDERS, type AdminOrderRow } from "@/lib/roles-data";
import {
  listOrdersPage,
  type AdminOrderFilters,
  type AdminOrdersPage,
} from "@/lib/data-access/admin-orders";
import { UNASSIGNED_AFTER_MIN } from "@/lib/dispatch/thresholds";
import { pageCountOf, toPage } from "@/lib/utils/paging";
import {
  listPendingRestaurants,
  type PendingRestaurant,
} from "@/lib/data-access/admin-stats";
import { PendingApprovals } from "@/components/admin/pending-approvals";
import {
  Empty,
  Figure,
  FigureRow,
  LiveBadge,
  PageHeader,
  Section,
  StatusDot,
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
 * Admin → Orders. WEB. Every order across every restaurant: what is still moving
 * first, late ones first, then what has finished, newest first.
 *
 * Search and every filter run in the database (`listOrdersPage`), so they reach
 * every order ever placed, and the stage counts are true. The figures in flight,
 * past promise time and cancelled are counts across the whole filter; value and
 * earnings are added up from the rows on screen, and say so.
 *
 * ## Why rows do not expand
 *
 * The columns already carry everything an expanded row would reveal: what was
 * ordered, how it was paid for, whether the payment landed, and what the
 * platform earns from it. A disclosure that shows nothing new is a click that
 * costs an operator a row of vertical space. The order code opens the full
 * record, which is where the timeline and the address live.
 *
 * Search and every filter live in the URL, so a filtered view is reloadable and
 * shareable. The 4-second refresh runs only on the first page of an unsearched
 * list: that is the live view, and it keeps a search or old pages from re-reading
 * the table for nothing.
 */

/** Matches the AutoRefresh interval below; stated in the UI, not implied. */
const REFRESH_MS = 4000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IN_FLIGHT: AdminOrderRow["status"][] = ["PLACED", "KITCHEN", "READY", "ON_THE_WAY"];

type Search = {
  q?: string;
  status?: string;
  vendor?: string;
  payment?: string;
  rider?: string;
  page?: string;
};

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

/** The line under the payment method: what is still owed, if anything. */
/** How the order is being paid, in one word or two. */
function paymentWord(o: { paymentMethod?: string; total: number; pointsUsed?: number }): string {
  if (o.paymentMethod === "online") return "Online";
  if (!o.pointsUsed) return "Cash";
  return cashDue(o.total, o.pointsUsed) > 0 ? "Cash and points" : "Points";
}

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
    return <p className="truncate text-[11px] text-muted">collected</p>;
  }
  if (o.paymentStatus && o.paymentStatus !== "paid") {
    return (
      <p
        className={
          o.paymentStatus === "failed"
            ? "truncate text-[11px] font-semibold text-deal"
            : "truncate text-[11px] text-[color:var(--c-ink-amber)]"
        }
      >
        {o.paymentStatus}
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
  const filters: AdminOrderFilters = {
    q: (sp.q ?? "").trim(),
    status: ORDER_STATUS_ORDER.includes(sp.status as AdminOrderRow["status"])
      ? (sp.status as AdminOrderRow["status"])
      : null,
    vendorId: UUID.test(sp.vendor ?? "") ? (sp.vendor as string).toLowerCase() : "",
    payment: sp.payment === "cod" || sp.payment === "online" || sp.payment === "failed" ? sp.payment : "",
    noRider: sp.rider === "none",
    page: toPage(sp.page),
  };

  if (!isSupabaseConfigured) {
    return renderOrders(demoPage(filters), [], filters);
  }

  const [view, pending] = await Promise.all([
    listOrdersPage(filters),
    listPendingRestaurants(),
  ]);
  return renderOrders(view, pending, filters);
}

/** The seed rows, with no database behind them to filter or page. */
function demoPage(f: AdminOrderFilters): AdminOrdersPage {
  const rows = ADMIN_ORDERS.filter((o) => !f.status || o.status === f.status);
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

function renderOrders(
  view: AdminOrdersPage,
  pending: PendingRestaurant[],
  f: AdminOrderFilters
) {
  const orders = view.rows;

  const href = (next: Partial<Search>) => {
    const merged: Search = {
      q: f.q || undefined,
      status: f.status ?? undefined,
      vendor: f.vendorId || undefined,
      payment: f.payment || undefined,
      rider: f.noRider ? "none" : undefined,
      ...next,
    };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) usp.set(k, v);
    const query = usp.toString();
    return query ? `/admin/orders?${query}` : "/admin/orders";
  };

  /* The stage tabs count against everything *except* the stage filter, so
     switching between them does not make the other counts jump around. */
  const allCount = ORDER_STATUS_ORDER.reduce((sum, s) => sum + view.counts[s], 0);
  const tabs = [
    { href: href({ status: undefined, page: undefined }), label: "All", count: allCount },
    ...ORDER_STATUS_ORDER.map((s) => ({
      href: href({ status: s, page: undefined }),
      label: ORDER_STATUS[s].short,
      count: view.counts[s],
    })).filter((t) => t.count > 0),
  ];

  const inFlight = IN_FLIGHT.reduce(
    (sum, s) => sum + (!f.status || f.status === s ? view.counts[s] : 0),
    0
  );
  const late = view.late;
  const worst = view.worstLate;
  const cancelled = !f.status || f.status === "CANCELLED" ? view.counts.CANCELLED : 0;
  const value = orders.reduce((sum, o) => sum + o.total, 0);
  const earned = orders.reduce((sum, o) => sum + (o.profit ?? 0), 0);

  const columns: Column<AdminOrderRow>[] = [
    {
      key: "code",
      header: "Order",
      width: "w-[140px]",
      cell: (o) => (
        <div className="min-w-0">
          <p className="text-data text-[11.5px] font-semibold text-ink">
            {o.code}
          </p>
        </div>
      ),
    },
    {
      key: "restaurant",
      header: "Vendor",
      width: "w-[165px]",
      cell: (o) => (
        <p
          className="truncate text-[12.5px] font-medium text-ink"
          title={o.restaurant}
        >
          {o.restaurant}
        </p>
      ),
    },
    {
      key: "items",
      header: "Items",
      width: "w-[210px]",
      cell: (o) => <ItemsCell items={o.items} count={o.itemCount} />,
    },
    {
      key: "customer",
      header: "Customer",
      cell: (o) => (
        <p className="truncate text-[12.5px] text-ink">{o.customer}</p>
      ),
    },
    {
      // Method and outcome in one column. A failed or pending payment is the
      // thing on this screen most likely to need a person, so it is stated in
      // the warning tone rather than left as a grey word under the method.
      key: "payment",
      header: "Payment",
      width: "w-[120px]",
      cell: (o) =>
        o.paymentMethod ? (
          <div className="min-w-0">
            <p className="truncate text-[12px] text-ink">
              {paymentWord(o)}
            </p>
            <PaymentNote order={o} />
          </div>
        ) : (
          <span className="text-[11.5px] text-[color:var(--c-faint)]">—</span>
        ),
    },
    {
      key: "rider",
      header: "Rider",
      width: "w-[120px]",
      cell: (o) =>
        o.rider ? (
          <p className="truncate text-[12px] text-ink" title={o.rider}>{o.rider}</p>
        ) : IN_FLIGHT.includes(o.status) ? (
          <p className="text-[11.5px] font-semibold text-[color:var(--c-ink-amber)]">No rider</p>
        ) : (
          <span className="text-[11.5px] text-[color:var(--c-faint)]">—</span>
        ),
    },
    {
      key: "status",
      header: "Stage",
      width: "w-[124px]",
      cell: (o) => (
        <span className="inline-flex flex-col gap-0.5 items-start">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={STATUS_TONE[o.status]} />
            <span className="text-[12px] text-ink">
              {ORDER_STATUS[o.status].short}
            </span>
          </span>
          {o.lateByMinutes ? (
            <span className="text-data text-[11px] font-semibold text-deal">
              {o.lateByMinutes}m late
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "placedAt",
      header: "Placed",
      width: "w-[112px]",
      cell: (o) => (
        <span className="text-data whitespace-nowrap text-[11.5px] text-muted">
          {o.placedAt}
        </span>
      ),
    },
    {
      key: "total",
      header: "Value",
      align: "right",
      width: "w-[92px]",
      cell: (o) => (
        <span className="text-data text-[12.5px] font-semibold">
          {formatINR(o.total)}
        </span>
      ),
    },
    {
      // Commission + GST on commission + other charges, at the vendor's own
      // rate — what the platform keeps from this order. Nothing to show on a
      // cancelled order, and undefined on the demo seed rows.
      key: "profit",
      header: "You earn",
      align: "right",
      width: "w-[92px]",
      cell: (o) =>
        o.profit != null ? (
          <span className="text-data text-[12.5px] font-semibold text-green">
            {formatINR(o.profit)}
          </span>
        ) : (
          <span className="text-data text-[12.5px] text-[color:var(--c-faint)]">
            —
          </span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "w-[72px]",
      // Open only: there is nothing to do from the list that the order's own
      // page does not do better.
      cell: (o) =>
        o.id ? (
          <Link
            href={`/admin/orders/${o.id}`}
            prefetch={false}
            className="c-btn-affirm"
          >
            Open
          </Link>
        ) : null,
    },
  ];

  const filtered = Boolean(f.q || f.status || f.vendorId || f.payment || f.noRider);
  const totalPages = pageCountOf(view.total, view.pageSize);
  const live = isSupabaseConfigured && view.page === 1 && !f.q;

  return (
    <>
      {live ? <AutoRefresh interval={REFRESH_MS} /> : null}

      <PageHeader
        title="Orders"
        description={live ? `What is still moving comes first. Refreshing every ${Math.round(REFRESH_MS / 1000)}s.` : "What is still moving comes first."}
        status={<LiveBadge label={inFlight > 0 ? `${inFlight} in flight` : "All settled"} />}
      />

      <Toolbar>
        <FilterForm
          action="/admin/orders"
          carry={{ status: f.status ?? undefined }}
        >
          <SearchField
            defaultValue={f.q}
            placeholder="Order code, customer, vendor or dish"
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
        {filtered ? <FilterReset href="/admin/orders" /> : null}
      </Toolbar>

      {tabs.length > 2 ? (
        <Tabs
          label="Order stage"
          active={href({ status: f.status ?? undefined, page: undefined })}
          items={tabs}
        />
      ) : null}

      {view.searchCapped ? (
        <p className="text-[12.5px] font-medium text-[color:var(--c-ink-amber)]">
          That search matches a lot, so only some of it is listed. Add more words to narrow it.
        </p>
      ) : null}

      <FigureRow>
        <Figure
          label="In flight"
          value={inFlight}
          note="Placed, cooking, ready or on the way"
        />
        <Figure
          label="Past promise time"
          value={late}
          note={late > 0 ? `worst is ${worst}m over` : "everything on time"}
        />
        <Figure label="Cancelled" value={cancelled} note="in this selection" />
        <Figure
          label="Value"
          value={formatINR(value)}
          note={`on this page, ${orders.length} order${orders.length === 1 ? "" : "s"}`}
        />
        <Figure
          label="You earn"
          value={formatINR(earned)}
          note="on this page"
        />
      </FigureRow>

      <DataTable
        caption="Orders"
        columns={columns}
        rows={orders}
        rowKey={(o) => o.id ?? o.code}
        // The demo seed rows have no id and therefore nothing to open — a link
        // to /admin/orders/undefined would 404 on tap.
        rowHref={(o) => (o.id ? `/admin/orders/${o.id}` : null)}
        rowTone={(o) => ((o.lateByMinutes ?? 0) > 0 ? "alert" : null)}
        // Wide enough that the dish names are not the first thing squeezed,
        // which would defeat the point of showing them.
        minWidth={1300}
        footer={
          <TableFooter
            page={view.page}
            totalPages={totalPages}
            hrefFor={(p) => href({ page: p > 1 ? String(p) : undefined })}
            summary={`${view.total} order${view.total === 1 ? "" : "s"}`}
          />
        }
        empty={
          filtered ? (
            <Empty action={{ href: "/admin/orders", label: "Clear filters" }}>
              No orders match.
            </Empty>
          ) : (
            <Empty>
              No orders yet — new ones land here in real time as customers check
              out.
            </Empty>
          )
        }
      />

      {pending.length ? (
        <Section title="Shops waiting to go live" meta={`${pending.length}`}>
          <PendingApprovals pending={pending} />
        </Section>
      ) : null}
    </>
  );
}
