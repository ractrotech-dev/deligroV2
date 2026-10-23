import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { deferNotify } from "@/lib/notifications/defer";
import { notifyShop } from "@/lib/notifications/notify-user";
import { shortOrderId } from "@/lib/utils/order-map";
import { addIstDays, startOfIstDay, startOfIstWeek } from "@/lib/utils/ist-time";
import {
  breakdownOrder,
  checkTotals,
  correctionDelta,
  platformHeldPayment,
  sumSettlementTotals,
  type OrderLineItem,
  type SettlementDiscountFunding,
  type SettlementOrderBreakdown,
  type SettlementPaymentMethod,
  type SettlementPaymentStatus,
  type VendorSettlementEstimate,
} from "@/lib/settlements/math";
import {
  DEFAULT_SETTLEMENT_CYCLE,
  isSettlementCycle,
  istDay,
  type SettlementCycle,
} from "@/lib/settlements/cycle";
import {
  effectiveCommissionPct,
  getCommissionGstPct,
  getVendorCommissionDefault,
} from "@/lib/data-access/admin-commission";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";

/**
 * Admin vendor settlements — the settle-out ledger.
 *
 * Caller MUST already be admin-gated (layout requireRole or action requireRole).
 * Service-role client is authorization-backed by that gate (AGENTS.md §5).
 *
 * Two shapes of payout live here and share every line of arithmetic:
 *
 *   batch    — a date range of delivered orders, built and paid as one run.
 *   instant  — one order, paid ahead of its cycle because the vendor asked.
 *
 * An instant payout is a settlement with a single line, NOT a flag on the
 * order. That is deliberate: `vendor_settlement_orders` carries
 * UNIQUE(order_id), so an order that has been paid early is structurally unable
 * to appear in the next batch. "Excluded from the next settlement" is therefore
 * a database constraint rather than a filter someone has to remember to write —
 * which is the only version of that promise worth making about money.
 */

export type SettlementStatus = "draft" | "paid" | "void";
type SettlementKind = "batch" | "instant";

/** Every figure a payout statement prints, per order. */
export interface SettlementLine {
  orderId: string;
  code: string;
  /** What was ordered. Empty when the items could not be read. */
  items: OrderLineItem[];
  /** What the customer paid. */
  orderTotal: number;
  deliveryFee: number;
  taxAmount: number;
  tip: number;
  foodGross: number;
  /**
   * How much of this order's discount Deligro funded (0041). The one figure on
   * a statement that is added rather than deducted — without it `foodGross` is
   * unexplainably larger than the customer-side split above it.
   */
  platformDiscount: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  vendorNet: number;
  refundRecovered: number;
  contribution: number;
  paymentMethod: SettlementPaymentMethod;
  paymentStatus: SettlementPaymentStatus;
  remitsVendor: boolean;
  deliveredAt: string;
}

export interface SettlementListItem {
  id: string;
  restaurantId: string;
  restaurantName: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  foodGross: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  refundsRecovered: number;
  netPayable: number;
  status: SettlementStatus;
  kind: SettlementKind;
  orderCount: number;
  createdAt: string;
  paidAt: string | null;
  paymentRef: string | null;
}

interface SettlementPayoutSnapshot {
  upiId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  commissionPct: number;
  commissionGstPct: number;
  otherChargesPerOrder: number;
  settlementCycle: SettlementCycle;
}

export interface SettlementDetail extends SettlementListItem {
  notes: string | null;
  createdBy: string | null;
  paidBy: string | null;
  voidedAt: string | null;
  payout: SettlementPayoutSnapshot;
  lines: SettlementLine[];
  /**
   * Rupees by which the stored header disagrees with the sum of its stored
   * lines. Always 0 in practice; surfaced so a statement can say so rather
   * than leave a reader to add up 300 rows to find out.
   */
  mismatch: number;
}

export interface SettlementPreview {
  restaurantId: string;
  restaurantName: string;
  commissionPct: number;
  commissionGstPct: number;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  foodGross: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  refundsRecovered: number;
  /**
   * This batch's own total, before any outstanding correction (0048). netPayable
   * below is what will actually be created if this preview is confirmed — the
   * two differ only when a refund landed on an order from an earlier, already
   * PAID settlement for this same vendor.
   */
  netPayable: number;
  /** Outstanding corrections already netted into netPayable above. Rupees, >= 0. */
  pendingCorrections: number;
  lines: SettlementLine[];
  payout: SettlementPayoutSnapshot;
}

