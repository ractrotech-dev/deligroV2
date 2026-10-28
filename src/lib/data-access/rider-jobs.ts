import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { getFeatures } from "@/lib/features/flags.server";
import { haversineKm } from "@/lib/geo/distance";
import { computeOrderEta } from "@/lib/orders/eta";
import { roadMinutesFor } from "@/lib/orders/road-leg";
import { shortOrderId, dbStatusToUi } from "@/lib/utils/order-map";
import { deferNotify } from "@/lib/notifications/defer";
import { captureError } from "@/lib/obs/emit";
import { stopRiderRing } from "@/lib/notifications/order-events";
import {
  DISPATCH_COLUMNS,
  dispatchOrder,
  type DispatchStage,
} from "@/lib/dispatch/rider-dispatch";
import {
  HANDOVER_COLUMNS,
  acceptDelivery,
  activeCustomerPhone,
  activeOrderDetail,
  paymentInstruction,
  pointOf,
  readPoolPayments,
  readyIn,
  type AcceptError,
  type DriverPayment,
} from "@/lib/data-access/driver-orders";
import { readRiderPresence, type RiderPresence } from "@/lib/data-access/rider-presence";
import { RiderSchemaPendingError } from "@/lib/data-access/rider-status";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import {
  isRejectReason,
  normalizeOfferWindow,
  offerDeadline,
  offerState,
  roadKmFallback,
  type RejectReason,
} from "@/lib/rider/offer-window";
import { podPhotoRequired } from "@/lib/rider/delivery-machine";
import { riderDeliveryStatus, type RiderDeliveryStatus } from "@/lib/rider/figures";
import { isCashOrder } from "@/lib/data-access/rider-delivery-actions";
import type { PlatformSettings } from "@/types";

/**
 * The rider app's job data: the board (offers, heads-ups, the active delivery),
 * and the two answers to an offer, accept and reject.
 *
 * Every function takes the rider's id and trusts it, because every one runs on
 * the service-role client (the orders a rider may see are not visible to them
 * under RLS until they hold the job). The authorization is the caller's:
 * `/api/rider/*` derive the id from the session behind `requireRiderApi()`.
 * What a rider is shown is decided here, by that id and the offer rules - never
 * by anything in the request.
 *
 * ## What goes to the phone, and when
 *
 * An offer carries what is needed to weigh a job (where, how far, what it pays,
 * what to collect) and nothing that identifies the customer or the shop's
 * contact. The customer's number, the shop's number, the customer's name and
 * the items list arrive only once the rider holds the order (`active`), and the
 * two numbers only while `driver.call_customer` is on.
 *
 * ## Before 0081 / 0082
 *
 * Reads degrade rather than fail: a database without `rider_status` has nobody
 * online, so the board has no offers; without the stamps the active delivery's
 * status is read from `deliveries.status`; without the event and exception
 * tables the timeline is empty. Writes fail closed: accept answers
 * `migration_pending` (503) when there is no presence table to check, and a
 * rejection that cannot be recorded is not applied.
 */

export interface RiderStop {
  name: string;
  line: string | null;
  point: { lat: number; lng: number } | null;
  phone: string | null;
}

export interface RiderOffer {
  orderId: string;
  code: string;
  shop: RiderStop;
  drop: RiderStop;
  instructions: string | null;
  itemCount: number;
  shopToDropKm: number | null;
  riderToShopKm: number | null;
  etaMinutes: number | null;
  /** When the exclusive window ends (ISO); null for an order nobody is holding. */
  offerExpiresAt: string | null;
  reservedForYou: boolean;
  payment: DriverPayment;
  /**
   * Always null. Riders are paid a fixed salary outside the app (P3-R11), so an
   * offer never shows what the job "pays". The field stays so the wire shape
   * the apps already parse does not change.
   */
  estimatedEarning: null;
}

export interface RiderUpcoming {
  offer: RiderOffer;
  readyInMinutes: number | null;
}

// Defined with the figures (pure, shared with Home and History) so there is one status table.
export type { RiderDeliveryStatus };

export interface RiderEvent {
  kind: string;
  method: string | null;
  reason: string | null;
  at: string;
}

export interface RiderException {
  id: string;
  kind: string;
  status: string;
  reason: string;
  decisionNote: string | null;
  createdAt: string;
}

