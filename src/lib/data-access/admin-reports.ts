import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { addIstDays } from "@/lib/utils/ist-time";
import { shortOrderId } from "@/lib/utils/order-map";
import {
  breakdownOrder,
  sumSettlementTotals,
  type SettlementTotals,
} from "@/lib/settlements/math";
import {
  effectiveCommissionPct,
  getCommissionGstPct,
  getVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import {
  parseIstDateInput,
  type SettlementStatus,
} from "@/lib/data-access/admin-settlements";
import { formatDayKey, istDay } from "@/lib/settlements/cycle";
import {
  REPORT_KINDS,
  type PaymentFilter,
  type ReportDay,
  type ReportFilters,
  type ReportKind,
  type ReportResult,
} from "@/lib/reports/kinds";

// Re-exported so server callers can keep importing everything from one place.
export {
  REPORT_KINDS,
  type PaymentFilter,
  type ReportDay,
  type ReportFilters,
  type ReportKind,
  type ReportResult,
};

/**
 * The reports the platform owner and a shop owner both need to close their
 * books: what sold, what was earned, what each order was worth, and what has
 * been paid out.
 *
 * Every money figure comes from `@/lib/settlements/math` — the same functions
 * the settlement screen and the order payouts screen use. That is not tidiness
 * for its own sake: a report that computes commission its own way is a report
 * that will eventually disagree with the payout it is supposed to explain, and
 * the person holding both printouts has no way to tell which is right.
 *
 * Admin-gated by the caller (AGENTS.md §5). Reads ride the service-role client
 * because commission_pct is not readable by anon/authenticated (0032).
 */

const nf = new Intl.NumberFormat("en-IN");
const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/** Sensible default range: the last 30 days including today. */
export function defaultRange(): { from: string; to: string } {
  const to = istDay();
  const d = new Date(`${to}T00:00:00Z`);
  const from = new Date(d.getTime() - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

interface OrderRow {
  id: string;
  restaurant_id: string;
  total: number;
  delivery_fee: number | null;
  tax_amount: number | null;
  tip: number | null;
  status: string;
  created_at: string;
  payment_method?: string | null;
  payment_status?: string | null;
  /** 0031 / 0041. Absent on a database that predates them. */
  discount?: number | null;
  discount_funded_by?: string | null;
}

const ORDER_SELECT =
  "id, restaurant_id, total, delivery_fee, tax_amount, tip, status, created_at, payment_method, payment_status";
/**
 * 0041's funder columns, asked for separately.
 *
 * A report that names a column the database does not have is a 400, and these
 * arrive later than everything else in ORDER_SELECT. Without them every
 * discount prices as vendor-absorbed, which is what this file did before the
 * columns existed — the report degrades to the old arithmetic rather than
 * failing to render.
 */
const ORDER_SELECT_WITH_DISCOUNT = `${ORDER_SELECT}, discount, discount_funded_by`;
/** PostgREST's "column does not exist". */
const UNDEFINED_COLUMN = "42703";
/** null = not probed yet; latches after the first query. */
let hasDiscountFunding: boolean | null = null;

/** IST calendar day of an instant, as "YYYY-MM-DD". */
function dayOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 5.5 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

interface Context {
  orders: OrderRow[];
  vendorNames: Map<string, string>;
  commissionPct: Map<string, number>;
  otherCharges: Map<string, number>;
  commissionGstPct: number;
  refunds: Map<string, number>;
}

/**
 * Load the window once, and reuse it for whichever report was asked for.
 *
 * Deliberately capped. A report that silently returns the first 5,000 orders of
 * a wider range is worse than one that refuses, so the cap is surfaced in the
 * subtitle rather than swallowed.
 */
const MAX_ORDERS = 5000;

async function loadContext(filters: ReportFilters): Promise<Context | { error: string }> {
  const from = parseIstDateInput(filters.from);
  const to = parseIstDateInput(filters.to);
  if (!from || !to) return { error: "Pick a start and end date." };
  if (to < from) return { error: "The end date must be on or after the start date." };

  const supabase = createAdminClient();
  const runOrders = (cols: string) => {
    let q = supabase
      .from("orders")
      .select(cols)
      .gte("created_at", from.toISOString())
      .lt("created_at", addIstDays(to, 1).toISOString())
      // Cancelled orders are not sales. They are counted separately by the
      // orders report, which asks for them on purpose.
      .neq("status", "cancelled");

    if (filters.vendorId) q = q.eq("restaurant_id", filters.vendorId);
    if (filters.payment && filters.payment !== "all") {
      q = q.eq("payment_method", filters.payment);
    }
    return q.order("created_at", { ascending: true }).limit(MAX_ORDERS);
  };

  let result = await runOrders(
    hasDiscountFunding === false ? ORDER_SELECT : ORDER_SELECT_WITH_DISCOUNT
  );
  if (result.error && hasDiscountFunding !== false) {
    if (result.error.code !== UNDEFINED_COLUMN) throw result.error;
    hasDiscountFunding = false;
    result = await runOrders(ORDER_SELECT);
  } else if (!result.error) {
    hasDiscountFunding = hasDiscountFunding ?? true;
  }
  if (result.error) throw result.error;

  const orders = (result.data ?? []) as unknown as OrderRow[];
  const ids = [...new Set(orders.map((o) => o.restaurant_id))];

  const [vendors, platformDefault, commissionGstPct, refunds] = await Promise.all([
    loadVendors(ids),
    getVendorCommissionDefault(),
    getCommissionGstPct(),
    loadRefunds(orders.map((o) => o.id)),
  ]);

  const commissionPct = new Map<string, number>();
  const otherCharges = new Map<string, number>();
  const vendorNames = new Map<string, string>();
  for (const v of vendors) {
    vendorNames.set(v.id, v.name);
    commissionPct.set(v.id, effectiveCommissionPct(v.commissionPct, platformDefault));
    otherCharges.set(v.id, v.otherCharges);
  }

  return { orders, vendorNames, commissionPct, otherCharges, commissionGstPct, refunds };
}

async function loadVendors(ids: string[]): Promise<
  { id: string; name: string; commissionPct: number | null; otherCharges: number }[]
> {
  if (ids.length === 0) return [];
  const supabase = createAdminClient();

  // Same optional-column dance as the settlement ledger: 0034's per-order
  // charge may not exist yet, and a report must not fail because of it.
  const read = (withCharges: boolean) =>
    supabase
      .from("restaurants")
      .select(
        `id, name, commission_pct${withCharges ? ", other_charges_per_order" : ""}`
      )
      .in("id", ids);

  let result = await read(true);
  if (result.error) result = await read(false);
  if (result.error) throw result.error;

  return ((result.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: ((r.name as string) ?? "").trim() || "Shop",
    commissionPct:
      r.commission_pct === null || r.commission_pct === undefined
        ? null
        : Number(r.commission_pct),
    otherCharges: Math.max(0, Math.round(Number(r.other_charges_per_order ?? 0))),
  }));
}

async function loadRefunds(orderIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (orderIds.length === 0) return map;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("refunds")
    .select("order_id, amount")
    .in("order_id", orderIds.slice(0, MAX_ORDERS))
    .eq("status", "approved");
  if (error) return map;
  for (const r of data ?? []) {
    const id = r.order_id as string;
    map.set(id, (map.get(id) ?? 0) + Number(r.amount ?? 0));
  }
  return map;
}

/** One order, priced with the shared settlement arithmetic. */
function priceOrder(o: OrderRow, ctx: Context) {
  return breakdownOrder({
    total: Number(o.total) || 0,
    deliveryFee: Number(o.delivery_fee) || 0,
    taxAmount: Number(o.tax_amount) || 0,
    tip: Number(o.tip) || 0,
    discount: Number(o.discount ?? 0) || 0,
    // Anything not explicitly the platform's is the shop's, null included —
    // see SettlementOrderInput.discountFundedBy on why that direction.
    discountFundedBy: o.discount_funded_by === "platform" ? "platform" : "vendor",
    commissionPct: ctx.commissionPct.get(o.restaurant_id) ?? 0,
    commissionGstPct: ctx.commissionGstPct,
    otherCharges: ctx.otherCharges.get(o.restaurant_id) ?? 0,
    paymentMethod:
      o.payment_method === "online" || o.payment_method === "cod"
        ? o.payment_method
        : null,
    paymentStatus:
      o.payment_status === "paid" || o.payment_status === "pending"
        ? o.payment_status
        : null,
    approvedRefunds: ctx.refunds.get(o.id) ?? 0,
  });
}

/** How many days a report will plot before the axis is a smear rather than a scale. */
const MAX_SERIES_DAYS = 180;

const dayLabelFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/**
 * The window as one row per IST calendar day, zero-filled.
 *
 * Built from `ctx.orders` — the exact set the tables are built from, already
 * narrowed by vendor and payment method — so the chart and the table below it
 * can never be answering different questions. That is the whole reason this
 * lives here rather than the page calling `getAdminSeries` alongside.
 *
 * Ranges longer than `MAX_SERIES_DAYS` return nothing rather than a plot with
 * six hundred points in it. The table still covers the full range; only the
 * chart declines, and the page says so instead of drawing an unreadable one.
 */
function buildSeries(f: ReportFilters, ctx: Context): ReportDay[] {
  const start = parseIstDateInput(f.from);
  const end = parseIstDateInput(f.to);
  if (!start || !end) return [];

  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > MAX_SERIES_DAYS) return [];

  // Buckets first, so the shape of the answer never depends on what came back.
  const buckets = new Map<string, ReportDay>();
  for (let i = 0; i < days; i++) {
    // `parseIstDateInput` returns the IST midnight of the day as an instant, so
    // stepping and re-slicing in UTC walks calendar days without a zone shift.
    const at = new Date(start.getTime() + i * 86_400_000);
    const key = at.toISOString().slice(0, 10);
    buckets.set(key, {
      date: key,
      // Formatted as UTC for the same reason: the instant already *is* the day
      // we mean, and re-applying an offset would shift half the labels back a
      // date.
      label: dayLabelFmt.format(at),
      orders: 0,
      sales: 0,
    });
  }

  for (const o of ctx.orders) {
    const bucket = buckets.get(dayOf(o.created_at));
    // An order outside the requested range cannot happen — `loadContext`
    // filters on it — but a bucket miss must drop the order rather than invent
    // a day for it.
    if (!bucket) continue;
    bucket.orders += 1;
    bucket.sales += Math.round(Number(o.total) || 0);
  }

  return [...buckets.values()];
}

function rangeSubtitle(f: ReportFilters, count: number, vendorName?: string): string {
  const parts = [`${formatDayKey(f.from)} to ${formatDayKey(f.to)}`];
  if (vendorName) parts.push(vendorName);
  if (f.payment && f.payment !== "all") {
    parts.push(f.payment === "cod" ? "cash orders only" : "online orders only");
  }
  parts.push(`${nf.format(count)} order${count === 1 ? "" : "s"}`);
  if (count >= MAX_ORDERS) {
    parts.push(`showing the first ${nf.format(MAX_ORDERS)} — narrow the dates`);
  }
  return parts.join(" · ");
}

/* ------------------------------------------------------------------
 * The reports.
 * ------------------------------------------------------------------ */

/**
 * What each report function returns: everything but the daily series, which
 * `buildReport` attaches once rather than four times.
 */
type ReportBody = Omit<ReportResult, "series">;

export async function buildReport(
  filters: ReportFilters
): Promise<ReportResult | { error: string }> {
  const ctx = await loadContext(filters);
  if ("error" in ctx) return ctx;

  const vendorName = filters.vendorId
    ? ctx.vendorNames.get(filters.vendorId)
    : undefined;
  const subtitle = rangeSubtitle(filters, ctx.orders.length, vendorName);

  // Attached here rather than inside each report: four of the five plot the
  // same two series over the same window, and the fifth is grouped by batch
  // rather than by day, so a daily line under it would be a chart of something
  // the table is not about.
  const series = filters.kind === "settlement" ? [] : buildSeries(filters, ctx);

  switch (filters.kind) {
    case "sales":
      return { ...salesReport(filters, ctx, subtitle), series };
    case "earnings":
      return { ...earningsReport(filters, ctx, subtitle), series };
    case "orders":
      return { ...ordersReport(filters, ctx, subtitle), series };
    case "average-order":
      return { ...averageOrderReport(filters, ctx, subtitle), series };
    case "settlement":
      // Grouped by payout, not by day, so it plots nothing — see the note on
      // `series` above.
      return { ...(await settlementReport(filters, subtitle)), series };
  }
}

/** Day by day: how many orders and how much money came in. */
function salesReport(
  f: ReportFilters,
  ctx: Context,
  subtitle: string
): ReportBody {
  const byDay = new Map<
    string,
    { orders: number; sales: number; cash: number; online: number }
  >();

  for (const o of ctx.orders) {
    const day = dayOf(o.created_at);
    const bucket =
      byDay.get(day) ?? { orders: 0, sales: 0, cash: 0, online: 0 };
    const total = Math.round(Number(o.total) || 0);
    bucket.orders += 1;
    bucket.sales += total;
    if (o.payment_method === "online") bucket.online += total;
    else bucket.cash += total;
    byDay.set(day, bucket);
  }

  const rows = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, b]) => ({
      day: formatDayKey(day),
      orders: b.orders,
      sales: b.sales,
      cash: b.cash,
      online: b.online,
    }));

  const totals = rows.reduce(
    (acc, r) => ({
      day: "Total",
      orders: acc.orders + r.orders,
      sales: acc.sales + r.sales,
      cash: acc.cash + r.cash,
      online: acc.online + r.online,
    }),
    { day: "Total", orders: 0, sales: 0, cash: 0, online: 0 }
  );

  return {
    kind: f.kind,
    title: "Sales report",
    subtitle,
    highlights: [
      { label: "Total sales", value: money(totals.sales), note: "money customers paid" },
      { label: "Orders", value: nf.format(totals.orders) },
      { label: "Paid in cash", value: money(totals.cash) },
      { label: "Paid online", value: money(totals.online) },
    ],
    table: {
      columns: [
        { key: "day", label: "Day" },
        { key: "orders", label: "Orders", align: "right" },
        { key: "cash", label: "Cash", align: "right", money: true },
        { key: "online", label: "Online", align: "right", money: true },
        { key: "sales", label: "Total sales", align: "right", money: true },
      ],
      rows,
      totals,
    },
    empty: rows.length === 0,
  };
}

