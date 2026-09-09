import Link from "next/link";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { formatINR } from "@/lib/utils/format";
import { ADMIN_ORDERS, type AdminOrderRow } from "@/lib/roles-data";
import { listAllOrders } from "@/lib/data-access/admin-orders";
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
 * Admin → Orders. Every order across every restaurant, newest first, with the
 * in-flight ones pulled forward and the late ones pulled forward of those.
 *
 * ## The window, and why the page keeps saying so
 *
 * `listAllOrders` takes a row limit, not a date range, so this screen is always
 * "the last N orders" rather than "all orders since". Every filter below is
 * applied to that window. The footer states which, because "3 orders" meaning
 * "3 in the last 200" and meaning "3, ever" are very different answers to the
 * same question.
 *
 * That is also why there is no date filter and no rider filter. A date range
 * would need a query this data layer does not expose, and would silently mean
 * "orders from that range *that happen to be in the last 200*", which is worse
 * than not offering it. `AdminOrderRow` carries no rider at all — only the
 * dispatch board's row type does — so a rider dropdown would be a control with
 * nothing behind it. Both are gaps in the data layer, not in the design, and
 * the honest thing is to leave them out until they are real.
 *
 * ## Why rows do not expand
 *
 * The columns already carry everything an expanded row would reveal: what was
 * ordered, how it was paid for, whether the payment landed, and what the
 * platform earns from it. A disclosure that shows nothing new is a click that
 * costs an operator a row of vertical space. The order code opens the full
 * record, which is where the timeline, the address and the rider live.
 *
 * Search and every filter live in the URL, so a filtered view is reloadable and
 * shareable.
 */

/** The window we pull. Widened when searching so a query can reach further back. */
const WINDOW = 50;
const SEARCH_WINDOW = 250;

/** Matches the AutoRefresh interval below; stated in the UI, not implied. */
const REFRESH_MS = 4000;

const IN_FLIGHT: AdminOrderRow["status"][] = [
  "PLACED",
  "KITCHEN",
  "READY",
  "ON_THE_WAY",
];

type Search = {
  q?: string;
  status?: string;
  vendor?: string;
  payment?: string;
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
}: {
  items?: { name: string; qty: number }[];
  count?: number;
}) {
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

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const status = ORDER_STATUS_ORDER.includes(sp.status as AdminOrderRow["status"])
    ? (sp.status as AdminOrderRow["status"])
    : null;
  const vendor = (sp.vendor ?? "").trim();
  const payment = sp.payment === "cod" || sp.payment === "online" ? sp.payment : "";

  if (!isSupabaseConfigured) {
    return renderOrders(ADMIN_ORDERS, [], { q, status, vendor, payment }, WINDOW);
  }

  const limit = q ? SEARCH_WINDOW : WINDOW;
  const [live, pending] = await Promise.all([
    listAllOrders(limit),
    listPendingRestaurants(),
  ]);
  return renderOrders(live, pending, { q, status, vendor, payment }, limit);
}

interface Filters {
  q: string;
  status: AdminOrderRow["status"] | null;
  vendor: string;
  payment: string;
}