export interface RiderActive {
  orderId: string;
  deliveryId: string;
  code: string;
  status: RiderDeliveryStatus;
  shop: RiderStop;
  drop: RiderStop & { customerName: string | null };
  instructions: string | null;
  items: { name: string; qty: number }[];
  payment: RiderOffer["payment"];
  pickupCodeRequired: boolean;
  distanceKm: number | null;
  etaMinutes: number | null;
  podPhotoRequired: boolean;
  timeline: RiderEvent[];
  exceptions: RiderException[];
  arrivedDropAt: string | null;
  unreachableWaitMinutes: number;
}

export interface RiderBoard {
  offers: RiderOffer[];
  upcoming: RiderUpcoming[];
  active: RiderActive | null;
  offerWindowSeconds: number;
  /**
   * The server's clock when this board was built (ISO). The app keeps the gap
   * between it and the phone's clock, so a countdown against `offerExpiresAt`
   * is right on a phone whose clock is wrong.
   */
  serverNow: string;
  /**
   * `platform_settings.routing_base_url`: the routing server the app draws the
   * delivery route with. Null when it is empty (the app then uses its default).
   */
  routingBaseUrl: string | null;
}

/**
 * Seams for tests and for callers that already hold the answer. Production
 * passes nothing: the window and the switches come from settings, the clock from
 * the system.
 */
export interface RiderJobOptions {
  windowSeconds?: number;
  now?: number;
  settings?: PlatformSettings;
  /** `driver.call_customer`; read from the feature switches when omitted. */
  canCall?: boolean;
  /** Tests: the routing server and the fetch that reaches it, and how a ring is stopped. */
  routingBaseUrl?: string;
  fetch?: typeof fetch;
  stopRing?: (driverId: string, orderId: string) => Promise<unknown>;
}

type AdminClient = ReturnType<typeof createAdminClient>;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** `orders.delivery_instructions` arrives with 0082. */
const INSTRUCTIONS_COLUMN = "orders.delivery_instructions";
/** The four 0081 stamps/columns the active delivery reads. */
const STAMP_COLUMNS = "arrived_pickup_at, departed_pickup_at, arrived_drop_at, distance_km";
const STAMP_NAMES = ["arrived_pickup_at", "departed_pickup_at", "arrived_drop_at", "distance_km"];

interface ShopRow {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  prep_minutes: number | null;
  eta_min: number | null;
  eta_max: number | null;
}

interface OrderRow {
  id: string;
  status: string;
  total: number;
  address: { label?: string; line?: string; lat?: number; lng?: number } | null;
  created_at: string | null;
  accepted_at: string | null;
  ready_at: string | null;
  delivery_instructions?: string | null;
  restaurants: ShopRow | ShopRow[] | null;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
  order_items: { name: string; qty: number }[] | null;
}

/**
 * `profiles` is disambiguated by name because `orders` has two foreign keys to
 * it (`customer_id`, `placed_by`): a bare embed is a hard PGRST201. The rider
 * needs the person receiving the food. Never `select("*")` on orders (AGENTS.md):
 * `pickup_otp` / `delivery_otp` are column-revoked (0058) and no longer used.
 */