/**
 * Who earned what. One row per shop, so it answers the platform owner's
 * question ("what did we keep") and each shop owner's ("what did I earn") from
 * the same table.
 */
function earningsReport(
  f: ReportFilters,
  ctx: Context,
  subtitle: string
): ReportBody {
  const byVendor = new Map<
    string,
    { orders: number; sales: number } & SettlementTotals
  >();

  for (const o of ctx.orders) {
    const bd = priceOrder(o, ctx);
    const key = o.restaurant_id;
    const acc =
      byVendor.get(key) ??
      {
        orders: 0,
        sales: 0,
        foodGross: 0,
        commission: 0,
        commissionGst: 0,
        otherCharges: 0,
        refundsRecovered: 0,
        netPayable: 0,
      };
    acc.orders += 1;
    acc.sales += bd.orderTotal;
    acc.foodGross += bd.foodGross;
    acc.commission += bd.commission;
    acc.commissionGst += bd.commissionGst;
    acc.otherCharges += bd.otherCharges;
    acc.refundsRecovered += bd.refundRecovered;
    // The shop's earnings for the period, regardless of who is holding the
    // cash — that is a settlement question, not an earnings one.
    acc.netPayable += bd.vendorNet;
    byVendor.set(key, acc);
  }

  const rows = [...byVendor.entries()]
    .map(([id, v]) => ({
      shop: ctx.vendorNames.get(id) ?? "Shop",
      orders: v.orders,
      sales: v.sales,
      food: v.foodGross,
      commission: v.commission,
      gst: v.commissionGst,
      other: v.otherCharges,
      earned: v.netPayable,
    }))
    .sort((a, b) => b.sales - a.sales);

  const totals = rows.reduce(
    (acc, r) => ({
      shop: "Total",
      orders: acc.orders + r.orders,
      sales: acc.sales + r.sales,
      food: acc.food + r.food,
      commission: acc.commission + r.commission,
      gst: acc.gst + r.gst,
      other: acc.other + r.other,
      earned: acc.earned + r.earned,
    }),
    { shop: "Total", orders: 0, sales: 0, food: 0, commission: 0, gst: 0, other: 0, earned: 0 }
  );

  const platformKeeps = totals.commission + totals.gst + totals.other;

  return {
    kind: f.kind,
    title: "Earnings report",
    subtitle,
    highlights: [
      { label: "Shops earned", value: money(totals.earned), note: "before refunds" },
      { label: "Platform kept", value: money(platformKeeps), note: "commission, GST and charges" },
      { label: "Commission", value: money(totals.commission) },
      { label: "GST on commission", value: money(totals.gst) },
    ],
    table: {
      columns: [
        { key: "shop", label: "Shop" },
        { key: "orders", label: "Orders", align: "right" },
        { key: "sales", label: "Customers paid", align: "right", money: true },
        { key: "food", label: "Food value", align: "right", money: true },
        { key: "commission", label: "Commission", align: "right", money: true },
        { key: "gst", label: "GST on commission", align: "right", money: true },
        { key: "other", label: "Other charges", align: "right", money: true },
        { key: "earned", label: "Shop earned", align: "right", money: true },
      ],
      rows,
      totals,
    },
    empty: rows.length === 0,
  };
}