export interface SettlementStats {
  draftCount: number;
  paidThisWeek: number;
  paidThisWeekAmount: number;
  unsettledOnlineVolume: number;
  unsettledOrderCount: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

function periodLabel(startIso: string, endExclusiveIso: string): string {
  const start = new Date(startIso);
  const lastDay = new Date(new Date(endExclusiveIso).getTime() - 1);
  const from = dateFmt.format(start);
  const to = dateFmt.format(lastDay);
  return from === to ? from : `${from} – ${to}`;
}

/** Parse YYYY-MM-DD as IST calendar day start; reject garbage. */
export function parseIstDateInput(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00+05:30`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  if (y < 2000 || y > 2200) return null;
  return startOfIstDay(dt);
}

function asMethod(v: string | null | undefined): SettlementPaymentMethod {
  if (v === "cod" || v === "online") return v;
  return null;
}

/**
 * Anything that is not literally `'platform'` reads as the shop's own discount,
 * including the null every order carries from before 0041 — see the note on
 * `SettlementOrderInput.discountFundedBy` for why that direction.
 */
function asDiscountFunding(
  v: string | null | undefined
): SettlementDiscountFunding {
  return v === "platform" ? "platform" : "vendor";
}

function asPayStatus(v: string | null | undefined): SettlementPaymentStatus {
  if (
    v === "pending" ||
    v === "authorized" ||
    v === "paid" ||
    v === "failed" ||
    v === "refunded"
  ) {
    return v;
  }
  return null;
}

function asKind(v: unknown): SettlementKind {
  return v === "instant" ? "instant" : "batch";
}

/* ------------------------------------------------------------------
 * Schema probes.
 *
 * 0034 added six columns to vendor_settlement_orders and three to
 * vendor_settlements. A database with 0028 but not 0034 must still be able to
 * read and build settlements — it simply cannot record the new deductions,
 * which on that database are zero anyway because the rate has nowhere to live.
 * ------------------------------------------------------------------ */
const LINE_EXTRAS = "vendor_settlement_orders.commission_gst";
const HEADER_EXTRAS = "vendor_settlements.kind";
/** 0048. A missing relation (42P01), not a missing column — probed the same way. */
const CORRECTIONS_TABLE = "settlement_corrections";

const LINE_BASE =
  "order_id, food_gross, commission, vendor_net, contribution, refund_recovered, payment_method, payment_status";
const LINE_EXTRA_COLS =
  "commission_gst, other_charges, order_total, delivery_fee, tax_amount, tip";

/** A PostgREST row, before it is mapped. */
type Row = Record<string, unknown>;

interface PgResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

/**
 * Run a query that names columns a pre-0034 database does not have, and retry
 * once without them if that is what went wrong.
 *
 * Every optional-column read in this file goes through here rather than
 * hand-rolling the probe, because the hand-rolled version has to reassign the
 * destructured `data` — which makes supabase-js infer the row type from the
 * first call and reject the second, and pushes every caller into casts that
 * hide real mistakes alongside the fake one.
 */
async function selectOptional(
  probeKey: string,
  run: (withExtras: boolean) => PromiseLike<PgResult>
): Promise<Row[]> {
  const withExtras = !columnKnownMissing(probeKey);
  const first = await run(withExtras);
  if (!first.error) {
    if (withExtras) rememberColumn(probeKey, true);
    return asRows(first.data);
  }
  if (!withExtras || !isMissingColumn(first.error)) throw first.error;

  rememberColumn(probeKey, false);
  const retry = await run(false);
  if (retry.error) throw retry.error;
  return asRows(retry.data);
}

/** `, <cols>` for a select that asks for the optional columns, "" for one that does not. */
function extraCols(withExtras: boolean, cols: string): string {
  return withExtras ? `, ${cols}` : "";
}

function asRows(data: unknown): Row[] {
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]) as Row[];
}

interface OrderRow {
  id: string;
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

interface RestaurantRow {
  id: string;
  name: string;
  commission_pct: number | null;
  upi_id: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_name: string | null;
  other_charges_per_order?: number | null;
  settlement_cycle?: string | null;
}

const RESTAURANT_BASE =
  "id, name, commission_pct, upi_id, bank_account_name, bank_account_number, bank_ifsc, bank_name";
const RESTAURANT_TERMS = "other_charges_per_order, settlement_cycle";
const RESTAURANT_TERM_COLUMNS = "restaurants.other_charges_per_order";

/**
 * One vendor's row with the 0034 payout terms attached when the database has
 * them. Falls back to the base column list — and therefore to zero other
 * charges and a weekly cycle — rather than failing the settlement run.
 */
async function loadRestaurant(
  filter: { column: "id"; value: string }
): Promise<RestaurantRow | null> {
  const supabase = createAdminClient();
  const [row] = await selectOptional(RESTAURANT_TERM_COLUMNS, (extras) =>
    supabase
      .from("restaurants")
      .select(`${RESTAURANT_BASE}${extraCols(extras, RESTAURANT_TERMS)}`)
      .eq(filter.column, filter.value)
      .maybeSingle()
  );
  return (row as unknown as RestaurantRow | undefined) ?? null;
}

/** The commercial terms this vendor is on right now. */
interface PayoutTerms {
  commissionPct: number;
  commissionGstPct: number;
  otherChargesPerOrder: number;
  settlementCycle: SettlementCycle;
}

async function termsFor(rest: RestaurantRow): Promise<PayoutTerms> {
  const [platformDefault, commissionGstPct] = await Promise.all([
    getVendorCommissionDefault(),
    getCommissionGstPct(),
  ]);
  return {
    commissionPct: effectiveCommissionPct(rest.commission_pct, platformDefault),
    commissionGstPct,
    otherChargesPerOrder: Math.max(
      0,
      Math.round(Number(rest.other_charges_per_order ?? 0))
    ),
    settlementCycle: isSettlementCycle(rest.settlement_cycle)
      ? rest.settlement_cycle
      : DEFAULT_SETTLEMENT_CYCLE,
  };
}

function payoutFrom(
  r: RestaurantRow,
  terms: PayoutTerms
): SettlementPayoutSnapshot {
  return {
    upiId: r.upi_id,
    bankAccountName: r.bank_account_name,
    bankAccountNumber: r.bank_account_number,
    bankIfsc: r.bank_ifsc,
    bankName: r.bank_name,
    commissionPct: terms.commissionPct,
    commissionGstPct: terms.commissionGstPct,
    otherChargesPerOrder: terms.otherChargesPerOrder,
    settlementCycle: terms.settlementCycle,
  };
}

/**
 * What each of these orders actually contained, for the payout tables.
 *
 * A settlement line identified by code alone — "9F1A8540, ₹120" — is not
 * something an operator or a vendor can check against anything. The dish names
 * are what makes a disputed row resolvable ("that is the biryani we cancelled")
 * without opening every order in another tab.
 *
 * Reads the `order_items` snapshot, not `menu_items`: the name stored on the
 * line is what the dish was called when it was sold, which is the only version
 * that belongs on a payout statement — a menu rename must not rewrite history.
 */
async function loadOrderItems(
  orderIds: string[]
): Promise<Map<string, OrderLineItem[]>> {
  const map = new Map<string, OrderLineItem[]>();
  if (orderIds.length === 0) return map;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("order_items")
    .select("order_id, name, qty")
    .in("order_id", orderIds);
  // A payout table without dish names is degraded, not broken — never take the
  // settlement down over the decorative half of a row.
  if (error) return map;
  for (const row of data ?? []) {
    const id = row.order_id as string;
    const list = map.get(id) ?? [];
    list.push({ name: String(row.name ?? "").trim() || "Item", qty: Number(row.qty ?? 1) });
    map.set(id, list);
  }
  return map;
}

async function loadApprovedRefunds(
  orderIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (orderIds.length === 0) return map;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("refunds")
    .select("order_id, amount")
    .in("order_id", orderIds)
    .eq("status", "approved");
  if (error) throw error;
  for (const row of data ?? []) {
    const id = row.order_id as string;
    map.set(id, (map.get(id) ?? 0) + Number(row.amount ?? 0));
  }
  return map;
}

/**
 * Orders already sitting in a live (non-void) settlement of any kind.
 *
 * This is what makes an instantly-paid order drop out of the next batch: it is
 * in a settlement, so it is settled, and there is no separate concept to keep
 * in step. Voided headers have no child rows, so a voided payout frees its
 * order again by the same path.
 */
async function alreadySettledOrderIds(
  restaurantId: string
): Promise<Set<string>> {
  const supabase = createAdminClient();
  const { data: settlements, error: sErr } = await supabase
    .from("vendor_settlements")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .neq("status", "void");
  if (sErr) throw sErr;
  const ids = (settlements ?? []).map((s) => s.id as string);
  if (ids.length === 0) return new Set();

  const { data: lines, error: lErr } = await supabase
    .from("vendor_settlement_orders")
    .select("order_id")
    .in("settlement_id", ids);
  if (lErr) throw lErr;
  return new Set((lines ?? []).map((l) => l.order_id as string));
}

/** Turn a delivered order row into a priced settlement line. */
function lineFor(
  o: OrderRow,
  terms: PayoutTerms,
  refunds: Map<string, number>,
  items?: Map<string, OrderLineItem[]>
): SettlementLine {
  const paymentMethod = asMethod(o.payment_method);
  const paymentStatus = asPayStatus(o.payment_status);
  const bd: SettlementOrderBreakdown = breakdownOrder({
    total: Number(o.total) || 0,
    deliveryFee: Number(o.delivery_fee) || 0,
    taxAmount: Number(o.tax_amount) || 0,
    tip: Number(o.tip) || 0,
    discount: Number(o.discount ?? 0) || 0,
    discountFundedBy: asDiscountFunding(o.discount_funded_by),
    commissionPct: terms.commissionPct,
    commissionGstPct: terms.commissionGstPct,
    otherCharges: terms.otherChargesPerOrder,
    paymentMethod,
    paymentStatus,
    approvedRefunds: refunds.get(o.id) ?? 0,
  });

  return {
    orderId: o.id,
    code: shortOrderId(o.id),
    items: items?.get(o.id) ?? [],
    ...bd,
    paymentMethod,
    paymentStatus,
    deliveredAt: o.created_at,
  };
}

const ORDER_BASE_SELECT =
  "id, total, delivery_fee, tax_amount, tip, status, created_at";
/** 0025 added the payment split; a database without it prices every order as COD. */
const ORDER_PAY_COLUMNS = "orders.payment_method";
/**
 * 0041 added the funder. Without it every discount reads as vendor-absorbed,
 * which is what this file did before the column existed — a degraded database
 * gets the old arithmetic rather than a broken screen.
 */
const ORDER_DISCOUNT_COLUMNS = "orders.discount_funded_by";

function orderSelect(withPay: boolean, withDiscount: boolean): string {
  return [
    ORDER_BASE_SELECT,
    withPay ? "payment_method, payment_status" : null,
    withDiscount ? "discount, discount_funded_by" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Read orders with both optional column groups, dropping one group at a time.
 *
 * `selectOptional` handles a single probe; order reads have two independent
 * ones (0025's payment split, 0041's discount funder) and a database can have
 * either without the other. Dropped newest-first so a database with 0025 but
 * not 0041 does not lose its payment columns to a failed probe for the funder —
 * the same ordering rule, and the same reason, as `selectRestaurants`.
 */
async function selectOrders(
  run: (cols: string) => PromiseLike<PgResult>,
  suffix = ""
): Promise<Row[]> {
  const withSuffix = (cols: string) => (suffix ? `${cols}, ${suffix}` : cols);
  const groups: Array<[string, () => boolean]> = [
    [ORDER_DISCOUNT_COLUMNS, () => !columnKnownMissing(ORDER_DISCOUNT_COLUMNS)],
    [ORDER_PAY_COLUMNS, () => !columnKnownMissing(ORDER_PAY_COLUMNS)],
  ];

  for (const [key, optimistic] of groups) {
    if (!optimistic()) continue;
    const result = await run(
      withSuffix(
        orderSelect(
          !columnKnownMissing(ORDER_PAY_COLUMNS),
          !columnKnownMissing(ORDER_DISCOUNT_COLUMNS)
        )
      )
    );
    if (!result.error) {
      if (!columnKnownMissing(ORDER_PAY_COLUMNS)) {
        rememberColumn(ORDER_PAY_COLUMNS, true);
      }
      if (!columnKnownMissing(ORDER_DISCOUNT_COLUMNS)) {
        rememberColumn(ORDER_DISCOUNT_COLUMNS, true);
      }
      return asRows(result.data);
    }
    if (!isMissingColumn(result.error)) throw result.error;
    rememberColumn(key, false);
  }

  const last = await run(withSuffix(ORDER_BASE_SELECT));
  if (last.error) throw last.error;
  return asRows(last.data);
}

/**
 * Build a preview for a vendor + IST-inclusive date range (from/to as YYYY-MM-DD).
 * `to` is the last included calendar day; stored period_end is the next midnight.
 */
export async function previewSettlement(input: {
  restaurantId: string;
  fromDate: string;
  toDate: string;
}): Promise<SettlementPreview | { error: string }> {
  if (!UUID_RE.test(input.restaurantId)) {
    return { error: "Invalid restaurant." };
  }
  const periodStart = parseIstDateInput(input.fromDate);
  const toStart = parseIstDateInput(input.toDate);
  if (!periodStart || !toStart) {
    return { error: "Use dates as YYYY-MM-DD." };
  }
  if (toStart < periodStart) {
    return { error: "End date must be on or after the start date." };
  }
  const periodEnd = addIstDays(toStart, 1);

  const rest = await loadRestaurant({ column: "id", value: input.restaurantId });
  if (!rest) return { error: "Restaurant not found." };
  const terms = await termsFor(rest);

  const supabase = createAdminClient();
  const orders = (await selectOrders((cols) =>
    supabase
      .from("orders")
      .select(cols)
      .eq("restaurant_id", input.restaurantId)
      .eq("status", "delivered")
      .gte("created_at", periodStart.toISOString())
      .lt("created_at", periodEnd.toISOString())
      .order("created_at", { ascending: true })
  )) as unknown as OrderRow[];

  const settled = await alreadySettledOrderIds(input.restaurantId);
  const eligible = orders.filter((o) => !settled.has(o.id));
  const ids = eligible.map((o) => o.id);
  const [refunds, items] = await Promise.all([
    loadApprovedRefunds(ids),
    loadOrderItems(ids),
  ]);
  const lines = eligible.map((o) => lineFor(o, terms, refunds, items));
  const totals = sumSettlementTotals(lines);
  const corrections = await outstandingCorrectionsFor(input.restaurantId);

  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  return {
    restaurantId: rest.id,
    restaurantName: rest.name?.trim() || "Restaurant",
    commissionPct: terms.commissionPct,
    commissionGstPct: terms.commissionGstPct,
    periodStart: startIso,
    periodEnd: endIso,
    periodLabel: periodLabel(startIso, endIso),
    ...totals,
    // Overrides the raw batch figure from `...totals` above with what will
    // actually be created if this preview is confirmed — see the field's own
    // comment on SettlementPreview.
    netPayable: totals.netPayable - corrections.total,
    pendingCorrections: corrections.total,
    lines,
    payout: payoutFrom(rest, terms),
  };
}

/**
 * What one vendor is actually owed for a window — the same arithmetic a real
 * statement uses, for the vendor's own Earnings screen.
 *
 * Caller MUST be admin OR the owning vendor. `createAdminClient()` bypasses RLS
 * (AGENTS.md §5); the vendor path is authorised by `hasVendorAccess` +
 * `resolveVendorRestaurant` in `/vendor/earnings` and `/api/vendor/earnings`,
 * which resolve the restaurant id from the signed-in account rather than
 * accepting one. It has to be the service-role client either way: migrations
 * 0032/0035 revoke `commission_pct` and `commission_gst_pct` from
 * `authenticated`, so a vendor's own cookie-bound client cannot read the rate
 * it is charged.
 *
 * It shares `loadRestaurant`/`termsFor`/`lineFor` with `previewSettlement`
 * deliberately: the vendor's forecast and the statement they are later paid
 * against are then the same computation over the same rows, and cannot drift.
 *
 * The returned shape lives in `settlements/math.ts`, not here: the vendor's
 * Earnings panel is a client component and must not import, even type-only,
 * from a `server-only` data-access module.
 */
export async function settlementEstimateFor(input: {
  restaurantId: string;
  from: Date;
  /** Exclusive. */
  to: Date;
}): Promise<VendorSettlementEstimate | null> {
  if (!UUID_RE.test(input.restaurantId)) return null;

  const rest = await loadRestaurant({ column: "id", value: input.restaurantId });
  if (!rest) return null;
  const terms = await termsFor(rest);

  const supabase = createAdminClient();
  const orders = (await selectOrders((cols) =>
    supabase
      .from("orders")
      .select(cols)
      .eq("restaurant_id", input.restaurantId)
      .eq("status", "delivered")
      .gte("created_at", input.from.toISOString())
      .lt("created_at", input.to.toISOString())
  )) as unknown as OrderRow[];

  const settled = await alreadySettledOrderIds(input.restaurantId);
  const eligible = orders.filter((o) => !settled.has(o.id));
  const refunds = await loadApprovedRefunds(eligible.map((o) => o.id));
  const lines = eligible.map((o) => lineFor(o, terms, refunds));
  const totals = sumSettlementTotals(lines);
  // A vendor whose earlier, already-paid settlement has since had a refund
  // land against one of its orders (0048) will see a smaller estimate here —
  // the same number their actual next payout will land on, not a forecast
  // that quietly ignores what has already been recovered against them.
  const corrections = await outstandingCorrectionsFor(input.restaurantId);

  return {
    commissionPct: terms.commissionPct,
    commissionGstPct: terms.commissionGstPct,
    otherChargesPerOrder: terms.otherChargesPerOrder,
    orderCount: eligible.length,
    grossRevenue: eligible.reduce((sum, o) => sum + (Number(o.total) || 0), 0),
    ...totals,
    netPayable: totals.netPayable - corrections.total,
    settledCount: orders.length - eligible.length,
  };
}

/* ------------------------------------------------------------------
 * Writing a settlement.
 * ------------------------------------------------------------------ */

interface WriteInput {
  restaurantId: string;
  periodStart: string;
  periodEnd: string;
  lines: SettlementLine[];
  totals: ReturnType<typeof sumSettlementTotals>;
  kind: SettlementKind;
  adminId: string;
  notes?: string | null;
}

const RACE_MESSAGE =
  "One or more orders were just settled elsewhere. Refresh and try again.";

/**
 * Insert the header and its lines, rolling the header back if the lines fail.
 *
 * The rollback matters more than it looks: without it a UNIQUE(order_id)
 * collision leaves an empty settlement whose header says ₹4,200 is owed and
 * whose body is blank — which is exactly the kind of ledger row that gets paid
 * twice by the next person to open the screen.
 */
async function writeSettlement(
  input: WriteInput
): Promise<{ id: string } | { error: string }> {
  // Belt and braces on the money: refuse to store a header its own lines do not
  // add up to. Costs one pass over the array; catches the day a deduction is
  // added to the line and forgotten in the total.
  const drift = checkTotals(input.totals, input.lines);
  if (drift !== 0) {
    console.error(
      `[settlements] header/line mismatch of ₹${drift} for restaurant ${input.restaurantId} — refusing to write`
    );
    return {
      error:
        "The totals did not add up, so nothing was saved. Please report this — no money has moved.",
    };
  }

  const supabase = createAdminClient();
  const withExtras = !columnKnownMissing(HEADER_EXTRAS);

  // Outstanding corrections (0048) — refunds recovered against orders whose
  // ORIGINAL settlement was already paid — are netted into whichever
  // settlement is written next for this vendor, batch or instant alike. Not
  // stored as its own header column: net_payable already carries it, and the
  // settlement_corrections rows themselves (applied_settlement_id) are the
  // trace of why.
  const corrections = await outstandingCorrectionsFor(input.restaurantId);
  const netPayable = input.totals.netPayable - corrections.total;

  // A one-order payout must be an amount that is actually paid out. A COD
  // order nets to the platform's deductions (negative: the shop already holds
  // the cash); drafting that would only be refused at approval
  // (negative_net), and would hold the vendor's outstanding corrections in
  // the meantime. Refuse here before anything is written.
  if (input.kind === "instant" && netPayable < 0) {
    return {
      error:
        "Net is negative (vendor owes the platform), so there is nothing to pay out. Collect that separately — do not mark as paid out.",
    };
  }

  const headerBase: Record<string, unknown> = {
    restaurant_id: input.restaurantId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    food_gross: input.totals.foodGross,
    commission: input.totals.commission,
    refunds_recovered: input.totals.refundsRecovered,
    net_payable: netPayable,
    created_by: input.adminId,
    notes: corrections.total > 0
      ? [
          input.notes?.trim() || null,
          `Includes ₹${corrections.total} recovered against ${corrections.ids.length} earlier refund correction${corrections.ids.length === 1 ? "" : "s"}.`,
        ].filter(Boolean).join("\n")
      : input.notes?.trim() || null,
  };

  // Every settlement starts as a draft. It becomes paid only when its payment
  // request is approved by someone other than the requester (0156).
  headerBase.status = "draft";

  const headerExtras = {
    kind: input.kind,
    commission_gst: input.totals.commissionGst,
    other_charges: input.totals.otherCharges,
  };

  const insertHeader = (extras: boolean) =>
    supabase
      .from("vendor_settlements")
      .insert(extras ? { ...headerBase, ...headerExtras } : headerBase)
      .select("id")
      .single();

  let { data: header, error: hErr } = await insertHeader(withExtras);
  if (hErr && withExtras && isMissingColumn(hErr)) {
    rememberColumn(HEADER_EXTRAS, false);
    ({ data: header, error: hErr } = await insertHeader(false));
  }
  if (hErr) {
    if (hErr.code === "23505") return { error: RACE_MESSAGE };
    throw hErr;
  }
  if (!header) return { error: "Could not create the settlement." };

  const settlementId = header.id as string;
  const lineExtras = !columnKnownMissing(LINE_EXTRAS);

  const rows = input.lines.map((l) => {
    const base: Record<string, unknown> = {
      settlement_id: settlementId,
      order_id: l.orderId,
      food_gross: l.foodGross,
      commission: l.commission,
      vendor_net: l.vendorNet,
      contribution: l.contribution,
      refund_recovered: l.refundRecovered,
      payment_method: l.paymentMethod,
      payment_status: l.paymentStatus,
    };
    if (!lineExtras) return base;
    return {
      ...base,
      commission_gst: l.commissionGst,
      other_charges: l.otherCharges,
      order_total: l.orderTotal,
      delivery_fee: l.deliveryFee,
      tax_amount: l.taxAmount,
      tip: l.tip,
    };
  });

  const insertLines = (payload: Record<string, unknown>[]) =>
    supabase.from("vendor_settlement_orders").insert(payload);

  let { error: lErr } = await insertLines(rows);
  if (lErr && lineExtras && isMissingColumn(lErr)) {
    rememberColumn(LINE_EXTRAS, false);
    ({ error: lErr } = await insertLines(
      input.lines.map((l) => ({
        settlement_id: settlementId,
        order_id: l.orderId,
        food_gross: l.foodGross,
        commission: l.commission,
        vendor_net: l.vendorNet,
        contribution: l.contribution,
        refund_recovered: l.refundRecovered,
        payment_method: l.paymentMethod,
        payment_status: l.paymentStatus,
      }))
    ));
  }

  if (lErr) {
    await supabase.from("vendor_settlements").delete().eq("id", settlementId);
    if (lErr.code === "23505") return { error: RACE_MESSAGE };
    throw lErr;
  }

  // Only now that both the header and its lines are actually written: a
  // correction marked applied against a settlement that then failed to save
  // would be recovered against nothing.
  try {
    await applyCorrectionsTo(corrections.ids, settlementId);
  } catch (err) {
    // Another settlement claimed (some of) these corrections first, or the claim
    // could not be written. The header's net already has them deducted, so keep
    // none of it: hand back whatever this attempt did claim, delete the
    // settlement (its lines go with it, which frees the orders), and tell the
    // operator to build it again against the corrections as they now stand.
    await releaseCorrectionsFrom(settlementId);
    await supabase.from("vendor_settlements").delete().eq("id", settlementId);
    if (err instanceof Error && err.message === "corrections_already_applied") {
      return { error: RACE_MESSAGE };
    }
    throw err;
  }

  return { id: settlementId };
}

export async function createSettlementDraft(input: {
  restaurantId: string;
  fromDate: string;
  toDate: string;
  adminId: string;
  notes?: string | null;
}): Promise<{ id: string } | { error: string }> {
  const preview = await previewSettlement({
    restaurantId: input.restaurantId,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });
  if ("error" in preview) return preview;
  if (preview.lines.length === 0) {
    return { error: "No unsettled delivered orders in that range." };
  }

  return writeSettlement({
    restaurantId: preview.restaurantId,
    periodStart: preview.periodStart,
    periodEnd: preview.periodEnd,
    lines: preview.lines,
    totals: sumSettlementTotals(preview.lines),
    kind: "batch",
    adminId: input.adminId,
    notes: input.notes,
  });
}

/* ------------------------------------------------------------------
 * Order-level payouts — the Paid / Unpaid dropdown.
 * ------------------------------------------------------------------ */

export interface OrderPayoutRow extends SettlementLine {
  /** Paid = this order sits in a live settlement. */
  paid: boolean;
  /** The settlement holding it, for the statement link. */
  settlementId: string | null;
  settlementKind: SettlementKind | null;
  settlementStatus: SettlementStatus | null;
  paidAt: string | null;
  paymentRef: string | null;
}

export interface OrderPayoutPage {
  restaurantId: string;
  restaurantName: string;
  terms: PayoutTerms;
  payout: SettlementPayoutSnapshot;
  rows: OrderPayoutRow[];
  /** Totals for what is still unpaid — what the next batch will be worth. */
  unpaidTotals: ReturnType<typeof sumSettlementTotals>;
  unpaidCount: number;
}

export interface OrderPayoutFilters {
  fromDate?: string;
  toDate?: string;
  /** "paid" | "unpaid" | undefined for both. */
  state?: "paid" | "unpaid";
  limit?: number;
}

/**
 * Every delivered order for one vendor, priced, with whether it has been paid.
 *
 * `paid` is derived from settlement membership rather than stored on the order,
 * so it cannot disagree with what the batch builder will actually pick up.
 */
export async function listOrderPayouts(
  restaurantId: string,
  filters: OrderPayoutFilters = {}
): Promise<OrderPayoutPage | { error: string }> {
  if (!UUID_RE.test(restaurantId)) return { error: "Invalid restaurant." };

  const rest = await loadRestaurant({ column: "id", value: restaurantId });
  if (!rest) return { error: "Restaurant not found." };
  const terms = await termsFor(rest);

  const supabase = createAdminClient();
  const from = filters.fromDate ? parseIstDateInput(filters.fromDate) : null;
  const to = filters.toDate ? parseIstDateInput(filters.toDate) : null;
  if (filters.fromDate && !from) return { error: "Use dates as YYYY-MM-DD." };
  if (filters.toDate && !to) return { error: "Use dates as YYYY-MM-DD." };

  const rows = (await selectOrders((cols) => {
    let query = supabase
      .from("orders")
      .select(cols)
      .eq("restaurant_id", restaurantId)
      .eq("status", "delivered");
    if (from) query = query.gte("created_at", from.toISOString());
    if (to) query = query.lt("created_at", addIstDays(to, 1).toISOString());
    return query
      .order("created_at", { ascending: false })
      .limit(Math.min(500, Math.max(1, filters.limit ?? 200)));
  })) as unknown as OrderRow[];
  const [refunds, items, membership] = await Promise.all([
    loadApprovedRefunds(rows.map((o) => o.id)),
    loadOrderItems(rows.map((o) => o.id)),
    settlementMembership(restaurantId),
  ]);

  const priced: OrderPayoutRow[] = rows.map((o) => {
    const m = membership.get(o.id) ?? null;
    return {
      ...lineFor(o, terms, refunds, items),
      paid: m !== null,
      settlementId: m?.settlementId ?? null,
      settlementKind: m?.kind ?? null,
      settlementStatus: m?.status ?? null,
      paidAt: m?.paidAt ?? null,
      paymentRef: m?.paymentRef ?? null,
    };
  });

  const shown = filters.state
    ? priced.filter((r) => (filters.state === "paid" ? r.paid : !r.paid))
    : priced;

  const unpaid = priced.filter((r) => !r.paid);

  return {
    restaurantId: rest.id,
    restaurantName: rest.name?.trim() || "Restaurant",
    terms,
    payout: payoutFrom(rest, terms),
    rows: shown,
    unpaidTotals: sumSettlementTotals(unpaid),
    unpaidCount: unpaid.length,
  };
}

interface Membership {
  settlementId: string;
  kind: SettlementKind;
  status: SettlementStatus;
  paidAt: string | null;
  paymentRef: string | null;
}

/** order_id → the live settlement holding it. Voided ones have no lines. */
async function settlementMembership(
  restaurantId: string
): Promise<Map<string, Membership>> {
  const supabase = createAdminClient();
  const map = new Map<string, Membership>();

  const headers = await selectOptional(HEADER_EXTRAS, (extras) =>
    supabase
      .from("vendor_settlements")
      .select(`id, status, paid_at, payment_ref${extras ? ", kind" : ""}`)
      .eq("restaurant_id", restaurantId)
      .neq("status", "void")
  );

  const byId = new Map<string, Membership>();
  for (const h of headers) {
    byId.set(h.id as string, {
      settlementId: h.id as string,
      kind: asKind(h.kind),
      status: h.status as SettlementStatus,
      paidAt: (h.paid_at as string | null) ?? null,
      paymentRef: (h.payment_ref as string | null) ?? null,
    });
  }
  if (byId.size === 0) return map;

  const { data: lines, error: lErr } = await supabase
    .from("vendor_settlement_orders")
    .select("order_id, settlement_id")
    .in("settlement_id", [...byId.keys()]);
  if (lErr) throw lErr;

  for (const l of lines ?? []) {
    const m = byId.get(l.settlement_id as string);
    if (m) map.set(l.order_id as string, m);
  }
  return map;
}

/**
 * Build a one-order DRAFT settlement, to pay one order ahead of its cycle.
 *
 * It is not paid here: like every vendor payment it goes up for approval
 * (settlement-requests.ts) and is paid when someone other than the requester
 * approves it with the transaction reference. The UNIQUE(order_id)
 * constraint is what refuses a second payout for the same order — including
 * the race where two operators click at once, which is why the collision is
 * handled as a message rather than prevented by a read-then-write.
 */
export async function createInstantDraft(input: {
  orderId: string;
  adminId: string;
}): Promise<{ id: string } | { error: string }> {
  if (!UUID_RE.test(input.orderId)) return { error: "Invalid order." };

  const supabase = createAdminClient();
  const found = await selectOrders(
    (cols) => supabase.from("orders").select(cols).eq("id", input.orderId),
    "restaurant_id"
  );
  const order = found[0] as unknown as
    | (OrderRow & { restaurant_id: string })
    | undefined;
  if (!order) return { error: "Order not found." };

  const row = order as OrderRow & { restaurant_id: string };
  if (row.status !== "delivered") {
    return {
      error: "Only a delivered order can be paid out. This one is not delivered yet.",
    };
  }

  const settled = await alreadySettledOrderIds(row.restaurant_id);
  if (settled.has(row.id)) {
    return { error: "This order has already been paid or is in a settlement." };
  }

  const rest = await loadRestaurant({ column: "id", value: row.restaurant_id });
  if (!rest) return { error: "Restaurant not found." };
  const terms = await termsFor(rest);
  const refunds = await loadApprovedRefunds([row.id]);
  const line = lineFor(row, terms, refunds);

  // The period of a one-order payout is that order's own IST day, so the
  // statement reads as a date rather than as an empty range.
  const dayStart = startOfIstDay(new Date(row.created_at));
  const dayEnd = addIstDays(dayStart, 1);

  return writeSettlement({
    restaurantId: row.restaurant_id,
    periodStart: dayStart.toISOString(),
    periodEnd: dayEnd.toISOString(),
    lines: [line],
    totals: sumSettlementTotals([line]),
    kind: "instant",
    adminId: input.adminId,
    notes: `Paid early for order ${line.code}.`,
  });
}

/** Which settlement, if any, an order's payout has already been booked into. */
export interface OrderSettlementRef {
  id: string;
  status: SettlementStatus;
  kind: SettlementKind;
}

/**
 * Whether — and where — an order has already been settled.
 *
 * `vendor_settlement_orders` carries UNIQUE(order_id), so at most one row can
 * ever match. Used both to reverse an instant payout (below) and, from
 * `refunds.ts`, to flag a refund approved for an order whose payout is already
 * booked — a settlement's own total is frozen the moment it's written, so a
 * later refund has nothing to automatically net against.
 */
export async function findSettlementForOrder(
  orderId: string
): Promise<OrderSettlementRef | null> {
  const supabase = createAdminClient();
  const { data: line, error } = await supabase
    .from("vendor_settlement_orders")
    .select("settlement_id")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!line) return null;

  const settlementId = line.settlement_id as string;
  const [header] = await selectOptional(HEADER_EXTRAS, (extras) =>
    supabase
      .from("vendor_settlements")
      .select(`id, status${extras ? ", kind" : ""}`)
      .eq("id", settlementId)
      .maybeSingle()
  );
  if (!header) return null;

  return {
    id: settlementId,
    status: header.status as SettlementStatus,
    kind: asKind(header.kind),
  };
}

/**
 * Record, on the settlement itself, that a refund landed for one of its
 * orders after the fact.
 *
 * There is no automatic clawback: a settlement's `net_payable` is frozen the
 * instant it's written, `voidSettlement` refuses to reverse a `paid` header
 * (see its own comment — "record a correction instead"), and inventing a
 * negative adjustment line here would assert a reconciliation step that
 * doesn't exist elsewhere in the ledger. What this can do honestly is make the
 * mismatch impossible to miss: appended to `notes`, which the settlement
 * detail page already renders, so an operator opening the settlement a refund
 * was flagged against sees it right there rather than having to cross-reference
 * `/admin/refunds` by hand.
 *
 * Best-effort. Called after a refund has already been approved and the money
 * already moved — a failure to write this note must not read back as the
 * refund itself having failed.
 */
export async function flagSettlementForRefund(
  settlementId: string,
  note: string
): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("vendor_settlements")
      .select("notes")
      .eq("id", settlementId)
      .maybeSingle();

    const existing = (data?.notes as string | null)?.trim();
    const notes = existing ? `${existing}\n${note}` : note;

    await supabase
      .from("vendor_settlements")
      .update({ notes })
      .eq("id", settlementId);
  } catch (err) {
    console.error(
      `[flagSettlementForRefund] could not flag settlement ${settlementId}`,
      err
    );
  }
}

/* ------------------------------------------------------------------
 * Settlement corrections (0048) — recovering a refund from a vendor that
 * has already been paid for the order it applies to.
 * ------------------------------------------------------------------ */

/**
 * Every outstanding correction for one vendor, and their total.
 *
 * Degrades to zero on a database without 0048 applied — the same shape as
 * every other optional-schema read in this file: a missing feature, not a
 * broken settlement run.
 */
async function outstandingCorrectionsFor(
  restaurantId: string
): Promise<{ total: number; ids: string[] }> {
  if (columnKnownMissing(CORRECTIONS_TABLE)) return { total: 0, ids: [] };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("settlement_corrections")
    .select("id, amount")
    .eq("restaurant_id", restaurantId)
    .eq("status", "outstanding");

  if (error) {
    if (isMissingTable(error)) {
      rememberColumn(CORRECTIONS_TABLE, false);
      return { total: 0, ids: [] };
    }
    throw error;
  }
  rememberColumn(CORRECTIONS_TABLE, true);

  const rows = data ?? [];
  return {
    total: rows.reduce((sum, r) => sum + Number(r.amount), 0),
    ids: rows.map((r) => r.id as string),
  };
}

/**
 * Mark a batch of outstanding corrections as absorbed into the settlement
 * that was just written. Called from writeSettlement() right after the
 * header insert succeeds — never before, so a settlement that fails to write
 * never marks a correction applied against nothing.
 */
async function applyCorrectionsTo(
  correctionIds: string[],
  settlementId: string
): Promise<void> {
  if (correctionIds.length === 0) return;
  const supabase = createAdminClient();
  // Conditional on `outstanding`, and the rows it claimed are counted. Two
  // settlements written for the same vendor at the same moment both read the
  // same outstanding corrections and both netted them into their header; with
  // an unconditional update both "won", and the vendor was charged twice. Now
  // exactly one claims each row, and a short count is a loud error — the
  // caller rolls the header back rather than keep a total that includes a
  // deduction it does not own.
  const { data, error } = await supabase
    .from("settlement_corrections")
    .update({
      status: "applied",
      applied_settlement_id: settlementId,
      applied_at: new Date().toISOString(),
    })
    .in("id", correctionIds)
    .eq("status", "outstanding")
    .select("id");
  if (error) throw error;
  if ((data?.length ?? 0) !== correctionIds.length) {
    throw new Error("corrections_already_applied");
  }
}

/**
 * Reverse: put every correction a voided settlement had absorbed back to
 * outstanding, so it is picked up again by whatever settlement comes next.
 * Only reachable for a voided draft or a voided instant payout — a paid
 * batch can never be voided (see voidSettlement), so a correction it
 * absorbed is never at risk of this path running against real, sent money.
 */
async function releaseCorrectionsFrom(settlementId: string): Promise<void> {
  if (columnKnownMissing(CORRECTIONS_TABLE)) return;
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("settlement_corrections")
    .update({ status: "outstanding", applied_settlement_id: null, applied_at: null })
    .eq("applied_settlement_id", settlementId);
  if (error && isMissingTable(error)) rememberColumn(CORRECTIONS_TABLE, false);
}

/**
 * Create an outstanding correction for a refund approved against an order
 * whose payout is already booked into a settlement (draft or paid).
 *
 * Called from decideRefund() in refunds.ts, immediately after a refund is
 * approved — never invents a rupee figure: it is the approved refunds on the
 * order (including the one that just landed) minus the refund already counted
 * in the stored settlement line, minus anything already recovered by an
 * earlier correction on this same order. Rate-free on purpose — see below.
 *
 * Returns amount: 0 (not an error) when the refund does not change what the
 * vendor is owed for this order — e.g. it was already fully netted at
 * settlement time, or the whole refund is Deligro's own to absorb.
 */
export async function createSettlementCorrection(input: {
  orderId: string;
  refundId: string;
  createdBy: string;
}): Promise<{ ok: true; amount: number } | { ok: false; error: string }> {
  const ref = await findSettlementForOrder(input.orderId);
  if (!ref) return { ok: false, error: "not_settled" };
  // A draft can simply be voided and rebuilt — see the migration header for
  // why that path needs no correction row at all.
  if (ref.status !== "paid") return { ok: true, amount: 0 };

  const supabase = createAdminClient();

  const { data: settlement, error: sErr } = await supabase
    .from("vendor_settlements")
    .select("restaurant_id")
    .eq("id", ref.id)
    .maybeSingle();
  if (sErr) return { ok: false, error: "read_failed" };
  if (!settlement) return { ok: false, error: "settlement_not_found" };
  const restaurantId = settlement.restaurant_id as string;

  const { data: line, error: lErr } = await supabase
    .from("vendor_settlement_orders")
    .select("contribution, refund_recovered")
    .eq("settlement_id", ref.id)
    .eq("order_id", input.orderId)
    .maybeSingle();
  if (lErr) return { ok: false, error: "read_failed" };
  if (!line) return { ok: false, error: "line_not_found" };
  const storedRefundRecovered = Math.max(0, Number(line.refund_recovered) || 0);

  // Deliberately NOT a re-pricing of the order. An earlier version rebuilt the
  // line with the vendor's CURRENT commission and charges and subtracted the
  // stored contribution, so any rate change between settlement and refund
  // landed in the correction as if the refund had caused it (settled at 10%,
  // rate moved to 15%, ₹100 refund → correction ₹150). A refund enters a
  // line's contribution one-for-one — `vendorNet − refund` online, `… − refund`
  // on COD — so what the refund changed is exactly the refund not yet counted
  // in the stored line, whatever the rates now are.
  const refunds = await loadApprovedRefunds([input.orderId]);
  const approvedNow = Math.max(0, Math.round(refunds.get(input.orderId) ?? 0));

  // Prior corrections already created for this same order (an earlier,
  // separate refund on it) are money already recovered or already queued to
  // be — subtract them so a second refund on the same order only charges its
  // own incremental effect, never the first refund's a second time.
  const { data: prior, error: pErr } = await supabase
    .from("settlement_corrections")
    .select("amount")
    .eq("order_id", input.orderId)
    .neq("status", "voided");
  if (pErr) return { ok: false, error: "read_failed" };
  const priorTotal = (prior ?? []).reduce((sum, r) => sum + Number(r.amount), 0);

  const delta = correctionDelta({
    approvedRefundsNow: approvedNow,
    refundAlreadyInLine: storedRefundRecovered,
    priorCorrections: priorTotal,
  });
  if (delta <= 0) return { ok: true, amount: 0 };

  // Recorded with its audit row in one transaction (ops_record_settlement_correction,
  // 0156). The action id is the refund's, so a retry is a replay, never a second debit.
  const { error: insErr } = await supabase.rpc("ops_record_settlement_correction", {
    p_actor: input.createdBy,
    p_order: input.orderId,
    p_refund: input.refundId,
    p_settlement: ref.id,
    p_amount: delta,
    p_reason: `Refund ${input.refundId} reduced order ${shortOrderId(input.orderId)}'s food value after its settlement was already paid.`,
    p_client_action_id: `settlement-correction:${input.refundId}`,
  });
  if (insErr) {
    if (isMissingTable(insErr)) {
      rememberColumn(CORRECTIONS_TABLE, false);
      return { ok: true, amount: 0 };
    }
    return { ok: false, error: "write_failed" };
  }
  rememberColumn(CORRECTIONS_TABLE, true);

  return { ok: true, amount: delta };
}