function orderColumns(withInstructions: boolean): string {
  return [
    "id, status, total, address, created_at, accepted_at, ready_at",
    withInstructions ? "delivery_instructions" : null,
    "restaurants(name, address, lat, lng, prep_minutes, eta_min, eta_max)",
    "profiles!orders_customer_id_fkey(full_name)",
    "order_items(name, qty)",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Orders, retrying without `delivery_instructions` on a database that predates 0082. */
async function selectOrders(
  run: (columns: string) => PromiseLike<{
    data: OrderRow[] | null;
    error: { code?: string; message?: string } | null;
  }>
): Promise<OrderRow[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const withInstructions = !columnKnownMissing(INSTRUCTIONS_COLUMN);
    const { data, error } = await run(orderColumns(withInstructions));
    if (!error) {
      if (withInstructions) rememberColumn(INSTRUCTIONS_COLUMN, true);
      return data ?? [];
    }
    if (withInstructions && isMissingColumn(error) && /delivery_instructions/.test(error.message ?? "")) {
      rememberColumn(INSTRUCTIONS_COLUMN, false);
      continue;
    }
    throw error;
  }
  return [];
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function km1(from: { lat: number; lng: number } | null, to: { lat: number; lng: number } | null) {
  return from && to ? Math.round(haversineKm(from, to) * 10) / 10 : null;
}

function shopStop(order: OrderRow): RiderStop {
  const shop = one(order.restaurants);
  return {
    name: text(shop?.name) ?? "Kitchen",
    line: text(shop?.address),
    point: pointOf(shop?.lat, shop?.lng),
    phone: null,
  };
}

function dropStop(order: OrderRow): RiderStop {
  return {
    name: text(order.address?.label) ?? "Delivery address",
    line: text(order.address?.line),
    point: pointOf(order.address?.lat, order.address?.lng),
    phone: null,
  };
}

/**
 * Minutes until the order could be at the door, from where the rider is: the
 * ride to the shop (or the kitchen's remaining time, whichever is later), then
 * the shop-to-door leg. The same model the customer's countdown uses
 * (`computeOrderEta`, `roadMinutesFor`) - there is no second one. Null unless
 * both distances are known: a number built on a guessed distance is worse than
 * none.
 */
function etaToDoor(
  order: OrderRow,
  riderToShopKm: number | null,
  shopToDropKm: number | null,
  defaultPrepMinutes: number,
  now: number
): number | null {
  if (riderToShopKm === null || shopToDropKm === null) return null;
  const shop = one(order.restaurants);
  const eta = computeOrderEta({
    status: dbStatusToUi(order.status),
    createdAt: order.created_at,
    acceptedAt: order.accepted_at,
    readyAt: order.ready_at,
    etaMin: shop?.eta_min ?? null,
    etaMax: shop?.eta_max ?? null,
    defaultPrepMinutes,
    restaurantPrepMinutes: shop?.prep_minutes ?? null,
    straightLineKm: shopToDropKm,
    now,
  });
  const toShop = roadMinutesFor(riderToShopKm) ?? 0;
  const kitchenLeft =
    order.status === "ready" ? 0 : (readyIn(
      { accepted_at: order.accepted_at, restaurants: order.restaurants },
      defaultPrepMinutes,
      now
    ) ?? 0);
  return Math.round(Math.max(toShop, kitchenLeft) + eta.rideMinutes);
}

function toOffer(
  order: OrderRow,
  ctx: {
    presence: RiderPresence | null;
    payment: DriverPayment | undefined;
    reserved: boolean;
    expiresAt: string | null;
    settings: Pick<PlatformSettings, "defaultPrepMinutes">;
    now: number;
  }
): RiderOffer {
  const shop = shopStop(order);
  const drop = dropStop(order);
  const shopToDropKm = km1(shop.point, drop.point);
  const riderToShopKm = km1(ctx.presence?.position ?? null, shop.point);
  return {
    orderId: order.id,
    code: `#${shortOrderId(order.id)}`,
    shop,
    drop,
    instructions: text(order.delivery_instructions),
    itemCount: (order.order_items ?? []).reduce((n, i) => n + i.qty, 0),
    shopToDropKm,
    riderToShopKm,
    etaMinutes: etaToDoor(order, riderToShopKm, shopToDropKm, ctx.settings.defaultPrepMinutes, ctx.now),
    offerExpiresAt: ctx.expiresAt,
    reservedForYou: ctx.reserved,
    payment: ctx.payment ?? { instruction: "unconfirmed", collectAmount: 0 },
    estimatedEarning: null,
  };
}

interface DeliveryOfferRow {
  id: string;
  order_id: string;
  status: string;
  offered_driver_id?: string | null;
  offered_at?: string | null;
}

/**
 * Every delivery row on these orders, whatever its status: one query answers
 * both "is it already taken?" and "who is it held for?". Without 0042 there are
 * no offers, so only the status is read.
 */
async function readDeliveriesFor(
  supabase: AdminClient,
  orderIds: string[]
): Promise<DeliveryOfferRow[]> {
  if (orderIds.length === 0) return [];
  const withOffers = !columnKnownMissing(DISPATCH_COLUMNS);
  const { data, error } = await supabase
    .from("deliveries")
    .select(withOffers ? "id, order_id, status, offered_driver_id, offered_at" : "id, order_id, status")
    .in("order_id", orderIds)
    .overrideTypes<DeliveryOfferRow[]>();
  if (error) {
    if (withOffers && isMissingColumn(error)) {
      rememberColumn(DISPATCH_COLUMNS, false);
      return readDeliveriesFor(supabase, orderIds);
    }
    throw error;
  }
  if (withOffers) rememberColumn(DISPATCH_COLUMNS, true);
  return data ?? [];
}

/** Orders this rider has already turned down: they do not reappear on their board. */
async function declinedByRider(
  supabase: AdminClient,
  driverId: string,
  orderIds: string[]
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("delivery_events")
    .select("order_id")
    .eq("driver_id", driverId)
    .eq("kind", "rejected")
    .in("order_id", orderIds)
    .overrideTypes<{ order_id: string }[]>();
  // Missing table (no 0081): nothing has ever been rejected. Any other failure
  // costs the filter, never the board.
  if (error) return new Set();
  return new Set((data ?? []).map((r) => r.order_id));
}

/** Orders read per page, and the most offers one board lists. */
const BOARD_PAGE = 50;
const BOARD_SIZE = 50;
/** A bound on the paging, so a pathological backlog cannot turn one poll into a table scan. */
const MAX_BOARD_PAGES = 10;

async function readOffersAndUpcoming(
  supabase: AdminClient,
  driverId: string,
  presence: RiderPresence | null,
  windowSeconds: number,
  settings: PlatformSettings,
  now: number
): Promise<{ offers: RiderOffer[]; upcoming: RiderUpcoming[] }> {
  // Not in a shift (or no way to tell): no offers. A card the server would
  // refuse on tap is worse than no card.
  if (!presence?.online) return { offers: [], upcoming: [] };

  // Page through ready orders, oldest first, filtering as we go. A single
  // `limit(50)` taken BEFORE the held/taken/declined filters would let fifty
  // orders held for other riders hide every open one behind them.
  const at = new Date(now);
  const stateOf = (d: DeliveryOfferRow | undefined) =>
    offerState(
      driverId,
      { offeredDriverId: d?.offered_driver_id ?? null, offeredAt: d?.offered_at ?? null },
      windowSeconds,
      at
    );
  const visible: OrderRow[] = [];
  const deliveryOf = new Map<string, DeliveryOfferRow>();
  for (let page = 0; page < MAX_BOARD_PAGES && visible.length < BOARD_SIZE; page++) {
    const from = page * BOARD_PAGE;
    const ready = await selectOrders((columns) =>
      supabase
        .from("orders")
        .select(columns)
        .eq("status", "ready")
        .order("created_at", { ascending: true })
        .range(from, from + BOARD_PAGE - 1)
        .overrideTypes<OrderRow[]>()
    );
    const readyIds = ready.map((o) => o.id);
    const [deliveries, declined] = await Promise.all([
      readDeliveriesFor(supabase, readyIds),
      declinedByRider(supabase, driverId, readyIds),
    ]);
    const byOrder = new Map(deliveries.map((d) => [d.order_id, d]));
    for (const o of ready) {
      if (visible.length >= BOARD_SIZE) break;
      if (declined.has(o.id)) continue;
      const d = byOrder.get(o.id);
      // Somebody holds it (or finished it): not an offer.
      if (d && d.status !== "unassigned") continue;
      // Held for another rider: hidden, not shown-and-refused.
      if (stateOf(d) === "held") continue;
      visible.push(o);
      if (d) deliveryOf.set(o.id, d);
    }
    if (ready.length < BOARD_PAGE) break;
  }
  const payments = await readPoolPayments(supabase, visible);

  const offers = visible.map((o) => {
    const d = deliveryOf.get(o.id);
    const reserved = stateOf(d) === "mine";
    return toOffer(o, {
      presence,
      payment: payments.get(o.id),
      reserved,
      expiresAt: reserved ? offerDeadline(d?.offered_at ?? null, windowSeconds) : null,
      settings,
      now,
    });
  });
  // Whatever is held for this rider goes first - it is the one card that stops
  // being theirs if they scroll past it. Stable otherwise (oldest first).
  offers.sort((a, b) => Number(b.reservedForYou) - Number(a.reservedForYou));

  const upcoming = await readUpcoming(supabase, driverId, presence, settings, now);
  return { offers, upcoming };
}

/**
 * Every offer held for this rider (an unassigned delivery with
 * `offered_driver_id` = them) with the status of its order. The ONE selection
 * behind Jobs' "Upcoming" (the `kitchen` ones) and Home's Pending count, so
 * the two cannot drift. Throws on a failed read; before 0042 there is no such
 * column, so nothing is ever held (empty).
 */
export async function readHeldOffers(
  supabase: AdminClient,
  driverId: string
): Promise<{ orderId: string; offeredAt: string | null; orderStatus: string | null }[]> {
  if (columnKnownMissing(DISPATCH_COLUMNS)) return [];
  const { data: mine, error } = await supabase
    .from("deliveries")
    .select("order_id, offered_at")
    .eq("status", "unassigned")
    .eq("offered_driver_id", driverId)
    .overrideTypes<{ order_id: string; offered_at: string | null }[]>();
  if (error) {
    if (isMissingColumn(error)) {
      rememberColumn(DISPATCH_COLUMNS, false);
      return [];
    }
    throw error;
  }
  const held = mine ?? [];
  if (held.length === 0) return [];
  const { data: orders, error: orderError } = await supabase
    .from("orders")
    .select("id, status")
    .in("id", held.map((r) => r.order_id))
    .overrideTypes<{ id: string; status: string | null }[]>();
  if (orderError) throw orderError;
  const status = new Map((orders ?? []).map((o) => [o.id, o.status]));
  return held.map((r) => ({ orderId: r.order_id, offeredAt: r.offered_at, orderStatus: status.get(r.order_id) ?? null }));
}

/** Pickups offered to this rider while the kitchen is still cooking. */
async function readUpcoming(
  supabase: AdminClient,
  driverId: string,
  presence: RiderPresence | null,
  settings: PlatformSettings,
  now: number
): Promise<RiderUpcoming[]> {
  if (columnKnownMissing(DISPATCH_COLUMNS)) return [];
  try {
    const ids = (await readHeldOffers(supabase, driverId)).filter((h) => h.orderStatus === "kitchen").map((h) => h.orderId);
    if (ids.length === 0) return [];

    // `kitchen` only: once it is `ready` it belongs in `offers`, where it can
    // be accepted - in both places it would read as two jobs.
    const rows = await selectOrders((columns) =>
      supabase
        .from("orders")
        .select(columns)
        .in("id", ids)
        .eq("status", "kitchen")
        .order("accepted_at", { ascending: true })
        .overrideTypes<OrderRow[]>()
    );
    const payments = await readPoolPayments(supabase, rows);
    return rows.map((o) => ({
      offer: toOffer(o, {
        presence,
        payment: payments.get(o.id),
        reserved: true,
        // A heads-up has no countdown: nothing can be accepted yet.
        expiresAt: null,
        settings,
        now,
      }),
      readyInMinutes: readyIn(
        { accepted_at: o.accepted_at, restaurants: o.restaurants },
        settings.defaultPrepMinutes,
        now
      ),
    }));
  } catch {
    // A failure here costs the heads-up section, never the board.
    return [];
  }
}

interface ActiveDeliveryRow {
  id: string;
  order_id: string;
  status: string;
  arrived_pickup_at?: string | null;
  departed_pickup_at?: string | null;
  arrived_drop_at?: string | null;
  distance_km?: number | null;
}

/** The rider's delivery in flight, on whatever stamp columns this database has. */
async function readActiveDelivery(
  supabase: AdminClient,
  driverId: string
): Promise<ActiveDeliveryRow | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const withStamps = !columnKnownMissing(HANDOVER_COLUMNS);
    const { data, error } = await supabase
      .from("deliveries")
      .select(withStamps ? `id, order_id, status, ${STAMP_COLUMNS}` : "id, order_id, status")
      .eq("driver_id", driverId)
      .in("status", ["assigned", "picked_up"])
      .order("assigned_at", { ascending: false })
      .limit(1)
      .overrideTypes<ActiveDeliveryRow[]>();
    if (!error) {
      if (withStamps) rememberColumn(HANDOVER_COLUMNS, true);
      return data?.[0] ?? null;
    }
    if (
      withStamps &&
      isMissingColumn(error) &&
      STAMP_NAMES.some((c) => (error.message ?? "").includes(c))
    ) {
      rememberColumn(HANDOVER_COLUMNS, false);
      continue;
    }
    throw error;
  }
  return null;
}