/** Every order, one per line — the report you reconcile against. */
function ordersReport(
  f: ReportFilters,
  ctx: Context,
  subtitle: string
): ReportBody {
  const rows = ctx.orders.map((o) => {
    const bd = priceOrder(o, ctx);
    return {
      order: shortOrderId(o.id),
      day: formatDayKey(dayOf(o.created_at)),
      shop: ctx.vendorNames.get(o.restaurant_id) ?? "Shop",
      how:
        o.payment_method === "online"
          ? o.payment_status === "paid"
            ? "Online (paid)"
            : "Online (unpaid)"
          : "Cash",
      status: o.status,
      total: bd.orderTotal,
      delivery: bd.deliveryFee,
      tax: bd.taxAmount,
      tip: bd.tip,
      food: bd.foodGross,
      commission: bd.commission + bd.commissionGst + bd.otherCharges,
      shopGets: bd.vendorNet,
    };
  });

  const sum = (k: keyof (typeof rows)[number]) =>
    rows.reduce((acc, r) => acc + (Number(r[k]) || 0), 0);

  return {
    kind: f.kind,
    title: "Orders report",
    subtitle,
    highlights: [
      { label: "Orders", value: nf.format(rows.length) },
      { label: "Total value", value: money(sum("total")) },
      { label: "Food value", value: money(sum("food")) },
      { label: "Shops earned", value: money(sum("shopGets")) },
    ],
    table: {
      columns: [
        { key: "order", label: "Order" },
        { key: "day", label: "Day" },
        { key: "shop", label: "Shop" },
        { key: "how", label: "Paid by" },
        { key: "status", label: "Status" },
        { key: "total", label: "Customer paid", align: "right", money: true },
        { key: "delivery", label: "Delivery fee", align: "right", money: true },
        { key: "tax", label: "GST / taxes", align: "right", money: true },
        { key: "tip", label: "Tip", align: "right", money: true },
        { key: "food", label: "Food value", align: "right", money: true },
        { key: "commission", label: "Platform kept", align: "right", money: true },
        { key: "shopGets", label: "Shop earned", align: "right", money: true },
      ],
      rows,
      totals: {
        order: "Total",
        day: "",
        shop: "",
        how: "",
        status: "",
        total: sum("total"),
        delivery: sum("delivery"),
        tax: sum("tax"),
        tip: sum("tip"),
        food: sum("food"),
        commission: sum("commission"),
        shopGets: sum("shopGets"),
      },
    },
    empty: rows.length === 0,
  };
}