/**
 * Move an order back to Unpaid.
 *
 * Only an INSTANT payout can be undone this way. An order inside a batch is
 * released by voiding that (draft) batch — undoing one line of a settlement an
 * operator has already remitted against would leave the header claiming a
 * total its lines no longer make.
 *
 * A DRAFT one-order payout is voided (audited). A PAID one is a completed
 * record no one person may undo (0156): this asks for a reversal instead, and
 * a different person approves it (the transfer really did not reach the
 * vendor), which voids the payout so the order can be paid again.
 */
export async function markOrderUnpaid(input: {
  orderId: string;
  adminId: string;
  reason?: string;
}): Promise<{ ok: true; reversalRequested?: boolean } | { error: string }> {
  if (!UUID_RE.test(input.orderId)) return { error: "Invalid order." };

  const ref = await findSettlementForOrder(input.orderId);
  if (!ref) return { error: "This order is not marked paid." };

  if (ref.kind !== "instant") {
    return {
      error:
        "This order is part of a settlement batch. Void that settlement to release it.",
    };
  }

  if (ref.status === "paid") {
    const why = input.reason?.trim() ?? "";
    if (why.length < 3) {
      return { error: "This payout is recorded as paid. Say why it should be reversed (for example, the bank returned the transfer) — someone else then approves it." };
    }
    const { error } = await createAdminClient().rpc("ops_request_settlement_reversal", {
      p_actor: input.adminId, p_settlement: ref.id, p_reason: why, p_client_action_id: crypto.randomUUID(),
    });
    if (error) {
      const m = (error.message ?? "").trim();
      if (m === "duplicate_pending") return { error: "A reversal of this payout is already waiting for approval." };
      if (m === "not_paid") return { error: "This payout is no longer paid." };
      return { error: "Couldn't ask for the reversal. Try again." };
    }
    return { ok: true, reversalRequested: true };
  }

  return voidSettlement({ id: ref.id, adminId: input.adminId, reason: input.reason?.trim() || "Order moved back to unpaid" });
}