function renderOrders(
  all: AdminOrderRow[],
  pending: PendingRestaurant[],
  f: Filters,
  windowSize: number
) {
  const needle = f.q.toLowerCase();
  const orders = all.filter((o) => {
    if (f.status && o.status !== f.status) return false;
    if (f.vendor && o.restaurant !== f.vendor) return false;
    if (f.payment && o.paymentMethod !== f.payment) return false;
    if (!needle) return true;
    return (
      o.code.toLowerCase().includes(needle) ||
      o.customer.toLowerCase().includes(needle) ||
      o.restaurant.toLowerCase().includes(needle) ||
      // Dish names too — "biryani" is a thing an operator on a call actually
      // types, and until this was added it matched nothing.
      (o.items ?? []).some((i) => i.name.toLowerCase().includes(needle))
    );
  });

  /* ---------- controls ----------
     The status tabs count against everything *except* the status filter, so
     switching between them does not make the other counts jump around. The
     vendor and payment filters do narrow them, because those are still in
     force whichever tab you are on. */
  const scoped = all.filter((o) => {
    if (f.vendor && o.restaurant !== f.vendor) return false;
    if (f.payment && o.paymentMethod !== f.payment) return false;
    if (!needle) return true;
    return (
      o.code.toLowerCase().includes(needle) ||
      o.customer.toLowerCase().includes(needle) ||
      o.restaurant.toLowerCase().includes(needle) ||
      (o.items ?? []).some((i) => i.name.toLowerCase().includes(needle))
    );
  });

  const href = (next: Partial<Search>) => {
    const merged: Search = {
      q: f.q || undefined,
      status: f.status ?? undefined,
      vendor: f.vendor || undefined,
      payment: f.payment || undefined,
      ...next,
    };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) usp.set(k, v);
    const query = usp.toString();
    return query ? `/admin/orders?${query}` : "/admin/orders";
  };

  const tabs = [
    { href: href({ status: undefined }), label: "All", count: scoped.length },
    ...ORDER_STATUS_ORDER.map((s) => ({
      href: href({ status: s }),
      label: ORDER_STATUS[s].short,
      count: scoped.filter((o) => o.status === s).length,
    })).filter((t) => t.count > 0),
  ];

  // Every shop with an order in the window, so the dropdown can only ever
  // offer a filter that has something behind it.
  const vendors = [...new Set(all.map((o) => o.restaurant))].sort();

  /* ---------- summary ----------
     Describes the *filtered* rows, not the whole window. The old version
     summarised everything loaded regardless of the filters above it, so
     narrowing to one shop left five figures about a different set of orders
     sitting under the table. */
  const inFlight = orders.filter((o) => IN_FLIGHT.includes(o.status)).length;
  const late = orders.filter((o) => (o.lateByMinutes ?? 0) > 0).length;
  const worst = orders.reduce((m, o) => Math.max(m, o.lateByMinutes ?? 0), 0);
  const cancelled = orders.filter((o) => o.status === "CANCELLED").length;
  const value = orders.reduce((sum, o) => sum + o.total, 0);
  const earned = orders.reduce((sum, o) => sum + (o.profit ?? 0), 0);

  const columns: Column<AdminOrderRow>[] = [
    {
      key: "code",
      header: "Order",
      role: "title",
      width: "w-[140px]",
      cell: (o) => (
        <div className="min-w-0">
          <p className="text-data text-[11.5px] font-semibold text-ink">
            {o.code}
          </p>
          <p className="truncate text-[13px] text-ink @3xl:hidden">
            {o.customer}
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
      role: "wideOnly",
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
              {o.paymentMethod === "online" ? "Online" : "Cash"}
            </p>
            {o.paymentStatus && o.paymentStatus !== "paid" ? (
              <p
                className={
                  o.paymentStatus === "failed"
                    ? "truncate text-[11px] font-semibold text-deal"
                    : "truncate text-[11px] text-[color:var(--c-ink-amber)]"
                }
              >
                {o.paymentStatus}
              </p>
            ) : null}
          </div>
        ) : (
          <span className="text-[11.5px] text-[color:var(--c-faint)]">—</span>
        ),
    },
    {
      key: "status",
      header: "Stage",
      role: "trailing",
      width: "w-[124px]",
      cell: (o) => (
        <span className="inline-flex flex-col items-end gap-0.5 @3xl:items-start">
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
      role: "wideOnly",
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
      role: "actions",
      align: "right",
      width: "w-[72px]",
      // Open only. An admin-initiated refund has no server action behind it —
      // refunds are raised against an order and then decided on the Refunds
      // screen — and a button that cannot do the thing it names is worse than
      // no button.
      cell: (o) =>
        o.id ? (
          <Link href={`/admin/orders/${o.id}`} className="c-btn-affirm press">
            Open
          </Link>
        ) : null,
    },
  ];

  const filtered = Boolean(f.q || f.status || f.vendor || f.payment);

  return (
    <>
      {isSupabaseConfigured ? <AutoRefresh interval={REFRESH_MS} /> : null}

      <PageHeader
        title="Orders"
        description={`Live order operations — the last ${windowSize} orders, plus everything still moving. Refreshing every ${Math.round(REFRESH_MS / 1000)}s.`}
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
            value={f.vendor}
            options={[
              { value: "", label: "All vendors" },
              ...vendors.map((v) => ({ value: v, label: v })),
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
            ]}
          />
          <FilterSubmit />
        </FilterForm>
        {filtered ? <FilterReset href="/admin/orders" /> : null}
      </Toolbar>

      {tabs.length > 2 ? (
        <Tabs
          label="Order stage"
          active={href({ status: f.status ?? undefined })}
          items={tabs}
        />
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
          note={`across ${orders.length} order${orders.length === 1 ? "" : "s"}`}
        />
        <Figure
          label="You earn"
          value={formatINR(earned)}
          note="commission + GST + charges"
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
        minWidth={1180}
        footer={
          <TableFooter
            page={1}
            totalPages={1}
            hrefFor={() => "/admin/orders"}
            summary={
              filtered
                ? `${orders.length} of ${all.length} in this window`
                : `${all.length} order${all.length === 1 ? "" : "s"} in this window`
            }
          />
        }
        empty={
          filtered ? (
            <Empty action={{ href: "/admin/orders", label: "Clear filters" }}>
              Nothing in the last {windowSize} orders matches. Older orders are
              not in this window.
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
