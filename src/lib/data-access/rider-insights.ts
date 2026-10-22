import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { readAllRows, readInChunks } from "@/lib/data-access/read-all";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { RiderSchemaPendingError, getRiderAvailability, isRiderSchemaPending } from "@/lib/data-access/rider-status";
import {
  getEarningsSummary,
  getIncentiveProgress,
  getIncentivesSince,
  getMonthlyMoney,
} from "@/lib/data-access/rider-earnings";
import { readHeldOffers } from "@/lib/data-access/rider-jobs";
import { dropLabel } from "@/lib/data-access/driver-orders";
import { signDeliveryProofUrl } from "@/lib/data-access/order-proof";
import { shortOrderId } from "@/lib/utils/order-map";
import { normalizeOfferWindow, offerState } from "@/lib/rider/offer-window";
import { riderPhase, type RiderAvailability } from "@/lib/rider/availability";
import {
  addDays,
  isDayKey,
  istDay,
  istDayStartIso,
  istWeekStart,
  parseRange,
  type IncentiveProgress,
} from "@/lib/rider/earnings-math";
import {
  HISTORY_OUTCOMES,
  TERMINAL_KINDS,
  buildStints,
  chooseTargets,
  decodeHistoryCursor,
  deliveredBetween,
  encodeHistoryCursor,
  historyKinds,
  historyReason,
  isAfterCursor,
  isStrictTimestamp,
  lastMonths,
  micros,
  monthlyReport,
  nearestTarget,
  nextStepFor,
  performanceFigures,
  proofOf,
  riderDeliveryStatus,
  todayFigures,
  type EventFact,
  type HistoryOutcome,
  type MonthRow,
  type OfferFact,
  type ProofKind,
  type RiderDeliveryStatus,
  type ShiftFact,
  type Stint,
} from "@/lib/rider/figures";
import type { RiderEvent } from "@/lib/data-access/rider-jobs";
import type { PlatformSettings } from "@/types";

/**
 * What a rider did, for the app's Home, History and Performance screens - and
 * what their customers said about them.
 *
 * Every function takes the rider's id and trusts it, because every one runs on
 * the service-role client. The authorization is the caller's:
 * `/api/rider/{dashboard,history,history/[orderId],performance,ratings}` derive
 * the id from the session behind `requireRiderApi()`; the admin rider page
 * behind `requireRole("admin")`. Every query that touches a rider's rows is
 * filtered `driver_id = <that id>` - nothing here reads another rider's data,
 * and a delivery or order is reached only THROUGH one of this rider's events.
 *
 * The counting rules are `lib/rider/figures.ts` (pure, tested on plain rows);
 * this file reads rows, maps them, and applies the feature switches it is told
 * about. The money is read from the recorded ledger (`rider-earnings.ts`) and
 * only when the caller says the rider may see it (`earnings: true`); a rider is
 * salaried, so a per-delivery ₹0 ledger row is never shown as money.
 *
 * ## Before the migrations
 *
 * Without 0081 (`delivery_events`) every function throws
 * `RiderSchemaPendingError` -> 503 `migration_pending`: counts built on nothing
 * would be a false statement about a rider's work. Without 0083 the money is
 * left out (`null`) and the rest still answers. Without 0084 a rider simply has
 * no ratings yet (Performance, the admin page) - except `getRiderRatings`, whose
 * only job is that table, which fails closed.
 *
 * ## Volume
 *
 * Home reads today's events; History reads 20 rows by keyset and the handful of
 * rows behind them; Performance reads twelve months of the rider's events and
 * shifts, paged past PostgREST's 1000-row cap (a busy rider is a few tens of
 * thousands of small rows a year; the route is rate-limited).
 */