/* ------------------------------------------------------------------
 * Reading settlements.
 * ------------------------------------------------------------------ */

const HEADER_BASE_SELECT =
  "id, restaurant_id, period_start, period_end, food_gross, commission, refunds_recovered, net_payable, status, created_at, paid_at, payment_ref";

function mapHeader(
  r: Record<string, unknown>,
  restaurantName: string,
  orderCount: number
): SettlementListItem {
  return {
    id: r.id as string,
    restaurantId: r.restaurant_id as string,
    restaurantName,
    periodStart: r.period_start as string,
    periodEnd: r.period_end as string,
    periodLabel: periodLabel(r.period_start as string, r.period_end as string),
    foodGross: Number(r.food_gross) || 0,
    commission: Number(r.commission) || 0,
    commissionGst: Number(r.commission_gst ?? 0) || 0,
    otherCharges: Number(r.other_charges ?? 0) || 0,
    refundsRecovered: Number(r.refunds_recovered) || 0,
    netPayable: Number(r.net_payable) || 0,
    status: r.status as SettlementStatus,
    kind: asKind(r.kind),
    orderCount,
    createdAt: r.created_at as string,
    paidAt: (r.paid_at as string | null) ?? null,
    paymentRef: (r.payment_ref as string | null) ?? null,
  };
}

