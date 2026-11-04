import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { shortOrderId } from "@/lib/utils/order-map";
import { formatDateTime } from "@/lib/utils/relative-time";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { breakdownOrder, platformDeductions } from "@/lib/settlements/math";
import {
  effectiveCommissionPct,
  getCommissionGstPct,
  getVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import { trend, type Trend } from "@/lib/data-access/admin-stats";
import { requireRole } from "@/lib/auth";
import { loadMetricOrders, loadPricing, loadRefunds } from "@/lib/data-access/ops-metrics";
import { adminEarnings } from "@/lib/metrics/admin";
import { istDayKey } from "@/lib/metrics/ist";
import { kitchenPace } from "@/lib/orders/kitchen-pace";
import { readInChunks } from "@/lib/data-access/read-all";
import { UNASSIGNED_AFTER_MIN } from "@/lib/dispatch/thresholds";
import { pageAcrossRuns } from "@/lib/utils/paging";
import type { AdminOrderRow } from "@/lib/roles-data";
import type { PaymentMethod, PaymentStatus } from "@/types";

/**
 * Admin all-orders feed, and the single-order view an operator opens when a
 * customer rings up to complain.
 *
 * Admins may see every order (is_admin() in the RLS policies); we use the
 * service-role client here so the customer / restaurant / items joins come back
 * in one query. The caller MUST already be role-gated to admin — the /admin
 * layout's `requireRole("admin")` runs before any page under it renders, and
 * every export below is reachable only from those pages. That gate is the
 * authorization for the createAdminClient() calls in this file (AGENTS.md §5).
 *
 * What this file used to hide, and no longer does:
 *
 *   * `ready` was mapped to "KITCHEN", so an operator could not tell a kitchen
 *     still cooking from one whose food had been sitting on the pass waiting for
 *     a rider — the exact window where an order goes wrong.
 *   * how an order was paid was not read at all. An online order that never
 *     settled is invisible to the kitchen by design (see vendor-orders.ts), so
 *     the admin is the only person who can see that it is stuck.
 *   * nothing computed lateness, because until 0026 nothing recorded when the
 *     kitchen accepted an order or when the food was ready.
 */

/* ============================================================
   Status
   ============================================================ */

const STATUS_MAP: Record<string, AdminOrderRow["status"]> = {
  placed: "PLACED",
  kitchen: "KITCHEN",
  ready: "READY",
  on_the_way: "ON_THE_WAY",
  delivered: "DELIVERED",
  cancelled: "CANCELLED",
};

/** One `order_status` value in, one admin pill out. No folding. */
export function adminOrderStatus(dbStatus: string): AdminOrderRow["status"] {
  return STATUS_MAP[dbStatus] ?? "PLACED";
}

/** The stages an order is still in flight, and can therefore still run late. */
const ACTIVE_DB_STATUSES = ["placed", "kitchen", "ready", "on_the_way"];

/* ============================================================
   Lateness
   ------------------------------------------------------------
   Deliberately computed here rather than imported.

   `src/lib/orders/eta.ts` answers the customer's question — "when will my food
   get here" — from the same three inputs: the restaurant's advertised band,
   `platform_settings.default_prep_minutes`, and 0026's lifecycle stamps. This
   answers the operator's much smaller one: "how far past the promise is this
   order, right now". The two arrived in the same release from opposite ends and
   SHOULD be one module: once both have landed, fold this into eta.ts and have
   the admin list call `computeOrderEta(...).lateByMinutes`. Until then, keeping
   the copy small and local beats a cross-import between two moving parts.
   ============================================================ */

const MINUTE = 60_000;

/**
 * `default_prep_minutes` is a free-text admin field. Clamped rather than
 * trusted: a stray 0 (or 6000) must not turn every order on the board red.
 */
const MIN_PREP_MINUTES = 1;
const MAX_PREP_MINUTES = 180;

/** No road leg is shorter than this, whatever the subtraction produces. */
const MIN_RIDE_MINUTES = 5;

/** Only reached when a restaurant has advertised no band at all. */
const FALLBACK_RIDE_MINUTES = 10;

/**
 * How far past the advertised band an order goes before it is called late.
 *
 * A band is a promise with a range, and a minute either side of its outer edge
 * is noise. An ops screen that shouts at one minute is an ops screen nobody
 * reads. The reported figure is still measured from the true edge, so the first
 * thing this ever says is "5 min late" rather than "1 min late".
 */
const LATE_GRACE_MINUTES = 5;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function positiveMinutes(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function clampPrepMinutes(value: number | null | undefined): number {
  const minutes = positiveMinutes(value) ?? MIN_PREP_MINUTES;
  return Math.min(Math.max(minutes, MIN_PREP_MINUTES), MAX_PREP_MINUTES);
}

interface LatenessInput {
  status: AdminOrderRow["status"];
  createdAt: string;
  /** 0026. Null both when the stage hasn't happened and when the column is absent. */
  acceptedAt?: string | null;
  readyAt?: string | null;
  etaMin?: number | null;
  etaMax?: number | null;
  /** Already clamped by `clampPrepMinutes` — read once per page, not per row. */
  prepMinutes: number;
  now: number;
}

/**
 * Minutes past the promise, or null when the order isn't late (or can't be).
 *
 * Delivered and cancelled orders return null: `orders` records no delivered_at,
 * so there is no honest way to say whether a finished order finished late, and
 * inventing one on an operations screen is worse than saying nothing.
 *
 * Every missing input degrades toward "not late" rather than toward a red
 * badge. A database without 0026 has no `accepted_at`, so a cooking order is
 * treated as though it could be plated at any moment — which understates
 * lateness, and is the right direction to be wrong in: a false "late" flag
 * sends an operator to ring a kitchen that is doing nothing wrong.
 */
function minutesLate(input: LatenessInput): number | null {
  if (input.status === "DELIVERED" || input.status === "CANCELLED") return null;

  const createdMs = parseMs(input.createdAt);
  if (createdMs === null) return null;

  const prep = input.prepMinutes;

  // The band, door to door. eta_min is what the storefront advertised; eta_max
  // is what the platform is actually held to, so lateness is measured from it.
  const advertisedMin = positiveMinutes(input.etaMin);
  const advertisedMax = positiveMinutes(input.etaMax);
  const advertised =
    advertisedMin ?? advertisedMax ?? prep + FALLBACK_RIDE_MINUTES;

  const ride = Math.max(advertised - prep, MIN_RIDE_MINUTES);
  // A promise shorter than its own two legs would make every order late from
  // the instant it was placed, so the target absorbs the difference.
  const target = Math.max(advertised, prep + ride);
  const outer = Math.max(advertisedMax ?? target, target);

  const targetMs = createdMs + target * MINUTE;
  const dueMs = createdMs + outer * MINUTE;

  const acceptedMs = parseMs(input.acceptedAt);
  const readyMs = parseMs(input.readyAt);
  const now = input.now;

  // The earliest handover still physically possible given what has actually
  // happened. This is the half that moves, and it is why an order sitting in
  // `ready` gets later by the minute instead of freezing at its checkout promise.
  let earliestMs: number;
  switch (input.status) {
    case "PLACED":
      // Nobody has started cooking, so it is still a full prep plus a full road
      // from whenever they do. Every minute the kitchen takes to accept pushes
      // the door time back by a minute — arithmetic, not pessimism.
      earliestMs = now + (prep + ride) * MINUTE;
      break;
    case "KITCHEN":
      earliestMs =
        Math.max(
          acceptedMs === null ? now : acceptedMs + prep * MINUTE,
          now
        ) +
        ride * MINUTE;
      break;
    case "READY":
      // Packed, waiting for a rider: the road leg has not started, so it can
      // only start now.
      earliestMs = now + ride * MINUTE;
      break;
    case "ON_THE_WAY": {
      // Not re-floored at `now`: the rider is moving and could knock at any
      // second, so an estimate that has slipped into the past is information.
      const leftMs = readyMs ?? acceptedMs;
      earliestMs = leftMs === null ? targetMs : leftMs + ride * MINUTE;
      break;
    }
    default:
      earliestMs = targetMs;
  }

  const expectedMs = Math.max(targetMs, earliestMs);
  // Whichever is worse: how far past the band we already are, or how far past
  // it we now expect to end up.
  const overshoot = Math.round((Math.max(expectedMs, now) - dueMs) / MINUTE);
  return overshoot >= LATE_GRACE_MINUTES ? overshoot : null;
}

/* ============================================================
   Schema probes (AGENTS.md §9)
   ============================================================ */

/** `payment_method` / `payment_status` arrive together in 0025. */
const PAYMENT_COLUMNS = "orders.payment_method";
/** `wallet_points_used` arrives in 0197. */
const WALLET_COLUMN = "orders.wallet_points_used";
/** `accepted_at` / `ready_at` / `cancelled_at` arrive together in 0026. */
const LIFECYCLE_COLUMNS = "orders.accepted_at";
/** `tip` arrives in 0013, and is part of the charge breakdown. */
const TIP_COLUMN = "orders.tip";
/** Also 0026, but a different table and a different query. */
const LOCATION_SOURCE_COLUMN = "deliveries.driver_location_source";
/**
 * `restaurants.other_charges_per_order` arrives in 0034 (same key
 * `admin-settlements.ts` probes, so the two share one cached answer).
 */
const RESTAURANT_TERM_COLUMN = "restaurants.other_charges_per_order";
/**
 * `restaurants.busy_until` / `busy_extra_minutes` arrive together in 0036
 * (same key `order-tracking.ts` probes for the same columns).
 */
const KITCHEN_PACE_COLUMN = "restaurants.prep_minutes";

type Flags = Record<string, boolean>;

interface ProbeGroup {
  /** Key inside `Flags`, read by the column builder. */
  key: string;
  /** schema-probe key — shared app-wide, so one probe answers everywhere. */
  column: string;
}

interface QueryResult<T> {
  data: T | null;
  error: { code?: string } | null;
}

/** The query succeeded, so every group still switched on is really there. */
function rememberPresent(groups: ProbeGroup[], flags: Flags): void {
  for (const g of groups) if (flags[g.key]) rememberColumn(g.column, true);
}

/**
 * Run a query, narrowing the column list on a database that is running a
 * migration or two behind.
 *
 * Asking PostgREST for a column that doesn't exist is a hard 400, not a null, so
 * one un-applied migration would otherwise blank the entire orders screen —
 * which is precisely the screen an operator opens when something has gone wrong.
 * Each optional group is dropped independently and remembered, so an environment
 * missing one migration still gets everything the others provide, and the retry
 * cost is paid once per process.
 *
 * `groups` must be ordered newest-migration-first: `isMissingColumn` doesn't say
 * WHICH column PostgREST objected to, so we drop the newest group and re-probe
 * rather than guess.
 */
async function selectProbed<T>(
  groups: ProbeGroup[],
  columns: (flags: Flags) => string,
  run: (columns: string) => PromiseLike<QueryResult<T>>
): Promise<{ data: T | null; flags: Flags }> {
  const flags: Flags = {};
  for (const g of groups) flags[g.key] = !columnKnownMissing(g.column);

  for (const { key, column } of groups) {
    if (!flags[key]) continue;

    const { data, error } = await run(columns(flags));
    if (!error) {
      rememberPresent(groups, flags);
      return { data: data ?? null, flags };
    }
    if (!isMissingColumn(error)) throw error;

    rememberColumn(column, false);
    flags[key] = false;
  }

  // Reached when every optional group has been ruled out — the bare query the
  // schema has supported since 0001.
  const { data, error } = await run(columns(flags));
  if (error) throw error;
  return { data: data ?? null, flags };
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * A malformed id is answered like a missing one.
 *
 * Postgres rejects a non-uuid with 22P02, which would surface as a 500 and tell
 * a prober that their input at least reached the database. "Not a real id" and
 * "no such order" are the same answer here (AGENTS.md consistent-404 rule).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ============================================================
   The list
   ============================================================ */

// Newest-migration-first, as `selectProbed` requires: kitchen pace is 0036,
// other_charges_per_order is 0034, lifecycle is 0026, payment is 0025, tip is
// 0013.
const LIST_GROUPS: ProbeGroup[] = [
  { key: "wallet", column: WALLET_COLUMN },
  { key: "kitchenPace", column: KITCHEN_PACE_COLUMN },
  { key: "restaurantTerms", column: RESTAURANT_TERM_COLUMN },
  { key: "lifecycle", column: LIFECYCLE_COLUMNS },
  { key: "payment", column: PAYMENT_COLUMNS },
  { key: "tip", column: TIP_COLUMN },
];

function listColumns(flags: Flags): string {
  return [
    "id, status, total, delivery_fee, tax_amount, created_at",
    flags.wallet ? ", wallet_points_used" : "",
    flags.tip ? ", tip" : "",
    flags.payment ? ", payment_method, payment_status" : "",
    flags.lifecycle ? ", accepted_at, ready_at" : "",
    // `commission_pct` is 0017 and unconditional here, same as
    // admin-settlements.ts's RESTAURANT_BASE — a database carrying 0025/0026
    // (both probed above) necessarily has it too.
    `, restaurants(name, eta_min, eta_max, commission_pct${
      flags.restaurantTerms ? ", other_charges_per_order" : ""
    }${flags.kitchenPace ? ", busy_until, busy_extra_minutes" : ""})`,
    ", customer:profiles!orders_customer_id_fkey(full_name)",
    // What was actually ordered. The list used to show an order's code, its
    // shop, its customer and its value but never the food — so the one question
    // an operator taking a phone call has ("what did they order?") could only be
    // answered by opening each row.
    //
    // `name, qty` only. The detail view pulls `price` too, because it prints a
    // bill; a summary line does not need it and this query runs on a 4s poll.
    // Not probed like the columns above: order_items is a base table the detail
    // query already joins unconditionally.
    ", order_items(name, qty)",
  ].join("");
}

interface RestaurantRef {
  name: string | null;
  eta_min?: number | null;
  eta_max?: number | null;
  /** 0036 — the "we're slammed" bump. */
  busy_until?: string | null;
  busy_extra_minutes?: number | null;
}

/** The list's restaurant embed, with the rate this row's profit is priced at. */
interface ListRestaurantRef extends RestaurantRef {
  commission_pct: number | null;
  other_charges_per_order?: number | null;
}

interface ListRow {
  id: string;
  status: string;
  total: number;
  delivery_fee: number | null;
  tax_amount: number | null;
  tip?: number | null;
  created_at: string;
  payment_method?: PaymentMethod | null;
  wallet_points_used?: number | null;
  payment_status?: PaymentStatus | null;
  accepted_at?: string | null;
  ready_at?: string | null;
  restaurants: ListRestaurantRef | ListRestaurantRef[] | null;
  customer:
    | { full_name: string | null }
    | { full_name: string | null }[]
    | null;
  order_items: { name: string | null; qty: number | null }[] | null;
}

/**
 * How many still-active orders to pull in on top of the newest page.
 *
 * A stuck order is, by definition, the one that has scrolled off the bottom of a
 * newest-first list — so a list that only ever shows the newest N cannot show
 * the thing this screen exists for. Capped so a backlog can't turn the query
 * into a full table scan of every order ever placed.
 */
const ACTIVE_WINDOW = 100;

interface RankedRow {
  row: AdminOrderRow;
  createdAtMs: number;
  lateBy: number | null;
}

/**
 * What the platform keeps from an order: commission + GST on commission +
 * other charges, at the vendor's own rate. The same three figures the
 * Settlements screen calls "Platform keeps" — reusing `breakdownOrder` rather
 * than re-deriving them keeps every screen that quotes this number from ever
 * disagreeing with the others.
 *
 * `paymentMethod`/`paymentStatus`/`approvedRefunds` are irrelevant to this
 * figure (they only steer `contribution`, which is discarded below), so
 * placeholders stand in rather than pulling refunds into a screen that polls
 * every 4 seconds. Discount funding is left unset for the same reason —
 * `foodGrossFromOrder`'s default (every discount reads as vendor-absorbed) is
 * the safe direction to be wrong in for a live estimate, not a payout.
 */
function platformEarningsOn(
  order: { total: number; deliveryFee: number; taxAmount: number; tip: number },
  commissionPct: number,
  commissionGstPct: number,
  otherCharges: number
): number {
  const bd = breakdownOrder({
    total: order.total,
    deliveryFee: order.deliveryFee,
    taxAmount: order.taxAmount,
    tip: order.tip,
    commissionPct,
    commissionGstPct,
    otherCharges,
    paymentMethod: null,
    paymentStatus: null,
    approvedRefunds: 0,
  });
  return platformDeductions(bd);
}

/** Null for a cancelled order: there is no food value to take a cut of. */
function profitFor(
  r: Pick<ListRow, "total" | "delivery_fee" | "tax_amount" | "tip">,
  status: AdminOrderRow["status"],
  restaurant: ListRestaurantRef | null,
  commissionDefaultPct: number,
  commissionGstPct: number
): number | null {
  if (status === "CANCELLED") return null;
  return platformEarningsOn(
    {
      total: r.total,
      deliveryFee: r.delivery_fee ?? 0,
      taxAmount: r.tax_amount ?? 0,
      tip: r.tip ?? 0,
    },
    effectiveCommissionPct(restaurant?.commission_pct, commissionDefaultPct),
    commissionGstPct,
    Math.max(0, Math.round(restaurant?.other_charges_per_order ?? 0))
  );
}

function mapListRow(
  r: ListRow,
  prepMinutes: number,
  now: number,
  commissionDefaultPct: number,
  commissionGstPct: number
): RankedRow {
  const restaurant = one(r.restaurants);
  const status = adminOrderStatus(r.status);

  // A line with no name is not a dish anyone can read out over the phone, and a
  // qty of null is not a quantity — drop both rather than rendering "undefined ×
  // null" on an operations screen. Legacy imported orders are the ones that have
  // them; an order that loses every line this way simply shows no dish summary,
  // which is honest, where a row of placeholders would not be.
  const items = (r.order_items ?? [])
    .map((line) => ({
      name: (line.name ?? "").trim(),
      qty: typeof line.qty === "number" && line.qty > 0 ? line.qty : 0,
    }))
    .filter((line) => line.name !== "" && line.qty > 0);

  const lateBy = lateByOf(r, prepMinutes, now);

  return {
    createdAtMs: parseMs(r.created_at) ?? 0,
    lateBy,
    row: {
      id: r.id,
      code: `#${shortOrderId(r.id)}`,
      customer: one(r.customer)?.full_name?.trim() || "Customer",
      restaurant: restaurant?.name ?? "—",
      status,
      total: r.total,
      placedAt: formatDateTime(r.created_at),
      placedAtIso: r.created_at,
      // Left undefined when the column isn't there, so the UI stays silent
      // rather than calling an unknown payment "cash".
      paymentMethod: r.payment_method ?? undefined,
      paymentStatus: r.payment_status ?? undefined,
      pointsUsed: r.wallet_points_used ?? 0,
      lateByMinutes: lateBy,
      items,
      itemCount: items.reduce((n, line) => n + line.qty, 0),
      profit: profitFor(r, status, restaurant, commissionDefaultPct, commissionGstPct),
    },
  };
}

/**
 * The admin order feed: the newest `limit` orders, PLUS every order still in
 * flight however old it is, late ones first.
 *
 * The second half is the point. An order that has been sitting in `ready` for
 * two hours is both the most important row on this screen and the one a plain
 * newest-first page is guaranteed to have pushed off the bottom.
 */
export async function listAllOrders(limit = 50): Promise<AdminOrderRow[]> {
  // Service role, and therefore past RLS. Authorized by the /admin layout's
  // requireRole("admin"), which runs before this page renders (AGENTS.md §5).
  const supabase = createAdminClient();

  const [settings, commissionDefaultPct, commissionGstPct] = await Promise.all([
    getSettings(),
    getVendorCommissionDefault(),
    getCommissionGstPct(),
  ]);
  const prepMinutes = clampPrepMinutes(settings.defaultPrepMinutes);

  const [recent, active] = await Promise.all([
    selectProbed<Record<string, unknown>[]>(LIST_GROUPS, listColumns, (columns) =>
      supabase
        .from("orders")
        .select(columns)
        .order("created_at", { ascending: false })
        .limit(limit)
        .overrideTypes<Record<string, unknown>[]>()
    ),
    selectProbed<Record<string, unknown>[]>(LIST_GROUPS, listColumns, (columns) =>
      supabase
        .from("orders")
        .select(columns)
        .in("status", ACTIVE_DB_STATUSES)
        // Oldest first: if there are more in-flight orders than the window, the
        // ones worth seeing are the ones that have been open longest.
        .order("created_at", { ascending: true })
        .limit(ACTIVE_WINDOW)
        .overrideTypes<Record<string, unknown>[]>()
    ),
  ]);

  const now = Date.now();
  const byId = new Map<string, RankedRow>();
  for (const raw of [...(recent.data ?? []), ...(active.data ?? [])]) {
    const r = raw as unknown as ListRow;
    if (!byId.has(r.id)) {
      byId.set(
        r.id,
        mapListRow(r, prepMinutes, now, commissionDefaultPct, commissionGstPct)
      );
    }
  }

  return [...byId.values()]
    .sort(
      (a, b) =>
        // Late first, worst first; everything else newest first.
        (b.lateBy ?? -1) - (a.lateBy ?? -1) || b.createdAtMs - a.createdAtMs
    )
    .map((r) => r.row);
}

/* ============================================================
   The Orders screen: real paging, filtered by the database
   ------------------------------------------------------------
   What is still moving comes first, late ones first, however old; then what has
   finished, newest first. A stuck order is the one this screen exists for, and a
   plain newest-first page is guaranteed to have pushed it off the bottom.
   ============================================================ */

export type OrderPaymentFilter = "cod" | "online" | "failed" | "";

export interface AdminOrderFilters {
  q: string;
  status: AdminOrderRow["status"] | null;
  /** A restaurant id. */
  vendorId: string;
  /** How it was paid, or "failed": exactly what Home's "Failed payments" counts. */
  payment: OrderPaymentFilter;
  /** In flight, past UNASSIGNED_AFTER_MIN, nobody carrying it: Home's "Orders with no rider". */
  noRider: boolean;
  page: number;
}

export interface AdminOrdersPage {
  rows: AdminOrderRow[];
  page: number;
  pageSize: number;
  total: number;
  /** True counts per stage, under every filter except the stage itself. */
  counts: Record<AdminOrderRow["status"], number>;
  /** Across every in-flight order matching the filters, not this page's. */
  late: number;
  worstLate: number;
  vendors: { id: string; name: string }[];
  /** The search matched more than can be looked up at once: only the newest are listed. */
  searchCapped: boolean;
}

export const ORDERS_PAGE_SIZE = 50;
const DB_STATUS: Record<AdminOrderRow["status"], string> = {
  PLACED: "placed",
  KITCHEN: "kitchen",
  READY: "ready",
  ON_THE_WAY: "on_the_way",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
};
const FINISHED_DB_STATUSES = ["delivered", "cancelled"];
const ALL_ORDER_STATUSES = Object.keys(DB_STATUS) as AdminOrderRow["status"][];

/** How many ids one filter may carry: 37 characters each, in a URL. */
const SEARCH_CAP = { people: 40, shops: 40, dishes: 60 };
const NO_RIDER_CAP = 100;
/** Every in-flight order is ranked by lateness; beyond this it is a backlog, not a board. */
const LATENESS_SCAN = 1000;

// A PostgREST builder's type is too deep to carry through these helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

/** `%` and `_` in what someone typed mean themselves. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * What a search matches, as one `or` filter over orders: the order's code, a
 * customer's name, a shop's name or a dish. Names are looked up first because an
 * `or` cannot reach across embedded tables. Null: nothing matched at all.
 */
async function searchFilter(q: string): Promise<{ or: string | null; capped: boolean }> {
  const supabase = createAdminClient();
  const pattern = likePattern(q);
  const [people, shops, dishes] = await Promise.all([
    supabase.from("profiles").select("id").ilike("full_name", pattern).limit(SEARCH_CAP.people),
    supabase.from("restaurants").select("id").ilike("name", pattern).limit(SEARCH_CAP.shops),
    supabase
      .from("orders")
      .select("id, order_items!inner(name)")
      .ilike("order_items.name", pattern)
      .order("created_at", { ascending: false })
      .limit(SEARCH_CAP.dishes),
  ]);
  if (people.error) throw people.error;
  if (shops.error) throw shops.error;
  if (dishes.error) throw dishes.error;

  const ids = (rows: unknown) => ((rows ?? []) as { id: string }[]).map((r) => r.id);
  const parts: string[] = [];
  const code = q.replace(/^#/, "").replace(/\s+/g, "");
  if (UUID_RE.test(code)) parts.push(`id.eq.${code.toLowerCase()}`);
  else if (/^[0-9a-fA-F]{4,8}$/.test(code)) parts.push(`short_code.like.${code.toUpperCase()}*`);
  if (ids(people.data).length) parts.push(`customer_id.in.(${ids(people.data).join(",")})`);
  if (ids(shops.data).length) parts.push(`restaurant_id.in.(${ids(shops.data).join(",")})`);
  if (ids(dishes.data).length) parts.push(`id.in.(${ids(dishes.data).join(",")})`);

  return {
    or: parts.length ? parts.join(",") : null,
    capped:
      ids(people.data).length >= SEARCH_CAP.people ||
      ids(shops.data).length >= SEARCH_CAP.shops ||
      ids(dishes.data).length >= SEARCH_CAP.dishes,
  };
}

/**
 * order id → the rider carrying it, for the orders given. Two queries rather than
 * an embed: `deliveries.driver_id` points at `profiles`, and the rest of this
 * codebase resolves that pair by hand (see getOrderDelivery) because the
 * relationship has no name PostgREST can be relied on to expose.
 *
 * A failure here costs the rider column, not the board.
 */
export async function ridersByOrder(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;

  try {
    const supabase = createAdminClient();

    const { data: deliveries, error } = await supabase
      .from("deliveries")
      .select("order_id, driver_id")
      .in("order_id", ids);
    if (error || !deliveries?.length) return out;

    const rows = deliveries as { order_id: string; driver_id: string | null }[];
    const driverIds = [
      ...new Set(rows.map((r) => r.driver_id).filter((d): d is string => Boolean(d))),
    ];
    if (!driverIds.length) return out;

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", driverIds);

    const nameById = new Map(
      ((profiles ?? []) as { id: string; full_name: string | null }[]).map((p) => [
        p.id,
        p.full_name?.trim() || "Rider",
      ])
    );

    for (const r of rows) {
      const name = r.driver_id ? nameById.get(r.driver_id) : undefined;
      if (name) out.set(r.order_id, name);
    }
  } catch {
    // Fall through with whatever was resolved.
  }

  return out;
}

/**
 * "No rider": in flight, older than UNASSIGNED_AFTER_MIN, and no delivery has a
 * driver on it. Every order is unassigned for its first few seconds, so that alone
 * is not a problem. The one definition: Home's count and the list it links to both
 * come from here, so the two can't disagree. Oldest first.
 */
export async function unassignedOrderIds(now: number = Date.now()): Promise<string[]> {
  const supabase = createAdminClient();
  const cutoff = new Date(now - UNASSIGNED_AFTER_MIN * MINUTE).toISOString();
  const { data, error } = await supabase
    .from("orders")
    .select("id")
    .in("status", ACTIVE_DB_STATUSES)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(LATENESS_SCAN);
  if (error) throw error;
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return [];

  const assigned = await readInChunks<{ order_id: string }>(ids, (chunk) =>
    supabase
      .from("deliveries")
      .select("order_id")
      .in("order_id", chunk)
      .not("driver_id", "is", null) as unknown as PromiseLike<{ data: { order_id: string }[] | null; error: unknown }>
  );
  if (assigned.error) throw assigned.error;
  const carried = new Set(assigned.data.map((r) => r.order_id));
  return ids.filter((id) => !carried.has(id));
}

/** The shops the vendor filter offers: all of them, so it can reach any order. */
async function listOrderVendors(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await createAdminClient()
    .from("restaurants")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as { id: string; name: string | null }[]).map((r) => ({
    id: r.id,
    name: r.name?.trim() || "Shop",
  }));
}

// Lateness needs only these; the page's own rows are read in full afterwards.
const LATENESS_GROUPS: ProbeGroup[] = [
  { key: "kitchenPace", column: KITCHEN_PACE_COLUMN },
  { key: "lifecycle", column: LIFECYCLE_COLUMNS },
];

function latenessColumns(flags: Flags): string {
  return [
    "id, status, created_at",
    flags.lifecycle ? ", accepted_at, ready_at" : "",
    `, restaurants(eta_min, eta_max${flags.kitchenPace ? ", busy_until, busy_extra_minutes" : ""})`,
  ].join("");
}

type LatenessRow = Pick<ListRow, "id" | "status" | "created_at" | "accepted_at" | "ready_at"> & {
  restaurants: RestaurantRef | RestaurantRef[] | null;
};

function lateByOf(r: Pick<LatenessRow, "status" | "created_at" | "accepted_at" | "ready_at"> & { restaurants: RestaurantRef | RestaurantRef[] | null }, prepMinutes: number, now: number): number | null {
  const restaurant = one(r.restaurants);
  // Bumped by any live "we're slammed" band — matches order-tracking.ts's
  // customer-facing figure, so an order running exactly on the schedule the
  // customer was actually promised doesn't get flagged late on this board.
  const pace = kitchenPace({
    etaMin: restaurant?.eta_min,
    etaMax: restaurant?.eta_max,
    busyUntil: restaurant?.busy_until,
    busyExtraMinutes: restaurant?.busy_extra_minutes,
    now,
  });
  return minutesLate({
    status: adminOrderStatus(r.status),
    createdAt: r.created_at,
    acceptedAt: r.accepted_at,
    readyAt: r.ready_at,
    etaMin: pace.etaMin,
    etaMax: pace.etaMax,
    prepMinutes,
    now,
  });
}

/**
 * One page of orders, every filter applied by the database: nothing here looks
 * only at the rows it happened to load, so the tab counts and the shop filter
 * reach every order ever placed.
 */
export async function listOrdersPage(f: AdminOrderFilters): Promise<AdminOrdersPage> {
  const supabase = createAdminClient();
  const pageSize = ORDERS_PAGE_SIZE;

  const [settings, commissionDefaultPct, commissionGstPct, vendors, search, noRiderIds] = await Promise.all([
    getSettings(),
    getVendorCommissionDefault(),
    getCommissionGstPct(),
    listOrderVendors(),
    f.q ? searchFilter(f.q) : Promise.resolve({ or: null, capped: false }),
    f.noRider ? unassignedOrderIds() : Promise.resolve(null),
  ]);
  const prepMinutes = clampPrepMinutes(settings.defaultPrepMinutes);

  const emptyCounts = Object.fromEntries(ALL_ORDER_STATUSES.map((s) => [s, 0])) as AdminOrdersPage["counts"];
  const nothing: AdminOrdersPage = {
    rows: [], page: 1, pageSize, total: 0, counts: emptyCounts, late: 0, worstLate: 0, vendors, searchCapped: search.capped,
  };
  if (f.q && !search.or) return nothing;
  if (noRiderIds && noRiderIds.length === 0) return nothing;

  const filtered = (query: Chain): Chain => {
    let out = query;
    if (search.or) out = out.or(search.or);
    if (f.vendorId) out = out.eq("restaurant_id", f.vendorId);
    if (f.payment === "failed") out = out.eq("payment_status", "failed").neq("status", "cancelled");
    else if (f.payment) out = out.eq("payment_method", f.payment);
    if (noRiderIds) out = out.in("id", noRiderIds.slice(0, NO_RIDER_CAP));
    return out;
  };

  const countsRead = await Promise.all(
    ALL_ORDER_STATUSES.map((s) =>
      filtered(supabase.from("orders").select("id", { count: "exact", head: true })).eq("status", DB_STATUS[s])
    )
  );
  const counts = { ...emptyCounts };
  ALL_ORDER_STATUSES.forEach((s, i) => {
    if (countsRead[i].error) throw countsRead[i].error;
    counts[s] = countsRead[i].count ?? 0;
  });

  const wanted = f.status ? [DB_STATUS[f.status]] : [...ACTIVE_DB_STATUSES, ...FINISHED_DB_STATUSES];
  const activeWanted = wanted.filter((s) => ACTIVE_DB_STATUSES.includes(s));
  const finishedWanted = wanted.filter((s) => FINISHED_DB_STATUSES.includes(s));
  const now = Date.now();

  // Every in-flight order that matches, ranked: this is where "late first" and the
  // "past promise time" figure come from, so both are true beyond this page.
  const active = activeWanted.length
    ? (
        await selectProbed<LatenessRow[]>(LATENESS_GROUPS, latenessColumns, (columns) =>
          filtered(supabase.from("orders").select(columns))
            .in("status", activeWanted)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(LATENESS_SCAN)
        )
      ).data ?? []
    : [];
  const ranked = active
    .map((r) => ({ id: r.id, lateBy: lateByOf(r, prepMinutes, now) }))
    .sort((a, b) => (b.lateBy ?? -1) - (a.lateBy ?? -1));
  const lateBys = ranked.map((r) => r.lateBy ?? 0).filter((m) => m > 0);

  const finishedTotal = finishedWanted.reduce(
    (sum, s) => sum + (counts[ALL_ORDER_STATUSES.find((k) => DB_STATUS[k] === s) as AdminOrderRow["status"]] ?? 0),
    0
  );
  const total = ranked.length + finishedTotal;
  const page = Math.min(Math.max(1, f.page), Math.max(1, Math.ceil(total / pageSize)));
  const { first, second } = pageAcrossRuns(page, pageSize, ranked.length, finishedTotal);

  const activeIds = first ? ranked.slice(first.from, first.to + 1).map((r) => r.id) : [];
  const [activeRows, finishedRows] = await Promise.all([
    activeIds.length
      ? selectProbed<Record<string, unknown>[]>(LIST_GROUPS, listColumns, (columns) =>
          supabase.from("orders").select(columns).in("id", activeIds).overrideTypes<Record<string, unknown>[]>()
        )
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    second
      ? selectProbed<Record<string, unknown>[]>(LIST_GROUPS, listColumns, (columns) =>
          filtered(supabase.from("orders").select(columns))
            .in("status", finishedWanted)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(second.from, second.to)
        )
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const toRow = (raw: unknown) =>
    mapListRow(raw as ListRow, prepMinutes, now, commissionDefaultPct, commissionGstPct).row;
  const byId = new Map(((activeRows.data ?? []) as unknown as ListRow[]).map((r) => [r.id, r]));
  const rows = [
    ...activeIds.flatMap((id) => {
      const raw = byId.get(id);
      return raw ? [toRow(raw)] : [];
    }),
    ...(finishedRows.data ?? []).map(toRow),
  ];

  const riders = await ridersByOrder(rows.map((r) => r.id as string));
  return {
    rows: rows.map((r) => ({ ...r, rider: riders.get(r.id as string) ?? null })),
    page,
    pageSize,
    total,
    counts,
    late: lateBys.length,
    worstLate: lateBys.reduce((m, n) => Math.max(m, n), 0),
    vendors,
    searchCapped: search.capped,
  };
}

/* ============================================================
   One order, in full
   ============================================================ */

interface AdminOrderLine {
  name: string;
  qty: number;
  /** Unit price snapshot, in whole rupees. */
  price: number;
}

interface AdminOrderRider {
  name: string;
  phone: string | null;
}

interface AdminOrderDelivery {
  status: string | null;
  assignedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  rider: AdminOrderRider | null;
  /**
   * `deliveries.driver_location_source` (0026): 'gps' is the only value that
   * means a device actually reported a fix. Null — which is what every row
   * written before the migration has — means the position the customer watched
   * was interpolated.
   */
  locationSource: string | null;
  /** False when this database predates 0026 and cannot answer at all. */
  locationSourceKnown: boolean;
}

export interface AdminOrderDetail {
  id: string;
  code: string;
  status: AdminOrderRow["status"];
  /** The raw `order_status` value — what the intervention controls act on. */
  dbStatus: string;
  createdAt: string;
  placedAt: string;
  /** 0026, stamped by a trigger. Null = the stage has not happened. */
  acceptedAt: string | null;
  readyAt: string | null;
  cancelledAt: string | null;
  /**
   * False when this database predates 0026. Then the three timestamps above are
   * unknown rather than un-reached, and the timeline must say so instead of
   * drawing a row of blanks that reads like the order never moved.
   */
  lifecycleKnown: boolean;
  /** Sum of the line items. `total` = this + fee + tax + tip (0013's recompute). */
  subtotal: number;
  deliveryFee: number;
  taxAmount: number;
  /** Null on a pre-0013 database with no tip column — not the same as "no tip". */
  tip: number | null;
  total: number;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  /** Wallet points on the order (0197). `total` stays the bill. */
  pointsUsed: number;
  /** False when this database predates 0025 and every order is COD by definition. */
  paymentKnown: boolean;
  address: { label: string | null; line: string | null };
  items: AdminOrderLine[];
  customer: { id: string; name: string; phone: string | null } | null;
  restaurant: { id: string; name: string; slug: string | null } | null;
  lateByMinutes: number | null;
  /** Null until a rider has been assigned — most orders, most of the time. */
  delivery: AdminOrderDelivery | null;
}

const DETAIL_GROUPS: ProbeGroup[] = [
  { key: "wallet", column: WALLET_COLUMN },
  { key: "kitchenPace", column: KITCHEN_PACE_COLUMN },
  { key: "lifecycle", column: LIFECYCLE_COLUMNS },
  { key: "payment", column: PAYMENT_COLUMNS },
  { key: "tip", column: TIP_COLUMN },
];

function detailColumns(flags: Flags): string {
  return [
    "id, status, total, delivery_fee, tax_amount, created_at, address",
    flags.wallet ? ", wallet_points_used" : "",
    flags.tip ? ", tip" : "",
    flags.payment ? ", payment_method, payment_status" : "",
    flags.lifecycle ? ", accepted_at, ready_at, cancelled_at" : "",
    ", order_items(name, qty, price)",
    `, restaurants(id, name, slug, eta_min, eta_max${
      flags.kitchenPace ? ", busy_until, busy_extra_minutes" : ""
    })`,
    ", customer:profiles!orders_customer_id_fkey(id, full_name, phone)",
  ].join("");
}

interface DetailRow {
  id: string;
  status: string;
  total: number;
  delivery_fee: number | null;
  tax_amount: number | null;
  tip?: number | null;
  created_at: string;
  address: { label?: string; line?: string } | null;
  payment_method?: PaymentMethod | null;
  wallet_points_used?: number | null;
  payment_status?: PaymentStatus | null;
  accepted_at?: string | null;
  ready_at?: string | null;
  cancelled_at?: string | null;
  order_items: AdminOrderLine[] | null;
  restaurants:
    | ({ id: string; slug: string | null } & RestaurantRef)
    | ({ id: string; slug: string | null } & RestaurantRef)[]
    | null;
  customer:
    | { id: string; full_name: string | null; phone: string | null }
    | { id: string; full_name: string | null; phone: string | null }[]
    | null;
}

function deliveryColumns(flags: Flags): string {
  return [
    "status, driver_id, assigned_at, picked_up_at, delivered_at",
    flags.source ? ", driver_location_source" : "",
  ].join("");
}

interface DeliveryRow {
  status: string | null;
  driver_id: string | null;
  assigned_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  driver_location_source?: string | null;
}

/**
 * The delivery leg, when there is one.
 *
 * A failure here degrades to null rather than taking the page down: an operator
 * with the order and no rider details can still answer the phone, an operator
 * with a 500 cannot. No courier assigned yet is the common case and is a null
 * row, not an error.
 */
async function readDelivery(
  supabase: ReturnType<typeof createAdminClient>,
  orderId: string
): Promise<AdminOrderDelivery | null> {
  let row: DeliveryRow | null = null;
  let sourceKnown = false;

  try {
    const probed = await selectProbed<Record<string, unknown>>(
      [{ key: "source", column: LOCATION_SOURCE_COLUMN }],
      deliveryColumns,
      (columns) =>
        supabase
          .from("deliveries")
          .select(columns)
          .eq("order_id", orderId)
          .maybeSingle()
          .overrideTypes<Record<string, unknown>>()
    );
    row = (probed.data as unknown as DeliveryRow | null) ?? null;
    sourceKnown = Boolean(probed.flags.source);
  } catch {
    return null;
  }

  if (!row) return null;

  let rider: AdminOrderRider | null = null;
  if (row.driver_id) {
    const { data: driver } = await supabase
      .from("profiles")
      .select("full_name, phone")
      .eq("id", row.driver_id)
      .maybeSingle();
    if (driver) {
      // Name and phone are real. We do not rate riders and do not record what
      // they drive, so nothing else is invented to fill the card out.
      rider = {
        name: driver.full_name?.trim() || "Rider",
        phone: driver.phone?.trim() || null,
      };
    }
  }

  return {
    status: row.status,
    assignedAt: row.assigned_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    rider,
    locationSource: row.driver_location_source ?? null,
    locationSourceKnown: sourceKnown,
  };
}

/**
 * Everything an operator needs to service a support call about one order:
 * what was ordered, what it cost, where it was going, how it was paid, who is
 * carrying it, and when each stage actually happened.
 *
 * Returns null for an id that does not exist — and for one that isn't a uuid —
 * so the page can answer both with the same 404.
 */
export async function getAdminOrderDetail(
  id: string
): Promise<AdminOrderDetail | null> {
  if (!UUID_RE.test(id)) return null;

  // Service role, past RLS. Authorized by the /admin layout's
  // requireRole("admin") above this call path (AGENTS.md §5).
  const supabase = createAdminClient();

  const { data, flags } = await selectProbed<Record<string, unknown>>(
    DETAIL_GROUPS,
    detailColumns,
    (columns) =>
      supabase
        .from("orders")
        .select(columns)
        .eq("id", id)
        .maybeSingle()
        .overrideTypes<Record<string, unknown>>()
  );

  if (!data) return null;
  const row = data as unknown as DetailRow;

  const restaurant = one(row.restaurants);
  const customer = one(row.customer);
  const items = row.order_items ?? [];
  const status = adminOrderStatus(row.status);

  const settings = await getSettings();
  const delivery = await readDelivery(supabase, row.id);

  // Bumped by any live "we're slammed" band — see mapListRow's identical use
  // on the board.
  const pace = kitchenPace({
    etaMin: restaurant?.eta_min,
    etaMax: restaurant?.eta_max,
    busyUntil: restaurant?.busy_until,
    busyExtraMinutes: restaurant?.busy_extra_minutes,
  });

  return {
    id: row.id,
    code: `#${shortOrderId(row.id)}`,
    status,
    dbStatus: row.status,
    createdAt: row.created_at,
    placedAt: formatDateTime(row.created_at),
    acceptedAt: row.accepted_at ?? null,
    readyAt: row.ready_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    lifecycleKnown: Boolean(flags.lifecycle),
    // Recomputed from the lines rather than read from a column, because there
    // isn't one: `recompute_order_total` (0013) writes
    // total = sum(qty × price) + delivery_fee + tax_amount + tip, so the
    // subtotal is the only part of the breakdown the database doesn't store.
    subtotal: items.reduce((sum, i) => sum + i.qty * i.price, 0),
    deliveryFee: row.delivery_fee ?? 0,
    taxAmount: row.tax_amount ?? 0,
    tip: flags.tip ? (row.tip ?? 0) : null,
    total: row.total,
    paymentMethod: row.payment_method ?? null,
    paymentStatus: row.payment_status ?? null,
    pointsUsed: row.wallet_points_used ?? 0,
    paymentKnown: Boolean(flags.payment),
    address: {
      label: row.address?.label?.trim() || null,
      line: row.address?.line?.trim() || null,
    },
    items: items.map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
    customer: customer
      ? {
          id: customer.id,
          name: customer.full_name?.trim() || "Customer",
          phone: customer.phone?.trim() || null,
        }
      : null,
    restaurant: restaurant
      ? {
          id: restaurant.id,
          name: restaurant.name ?? "—",
          slug: restaurant.slug,
        }
      : null,
    lateByMinutes: minutesLate({
      status,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      readyAt: row.ready_at,
      etaMin: pace.etaMin,
      etaMax: pace.etaMax,
      prepMinutes: clampPrepMinutes(settings.defaultPrepMinutes),
      now: Date.now(),
    }),
    delivery,
  };
}

/* ============================================================
   Platform earnings — for the dashboard KPI strip
   ============================================================ */

export interface PlatformEarnings {
  today: number;
  trend: Trend;
}


/**
 * Platform earnings — commission + GST on commission + other charges, at each
 * vendor's own rate — for today, with the same week-over-week trend the rest
 * of the dashboard KPI strip carries (`getAdminDashboard`'s `trends.gmv`).
 *
 * Reads with the service role (`restaurants.commission_pct` is revoked from
 * anon/authenticated by 0032), so it checks for an admin itself (AGENTS.md
 * §5). Priced by the shared ops metrics — the settlement arithmetic with each
 * order's discount, payment method and approved refunds — so this tile is what
 * a settlement for these orders would deduct, and what the manager dashboard's
 * commission figure says (design §18.4). The loop it replaced ignored discounts
 * and refunds (scripts/qa/admin-metrics-parity.ts).
 *
 * Cancelled orders are excluded: there is no food value to take a cut of.
 */
export async function getPlatformEarnings(): Promise<PlatformEarnings> {
  await requireRole("admin");
  const now = new Date();
  const orders = await loadMetricOrders(
    { all: true },
    { range: { from: istDayKey(new Date(now.getTime() - 15 * 86_400_000)), to: istDayKey(now) } }
  );
  const [refunds, pricing] = await Promise.all([
    loadRefunds(orders.map((o) => o.id)),
    loadPricing(orders.map((o) => o.restaurantId)),
  ]);
  const { today, curr, prev } = adminEarnings(orders, refunds, pricing, now);

  return { today, trend: trend(curr, prev) };
}