/** The spec's status table: `deliveries.status` plus the stamps. */
function deliveryStatus(row: ActiveDeliveryRow): RiderDeliveryStatus {
  return riderDeliveryStatus(row);
}

async function readTimeline(supabase: AdminClient, deliveryId: string): Promise<RiderEvent[]> {
  const { data, error } = await supabase
    .from("delivery_events")
    .select("kind, method, reason, created_at")
    .eq("delivery_id", deliveryId)
    .order("created_at", { ascending: true })
    .overrideTypes<
      { kind: string; method: string | null; reason: string | null; created_at: string }[]
    >();
  if (error) return [];
  return (data ?? []).map((e) => ({
    kind: e.kind,
    method: e.method,
    reason: e.reason,
    at: e.created_at,
  }));
}

async function readExceptions(supabase: AdminClient, deliveryId: string): Promise<RiderException[]> {
  const { data, error } = await supabase
    .from("delivery_exceptions")
    .select("id, kind, status, reason, decision_note, created_at")
    .eq("delivery_id", deliveryId)
    .order("created_at", { ascending: false })
    .overrideTypes<
      {
        id: string;
        kind: string;
        status: string;
        reason: string;
        decision_note: string | null;
        created_at: string;
      }[]
    >();
  if (error) return [];
  return (data ?? []).map((x) => ({
    id: x.id,
    kind: x.kind,
    status: x.status,
    reason: x.reason,
    decisionNote: x.decision_note,
    createdAt: x.created_at,
  }));
}