export async function listSettlements(
  limit = 50,
  restaurantId?: string
): Promise<SettlementListItem[]> {
  const supabase = createAdminClient();

  const rows = await selectOptional(HEADER_EXTRAS, (extras) => {
    let q = supabase
      .from("vendor_settlements")
      .select(
        `${HEADER_BASE_SELECT}${extras ? ", kind, commission_gst, other_charges" : ""}, restaurants(name), vendor_settlement_orders(count)`
      );
    if (restaurantId && UUID_RE.test(restaurantId)) {
      q = q.eq("restaurant_id", restaurantId);
    }
    return q.order("created_at", { ascending: false }).limit(limit);
  });

  return rows.map((r) => {
    const rest = r.restaurants as { name: string } | { name: string }[] | null;
    const name = Array.isArray(rest) ? rest[0]?.name : rest?.name;
    const counts = r.vendor_settlement_orders as
      | { count: number }[]
      | { count: number }
      | null;
    const orderCount = Array.isArray(counts)
      ? (counts[0]?.count ?? 0)
      : (counts?.count ?? 0);
    return mapHeader(r, name?.trim() || "Restaurant", orderCount);
  });
}

export async function getSettlement(
  id: string
): Promise<SettlementDetail | null> {
  if (!UUID_RE.test(id)) return null;
  const supabase = createAdminClient();

  const [head] = await selectOptional(HEADER_EXTRAS, (extras) =>
    supabase
      .from("vendor_settlements")
      .select(
        `${HEADER_BASE_SELECT}${extras ? ", kind, commission_gst, other_charges" : ""}, notes, created_by, paid_by, voided_at, restaurant_id`
      )
      .eq("id", id)
      .maybeSingle()
  );
  if (!head) return null;

  const rest = await loadRestaurant({
    column: "id",
    value: head.restaurant_id as string,
  });
  if (!rest) return null;
  const terms = await termsFor(rest);

  const lines = await readSettlementLines(id);
  const header = mapHeader(head, rest.name?.trim() || "Restaurant", lines.length);

  return {
    ...header,
    notes: (head.notes as string | null) ?? null,
    createdBy: (head.created_by as string | null) ?? null,
    paidBy: (head.paid_by as string | null) ?? null,
    voidedAt: (head.voided_at as string | null) ?? null,
    // The rate a vendor is on NOW, for context. The stored rupees above stay
    // authoritative for this settlement — a rate change never rewrites history.
    payout: payoutFrom(rest, terms),
    lines,
    mismatch: checkTotals(
      {
        foodGross: header.foodGross,
        commission: header.commission,
        commissionGst: header.commissionGst,
        otherCharges: header.otherCharges,
        refundsRecovered: header.refundsRecovered,
        // The header's net is the lines' net LESS any earlier-refund
        // corrections this settlement absorbed (writeSettlement), so add them
        // back before comparing with the lines — otherwise every settlement that
        // recovered a correction reported a mismatch exactly that large.
        netPayable: header.netPayable + (await appliedCorrectionsTotal(id)),
      },
      lines
    ),
  };
}