/** Average order value, day by day — is the basket growing or shrinking? */
function averageOrderReport(
  f: ReportFilters,
  ctx: Context,
  subtitle: string
): ReportBody {
  const byDay = new Map<string, { orders: number; sales: number }>();
  for (const o of ctx.orders) {
    const day = dayOf(o.created_at);
    const b = byDay.get(day) ?? { orders: 0, sales: 0 };
    b.orders += 1;
    b.sales += Math.round(Number(o.total) || 0);
    byDay.set(day, b);
  }

  const rows = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, b]) => ({
      day: formatDayKey(day),
      orders: b.orders,
      sales: b.sales,
      average: b.orders > 0 ? Math.round(b.sales / b.orders) : 0,
    }));

  const totalOrders = rows.reduce((a, r) => a + r.orders, 0);
  const totalSales = rows.reduce((a, r) => a + r.sales, 0);
  // The period average is computed from the period totals, not by averaging the
  // daily averages — a quiet Tuesday with two orders must not weigh the same as
  // a busy Saturday with two hundred.
  const periodAverage = totalOrders > 0 ? Math.round(totalSales / totalOrders) : 0;
  const best = rows.reduce<(typeof rows)[number] | null>(
    (b, r) => (b === null || r.average > b.average ? r : b),
    null
  );

  return {
    kind: f.kind,
    title: "Average order report",
    subtitle,
    highlights: [
      { label: "Average order value", value: money(periodAverage), note: "across the whole period" },
      { label: "Orders", value: nf.format(totalOrders) },
      { label: "Total sales", value: money(totalSales) },
      ...(best
        ? [{ label: "Best day", value: money(best.average), note: best.day }]
        : []),
    ],
    table: {
      columns: [
        { key: "day", label: "Day" },
        { key: "orders", label: "Orders", align: "right" },
        { key: "sales", label: "Total sales", align: "right", money: true },
        { key: "average", label: "Average order", align: "right", money: true },
      ],
      rows,
      totals: {
        day: "Whole period",
        orders: totalOrders,
        sales: totalSales,
        average: periodAverage,
      },
    },
    empty: rows.length === 0,
  };
}