/** A malformed query: the routes answer 400 with `code`. */
export class InsightsInputError extends Error {
  constructor(readonly code: "invalid_date" | "invalid_range" | "invalid_cursor" | "invalid_outcome") {
    super(code);
    this.name = "InsightsInputError";
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;
type PgError = { code?: string; message?: string };

function eventsPending(): RiderSchemaPendingError {
  return new RiderSchemaPendingError("migration_pending: delivery_events (0081) is not applied");
}
function ratingsPending(): RiderSchemaPendingError {
  return new RiderSchemaPendingError("migration_pending: rider_ratings (0084) is not applied");
}

/** Throw what an `delivery_events` / `rider_shifts` failure means. */
function failEvents(error: unknown): never {
  if (isMissingTable(error as PgError)) throw eventsPending();
  throw error;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

const EVENT_COLUMNS = "id, delivery_id, order_id, kind, method, reason, created_at";
const STINT_KINDS: string[] = ["accepted", "picked_up", ...TERMINAL_KINDS];
const OFFER_ONLY_KINDS = ["rejected", "lapsed"];

interface EventRow {
  id: number | string;
  delivery_id: string;
  order_id: string;
  kind: string;
  method: string | null;
  reason: string | null;
  created_at: string;
}

const toFact = (r: EventRow): EventFact => ({
  id: Number(r.id),
  deliveryId: r.delivery_id,
  orderId: r.order_id,
  kind: r.kind,
  at: r.created_at,
  method: r.method,
  reason: r.reason,
});

/** This rider's events of the given kinds since `fromIso`, oldest first, every page. */
async function readEvents(supabase: AdminClient, driverId: string, kinds: string[], fromIso?: string): Promise<EventRow[]> {
  const { data, error } = await readAllRows<EventRow>((from, to) => {
    let q = supabase.from("delivery_events").select(EVENT_COLUMNS).eq("driver_id", driverId).in("kind", kinds);
    if (fromIso) q = q.gte("created_at", fromIso);
    return q.order("created_at").order("id").range(from, to).overrideTypes<EventRow[]>();
  });
  if (error) failEvents(error);
  return data;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export interface RiderDashboard {
  today: { deliveries: number; pending: number; accepted: number; pickedUp: number; completed: number; cancelled: number; failed: number };
  /** Null when the rider may not see money (`driver.earnings` off) or the ledger (0083) is not there yet. */
  money: { today: number; total: number; pending: number; incentivesThisWeek: number } | null;
  availability: RiderAvailability;
  phase: string;
  current: { orderId: string; code: string; status: RiderDeliveryStatus; next: string } | null;
  /** The incentive nearest to being earned; null with the money, or when none is open. */
  nearestTarget: { name: string; done: number; target: number; bonus: number } | null;
  updatedAt: string;
}

export interface DashboardOptions {
  /** `driver.earnings` is on for this rider. Default false: money is shown only when the caller says so. */
  earnings?: boolean;
  /** Tests: the offer window comes from here instead of the settings. */
  settings?: Pick<PlatformSettings, "riderOfferWindowSeconds">;
}

interface ActiveRow {
  id: string;
  order_id: string;
  status: string;
  assigned_at: string | null;
  arrived_pickup_at: string | null;
  departed_pickup_at: string | null;
  arrived_drop_at: string | null;
}

/**
 * Offers waiting for this rider now, counted the way the Jobs board lists them
 * (same selection, `readHeldOffers`): pickups offered while the kitchen is
 * still cooking (no window - nothing can lapse them yet) plus ready orders held
 * for them inside the offer window. An offline rider has none: Jobs shows
 * nothing while they are offline.
 */
async function countPendingOffers(
  supabase: AdminClient,
  driverId: string,
  online: boolean,
  now: Date,
  windowSeconds: number
): Promise<number> {
  if (!online) return 0;
  return (await readHeldOffers(supabase, driverId)).filter(
    (h) =>
      h.orderStatus === "kitchen" ||
      (h.orderStatus === "ready" &&
        offerState(driverId, { offeredDriverId: driverId, offeredAt: h.offeredAt }, windowSeconds, now) === "mine")
  ).length;
}

async function readMoney(
  driverId: string,
  now: Date
): Promise<{ money: NonNullable<RiderDashboard["money"]>; progress: IncentiveProgress[] } | null> {
  try {
    const [summary, incentives, progress] = await Promise.all([
      getEarningsSummary(driverId, now),
      getIncentivesSince(driverId, istWeekStart(istDay(now))),
      getIncentiveProgress(driverId, now),
    ]);
    return { money: { today: summary.today, total: summary.total, pending: summary.pending, incentivesThisWeek: incentives }, progress };
  } catch (e) {
    // No ledger yet: the money is left out, not shown as ₹0.
    if (isRiderSchemaPending(e)) return null;
    throw e;
  }
}

/**
 * Home: the twelve figures. See `figures.ts` for how each is counted; the
 * counts of accepted / picked up and the active delivery are the current state
 * of the rider's `deliveries`, everything dated is from their events.
 */
export async function getRiderDashboard(
  driverId: string,
  now: Date = new Date(),
  opts: DashboardOptions = {}
): Promise<RiderDashboard> {
  const supabase = createAdminClient();
  const today = istDay(now);
  const settings = opts.settings ?? (await getSettings());
  const windowSeconds = normalizeOfferWindow(settings.riderOfferWindowSeconds);

  const availabilityRead = getRiderAvailability(driverId);
  const [availability, events, active, pending, money] = await Promise.all([
    availabilityRead,
    readEvents(supabase, driverId, STINT_KINDS, istDayStartIso(today)),
    supabase
      .from("deliveries")
      .select("id, order_id, status, assigned_at, arrived_pickup_at, departed_pickup_at, arrived_drop_at")
      .eq("driver_id", driverId)
      .in("status", ["assigned", "picked_up"])
      .order("assigned_at", { ascending: false })
      .overrideTypes<ActiveRow[]>(),
    availabilityRead.then((a) => countPendingOffers(supabase, driverId, a.isOnline, now, windowSeconds)),
    opts.earnings ? readMoney(driverId, now) : Promise.resolve(null),
  ]);
  if (active.error) throw active.error;

  const figures = todayFigures(buildStints(events.map(toFact)), today);
  const rows = active.data ?? [];
  const current = rows[0]
    ? (() => {
        const status = riderDeliveryStatus(rows[0]);
        return { orderId: rows[0].order_id, code: `#${shortOrderId(rows[0].order_id)}`, status, next: nextStepFor(status) };
      })()
    : null;

  return {
    today: {
      deliveries: figures.deliveries,
      pending,
      accepted: rows.filter((r) => r.status === "assigned").length,
      pickedUp: rows.filter((r) => r.status === "picked_up").length,
      completed: figures.completed,
      cancelled: figures.cancelled,
      failed: figures.failed,
    },
    money: money?.money ?? null,
    availability,
    phase: riderPhase(availability, now),
    current,
    nearestTarget: money ? nearestTarget(money.progress) : null,
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryItem {
  orderId: string;
  code: string;
  shop: string;
  dropArea: string | null;
  outcome: HistoryOutcome;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  endedAt: string;
  distanceKm: number | null;
  /** Rupees, from the recorded ledger; null for a ₹0 or missing earning, or when the rider may not see money. */
  earning: number | null;
  reason: string | null;
  cancelledBy: string | null;
  /** How a delivered job was proved; null otherwise. */
  proof: ProofKind | null;
  itemCount: number;
  orderValue: number;
}

export interface HistoryOptions {
  /** `driver.earnings` is on for this rider. Default false: no earning is put on any row. */
  earnings?: boolean;
}

export interface HistoryQuery {
  /** IST day `YYYY-MM-DD`; with `to`, at most 366 days apart. */
  from?: string;
  to?: string;
  outcome?: HistoryOutcome;
  cursor?: string | null;
}

/** Rows per History page. */
export const HISTORY_PAGE_SIZE = 20;
/** Event rows asked for per batch (the page, plus slack for corrected rows that drop out). */
const BATCH = HISTORY_PAGE_SIZE * 2;
/** Batches a page may take before it answers with what it has. */
const MAX_BATCHES = 6;

interface DeliveryRow {
  id: string;
  order_id: string;
  status: string;
  driver_id: string | null;
  distance_km: number | string | null;
  delivery_method: string | null;
  failure_reason: string | null;
}
interface OrderRow {
  id: string;
  total: number | string | null;
  address: { label?: unknown; area?: unknown } | null;
  restaurant_id: string | null;
  cancelled_by?: string | null;
  cancellation_reason?: string | null;
}

/** `orders.cancelled_by` arrives with 0051 - the key `order-cancellation.ts` latches too. */
const CANCELLATION_COLUMNS = "orders.cancelled_by";

/** Never `select("*")` on orders (AGENTS.md): the handover codes are not here. */
async function readOrders(supabase: AdminClient, ids: string[]): Promise<OrderRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const withCancel = !columnKnownMissing(CANCELLATION_COLUMNS);
    const columns = `id, total, address, restaurant_id${withCancel ? ", cancelled_by, cancellation_reason" : ""}`;
    const { data, error } = await readInChunks<OrderRow>(ids, (chunk) =>
      supabase.from("orders").select(columns).in("id", chunk).overrideTypes<OrderRow[]>()
    );
    if (!error) {
      if (withCancel) rememberColumn(CANCELLATION_COLUMNS, true);
      return data;
    }
    if (withCancel && isMissingColumn(error as PgError)) {
      rememberColumn(CANCELLATION_COLUMNS, false);
      continue;
    }
    throw error;
  }
  return [];
}

async function readDeliveries(supabase: AdminClient, ids: string[]): Promise<DeliveryRow[]> {
  const { data, error } = await readInChunks<DeliveryRow>(ids, (chunk) =>
    supabase
      .from("deliveries")
      .select("id, order_id, status, driver_id, distance_km, delivery_method, failure_reason")
      .in("id", chunk)
      .overrideTypes<DeliveryRow[]>()
  );
  if (error) throw error;
  return data;
}

/** Recorded earnings (latest attempt) for these deliveries; empty before 0083. */
async function readEarnings(supabase: AdminClient, driverId: string, deliveryIds: string[]): Promise<Map<string, number>> {
  const { data, error } = await readInChunks<{ delivery_id: string; amount: number | string; attempt: number }>(deliveryIds, (chunk) =>
    supabase
      .from("rider_earnings")
      .select("delivery_id, amount, attempt")
      .eq("driver_id", driverId)
      .in("delivery_id", chunk)
      .overrideTypes<{ delivery_id: string; amount: number | string; attempt: number }[]>()
  );
  if (error) {
    if (isMissingTable(error as PgError)) return new Map();
    throw error;
  }
  const best = new Map<string, { attempt: number; amount: number }>();
  for (const r of data) {
    const held = best.get(r.delivery_id);
    if (!held || num(r.attempt) > held.attempt) best.set(r.delivery_id, { attempt: num(r.attempt), amount: num(r.amount) });
  }
  return new Map([...best].map(([k, v]) => [k, v.amount]));
}

interface Enriched {
  key: { at: string; id: number };
  item: HistoryItem;
  stint: Stint;
  delivery: DeliveryRow | null;
}

/**
 * Turn a batch of terminal events (this rider's) into History rows. A row whose
 * event is not the end of its stint - a delivery that staff later corrected -
 * is dropped: the correction's own event makes the row.
 */
async function enrich(
  supabase: AdminClient,
  driverId: string,
  rows: EventRow[],
  opts: HistoryOptions
): Promise<Enriched[]> {
  if (rows.length === 0) return [];
  const deliveryIds = [...new Set(rows.map((r) => r.delivery_id))];
  const orderIds = [...new Set(rows.map((r) => r.order_id))];

  const [stintEvents, deliveries, orders, items, earnings] = await Promise.all([
    readInChunks<EventRow>(
      deliveryIds,
      (chunk) =>
        supabase
          .from("delivery_events")
          .select(EVENT_COLUMNS)
          .eq("driver_id", driverId)
          .in("delivery_id", chunk)
          .in("kind", STINT_KINDS)
          .order("created_at")
          .order("id")
          .overrideTypes<EventRow[]>(),
      50
    ),
    readDeliveries(supabase, deliveryIds),
    readOrders(supabase, orderIds),
    readInChunks<{ order_id: string; qty: number | string }>(orderIds, (chunk) =>
      supabase.from("order_items").select("order_id, qty").in("order_id", chunk).overrideTypes<{ order_id: string; qty: number | string }[]>()
    ),
    opts.earnings ? readEarnings(supabase, driverId, deliveryIds) : Promise.resolve(new Map<string, number>()),
  ]);
  if (stintEvents.error) failEvents(stintEvents.error);
  if (items.error) throw items.error;

  const restaurantIds = [...new Set(orders.map((o) => o.restaurant_id).filter((id): id is string => !!id))];
  const shops = await readInChunks<{ id: string; name: string | null }>(restaurantIds, (chunk) =>
    supabase.from("restaurants").select("id, name").in("id", chunk).overrideTypes<{ id: string; name: string | null }[]>()
  );
  if (shops.error) throw shops.error;

  const byEnd = new Map<number, Stint>();
  for (const s of buildStints(stintEvents.data.map(toFact))) {
    if (s.endEventId !== null) byEnd.set(s.endEventId, s);
  }
  const deliveryById = new Map(deliveries.map((d) => [d.id, d]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const shopName = new Map(shops.data.map((s) => [s.id, s.name?.trim() || null]));
  const qty = new Map<string, number>();
  for (const i of items.data) qty.set(i.order_id, (qty.get(i.order_id) ?? 0) + num(i.qty));

  const out: Enriched[] = [];
  for (const row of rows) {
    const stint = byEnd.get(Number(row.id));
    if (!stint || !stint.outcome || !stint.endedAt) continue;
    const delivery = deliveryById.get(row.delivery_id) ?? null;
    const order = orderById.get(row.order_id) ?? null;
    const outcome = stint.outcome;
    const money = outcome === "delivered" && opts.earnings ? (earnings.get(row.delivery_id) ?? 0) : 0;

    let reason: string | null = null;
    if (outcome === "failed") reason = historyReason("failed", stint.reason ?? delivery?.failure_reason ?? null);
    else if (outcome === "cancelled") reason = order?.cancellation_reason?.trim() || null;
    else if (outcome === "reassigned") reason = historyReason(stint.endKind ?? "reassigned", stint.reason);

    out.push({
      key: { at: row.created_at, id: Number(row.id) },
      stint,
      delivery,
      item: {
        orderId: row.order_id,
        code: `#${shortOrderId(row.order_id)}`,
        shop: (order?.restaurant_id ? shopName.get(order.restaurant_id) : null) ?? "Former shop",
        dropArea: order?.address ? dropLabel(order.address) : null,
        outcome,
        acceptedAt: iso(stint.acceptedAt),
        pickedUpAt: iso(stint.pickedUpAt),
        deliveredAt: outcome === "delivered" ? iso(stint.endedAt) : null,
        endedAt: iso(stint.endedAt) as string,
        distanceKm: delivery?.distance_km === null || delivery?.distance_km === undefined ? null : num(delivery.distance_km),
        // A ₹0 per-delivery row is a count for incentives, not money.
        earning: money > 0 ? money : null,
        reason,
        cancelledBy: outcome === "cancelled" ? (order?.cancelled_by ?? null) : null,
        proof: outcome === "delivered" ? proofOf(stint.method ?? delivery?.delivery_method) : null,
        itemCount: qty.get(row.order_id) ?? 0,
        orderValue: num(order?.total),
      },
    });
  }
  return out;
}

function parseHistoryQuery(q: HistoryQuery): {
  fromIso: string | null;
  toIso: string | null;
  kinds: string[];
  cursor: { at: string; id: number } | null;
} {
  let from = q.from;
  let to = q.to;
  if (from !== undefined && !isDayKey(from)) throw new InsightsInputError("invalid_date");
  if (to !== undefined && !isDayKey(to)) throw new InsightsInputError("invalid_date");
  if (from !== undefined && to !== undefined) {
    const range = parseRange(from, to);
    if (!range.ok) throw new InsightsInputError(range.error);
    ({ from, to } = range);
  }
  if (q.outcome !== undefined && !HISTORY_OUTCOMES.includes(q.outcome)) throw new InsightsInputError("invalid_outcome");
  const cursor = q.cursor ? decodeHistoryCursor(q.cursor) : null;
  if (q.cursor && !cursor) throw new InsightsInputError("invalid_cursor");
  return {
    fromIso: from ? istDayStartIso(from) : null,
    toIso: to ? istDayStartIso(addDays(to, 1)) : null,
    kinds: historyKinds(q.outcome),
    cursor,
  };
}

/**
 * The rider's finished deliveries - delivered, failed, cancelled, reassigned
 * away - newest first, 20 a page, by keyset on the event that ended them (so a
 * delivery landing at the top never shifts the next page). In-flight deliveries
 * are on the Jobs screen, not here. Filters are IST days (on the day a job
 * ended) and an outcome.
 */
export async function getRiderHistory(
  driverId: string,
  q: HistoryQuery,
  opts: HistoryOptions = {}
): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
  const parsed = parseHistoryQuery(q);
  const supabase = createAdminClient();

  const items: Enriched[] = [];
  let cursor = parsed.cursor;
  let exhausted = false;
  let lastScanned: { at: string; id: number } | null = null;
  for (let batch = 0; batch < MAX_BATCHES && items.length <= HISTORY_PAGE_SIZE; batch++) {
    let query = supabase
      .from("delivery_events")
      .select(EVENT_COLUMNS)
      .eq("driver_id", driverId)
      .in("kind", parsed.kinds);
    if (parsed.fromIso) query = query.gte("created_at", parsed.fromIso);
    if (parsed.toIso) query = query.lt("created_at", parsed.toIso);
    if (cursor) query = query.lte("created_at", cursor.at);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(BATCH)
      .overrideTypes<EventRow[]>();
    if (error) failEvents(error);
    const fetched = data ?? [];
    // `lte` keeps ties on the cursor's instant; the exact (instant, id) cut is made here.
    const rows = cursor ? fetched.filter((r) => isAfterCursor({ at: r.created_at, id: Number(r.id) }, cursor as { at: string; id: number })) : fetched;
    if (fetched.length < BATCH) exhausted = true;
    if (fetched.length > 0) {
      const last = fetched[fetched.length - 1];
      lastScanned = { at: last.created_at, id: Number(last.id) };
      cursor = lastScanned;
    }
    items.push(...(await enrich(supabase, driverId, rows, opts)));
    if (exhausted) break;
  }

  const page = items.slice(0, HISTORY_PAGE_SIZE);
  let next: { at: string; id: number } | null = null;
  if (items.length > HISTORY_PAGE_SIZE) next = page[page.length - 1].key;
  else if (!exhausted && lastScanned) next = lastScanned;
  return {
    items: page.map((e) => e.item),
    nextCursor: next ? encodeHistoryCursor(next) : null,
  };
}

export type HistoryDetail = HistoryItem & {
  timeline: RiderEvent[];
  proofPhotoUrl: string | null;
  items: { name: string; qty: number }[];
};

/** Release reasons are logged as a machine string; show the sentence. */
function timelineReason(kind: string, reason: string | null): string | null {
  if (reason?.startsWith("released:")) return historyReason("released", reason);
  return kind === "reassigned" ? null : (reason?.trim() || null);
}

/**
 * One finished delivery of this rider's, in full: the row, their own events
 * from acceptance to the end, the order's items, and - for a delivery they
 * delivered themselves - the proof photo as a 10-minute signed link. Null when
 * the rider never held this order or still holds it.
 */
export async function getRiderHistoryDetail(
  driverId: string,
  orderId: string,
  opts: HistoryOptions = {}
): Promise<HistoryDetail | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("delivery_events")
    .select(EVENT_COLUMNS)
    .eq("driver_id", driverId)
    .eq("order_id", orderId)
    .in("kind", [...TERMINAL_KINDS])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10)
    .overrideTypes<EventRow[]>();
  if (error) failEvents(error);
  const found = (await enrich(supabase, driverId, data ?? [], opts))[0];
  if (!found) return null;
  const { item, stint, delivery } = found;

  const [timelineRows, orderItems, photo] = await Promise.all([
    supabase
      .from("delivery_events")
      .select(EVENT_COLUMNS)
      .eq("driver_id", driverId)
      .eq("delivery_id", stint.deliveryId)
      .order("created_at")
      .order("id")
      .overrideTypes<EventRow[]>(),
    supabase.from("order_items").select("name, qty").eq("order_id", orderId).order("id").overrideTypes<{ name: string; qty: number | string }[]>(),
    delivery && item.outcome === "delivered" && delivery.driver_id === driverId && delivery.status === "delivered"
      ? readProofPath(supabase, delivery.id)
      : Promise.resolve(null),
  ]);
  if (timelineRows.error) failEvents(timelineRows.error);
  if (orderItems.error) throw orderItems.error;

  const lo = stint.acceptedAt ? micros(stint.acceptedAt) : Number.NEGATIVE_INFINITY;
  const hi = stint.endedAt ? micros(stint.endedAt) : Number.POSITIVE_INFINITY;
  const timeline: RiderEvent[] = (timelineRows.data ?? [])
    .filter((e) => {
      const at = micros(e.created_at);
      return at >= lo && at <= hi;
    })
    .map((e) => ({ kind: e.kind, method: e.method, reason: timelineReason(e.kind, e.reason), at: iso(e.created_at) as string }));

  return {
    ...item,
    timeline,
    proofPhotoUrl: photo && delivery ? await signDeliveryProofUrl(supabase, delivery.id, photo) : null,
    items: (orderItems.data ?? []).map((i) => ({ name: i.name, qty: num(i.qty) })),
  };
}

/** `deliveries.pod_photo_path` (0082); null before it. */
async function readProofPath(supabase: AdminClient, deliveryId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("deliveries")
    .select("pod_photo_path")
    .eq("id", deliveryId)
    .maybeSingle()
    .overrideTypes<{ pod_photo_path: string | null }>();
  if (error) {
    if (isMissingColumn(error)) return null;
    throw error;
  }
  return data?.pod_photo_path ?? null;
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export interface RiderPerformance {
  daily: { target: number; done: number };
  weekly: { target: number; done: number };
  avgAcceptToDeliverMin: number | null;
  avgPickupToDeliverMin: number | null;
  acceptanceRate: number | null;
  failedRate: number | null;
  onlineHoursThisWeek: number;
  rating: { average: number | null; count: number; recent: { rating: number; comment: string | null; at: string }[] };
  months: MonthRow[];
}

export interface PerformanceOptions {
  /** `driver.earnings` is on for this rider. Default false: the months carry no money. */
  earnings?: boolean;
  /** Tests: the default targets come from here instead of the settings. */
  settings?: Pick<PlatformSettings, "riderDailyTarget" | "riderWeeklyTarget">;
}

const RATING_COLUMNS = "id, rating, comment, created_at";
interface RatingRow {
  id: string;
  rating: number | string;
  comment: string | null;
  created_at: string;
}

/** The rider's ratings, newest first. Never selects `customer_id`: who rated is not the rider's to know. */
async function readRatings(supabase: AdminClient, driverId: string): Promise<RatingRow[]> {
  const { data, error } = await readAllRows<RatingRow>((from, to) =>
    supabase
      .from("rider_ratings")
      .select(RATING_COLUMNS)
      .eq("driver_id", driverId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to)
      .overrideTypes<RatingRow[]>()
  );
  if (error) {
    if (isMissingTable(error as PgError)) throw ratingsPending();
    throw error;
  }
  return data;
}

const average2 = (rows: RatingRow[]): number | null =>
  rows.length === 0 ? null : Math.round((rows.reduce((s, r) => s + num(r.rating), 0) / rows.length) * 100) / 100;

const RECENT_RATINGS = 10;

/**
 * Performance: targets, times, rates, hours online, ratings and the
 * month-by-month report. The headline rates and averages look back 30 IST days;
 * the months table twelve.
 */
export async function getRiderPerformance(
  driverId: string,
  now: Date = new Date(),
  opts: PerformanceOptions = {}
): Promise<RiderPerformance> {
  const supabase = createAdminClient();
  const today = istDay(now);
  const weekStart = istWeekStart(today);
  const firstMonth = `${lastMonths(today)[11]}-01`;
  const settings = opts.settings ?? (await getSettings());

  const [events, shifts, ratings, progress, money] = await Promise.all([
    readEvents(supabase, driverId, [...STINT_KINDS, ...OFFER_ONLY_KINDS], istDayStartIso(firstMonth)),
    readAllRows<{ id: number | string; started_at: string; ended_at: string | null }>((from, to) =>
      supabase
        .from("rider_shifts")
        .select("id, started_at, ended_at")
        .eq("driver_id", driverId)
        .gte("started_at", istDayStartIso(firstMonth))
        .order("started_at")
        .order("id")
        .range(from, to)
        .overrideTypes<{ id: number | string; started_at: string; ended_at: string | null }[]>()
    ),
    readRatings(supabase, driverId).catch((e: unknown) => {
      // Before 0084 nobody has rated anyone.
      if (isRiderSchemaPending(e)) return [] as RatingRow[];
      throw e;
    }),
    getIncentiveProgress(driverId, now).catch((e: unknown) => {
      // Before 0083 there are no rules to take a target from.
      if (isRiderSchemaPending(e)) return [] as IncentiveProgress[];
      throw e;
    }),
    opts.earnings
      ? getMonthlyMoney(driverId, firstMonth, today).catch((e: unknown) => {
          if (isRiderSchemaPending(e)) return null;
          throw e;
        })
      : Promise.resolve(null),
  ]);
  if (shifts.error) failEvents(shifts.error);

  const stints = buildStints(events.filter((e) => STINT_KINDS.includes(e.kind)).map(toFact));
  const offers: OfferFact[] = events
    .filter((e) => e.kind === "accepted" || e.kind === "rejected" || e.kind === "lapsed")
    .map((e) => ({ kind: e.kind as OfferFact["kind"], at: e.created_at }));
  const shiftFacts: ShiftFact[] = shifts.data.map((s) => ({ startedAt: s.started_at, endedAt: s.ended_at }));

  const figures = performanceFigures(stints, offers, shiftFacts, now);
  const targets = chooseTargets(
    { daily: num(settings.riderDailyTarget), weekly: num(settings.riderWeeklyTarget) },
    progress
  );

  return {
    daily: { target: targets.daily, done: deliveredBetween(stints, today, today) },
    weekly: { target: targets.weekly, done: deliveredBetween(stints, weekStart, today) },
    avgAcceptToDeliverMin: figures.avgAcceptToDeliverMin,
    avgPickupToDeliverMin: figures.avgPickupToDeliverMin,
    acceptanceRate: figures.acceptanceRate,
    failedRate: figures.failedRate,
    onlineHoursThisWeek: figures.onlineHoursThisWeek,
    rating: {
      average: average2(ratings),
      count: ratings.length,
      recent: ratings.slice(0, RECENT_RATINGS).map((r) => ({ rating: num(r.rating), comment: r.comment?.trim() || null, at: iso(r.created_at) as string })),
    },
    months: monthlyReport(stints, offers, shiftFacts, now, money),
  };
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

export const RATINGS_PAGE_SIZE = 20;

export interface RatingItem {
  rating: number;
  comment: string | null;
  at: string;
}

function encodeRatingCursor(key: { at: string; id: string }): string {
  return Buffer.from(`${key.at}|${key.id}`, "utf8").toString("base64url");
}
function decodeRatingCursor(cursor: string): { at: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.lastIndexOf("|");
  const at = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (sep < 1 || !id || !isStrictTimestamp(at)) return null;
  return { at, id };
}

/**
 * The rider's ratings: their average and count, and their comments 20 a page,
 * newest first. Rating, comment, time - never who left it. Fails closed before
 * 0084 (this is that table's only job).
 */
export async function getRiderRatings(
  driverId: string,
  q: { cursor?: string | null }
): Promise<{ average: number | null; count: number; items: RatingItem[]; nextCursor: string | null }> {
  const after = q.cursor ? decodeRatingCursor(q.cursor) : null;
  if (q.cursor && !after) throw new InsightsInputError("invalid_cursor");
  const all = await readRatings(createAdminClient(), driverId);
  // Newest first already; the cut is exact on (instant, id).
  const rest = after
    ? all.filter((r) => {
        const d = micros(r.created_at) - micros(after.at);
        return d < 0 || (d === 0 && r.id < after.id);
      })
    : all;
  const page = rest.slice(0, RATINGS_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    average: average2(all),
    count: all.length,
    items: page.map((r) => ({ rating: num(r.rating), comment: r.comment?.trim() || null, at: iso(r.created_at) as string })),
    nextCursor: rest.length > RATINGS_PAGE_SIZE && last ? encodeRatingCursor({ at: last.created_at, id: last.id }) : null,
  };
}

/**
 * The admin rider page's view: the same average and count, and the latest
 * comments WITH their order codes (an admin may follow a complaint to its
 * order; the rider may not). Before 0084: no ratings yet. Authorization is the
 * caller's (`requireRole("admin")`).
 */
export async function getRiderRatingsForAdmin(driverId: string): Promise<{
  average: number | null;
  count: number;
  recent: { rating: number; comment: string | null; at: string; orderId: string; orderCode: string }[];
}> {
  const supabase = createAdminClient();
  const { data, error } = await readAllRows<RatingRow & { order_id: string }>((from, to) =>
    supabase
      .from("rider_ratings")
      .select(`${RATING_COLUMNS}, order_id`)
      .eq("driver_id", driverId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to)
      .overrideTypes<(RatingRow & { order_id: string })[]>()
  );
  if (error) {
    if (isMissingTable(error as PgError)) return { average: null, count: 0, recent: [] };
    throw error;
  }
  return {
    average: average2(data),
    count: data.length,
    recent: data.slice(0, RECENT_RATINGS).map((r) => ({
      rating: num(r.rating),
      comment: r.comment?.trim() || null,
      at: iso(r.created_at) as string,
      orderId: r.order_id,
      orderCode: `#${shortOrderId(r.order_id)}`,
    })),
  };
}