/**
 * The shop's number: `restaurants.shop_phone` (0062), or the owner's `profiles.phone` when
 * the shop has none. Only for the rider holding the order, and only while
 * `driver.call_customer` is on. A failed read is a missing number, not a failed
 * board.
 */
async function readShopPhone(supabase: AdminClient, orderId: string): Promise<string | null> {
  type ShopContact = { shop_phone?: string | null; owner_id: string | null };
  type Row = { restaurants: ShopContact | ShopContact[] | null };
  for (const columns of ["shop_phone, owner_id", "owner_id"]) {
    const { data, error } = await supabase
      .from("orders")
      .select(`restaurants(${columns})`)
      .eq("id", orderId)
      .maybeSingle()
      .overrideTypes<Row>();
    if (error) {
      if (isMissingColumn(error) || error.code === "PGRST204") continue;
      return null;
    }
    const shop = one(data?.restaurants);
    const own = text(shop?.shop_phone);
    if (own) return own;
    if (!shop?.owner_id) return null;
    const { data: owner } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", shop.owner_id)
      .maybeSingle()
      .overrideTypes<{ phone: string | null }>();
    return text(owner?.phone);
  }
  return null;
}

async function readActive(
  supabase: AdminClient,
  driverId: string,
  presence: RiderPresence | null,
  settings: PlatformSettings,
  canCall: boolean,
  now: number
): Promise<RiderActive | null> {
  const delivery = await readActiveDelivery(supabase, driverId);
  if (!delivery) return null;

  const [order] = await selectOrders((columns) =>
    supabase
      .from("orders")
      .select(columns)
      .eq("id", delivery.order_id)
      .overrideTypes<OrderRow[]>()
  );
  if (!order) return null;

  const [detail, customerPhone, shopPhone, timeline, exceptions] = await Promise.all([
    activeOrderDetail(supabase, order.id),
    canCall ? activeCustomerPhone(supabase, order.id) : Promise.resolve(null),
    canCall ? readShopPhone(supabase, order.id) : Promise.resolve(null),
    readTimeline(supabase, delivery.id),
    readExceptions(supabase, delivery.id),
  ]);

  const status = deliveryStatus(delivery);
  const payment: DriverPayment = (() => {
    const instruction = paymentInstruction(detail);
    return { instruction, collectAmount: instruction === "collect" ? (order.total ?? 0) : 0 };
  })();

  const shop = shopStop(order);
  const drop = dropStop(order);
  const shopToDropKm = km1(shop.point, drop.point);
  const beforePickup = status === "accepted" || status === "arrived_pickup";

  const straight =
    shop.point && drop.point ? haversineKm(shop.point, drop.point) : null;
  const distanceKm =
    typeof delivery.distance_km === "number"
      ? delivery.distance_km
      : straight !== null
        ? roadKmFallback(straight)
        : null;

  let etaMinutes: number | null;
  if (status === "arrived_drop") {
    etaMinutes = 0;
  } else if (beforePickup) {
    etaMinutes = etaToDoor(
      order,
      km1(presence?.position ?? null, shop.point),
      shopToDropKm,
      settings.defaultPrepMinutes,
      now
    );
  } else {
    const left = presence?.position && drop.point ? haversineKm(presence.position, drop.point) : null;
    etaMinutes = roadMinutesFor(left);
  }

  const approvedWithoutCode = exceptions.some(
    (x) => x.kind === "complete_without_code" && x.status === "approved"
  );
  // The same rule AND the same "is this cash" answer (`isCashOrder`) that
  // `performDeliveryAction` enforces at the door, so the app asks for the photo
  // exactly when the server will refuse the step without it. Not
  // `payment.instruction`: that one says "unconfirmed" for an order with no
  // payment method, which the server counts as cash.
  const photoRequired = podPhotoRequired(settings.podPhotoRule, {
    isCod: isCashOrder({ payment_method: detail.method, payment_status: detail.status }),
    viaException: approvedWithoutCode,
  });

  return {
    orderId: order.id,
    deliveryId: delivery.id,
    code: `#${shortOrderId(order.id)}`,
    status,
    shop: { ...shop, phone: shopPhone },
    drop: {
      ...drop,
      phone: customerPhone,
      customerName: text(one(order.profiles)?.full_name),
    },
    instructions: text(order.delivery_instructions),
    items: (order.order_items ?? []).map((i) => ({ name: i.name, qty: i.qty })),
    payment,
    // Handover codes are retired (2026-10-27). Kept, always false, because
    // installed rider apps read it: false shows them a plain "Picked up".
    pickupCodeRequired: false,
    distanceKm,
    etaMinutes,
    podPhotoRequired: photoRequired,
    timeline,
    exceptions,
    arrivedDropAt: delivery.arrived_drop_at ?? null,
    unreachableWaitMinutes: settings.unreachableWaitMinutes,
  };
}