/** Rupees of earlier-refund corrections netted into this settlement's header. */
async function appliedCorrectionsTotal(settlementId: string): Promise<number> {
  if (columnKnownMissing(CORRECTIONS_TABLE)) return 0;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("settlement_corrections")
    .select("amount")
    .eq("applied_settlement_id", settlementId);
  if (error) {
    if (isMissingTable(error)) {
      rememberColumn(CORRECTIONS_TABLE, false);
      return 0;
    }
    throw error;
  }
  return (data ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
}

async function readSettlementLines(
  settlementId: string
): Promise<SettlementLine[]> {
  const supabase = createAdminClient();

  const rows = await selectOptional(LINE_EXTRAS, (extras) =>
    supabase
      .from("vendor_settlement_orders")
      .select(
        `${LINE_BASE}${extraCols(extras, LINE_EXTRA_COLS)}, orders(created_at)`
      )
      .eq("settlement_id", settlementId)
      .order("created_at", { ascending: true })
  );

  // The dish names are read live rather than snapshotted into the settlement
  // line: `order_items` is itself the snapshot taken at checkout, and it is
  // immutable for a delivered order, so there is nothing a second copy would
  // protect against.
  const items = await loadOrderItems(
    rows.map((l) => l.order_id as string).filter(Boolean)
  );

  return rows.map((l) => {
    const ord = l.orders as
      | { created_at: string }
      | { created_at: string }[]
      | null;
    const createdAt = Array.isArray(ord) ? ord[0]?.created_at : ord?.created_at;
    const paymentMethod = asMethod(l.payment_method as string | null);
    const paymentStatus = asPayStatus(l.payment_status as string | null);
    const foodGross = Number(l.food_gross) || 0;
    const commission = Number(l.commission) || 0;
    const commissionGst = Number(l.commission_gst ?? 0) || 0;
    const otherCharges = Number(l.other_charges ?? 0) || 0;

    return {
      orderId: l.order_id as string,
      code: shortOrderId(l.order_id as string),
      items: items.get(l.order_id as string) ?? [],
      // Pre-0034 lines never stored the customer-side split. Reporting 0 is
      // honest — the money was never recorded — and only affects the top three
      // rows of an old statement, not any figure the vendor was paid on.
      orderTotal: Number(l.order_total ?? 0) || 0,
      deliveryFee: Number(l.delivery_fee ?? 0) || 0,
      taxAmount: Number(l.tax_amount ?? 0) || 0,
      tip: Number(l.tip ?? 0) || 0,
      foodGross,
      // Derived rather than stored. `food_gross` on a line with a
      // platform-funded coupon is deliberately MORE than the customer-side
      // split adds up to, and the difference is exactly what the platform
      // gave away — so a column would be a second copy of a number already
      // implied by four others, and one more thing to keep in step.
      //
      // Guarded on `order_total`, because a pre-0034 line stored no split at
      // all: without this the whole food value would read as a giveaway.
      platformDiscount:
        Number(l.order_total ?? 0) > 0
          ? Math.max(
              0,
              foodGross -
                (Number(l.order_total ?? 0) -
                  Number(l.delivery_fee ?? 0) -
                  Number(l.tax_amount ?? 0) -
                  Number(l.tip ?? 0))
            )
          : 0,
      commission,
      commissionGst,
      otherCharges,
      vendorNet: Number(l.vendor_net) || 0,
      refundRecovered: Number(l.refund_recovered) || 0,
      contribution: Number(l.contribution) || 0,
      paymentMethod,
      paymentStatus,
      remitsVendor: platformHeldPayment(paymentMethod, paymentStatus),
      deliveredAt: createdAt ?? "",
    };
  });
}

/**
 * Has a refund been approved for one of this draft's orders since it was
 * built? Then its stored refund_recovered understates what is owed back, and
 * paying it would carry that gap forward with nothing left to catch it (a
 * paid batch can never be voided). Re-checked against the live refunds table,
 * never the snapshot.
 *
 * `freshNet` is what the draft would be if rebuilt now: its lines re-priced
 * with today's refunds (lineFor, the one arithmetic), less the corrections it
 * had absorbed. Equal to the stored net when not stale.
 *
 * There is no "mark paid" here: a settlement is paid only by approving its
 * payment request (settlement-requests.ts → ops_decide_payment_request, 0156),
 * by someone other than the person who requested it.
 */
export async function isDraftStale(settlementId: string): Promise<{ stale: boolean; freshNet: number }> {
  const supabase = createAdminClient();
  const { data: header, error: hErr } = await supabase
    .from("vendor_settlements")
    .select("id, restaurant_id, net_payable")
    .eq("id", settlementId)
    .maybeSingle();
  if (hErr) throw hErr;
  if (!header) return { stale: false, freshNet: 0 };
  const storedNet = Number(header.net_payable ?? 0);

  const { data: lines, error: linesErr } = await supabase
    .from("vendor_settlement_orders")
    .select("order_id, refund_recovered, contribution")
    .eq("settlement_id", settlementId);
  if (linesErr) throw linesErr;
  const rows = (lines ?? []) as { order_id: string; refund_recovered: number | null; contribution: number | null }[];
  if (rows.length === 0) return { stale: false, freshNet: storedNet };

  const orderIds = rows.map((l) => l.order_id);
  const freshRefunds = await loadApprovedRefunds(orderIds);
  const stale = rows.some((l) => (freshRefunds.get(l.order_id) ?? 0) !== Number(l.refund_recovered ?? 0));
  if (!stale) return { stale: false, freshNet: storedNet };

  // Re-price the same orders with today's refunds.
  const rest = await loadRestaurant({ column: "id", value: header.restaurant_id as string });
  if (!rest) return { stale: true, freshNet: storedNet };
  const terms = await termsFor(rest);
  const orders = await selectOrders((cols) => supabase.from("orders").select(cols).in("id", orderIds));
  const freshLines = (orders as unknown as OrderRow[]).map((o) => lineFor(o, terms, freshRefunds));
  const storedLines = rows.reduce((s, l) => s + Number(l.contribution ?? 0), 0);
  const correctionsAbsorbed = storedLines - storedNet;
  return { stale: true, freshNet: sumSettlementTotals(freshLines).netPayable - correctionsAbsorbed };
}

/**
 * Void a settlement through the audited RPC (0156): lines deleted so the
 * orders can be settled again, header kept as void, absorbed corrections back
 * to outstanding, a pending request on it cancelled — in one transaction with
 * the audit row. A PAID settlement — batch or instant — is never voided by one
 * person (0156): a bounced transfer is reversed through a reversal request
 * someone else approves (markOrderUnpaid / the settlement page). A reason is
 * required.
 */
export async function voidSettlement(input: {
  id: string;
  adminId: string;
  reason: string;
  clientActionId?: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!UUID_RE.test(input.id)) return { error: "Invalid settlement." };
  const reason = input.reason.trim();
  if (reason.length < 3) return { error: "Say why this settlement is being voided." };
  const { data, error } = await createAdminClient().rpc("ops_void_settlement", {
    p_actor: input.adminId,
    p_settlement: input.id,
    p_reason: reason,
    p_client_action_id: input.clientActionId ?? crypto.randomUUID(),
  });
  if (error) {
    const m = (error.message ?? "").trim();
    if (m === "already_void") return { error: "This settlement is already void." };
    if (m === "paid_settlement" || m === "paid_batch") {
      return { error: "This settlement has already been paid out, so it can't be voided. If the transfer didn't reach the vendor, ask for a reversal — someone else approves it." };
    }
    if (m === "reason_required") return { error: "Say why this settlement is being voided (3–300 characters)." };
    if (m === "forbidden") return { error: "Settlement not found." };
    throw error;
  }
  const res = data as { was_paid: boolean; restaurant_id: string; net_payable: number | null; replayed: boolean };
  // A paid instant payout reversed is a payment that failed or was taken back;
  // tell the shop (requirements §13 "failed or delayed payments").
  if (res.was_paid && !res.replayed) {
    deferNotify(() =>
      notifyShop(res.restaurant_id, {
        category: "payments",
        title: "Payout reversed",
        body: `A payout${res.net_payable != null ? ` of ₹${Number(res.net_payable).toLocaleString("en-IN")}` : ""} was reversed by Deligro. Those orders are unpaid again and will be settled again.`,
        url: "/payments",
        data: { settlementId: input.id },
      })
    );
  }
  return { ok: true };
}

/** Vendors for the settlement picker — active shops, name order. */
export async function listSettlementVendors(): Promise<
  {
    id: string;
    name: string;
    commissionPct: number;
    inheritsPlatformRate: boolean;
    settlementCycle: SettlementCycle;
  }[]
> {
  const supabase = createAdminClient();

  const rows = await selectOptional(RESTAURANT_TERM_COLUMNS, (terms) =>
    supabase
      .from("restaurants")
      .select(
        `id, name, commission_pct, status${terms ? ", settlement_cycle" : ""}`
      )
      .in("status", ["active", "inactive", "pending", "suspended"])
      .order("name", { ascending: true })
      .limit(500)
  );

  const platformDefault = await getVendorCommissionDefault();
  return rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string)?.trim() || "Restaurant",
    commissionPct: effectiveCommissionPct(
      r.commission_pct as number | null,
      platformDefault
    ),
    // The picker distinguishes the two so an admin can see at a glance which
    // vendors will move when the platform rate changes.
    inheritsPlatformRate: r.commission_pct === null,
    settlementCycle: isSettlementCycle(r.settlement_cycle)
      ? r.settlement_cycle
      : DEFAULT_SETTLEMENT_CYCLE,
  }));
}