/**
 * What has actually been paid out.
 *
 * Reads the settlement ledger rather than re-deriving anything: these are the
 * rupees that were snapshotted when each payout was built, so the report agrees
 * with the statements by construction even after a rate has changed.
 */
async function settlementReport(
  f: ReportFilters,
  subtitle: string
): Promise<ReportBody> {
  const from = parseIstDateInput(f.from);
  const to = parseIstDateInput(f.to);
  const supabase = createAdminClient();

  const read = (withExtras: boolean) => {
    let q = supabase
      .from("vendor_settlements")
      .select(
        `id, restaurant_id, period_start, period_end, food_gross, commission,
         refunds_recovered, net_payable, status, created_at, paid_at, payment_ref
         ${withExtras ? ", kind, commission_gst, other_charges" : ""},
         restaurants(name)`
      )
      .gte("created_at", from!.toISOString())
      .lt("created_at", addIstDays(to!, 1).toISOString());
    if (f.vendorId) q = q.eq("restaurant_id", f.vendorId);
    return q.order("created_at", { ascending: false }).limit(1000);
  };

  let result = await read(true);
  if (result.error) result = await read(false);
  if (result.error) throw result.error;

  const rows = ((result.data ?? []) as unknown as Record<string, unknown>[]).map(
    (r) => {
      const rest = r.restaurants as { name: string } | { name: string }[] | null;
      const name = Array.isArray(rest) ? rest[0]?.name : rest?.name;
      const commission = Number(r.commission) || 0;
      const gst = Number(r.commission_gst ?? 0) || 0;
      const other = Number(r.other_charges ?? 0) || 0;
      return {
        shop: name?.trim() || "Shop",
        kind: r.kind === "instant" ? "Paid early" : "Batch",
        period: `${formatDayKey(dayOf(r.period_start as string))} – ${formatDayKey(
          dayOf(new Date(new Date(r.period_end as string).getTime() - 1).toISOString())
        )}`,
        status:
          (r.status as SettlementStatus) === "paid"
            ? "Paid"
            : (r.status as SettlementStatus) === "void"
              ? "Cancelled"
              : "Not sent yet",
        food: Number(r.food_gross) || 0,
        deducted: commission + gst + other + (Number(r.refunds_recovered) || 0),
        paid: Number(r.net_payable) || 0,
        reference: (r.payment_ref as string | null) ?? "",
      };
    }
  );

  const live = rows.filter((r) => r.status !== "Cancelled");
  const sentOut = live
    .filter((r) => r.status === "Paid")
    .reduce((a, r) => a + r.paid, 0);
  const stillOwed = live
    .filter((r) => r.status === "Not sent yet")
    .reduce((a, r) => a + r.paid, 0);

  return {
    kind: "settlement",
    title: "Settlement report",
    subtitle: subtitle.replace(/\d+ orders?/, `${rows.length} payouts`),
    highlights: [
      { label: "Paid out", value: money(sentOut), note: "recorded as sent" },
      { label: "Still to pay", value: money(stillOwed), note: "worked out, not sent" },
      { label: "Payouts", value: nf.format(rows.length) },
      {
        label: "Paid early",
        value: nf.format(rows.filter((r) => r.kind === "Paid early").length),
        note: "single orders",
      },
    ],
    table: {
      columns: [
        { key: "shop", label: "Shop" },
        { key: "period", label: "Period" },
        { key: "kind", label: "Type" },
        { key: "status", label: "Status" },
        { key: "food", label: "Food value", align: "right", money: true },
        { key: "deducted", label: "Taken off", align: "right", money: true },
        { key: "paid", label: "Amount", align: "right", money: true },
        { key: "reference", label: "Reference" },
      ],
      rows,
      totals: {
        shop: "Total",
        period: "",
        kind: "",
        status: "",
        food: rows.reduce((a, r) => a + r.food, 0),
        deducted: rows.reduce((a, r) => a + r.deducted, 0),
        paid: live.reduce((a, r) => a + r.paid, 0),
        reference: "",
      },
    },
    empty: rows.length === 0,
  };
}

/** Shops for the report filter. Name order, every status. */
export async function listReportVendors(): Promise<
  { id: string; name: string }[]
> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(500);
  if (error) return [];
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: ((r.name as string) ?? "").trim() || "Shop",
  }));
}

/** Re-exported so the export helpers do not need the sum functions too. */
export { sumSettlementTotals };