/**
 * The rider's job board: what they may accept, what is coming, and what they
 * are carrying. See the module header for what is and is not in each part.
 */
export async function getRiderBoard(
  driverId: string,
  opts: RiderJobOptions = {}
): Promise<RiderBoard> {
  const supabase = createAdminClient();
  const now = opts.now ?? Date.now();

  const settings = opts.settings ?? (await getSettings());
  const windowSeconds =
    opts.windowSeconds ?? normalizeOfferWindow(settings.riderOfferWindowSeconds);
  const [presence, canCall] = await Promise.all([
    readRiderPresence(driverId, now),
    opts.canCall !== undefined
      ? Promise.resolve(opts.canCall)
      : getFeatures("driver", driverId).then((f) => f["driver.call_customer"] !== false),
  ]);

  const [{ offers, upcoming }, active] = await Promise.all([
    readOffersAndUpcoming(supabase, driverId, presence, windowSeconds, settings, now),
    readActive(supabase, driverId, presence, settings, canCall, now),
  ]);

  return {
    offers,
    upcoming,
    active,
    offerWindowSeconds: windowSeconds,
    serverNow: new Date(now).toISOString(),
    routingBaseUrl: settings.routingBaseUrl?.trim() || null,
  };
}

/**
 * Accept an offer. The app's twin of the web portal's `acceptDeliveryAction`,
 * through the same `acceptDelivery`, so the two cannot drift.
 *
 * Stricter than the web path in one way: on a database without `rider_status`
 * there is no way to know the rider is online, so it throws
 * `RiderSchemaPendingError` (the route answers 503 `migration_pending`) rather
 * than letting an unchecked rider take work.
 *
 * `documents_expired` (0086, admin setting on) is decided inside
 * `acceptDelivery`, so this route and the web portal refuse alike.
 */