/* ------------------------------------------------------------------
 * The settle-out queue — one row per vendor, priced, before any batch exists.
 *
 * This is the screen's real subject. `listSettlements()` can only show work
 * somebody has already started, so on a fresh install it shows nothing at all —
 * while the money owed to twenty vendors is sitting there unbatched. The queue
 * answers the question the operator actually arrives with: who is owed what,
 * for how long, and can I pay them.
 *
 * Every figure here goes through the same `lineFor`/`sumSettlementTotals` pair
 * the draft builder uses, so the amount previewed on this screen is the amount
 * the batch will be worth — not an estimate that drifts from it.
 * ------------------------------------------------------------------ */

export interface VendorSettlementQueueRow {
  restaurantId: string;
  restaurantName: string;
  vendorStatus: string;
  commissionPct: number;
  settlementCycle: SettlementCycle;
  /** Delivered orders not in any live settlement. */
  orderCount: number;
  foodGross: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  refundsRecovered: number;
  /** Positive: the platform owes the vendor. Negative: the vendor owes back. */
  netPayable: number;
  /** Money the platform is holding for this vendor (online, paid orders). */
  onlineHeld: number;
  onlineOrders: number;
  /** Deductions on cash orders — recovered from the payout, not remitted. */
  cashRecoverable: number;
  cashOrders: number;
  oldestUnsettledAt: string | null;
  newestUnsettledAt: string | null;
  /** Whole IST days since the oldest unsettled order. */
  waitingDays: number;
  /** Waiting longer than one of this vendor's own cycles. */
  overdue: boolean;
  /** UPI or a bank account is on file — otherwise nobody can be paid. */
  hasPayoutDetails: boolean;
  openDrafts: number;
  openDraftAmount: number;
  lastPaidAt: string | null;
  /** IST day range covering the unsettled orders, for the draft builder link. */
  suggestedFrom: string | null;
  suggestedTo: string | null;
}

export interface VendorSettlementQueue {
  rows: VendorSettlementQueueRow[];
  /** Delivered orders read while building the queue. */
  scanned: number;
  /** The scan hit its cap — figures below are a floor, not the whole ledger. */
  truncated: boolean;
}

const QUEUE_PAGE = 1000;
const QUEUE_MAX_ORDERS = 20_000;
const QUEUE_MAX_PAGES = QUEUE_MAX_ORDERS / QUEUE_PAGE;

const RESTAURANT_QUEUE_BASE =
  "id, name, status, commission_pct, upi_id, bank_account_number, bank_ifsc";

/**
 * How many pages a table of `total` rows needs, capped.
 *
 * Everything below pages in PARALLEL off an exact count rather than looping
 * "fetch, is it short, fetch again". A live ledger is comfortably past
 * PostgREST's 1000-row cap, and thirteen sequential round trips is the
 * difference between a screen that opens and one an operator gives up on.
 */
function pageCount(total: number): number {
  return Math.min(QUEUE_MAX_PAGES, Math.ceil(total / QUEUE_PAGE));
}

function pageRange(index: number): [number, number] {
  const from = index * QUEUE_PAGE;
  return [from, from + QUEUE_PAGE - 1];
}

/**
 * Every order sitting in a live settlement.
 *
 * A truncated "already settled" set is the one error here that pays a vendor
 * twice — the missing ids read as unsettled and go straight into the next batch
 * — so this reads the whole table rather than a first page of it.
 */
async function allSettledOrderIds(): Promise<Set<string>> {
  const supabase = createAdminClient();
  const { count, error: cErr } = await supabase
    .from("vendor_settlement_orders")
    .select("order_id", { count: "exact", head: true });
  if (cErr) throw cErr;

  const pages = pageCount(count ?? 0);
  const ids = new Set<string>();
  if (pages === 0) return ids;

  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const [from, to] = pageRange(i);
      return supabase
        .from("vendor_settlement_orders")
        .select("order_id")
        .order("order_id", { ascending: true })
        .range(from, to);
    })
  );

  for (const { data, error } of results) {
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.order_id as string);
  }
  return ids;
}

type DeliveredRow = OrderRow & { restaurant_id: string };

/** Delivered orders, oldest first — the end a settle-out backlog is worked from. */
async function scanDeliveredOrders(): Promise<{
  rows: DeliveredRow[];
  truncated: boolean;
}> {
  const supabase = createAdminClient();

  const deliveredPage = (pay: boolean, index: number) => {
    const [from, to] = pageRange(index);
    return (
      supabase
        .from("orders")
        .select(
          `${ORDER_BASE_SELECT}, restaurant_id${pay ? ", payment_method, payment_status" : ""}`
        )
        .eq("status", "delivered")
        // `id` breaks ties: two orders on the same timestamp can otherwise swap
        // between pages, which duplicates one and drops the other.
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    );
  };

  // The count and the first page go out together; the first page also probes
  // whether this database has the 0025 payment columns.
  const [countResult, first] = await Promise.all([
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "delivered"),
    selectOptional(ORDER_PAY_COLUMNS, (pay) => deliveredPage(pay, 0)),
  ]);
  if (countResult.error) throw countResult.error;

  const total = countResult.count ?? first.length;
  const rows = first as unknown as DeliveredRow[];
  const pages = pageCount(total);
  if (pages <= 1) return { rows, truncated: total > QUEUE_MAX_ORDERS };

  const pay = !columnKnownMissing(ORDER_PAY_COLUMNS);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => deliveredPage(pay, i + 1))
  );
  for (const { data, error } of rest) {
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as DeliveredRow[]));
  }

  return { rows, truncated: total > QUEUE_MAX_ORDERS };
}

/**
 * Approved refunds for the whole ledger, keyed by order.
 *
 * Read in one sweep rather than order-id-by-order-id: a queue covering 13,000
 * unsettled orders would otherwise issue 65 chunked `in(...)` queries to answer
 * a question the (much smaller) refunds table answers in one.
 */
async function allApprovedRefunds(): Promise<Map<string, number>> {
  const supabase = createAdminClient();
  const map = new Map<string, number>();

  const { count, error: cErr } = await supabase
    .from("refunds")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved");
  if (cErr) throw cErr;

  const pages = pageCount(count ?? 0);
  if (pages === 0) return map;

  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const [from, to] = pageRange(i);
      return supabase
        .from("refunds")
        .select("order_id, amount")
        .eq("status", "approved")
        .order("id", { ascending: true })
        .range(from, to);
    })
  );

  for (const { data, error } of results) {
    if (error) throw error;
    for (const r of data ?? []) {
      const id = r.order_id as string;
      map.set(id, (map.get(id) ?? 0) + Number(r.amount ?? 0));
    }
  }
  return map;
}