export async function acceptOffer(
  driverId: string,
  orderId: string,
  opts: RiderJobOptions = {}
): Promise<{ ok: true } | { ok: false; error: AcceptError }> {
  const now = opts.now ?? Date.now();
  const presence = await readRiderPresence(driverId, now);
  if (!presence) throw new RiderSchemaPendingError();
  return acceptDelivery(driverId, orderId, {
    windowSeconds: opts.windowSeconds,
    now,
    presence,
    routingBaseUrl: opts.routingBaseUrl,
    fetch: opts.fetch,
    stopRing: opts.stopRing,
  });
}

const NOTE_MAX = 200;

/**
 * Turn an offer down, with a reason.
 *
 * Only the current offeree may (`not_offered` otherwise - including a rider
 * whose offer has already moved on). In order:
 *
 *   1. record it: a `rejected` event with the reason and where the rider was.
 *      First, so a failure leaves the offer standing instead of cleared and
 *      unrecorded; on a database without `delivery_events` this throws
 *      `RiderSchemaPendingError` and nothing is applied.
 *   2. clear `offered_driver_id` / `offered_at` on the still-unassigned row (a
 *      plain update: no rider holds the delivery, so this is not a "release" in
 *      the 0082 guard's sense).
 *   3. stop the ring on the rider's phones.
 *   4. dispatch again, excluding every rider who has rejected or let a lapse on
 *      this order - not only this one. Who is next is dispatch's call; if
 *      nobody is eligible the order stays open and the sweep tries again.
 *
 * The position is stamped on the event, not written to the delivery row: no one
 * holds that row yet, and a rejecter's coordinates on it would be copied onto
 * the next rider's `offered` event by the audit trigger.
 */
export async function rejectOffer(
  driverId: string,
  orderId: string,
  reason: RejectReason,
  note?: string,
  opts: RiderJobOptions = {}
): Promise<{ ok: true } | { ok: false; error: "not_offered" | "invalid_reason" }> {
  if (!isRejectReason(reason)) return { ok: false, error: "invalid_reason" };

  const supabase = createAdminClient();
  const now = opts.now ?? Date.now();

  const { data: row, error: readError } = await supabase
    .from("deliveries")
    .select("id, status, offered_driver_id")
    .eq("order_id", orderId)
    .maybeSingle()
    .overrideTypes<{ id: string; status: string; offered_driver_id: string | null }>();
  if (readError) {
    // No 0042: there are no offers to reject.
    if (isMissingColumn(readError)) return { ok: false, error: "not_offered" };
    throw readError;
  }
  if (!row || row.status !== "unassigned" || row.offered_driver_id !== driverId) {
    return { ok: false, error: "not_offered" };
  }

  // Where the rider was is best-effort: an unreadable presence table must not
  // stop a rider declining an order, it only leaves the event without a position.
  const presence = await readRiderPresence(driverId, now).catch(() => null);
  const trimmed = (note ?? "").trim().slice(0, NOTE_MAX);

  const { error: eventError } = await supabase.from("delivery_events").insert({
    delivery_id: row.id,
    order_id: orderId,
    driver_id: driverId,
    kind: "rejected",
    reason: trimmed ? `${reason}: ${trimmed}` : reason,
    lat: presence?.position?.lat ?? null,
    lng: presence?.position?.lng ?? null,
  });
  if (eventError) {
    if (isMissingTable(eventError)) throw new RiderSchemaPendingError();
    throw eventError;
  }

  const { data: cleared, error: clearError } = await supabase
    .from("deliveries")
    .update({ offered_driver_id: null, offered_at: null })
    .eq("id", row.id)
    .eq("status", "unassigned")
    .eq("offered_driver_id", driverId)
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (clearError) throw clearError;
  // The offer moved on between our read and this write (the sweep lapsed it, or
  // someone accepted): it is no longer this rider's to reject.
  if ((cleared ?? []).length === 0) return { ok: false, error: "not_offered" };

  deferNotify(() => stopRiderRing(driverId, orderId));

  const excludeRiderIds = new Set<string>([driverId]);
  const { data: history, error: historyError } = await supabase
    .from("delivery_events")
    .select("driver_id")
    .eq("order_id", orderId)
    .in("kind", ["rejected", "lapsed"])
    .overrideTypes<{ driver_id: string | null }[]>();
  if (historyError) {
    // The rejection itself is recorded and the offer withdrawn, so the rider's
    // answer stands. But offering the order on from a PARTIAL exclusion list
    // could hand it back to someone who already said no: fail closed, leave it
    // open, and let the sweep (which has the same rule) pick it up.
    captureError(historyError, {
      source: "rider-jobs/reject",
      orderId,
      driverId,
      attrs: { event: "reject_history_unreadable" },
    });
    return { ok: true };
  }
  for (const e of history ?? []) if (e.driver_id) excludeRiderIds.add(e.driver_id);

  const { data: order } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<{ status: string }>();
  const stage: DispatchStage = order?.status === "ready" ? "ready" : "accepted";

  // Awaited (dispatch is awaited everywhere else): never throws, and it is the
  // difference between the next rider hearing about this now or a minute later.
  await dispatchOrder(orderId, stage, { excludeRiderIds: [...excludeRiderIds] });
  return { ok: true };
}