/** Whole days between two IST calendar keys. */
function daysBetweenKeys(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

interface QueueVendor {
  id: string;
  name: string;
  status: string;
  terms: PayoutTerms;
  hasPayoutDetails: boolean;
  lines: SettlementLine[];
}

/** A `restaurants` row as a queue vendor: its payout terms, and no lines yet. */
function queueVendorFromRow(
  r: Row,
  platformDefault: number,
  commissionGstPct: number
): QueueVendor {
  return {
    id: r.id as string,
    name: (r.name as string)?.trim() || "Restaurant",
    status: (r.status as string) ?? "active",
    terms: {
      commissionPct: effectiveCommissionPct(
        r.commission_pct as number | null,
        platformDefault
      ),
      commissionGstPct,
      otherChargesPerOrder: Math.max(
        0,
        Math.round(Number(r.other_charges_per_order ?? 0))
      ),
      settlementCycle: isSettlementCycle(r.settlement_cycle)
        ? r.settlement_cycle
        : DEFAULT_SETTLEMENT_CYCLE,
    },
    hasPayoutDetails: Boolean(
      (r.upi_id as string | null)?.trim() ||
        ((r.bank_account_number as string | null)?.trim() &&
          (r.bank_ifsc as string | null)?.trim())
    ),
    lines: [],
  };
}

/**
 * Who is holding each unsettled order's money: online orders the platform
 * holds for the vendor, cash orders the vendor holds and owes deductions on.
 */
function splitByWhoHolds(lines: SettlementLine[]) {
  let onlineHeld = 0;
  let onlineOrders = 0;
  let cashRecoverable = 0;
  let cashOrders = 0;
  for (const line of lines) {
    if (line.remitsVendor) {
      onlineOrders += 1;
      onlineHeld += line.contribution;
    } else {
      cashOrders += 1;
      cashRecoverable += -line.contribution;
    }
  }
  return { onlineHeld, onlineOrders, cashRecoverable, cashOrders };
}

/** The oldest and newest unsettled orders, and how long the oldest has waited. */
function unsettledSpan(lines: SettlementLine[], today: string) {
  // Lines are appended in the scan's ascending order, so the ends of the
  // array are the oldest and newest orders without a second sort.
  const oldest = lines[0]?.deliveredAt ?? null;
  const newest = lines.at(-1)?.deliveredAt ?? null;
  const fromKey = oldest ? istDay(new Date(oldest)) : null;
  const toKey = newest ? istDay(new Date(newest)) : null;
  const waitingDays = fromKey ? daysBetweenKeys(fromKey, today) : 0;
  return { oldest, newest, fromKey, toKey, waitingDays };
}

/** Days a vendor can wait for its payout before the queue calls it overdue. */
function overdueAfterDays(cycle: PayoutTerms["settlementCycle"]): number {
  return cycle === "monthly" ? 31 : 7;
}

export async function listVendorSettlementQueue(): Promise<VendorSettlementQueue> {
  const supabase = createAdminClient();

  const [platformDefault, commissionGstPct] = await Promise.all([
    getVendorCommissionDefault(),
    getCommissionGstPct(),
  ]);

  const vendorRows = await selectOptional(RESTAURANT_TERM_COLUMNS, (extras) =>
    supabase
      .from("restaurants")
      .select(
        `${RESTAURANT_QUEUE_BASE}${extraCols(extras, RESTAURANT_TERMS)}`
      )
      .in("status", ["active", "inactive", "pending", "suspended"])
      .order("name", { ascending: true })
      .limit(500)
  );

  const vendors = new Map<string, QueueVendor>();
  for (const r of vendorRows) {
    const vendor = queueVendorFromRow(r, platformDefault, commissionGstPct);
    vendors.set(vendor.id, vendor);
  }
  if (vendors.size === 0) return { rows: [], scanned: 0, truncated: false };

  const [settledIds, scan, refunds] = await Promise.all([
    allSettledOrderIds(),
    scanDeliveredOrders(),
    allApprovedRefunds(),
  ]);

  const eligible = scan.rows.filter(
    (o) => !settledIds.has(o.id) && vendors.has(o.restaurant_id)
  );

  for (const order of eligible) {
    const vendor = vendors.get(order.restaurant_id);
    if (!vendor) continue;
    vendor.lines.push(lineFor(order, vendor.terms, refunds));
  }

  // Drafts and the last payout are per-vendor context, not part of the
  // arithmetic: a vendor with an open draft must not be built a second one.
  const { data: draftRows, error: dErr } = await supabase
    .from("vendor_settlements")
    .select("restaurant_id, net_payable")
    .eq("status", "draft")
    .limit(1000);
  if (dErr) throw dErr;

  const drafts = new Map<string, { count: number; amount: number }>();
  for (const d of draftRows ?? []) {
    const id = d.restaurant_id as string;
    const prev = drafts.get(id) ?? { count: 0, amount: 0 };
    drafts.set(id, {
      count: prev.count + 1,
      amount: prev.amount + (Number(d.net_payable) || 0),
    });
  }

  const { data: paidRows, error: pErr } = await supabase
    .from("vendor_settlements")
    .select("restaurant_id, paid_at")
    .eq("status", "paid")
    .not("paid_at", "is", null)
    .order("paid_at", { ascending: false })
    .limit(1000);
  if (pErr) throw pErr;

  const lastPaid = new Map<string, string>();
  for (const p of paidRows ?? []) {
    const id = p.restaurant_id as string;
    if (!lastPaid.has(id)) lastPaid.set(id, p.paid_at as string);
  }

  const today = istDay();

  const rows: VendorSettlementQueueRow[] = [];
  for (const vendor of vendors.values()) {
    const draft = drafts.get(vendor.id) ?? { count: 0, amount: 0 };
    const paidAt = lastPaid.get(vendor.id) ?? null;

    // A vendor with nothing pending and nothing drafted is not a queue item.
    // Showing every shop at ₹0 is how a queue stops being read.
    if (vendor.lines.length === 0 && draft.count === 0) continue;

    const totals = sumSettlementTotals(vendor.lines);
    const { onlineHeld, onlineOrders, cashRecoverable, cashOrders } =
      splitByWhoHolds(vendor.lines);
    const { oldest, newest, fromKey, toKey, waitingDays } = unsettledSpan(
      vendor.lines,
      today
    );

    rows.push({
      restaurantId: vendor.id,
      restaurantName: vendor.name,
      vendorStatus: vendor.status,
      commissionPct: vendor.terms.commissionPct,
      settlementCycle: vendor.terms.settlementCycle,
      orderCount: vendor.lines.length,
      ...totals,
      onlineHeld,
      onlineOrders,
      cashRecoverable,
      cashOrders,
      oldestUnsettledAt: oldest,
      newestUnsettledAt: newest,
      waitingDays,
      overdue: waitingDays > overdueAfterDays(vendor.terms.settlementCycle),
      hasPayoutDetails: vendor.hasPayoutDetails,
      openDrafts: draft.count,
      openDraftAmount: draft.amount,
      lastPaidAt: paidAt,
      suggestedFrom: fromKey,
      suggestedTo: toKey,
    });
  }

  // Longest wait first, then the largest amount: the two reasons an operator
  // picks one vendor over another, in that order.
  rows.sort(
    (a, b) =>
      b.waitingDays - a.waitingDays ||
      b.netPayable - a.netPayable ||
      a.restaurantName.localeCompare(b.restaurantName)
  );

  return { rows, scanned: scan.rows.length, truncated: scan.truncated };
}

export async function getSettlementStats(): Promise<SettlementStats> {
  const supabase = createAdminClient();
  const monday = startOfIstWeek(new Date());

  const { count: draftCount, error: dErr } = await supabase
    .from("vendor_settlements")
    .select("id", { count: "exact", head: true })
    .eq("status", "draft");
  if (dErr) throw dErr;

  const { data: paidRows, error: pErr } = await supabase
    .from("vendor_settlements")
    .select("net_payable")
    .eq("status", "paid")
    .gte("paid_at", monday.toISOString());
  if (pErr) throw pErr;

  const paidThisWeekAmount = (paidRows ?? []).reduce(
    (sum, r) => sum + (Number(r.net_payable) || 0),
    0
  );

  // Paged: an unbounded select stops at PostgREST's 1000-row cap, and every
  // settled order beyond it would be counted here as still unsettled.
  const settledIds = await allSettledOrderIds();

  const { data: onlineOrders, error: oErr } = await supabase
    .from("orders")
    .select(
      "id, total, delivery_fee, tax_amount, tip, payment_method, payment_status"
    )
    .eq("status", "delivered")
    .eq("payment_method", "online")
    .eq("payment_status", "paid")
    .limit(2000);

  if (oErr) {
    // Database predating 0025 — no payment columns.
    return {
      draftCount: draftCount ?? 0,
      paidThisWeek: paidRows?.length ?? 0,
      paidThisWeekAmount,
      unsettledOnlineVolume: 0,
      unsettledOrderCount: 0,
    };
  }

  const unsettled = (onlineOrders ?? []).filter(
    (o) => !settledIds.has(o.id as string)
  );
  let unsettledOnlineVolume = 0;
  for (const o of unsettled) {
    // Food gross held by the platform — exact net (after commission) is on preview.
    unsettledOnlineVolume += Math.max(
      0,
      (Number(o.total) || 0) -
        (Number(o.delivery_fee) || 0) -
        (Number(o.tax_amount) || 0) -
        (Number(o.tip) || 0)
    );
  }

  return {
    draftCount: draftCount ?? 0,
    paidThisWeek: paidRows?.length ?? 0,
    paidThisWeekAmount,
    unsettledOnlineVolume,
    unsettledOrderCount: unsettled.length,
  };
}

/* ------------------------------------------------------------------
 * The vendor's own ledger (Partner app: dashboard, payments, reports).
 * ------------------------------------------------------------------ */

export interface VendorLedgerLine extends SettlementLine {
  /** In a live (non-void) settlement that has been paid. */
  paid: boolean;
  settlementId: string | null;
  settlementStatus: SettlementStatus | null;
  paidAt: string | null;
  paymentRef: string | null;
}

export interface VendorLedger {
  commissionPct: number;
  commissionGstPct: number;
  otherChargesPerOrder: number;
  settlementCycle: SettlementCycle;
  lines: VendorLedgerLine[];
  /** Outstanding corrections (0048): already-paid money Deligro will recover. */
  outstandingCorrections: number;
  /** Orders those corrections are against — paid, but partly recovered. */
  correctedOrderIds: string[];
}

const LEDGER_PAGE = 1000;
/** A runaway guard, not a business limit: 50k delivered orders. */
const LEDGER_MAX_PAGES = 50;

/**
 * Every delivered order of one shop in the window, priced exactly as a
 * settlement prices it (`lineFor` → `breakdownOrder`), with whether it has been
 * paid. The Partner app's dashboard, payments screen and reports all read this,
 * so their figures agree with each other and with the payouts.
 *
 * Service role, like every read in this module: call it only for a restaurant
 * the caller has been authorised for — the vendor routes resolve the id from
 * the session (vendorApiContext), never from the request. Bank details are not
 * returned.
 */
export async function vendorLedger(
  restaurantId: string,
  range: { from?: Date; to?: Date } = {}
): Promise<VendorLedger | null> {
  if (!UUID_RE.test(restaurantId)) return null;
  const rest = await loadRestaurant({ column: "id", value: restaurantId });
  if (!rest) return null;
  const terms = await termsFor(rest);
  const supabase = createAdminClient();

  const rows: OrderRow[] = [];
  for (let page = 0; page < LEDGER_MAX_PAGES; page++) {
    const batch = (await selectOrders((cols) => {
      let query = supabase
        .from("orders")
        .select(cols)
        .eq("restaurant_id", restaurantId)
        .eq("status", "delivered");
      if (range.from) query = query.gte("created_at", range.from.toISOString());
      if (range.to) query = query.lt("created_at", range.to.toISOString());
      return query
        .order("created_at", { ascending: false })
        .range(page * LEDGER_PAGE, (page + 1) * LEDGER_PAGE - 1);
    })) as unknown as OrderRow[];
    rows.push(...batch);
    if (batch.length < LEDGER_PAGE) break;
  }

  // In chunks: an `in.(…)` of thousands of ids overflows the request URL.
  const loadRefunds = async (): Promise<Map<string, number>> => {
    const all = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 150) {
      const part = await loadApprovedRefunds(rows.slice(i, i + 150).map((o) => o.id));
      for (const [k, v] of part) all.set(k, v);
    }
    return all;
  };

  const [refunds, membership, corrections] = await Promise.all([
    loadRefunds(),
    settlementMembership(restaurantId),
    outstandingCorrectionsFor(restaurantId),
  ]);

  return {
    commissionPct: terms.commissionPct,
    commissionGstPct: terms.commissionGstPct,
    otherChargesPerOrder: terms.otherChargesPerOrder,
    settlementCycle: terms.settlementCycle,
    lines: rows.map((o) => {
      const m = membership.get(o.id) ?? null;
      return {
        ...lineFor(o, terms, refunds),
        paid: m?.status === "paid",
        settlementId: m?.settlementId ?? null,
        settlementStatus: m?.status ?? null,
        paidAt: m?.paidAt ?? null,
        paymentRef: m?.paymentRef ?? null,
      };
    }),
    outstandingCorrections: corrections.total,
    correctedOrderIds: await correctedOrdersFor(corrections.ids),
  };
}

/** The orders a set of correction rows is against. */
async function correctedOrdersFor(correctionIds: string[]): Promise<string[]> {
  if (correctionIds.length === 0) return [];
  const { data, error } = await createAdminClient()
    .from("settlement_corrections")
    .select("order_id")
    .in("id", correctionIds);
  if (error) throw error;
  return [...new Set((data ?? []).map((r) => r.order_id as string))];
}
