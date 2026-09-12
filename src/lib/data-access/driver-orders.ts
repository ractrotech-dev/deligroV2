import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { shortOrderId } from "@/lib/utils/order-map";
import { notifyOnTheWay, notifyDelivered } from "@/lib/notifications/order-events";
import type { DeliveryJob, DeliveryStop } from "@/lib/roles-data";
import { getSettings } from "@/lib/settings";
import { haversineKm } from "@/lib/geo/distance";
import { PINNED_LOCATION } from "@/lib/location/pinned";
import { kitchenPrepMinutes } from "@/lib/orders/eta";
import {
  DISPATCH_COLUMNS,
  offerStateFor,
  type OfferRow,
} from "@/lib/dispatch/rider-dispatch";
import { notifyRiderArriving } from "@/lib/notifications/order-events";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { PaymentMethod, PaymentStatus } from "@/types";

/**
 * Driver marketplace + active delivery, on live data.
 *
 * A driver can only *see* an order once a delivery is assigned to them (RLS:
 * is_active_driver_for). The "available orders" pool — orders ready for pickup
 * with no rider yet — is by design invisible to a driver under RLS, so we read
 * it here with the service-role client. Every function is role-gated by the
 * caller (server action / route handler checks role === "driver") and only ever
 * returns — or writes — the signed-in driver's own delivery.
 */

export type Leg = "TO_PICKUP" | "TO_CUSTOMER";

/**
 * What the rider has to do about money at the door.
 *
 * `unconfirmed` is not hedging. It is an online order whose payment never
 * settled, which should not have reached a rider at all, and we refuse to guess
 * in either direction: telling a rider to collect from someone who already paid
 * charges that customer twice, and telling them to collect nothing hands the
 * food over for free. An operator has to break the tie.
 */
export type CashInstruction = "collect" | "prepaid" | "unconfirmed";

export interface DriverPayment {
  instruction: CashInstruction;
  /**
   * Rupees to take at the door — zero unless the instruction is "collect", so
   * that a screen which renders this without checking still cannot invent a
   * demand for money.
   */
  collectAmount: number;
}

export interface DriverActive {
  job: DeliveryJob;
  leg: Leg;
  /**
   * Cash vs prepaid for THIS order. Nothing in the driver UI used to mention
   * payment at all, which was harmless only for as long as every order was COD:
   * the day online payment is switched on, a rider with no signal asks a
   * prepaid customer to pay a second time.
   */
  payment: DriverPayment;
  /**
   * Whether this leg is gated by the kitchen's handover code.
   *
   * NOT the code itself, and that inversion is the fix. The rider used to be
   * SHOWN `orders.pickup_otp` to read out at the counter, while
   * `advanceDelivery` wrote `picked_up` without checking it — so a rider could
   * mark an order collected without ever visiting the shop, starting the
   * customer's road-leg ETA from a departure that never happened and pushing the
   * order to `on_the_way` on the kitchen board.
   *
   * Now the CODE is shown to the vendor, on the packed order, and the rider
   * types what the counter reads to them — the same shape as the delivery leg,
   * where the customer holds the code and the rider enters it. Possession of the
   * code is then evidence of having been there, which is the only thing that
   * made it worth having.
   *
   * False on a database whose order has no code recorded, where the leg stays
   * ungated rather than becoming impossible to complete.
   */
  pickupCodeRequired: boolean;
  /**
   * The customer's delivery code, when the leg is gated by it, is NOT here —
   * see `pickupCodeRequired`. Where the leg ENDS is not here either: it is
   * `job.pickup` or `job.drop`, chosen by `leg`. There used to be a separate
   * `navigateTo` pin on this object, which meant the Navigate button and the
   * address printed above it were two different facts about the same place and
   * could disagree — and did, because only one of them carried a street line.
   */
  /**
   * The customer's phone, for the Call control — which was likewise inert.
   *
   * On the ACTIVE delivery only, and read in its own query rather than added to
   * `ORDER_SELECT`, for the same reason `pickupOtp` is: that column list also
   * feeds the available pool, and every customer's number is not something to
   * ship to every rider who opens the board.
   */
  customerPhone: string | null;
}

/** An order in the open pool, plus whether dispatch is holding it for this rider. */
export interface AvailableJob extends DeliveryJob {
  /**
   * True while this order is inside its exclusivity window and the window
   * belongs to the rider reading the board. Orders held for *somebody else* are
   * not flagged — they are simply not in the list.
   */
  reservedForYou: boolean;
}

/**
 * A pickup this rider has been given advance notice of: the kitchen has
 * accepted it and is cooking, and dispatch picked this rider to collect it.
 *
 * The board could not show these before, because nothing existed before `ready`
 * — which is the moment the food is already on the pass. This is the difference
 * between a rider who is at the counter when the bag is and one who is told
 * about it afterwards.
 */
export interface UpcomingPickup {
  job: DeliveryJob;
  /**
   * Minutes the kitchen still needs, from `accepted_at` plus this shop's prep
   * leg — the same model the customer's countdown is built on. Null when the
   * order has no acceptance stamp to measure from.
   */
  readyInMinutes: number | null;
}

export interface DriverBoardData {
  available: AvailableJob[];
  /** Accepted by a kitchen, offered to this rider, not packed yet. */
  upcoming: UpcomingPickup[];
  active: DriverActive | null;
  // `earnings` used to sit here beside `trips`, and a money figure does not
  // belong on a salaried rider's board (see the "Salary model on the board"
  // task in build-plan.ts) — so the FIELD is gone, not merely the tile that
  // rendered it. onlineHours (5.5) and rating (4.8) went earlier, for a
  // different reason: they were constants, identical for every driver forever,
  // standing in for two things this platform has never tracked.
  today: { trips: number };
}

type AdminClient = ReturnType<typeof createAdminClient>;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * The pickup end, as `ORDER_SELECT` reads it.
 *
 * `address` is the vendor's own reverse-geocoded street line (migration 0009,
 * the same migration as `lat`/`lng` — which is why it can ride the existing
 * geo probe rather than needing one of its own). `landmark`/`pincode` are 0017
 * and are deliberately NOT here: adding them would widen this query's probe
 * group from "has 0009 and 0013" to "has 0017 as well", so a database at 0016
 * would silently lose shop coordinates and the tip to gain a landmark.
 */
interface OrderShop {
  name: string;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
}

interface OrderRow {
  id: string;
  total: number;
  delivery_fee?: number;
  tax_amount?: number;
  tip?: number;
  address: { label?: string; line?: string; lat?: number; lng?: number } | null;
  restaurants: OrderShop | OrderShop[] | null;
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
  order_items: { qty: number }[];
}

/** Pickup → drop, when both ends are known. Never a stand-in number. */
function jobDistance(r: OrderRow): number | undefined {
  const shop = one(r.restaurants);
  const from =
    typeof shop?.lat === "number" && typeof shop?.lng === "number"
      ? { lat: shop.lat, lng: shop.lng }
      : null;
  const to =
    typeof r.address?.lat === "number" && typeof r.address?.lng === "number"
      ? { lat: r.address.lat, lng: r.address.lng }
      : null;

  if (!from || !to) return undefined;
  return Math.round(haversineKm(from, to) * 10) / 10;
}

/** Trimmed, or undefined — never an empty string a card would render as a gap. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toJob(r: OrderRow): DeliveryJob {
  const shop = one(r.restaurants);
  const restaurant = shop?.name ?? "Kitchen";
  const customer = one(r.profiles)?.full_name?.trim() || "Customer";
  const items = (r.order_items ?? []).reduce((n, i) => n + i.qty, 0);

  // Both ends carry a findable address now. They did not before: `pickupArea`
  // was the shop's NAME (so the pickup line said "Saffron Kitchen" twice and
  // never said where it was) and `dropArea` was `address.label ?? address.line`
  // — which meant a rider whose customer had saved their address as "Home" was
  // handed the word "Home" and expected to deliver to it. The street line the
  // customer actually typed at checkout, flat number and entry code included,
  // was in the row the whole time and was being thrown away by that `??`.
  const pickup: DeliveryStop = {
    area: restaurant,
    address: text(shop?.address),
    point: pointOf(shop?.lat, shop?.lng) ?? undefined,
  };
  const drop: DeliveryStop = {
    area: text(r.address?.label) ?? "Delivery",
    address: text(r.address?.line),
    point: pointOf(r.address?.lat, r.address?.lng) ?? undefined,
  };

  return {
    id: r.id,
    code: `#${shortOrderId(r.id)}`,
    restaurant,
    pickup,
    drop,
    // Was hardcoded to 2.5 for every job, on every screen, forever.
    distanceKm: jobDistance(r),
    items,
    customer,
  };
}

/**
 * `profiles` is disambiguated by name because `orders` has two foreign keys to
 * it: `customer_id` and `placed_by` (migration 0029). A bare `profiles(...)`
 * embed is a hard PGRST201 from PostgREST, not a missing column, so the legacy
 * retry below cannot rescue it — the whole board 500s. The rider needs the
 * person receiving the food, which is `customer_id`; `placed_by` is the staff
 * account that typed a phone order.
 */
const ORDER_SELECT =
  "id, total, delivery_fee, tax_amount, tip, address, restaurants(name, address, lat, lng), profiles!orders_customer_id_fkey(full_name), order_items(qty)";

/**
 * The same query for a database that predates migrations 0009 (shop coords) and
 * 0013 (tip). Without this, asking for a column that doesn't exist is a hard 400
 * and the board silently shows a driver no jobs at all.
 */
const ORDER_SELECT_LEGACY =
  "id, total, delivery_fee, tax_amount, address, restaurants(name), profiles!orders_customer_id_fkey(full_name), order_items(qty)";

let ordersHaveGeoAndTip: boolean | null = null;

/** Run a driver-board order query, retrying on the pre-0009/0013 column set. */
async function selectJobs<T>(
  run: (columns: string) => PromiseLike<{ data: T | null; error: { code?: string } | null }>
): Promise<T | null> {
  if (ordersHaveGeoAndTip !== false) {
    const { data, error } = await run(ORDER_SELECT);
    if (!error) {
      ordersHaveGeoAndTip = true;
      return data;
    }
    if (!isMissingColumn(error)) throw error;
    ordersHaveGeoAndTip = false;
  }

  const { data, error } = await run(ORDER_SELECT_LEGACY);
  if (error) throw error;
  return data;
}

/** The 0025 payment columns arrive together, so one probe key covers both. */
const PAYMENT_COLUMNS = "orders.payment_method";
/** `deliveries.driver_location_source` arrives with 0026. */
const LOCATION_SOURCE_COLUMN = "deliveries.driver_location_source";
/** `deliveries.cod_collected_amount` / `cod_collected_at` arrive together with 0047. */
const COD_COLLECTED_COLUMN = "deliveries.cod_collected_amount";

interface ActiveOrderRow {
  pickup_otp?: string | null;
  payment_method?: PaymentMethod | null;
  payment_status?: PaymentStatus | null;
}

interface ActiveOrderDetail {
  pickupOtp: string | null;
  method: PaymentMethod | null;
  status: PaymentStatus | null;
  /**
   * Whether this database has the 0025 payment columns at all. Separating this
   * from a null `method` matters: "there is no such thing as an online order
   * here" and "we asked and got nothing back" look identical in the row and are
   * not remotely the same answer.
   */
  paymentColumns: boolean;
  /** False when the order row could not be read back. */
  found: boolean;
}

/**
 * The two things about the *active* order that the board queries deliberately
 * do not fetch: how the customer is paying, and the pickup handover code.
 *
 * Kept out of ORDER_SELECT on purpose. That column list also feeds the
 * available pool, and a code that proves a rider turned up at the counter is
 * not theirs to know before they have claimed the job.
 *
 * The payment pair is probed rather than assumed, because 0025 may not have
 * been applied here.
 */
async function activeOrderDetail(
  supabase: AdminClient,
  orderId: string
): Promise<ActiveOrderDetail> {
  const read = (columns: string) =>
    supabase
      .from("orders")
      .select(columns)
      .eq("id", orderId)
      .maybeSingle()
      .overrideTypes<ActiveOrderRow>();

  const shape = (row: ActiveOrderRow | null, paymentColumns: boolean) => ({
    pickupOtp: row?.pickup_otp ?? null,
    method: row?.payment_method ?? null,
    status: row?.payment_status ?? null,
    paymentColumns,
    found: row !== null,
  });

  if (!columnKnownMissing(PAYMENT_COLUMNS)) {
    const { data, error } = await read("pickup_otp, payment_method, payment_status");
    if (!error) {
      rememberColumn(PAYMENT_COLUMNS, true);
      return shape(data, true);
    }
    if (!isMissingColumn(error)) throw error;
    rememberColumn(PAYMENT_COLUMNS, false);
  }

  const { data, error } = await read("pickup_otp");
  if (error) throw error;
  return shape(data, false);
}

/** A pin, or null when this end has never been placed on a map. */
function pointOf(
  lat: number | null | undefined,
  lng: number | null | undefined
): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * The customer's number for one claimed order.
 *
 * Its own query, scoped to the order the rider is actually carrying. Failure is
 * soft: a rider whose Call button is disabled is worse off than one who can
 * call, but not as badly off as one whose whole board fails to load.
 */
async function activeCustomerPhone(
  supabase: AdminClient,
  orderId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("profiles!orders_customer_id_fkey(phone)")
    .eq("id", orderId)
    .maybeSingle()
    .overrideTypes<{ profiles: { phone: string | null } | { phone: string | null }[] | null }>();

  if (error) return null;
  return one(data?.profiles)?.phone?.trim() || null;
}

/** Cash-at-the-door, decided from what the database actually knows. */
function paymentInstruction(detail: ActiveOrderDetail): CashInstruction {
  // We asked and got nothing. No opinion, and no guessing: collecting from
  // someone who has already paid and handing over free food are both real
  // losses, and choosing between them is an operator's call, not a default.
  if (!detail.found) return "unconfirmed";

  // Before 0025 there was no way to pay online at all, so an order on a
  // database without those columns is COD by construction — genuinely known,
  // not merely unknown.
  if (!detail.paymentColumns) return "collect";

  // Settled either way: the money is with us, or back with the customer.
  // Checked first so it holds whatever the method says.
  if (detail.status === "paid" || detail.status === "refunded") return "prepaid";
  if (detail.method === "cod") return "collect";

  // Authorized: the gateway is holding the customer's money and capturing it is
  // our problem, not the rider's. Nothing to take at the door.
  if (detail.status === "authorized") return "prepaid";

  // Online, and the money never arrived. This order should not have reached a
  // rider; say so rather than pick a side.
  return "unconfirmed";
}

export async function getDriverBoard(driverId: string): Promise<DriverBoardData> {
  const supabase = createAdminClient();

  // Riders are salaried, not paid per order — see the "Salary model on the
  // board" task in build-plan.ts. `getSettings()` is still read once here for
  // `defaultPrepMinutes`, which the upcoming-pickup cards need.
  const settings = await getSettings();

  // Active delivery for this driver (assigned or picked up).
  type ActiveRow = { status: string; order: OrderRow | OrderRow[] | null };
  const activeRows = await selectJobs<ActiveRow[]>((columns) =>
    supabase
      .from("deliveries")
      .select(`status, order:orders(${columns})`)
      .eq("driver_id", driverId)
      .in("status", ["assigned", "picked_up"])
      .order("assigned_at", { ascending: false })
      .limit(1)
      .overrideTypes<ActiveRow[]>()
  );

  const activeRow = one(activeRows);
  let active: DriverActive | null = null;
  if (activeRow) {
    const order = one(activeRow.order);
    if (order) {
      const leg: Leg = activeRow.status === "picked_up" ? "TO_CUSTOMER" : "TO_PICKUP";
      const [detail, customerPhone] = await Promise.all([
        activeOrderDetail(supabase, order.id),
        activeCustomerPhone(supabase, order.id),
      ]);
      const instruction = paymentInstruction(detail);

      active = {
        job: toJob(order),
        leg,
        payment: {
          instruction,
          // orders.total is the authoritative sum (recompute_order_total) and
          // includes the tip, which on a cash order the rider also collects.
          collectAmount: instruction === "collect" ? (order.total ?? 0) : 0,
        },
        pickupCodeRequired:
          leg === "TO_PICKUP" && Boolean(detail.pickupOtp?.trim()),
        customerPhone,
      };
    }
  }

  // Available pool: orders that are ready and not already taken by a rider.
  const readyRows = await selectJobs<OrderRow[]>((columns) =>
    supabase
      .from("orders")
      .select(columns)
      .eq("status", "ready")
      .order("created_at", { ascending: true })
      .overrideTypes<OrderRow[]>()
  );
  const readyIds = (readyRows ?? []).map((r) => r.id);

  // Scoped to the orders on this board. This used to select every delivery on
  // the platform that had ever reached `assigned` — including every `delivered`
  // row ever written — to answer a question about at most a handful of ready
  // orders, so the cost of drawing one rider's board grew with the lifetime
  // order count. The set it produces is identical either way.
  const { data: taken } = readyIds.length
    ? await supabase
        .from("deliveries")
        .select("order_id, status")
        .in("order_id", readyIds)
        .in("status", ["assigned", "picked_up", "delivered"])
    : { data: [] };
  const takenIds = new Set((taken ?? []).map((d) => d.order_id as string));

  // Who each open order is currently held for. Empty map on a database without
  // 0042, which is exactly the old free-for-all: nothing is held, everything is
  // offered to everyone, first thumb wins.
  const now = Date.now();
  const offers = await readOffers(supabase, readyIds);

  const available: AvailableJob[] = [];
  for (const r of readyRows ?? []) {
    if (takenIds.has(r.id)) continue;
    const state = offerStateFor(driverId, offers.get(r.id), now);
    // Held for somebody else: not shown at all, rather than shown and refused.
    if (state === "held") continue;
    available.push({ ...toJob(r), reservedForYou: state === "mine" });
  }
  // Whatever is being held for this rider goes to the top — it is the one card
  // on the screen that will stop being theirs if they scroll past it.
  available.sort((a, b) => Number(b.reservedForYou) - Number(a.reservedForYou));

  const upcoming = await readUpcomingPickups(
    supabase,
    driverId,
    settings.defaultPrepMinutes,
    now
  );

  // Today's completed trips. A count, and only a count: this used to embed the
  // charge columns off every delivered order so it could total the day's
  // commission, which is a query (and a pre-migration fallback for `tip`) that
  // existed solely to produce a money figure the board no longer shows.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("deliveries")
    .select("id", { count: "exact", head: true })
    .eq("driver_id", driverId)
    .eq("status", "delivered")
    .gte("delivered_at", startOfDay.toISOString());

  return {
    available,
    upcoming,
    active,
    today: { trips: count ?? 0 },
  };
}

/**
 * order id → who it is currently offered to, for the orders on this board.
 *
 * One query for the whole board rather than one per card. Soft-fails to an
 * empty map, which is the pre-dispatch behaviour — every ready order visible to
 * every rider — rather than an empty board.
 */
async function readOffers(
  supabase: AdminClient,
  orderIds: string[]
): Promise<Map<string, OfferRow>> {
  const out = new Map<string, OfferRow>();
  if (columnKnownMissing(DISPATCH_COLUMNS) || orderIds.length === 0) return out;

  const { data, error } = await supabase
    .from("deliveries")
    .select("order_id, offered_driver_id, offered_at")
    // Scoped to the orders actually on this board. Reading every standing offer
    // would make the query grow with the platform rather than with the screen.
    .in("order_id", orderIds)
    .eq("status", "unassigned")
    .not("offered_driver_id", "is", null)
    .overrideTypes<
      { order_id: string; offered_driver_id: string | null; offered_at: string | null }[]
    >();

  if (error) {
    if (isMissingColumn(error)) rememberColumn(DISPATCH_COLUMNS, false);
    return out;
  }
  rememberColumn(DISPATCH_COLUMNS, true);

  for (const row of data ?? []) {
    out.set(row.order_id, {
      offeredDriverId: row.offered_driver_id,
      offeredAt: row.offered_at,
    });
  }
  return out;
}

interface UpcomingOrderRow extends OrderRow {
  accepted_at?: string | null;
  restaurants:
    | (OrderShop & { prep_minutes?: number | null })
    | (OrderShop & { prep_minutes?: number | null })[]
    | null;
}

/**
 * Pickups this rider has been given notice of: still cooking, offered to them.
 *
 * Gated on the 0042 probe, and that gate is what makes the rest of the query
 * safe to write plainly. `orders.accepted_at` is 0026 and
 * `restaurants.prep_minutes` is 0036, both of which any database carrying 0042
 * necessarily has — so this needs no fallback of its own, unlike the pool query
 * above, which has to work on environments as far back as 0008.
 *
 * A failure here costs the heads-up section, never the board.
 */
async function readUpcomingPickups(
  supabase: AdminClient,
  driverId: string,
  defaultPrepMinutes: number,
  now: number
): Promise<UpcomingPickup[]> {
  if (columnKnownMissing(DISPATCH_COLUMNS)) return [];

  try {
    const { data: mine, error } = await supabase
      .from("deliveries")
      .select("order_id")
      .eq("status", "unassigned")
      .eq("offered_driver_id", driverId)
      .overrideTypes<{ order_id: string }[]>();

    if (error) {
      if (isMissingColumn(error)) rememberColumn(DISPATCH_COLUMNS, false);
      return [];
    }
    rememberColumn(DISPATCH_COLUMNS, true);

    const ids = (mine ?? []).map((r) => r.order_id);
    if (ids.length === 0) return [];

    // `kitchen` only. An offer made at acceptance whose order has since become
    // `ready` belongs in the pool below, where it can actually be accepted —
    // showing it in both places would read as two jobs.
    const { data: rows } = await supabase
      .from("orders")
      .select(
        "id, total, delivery_fee, tax_amount, tip, address, accepted_at, restaurants(name, address, lat, lng, prep_minutes), profiles!orders_customer_id_fkey(full_name), order_items(qty)"
      )
      .in("id", ids)
      .eq("status", "kitchen")
      .order("accepted_at", { ascending: true })
      .overrideTypes<UpcomingOrderRow[]>();

    return (rows ?? []).map((r) => ({
      job: toJob(r),
      readyInMinutes: readyIn(r, defaultPrepMinutes, now),
    }));
  } catch {
    return [];
  }
}

/**
 * How much longer the kitchen needs, in whole minutes.
 *
 * `accepted_at` + this shop's prep leg, floored at zero — an order already past
 * its estimate reads as "any moment now", which is true, rather than as a
 * negative number. Null without an acceptance stamp: there is then nothing to
 * measure from, and quoting the raw prep time would restart the clock every
 * time the rider's board refreshed.
 */
function readyIn(
  r: UpcomingOrderRow,
  defaultPrepMinutes: number,
  now: number
): number | null {
  const acceptedMs = r.accepted_at ? Date.parse(r.accepted_at) : NaN;
  if (!Number.isFinite(acceptedMs)) return null;

  const prep = kitchenPrepMinutes({
    restaurantPrepMinutes: one(r.restaurants)?.prep_minutes,
    defaultPrepMinutes,
  });
  return Math.max(0, Math.round((acceptedMs + prep * 60_000 - now) / 60_000));
}

/** Claim a ready order: create the delivery row assigned to this driver. */
export async function acceptDelivery(
  driverId: string,
  orderId: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();

  // Guard against a double-claim race, and against taking an order dispatch is
  // currently holding for somebody else.
  //
  // This read used to filter to the claimed statuses, so it could not see the
  // `unassigned` row an offer now leaves behind — and the insert below would
  // then hit the unique constraint on `order_id` and report "already taken" for
  // an order nobody had taken. It reads the row whatever its status and decides
  // here instead.
  const { data: existing } = await supabase
    .from("deliveries")
    .select("id, status")
    .eq("order_id", orderId)
    .maybeSingle();

  if (existing && existing.status !== "unassigned") {
    return { ok: false, error: "already_taken" };
  }

  // The order itself must be ready for pickup. An offer can exist earlier, at
  // `kitchen`, purely as advance notice (see readUpcomingPickups) — the board
  // already withholds the Accept control until `ready`, but that's a UI choice,
  // not a guarantee. Without this check, a rider holding the order id from the
  // upcoming-pickups list could accept (or claim a standing offer) before the
  // kitchen has even started, or after the order was cancelled/delivered by
  // some other path, creating a live delivery nobody can act on correctly.
  const { data: order } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.status !== "ready") {
    return { ok: false, error: "not_ready" };
  }

  if (existing) {
    const held = await offerHeldFromOther(supabase, existing.id, driverId);
    // Fails closed: an offer we could not read is treated as somebody else's.
    // The window is three minutes, so the cost of being wrong is a rider
    // waiting three minutes; the cost the other way is two riders sent to the
    // same shop.
    if (held) return { ok: false, error: "reserved" };
    return claimOffer(supabase, existing.id, driverId);
  }

  // No coordinates. This insert used to seed driver_lat/driver_lng with a fixed
  // offset from the centre of Bemetara — 21.7157 + 0.012, 81.5335 - 0.008 — and
  // nothing in the app ever wrote them again, so the dot a customer watched
  // crossing their map had never been anywhere near their courier. Until the
  // rider's device reports (see reportDriverLocation), the honest answer is that
  // we do not know where they are, recorded as 'none' so the tracking map can
  // say "estimated" instead of drawing a confident position.
  const insert = (withSource: boolean) =>
    supabase.from("deliveries").insert({
      order_id: orderId,
      driver_id: driverId,
      status: "assigned",
      assigned_at: new Date().toISOString(),
      ...(withSource ? { driver_location_source: "none" } : {}),
    });

  let withSource = !columnKnownMissing(LOCATION_SOURCE_COLUMN);
  let { error } = await insert(withSource);

  if (error && withSource && isMissingColumn(error)) {
    // 0026 not applied here. A null lat/lng already means "no fix has ever been
    // reported"; the column only makes that explicit, so the job can still be
    // taken without it.
    rememberColumn(LOCATION_SOURCE_COLUMN, false);
    withSource = false;
    ({ error } = await insert(false));
  } else if (!error && withSource) {
    rememberColumn(LOCATION_SOURCE_COLUMN, true);
  }

  if (error) {
    // deliveries.order_id is unique (0001): when two riders tap Accept at once
    // both pass the check above and the loser's insert raises 23505. That's not
    // something the rider can fix — someone simply got there first.
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, error: "already_taken" };
    }
    throw error;
  }
  return { ok: true };
}

/** Is this delivery inside an exclusivity window belonging to another rider? */
async function offerHeldFromOther(
  supabase: AdminClient,
  deliveryId: string,
  driverId: string
): Promise<boolean> {
  if (columnKnownMissing(DISPATCH_COLUMNS)) return false;

  const { data, error } = await supabase
    .from("deliveries")
    .select("offered_driver_id, offered_at")
    .eq("id", deliveryId)
    .maybeSingle()
    .overrideTypes<{ offered_driver_id: string | null; offered_at: string | null }>();

  if (error) {
    if (isMissingColumn(error)) {
      rememberColumn(DISPATCH_COLUMNS, false);
      return false;
    }
    throw error;
  }
  rememberColumn(DISPATCH_COLUMNS, true);

  return (
    offerStateFor(driverId, {
      offeredDriverId: data?.offered_driver_id ?? null,
      offeredAt: data?.offered_at ?? null,
    }) === "held"
  );
}

/**
 * Turn a standing offer row into this rider's delivery.
 *
 * `.eq("status", "unassigned")` is the optimistic lock that replaces the unique
 * constraint the insert path relies on: two riders racing on an open offer both
 * reach here, and only the first update matches a row. `offered_driver_id` is
 * deliberately left as it was — it is the record of who dispatch asked, which
 * stays true whether or not that is who came.
 */
async function claimOffer(
  supabase: AdminClient,
  deliveryId: string,
  driverId: string
): Promise<{ ok: boolean; error?: string }> {
  const claim = (withSource: boolean) =>
    supabase
      .from("deliveries")
      .update({
        driver_id: driverId,
        status: "assigned",
        assigned_at: new Date().toISOString(),
        ...(withSource ? { driver_location_source: "none" } : {}),
      })
      .eq("id", deliveryId)
      .eq("status", "unassigned")
      .select("id")
      .overrideTypes<{ id: string }[]>();

  let withSource = !columnKnownMissing(LOCATION_SOURCE_COLUMN);
  let { data, error } = await claim(withSource);

  if (error && withSource && isMissingColumn(error)) {
    rememberColumn(LOCATION_SOURCE_COLUMN, false);
    withSource = false;
    ({ data, error } = await claim(false));
  } else if (!error && withSource) {
    rememberColumn(LOCATION_SOURCE_COLUMN, true);
  }

  if (error) throw error;
  if ((data ?? []).length === 0) return { ok: false, error: "already_taken" };
  return { ok: true };
}

/**
 * How far from the operating area a reported fix may be before we treat it as
 * garbage rather than a courier.
 *
 * The cases this catches are all client bugs, not riders: (0, 0) off the coast
 * of Africa, a desktop emulator's San Francisco default, and lat/lng posted the
 * wrong way round (81.5, 21.7 lands in the Arctic Ocean). 1 000 km is
 * deliberately far — it covers every road a Bemetara rider could conceivably be
 * on — so this rejects nonsense without ever refusing a real fix.
 *
 * It is derived from PINNED_LOCATION, i.e. from the single-city assumption. If
 * Deligro opens a city outside this radius, riders there will silently report
 * nothing and their customers will silently get an interpolated dot. Move this
 * with the city list, not after it.
 */
const MAX_FIX_KM = 1000;

export type LocationReport =
  | { ok: true; active: boolean }
  | { ok: false; error: "invalid_position" };

/**
 * Record where the rider's device says it is, on that rider's own in-flight
 * delivery.
 *
 * The row is chosen by driver_id and delivery status, never by an id supplied
 * by the caller: there is no parameter here with which a rider could name
 * somebody else's delivery, so "a driver writing another driver's location" is
 * not a check that can be forgotten — it is unrepresentable.
 *
 * Called from POST /api/driver/location, which authenticates, checks the role
 * and rate-limits before reaching this (createAdminClient bypasses RLS).
 */
export async function reportDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<LocationReport> {
  // Re-validated here rather than trusted from the route: this is the function
  // that writes, so this is where the position has to be defensible.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: "invalid_position" };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: "invalid_position" };
  }
  if (haversineKm(PINNED_LOCATION.coords, { lat, lng }) > MAX_FIX_KM) {
    return { ok: false, error: "invalid_position" };
  }

  const supabase = createAdminClient();

  const update = (withSource: boolean) =>
    supabase
      .from("deliveries")
      .update({
        driver_lat: lat,
        driver_lng: lng,
        driver_location_at: new Date().toISOString(),
        ...(withSource ? { driver_location_source: "gps" } : {}),
      })
      .eq("driver_id", driverId)
      .in("status", ["assigned", "picked_up"])
      .select("id, order_id, status")
      .overrideTypes<ReportedRow[]>();

  let withSource = !columnKnownMissing(LOCATION_SOURCE_COLUMN);
  let { data, error } = await update(withSource);

  if (error && withSource && isMissingColumn(error)) {
    // 0026 not applied: store the fix anyway. A recent driver_location_at with
    // real coordinates is still better than the interpolation, and the customer
    // UI degrades to treating an unlabelled position as unverified.
    rememberColumn(LOCATION_SOURCE_COLUMN, false);
    withSource = false;
    ({ data, error } = await update(false));
  } else if (!error && withSource) {
    rememberColumn(LOCATION_SOURCE_COLUMN, true);
  }

  if (error) throw error;

  const rows = data ?? [];

  // Awaited, not fired and forgotten: this runs inside a POST the rider's phone
  // makes every ten seconds, and an un-awaited promise in a serverless request
  // is one the runtime is free to kill mid-flight. It swallows its own failures,
  // so awaiting it cannot cost the position write that already succeeded.
  await maybeAnnounceArrival(supabase, rows[0], driverId, { lat, lng });

  // Nothing matched: this rider has no delivery in flight (finished on another
  // device, or reassigned by an operator). Not an error — but the caller should
  // stop reporting rather than keep asking.
  return { ok: true, active: rows.length > 0 };
}

interface ReportedRow {
  id: string;
  order_id: string;
  status: string;
}

/**
 * How close the rider gets before the customer is told they have arrived.
 *
 * 500 m, straight-line. Chosen to be the distance at which "come down" is
 * useful rather than the distance at which it is literally true: a courier
 * 500 m out is a minute or two away on a bike, which is roughly how long it
 * takes somebody to find their shoes and get to a gate. Measuring it as the
 * crow flies makes it generous in a lane and about right on a main road, and
 * being early here is the harmless direction.
 */
const ARRIVAL_RADIUS_M = 500;

/**
 * Tell the customer their rider is here — once, on the delivery leg only.
 *
 * The latch is `deliveries.arrival_notified_at` (0042) and it is what makes
 * this feature possible at all: the position that triggers it arrives every ten
 * seconds for the rest of the delivery, so without somewhere to record that we
 * have already said it, a customer whose courier is parking outside would be
 * notified every ten seconds until they were handed their food.
 *
 * Only `picked_up`. A rider on the way TO the shop passes within 500 m of
 * plenty of addresses, including sometimes the customer's own, and none of that
 * means their dinner has arrived.
 *
 * Best-effort throughout. A database without 0042 has no latch, so it gets no
 * notification rather than an unbounded stream of them — silence is the correct
 * failure here, and it clears itself the moment the migration is applied.
 */
async function maybeAnnounceArrival(
  supabase: AdminClient,
  row: ReportedRow | undefined,
  driverId: string,
  at: { lat: number; lng: number }
): Promise<void> {
  if (!row || row.status !== "picked_up") return;
  if (columnKnownMissing(DISPATCH_COLUMNS)) return;

  try {
    const { data: delivery, error } = await supabase
      .from("deliveries")
      .select("arrival_notified_at")
      .eq("id", row.id)
      .maybeSingle()
      .overrideTypes<{ arrival_notified_at: string | null }>();

    if (error) {
      if (isMissingColumn(error)) rememberColumn(DISPATCH_COLUMNS, false);
      return;
    }
    rememberColumn(DISPATCH_COLUMNS, true);
    if (delivery?.arrival_notified_at) return;

    const { data: order } = await supabase
      .from("orders")
      .select("address")
      .eq("id", row.order_id)
      .maybeSingle()
      .overrideTypes<{ address: { lat?: number; lng?: number } | null }>();

    const drop = pointOf(order?.address?.lat, order?.address?.lng);
    // An address with no pin cannot be arrived at. The rider still has the
    // street line on their screen; there is simply nothing to measure.
    if (!drop) return;
    if (haversineKm(at, drop) * 1000 > ARRIVAL_RADIUS_M) return;

    // Stamp BEFORE notifying, and only act on a row that was still unstamped:
    // two location posts can overlap (the phone retries after a tunnel), and
    // this is what stops both of them sending. A push we then fail to deliver
    // costs one message; a latch we set after sending can cost dozens.
    const { data: latched } = await supabase
      .from("deliveries")
      .update({ arrival_notified_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("arrival_notified_at", null)
      .select("id")
      .overrideTypes<{ id: string }[]>();
    if ((latched ?? []).length === 0) return;

    const { data: rider } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", driverId)
      .maybeSingle();

    await notifyRiderArriving(row.order_id, rider?.full_name ?? null);
  } catch {
    // Fire-and-forget by contract: a rider's position must still be recorded
    // when the notification path fails.
  }
}

interface DeliveryOtpOrder {
  delivery_otp: string | null;
  total: number | null;
  payment_method: PaymentMethod | null;
}

/**
 * The order row `advanceDelivery`'s completion step needs: the handover code,
 * the total (for the COD collection record), and how it was paid.
 *
 * `payment_method` is probed the same way `activeOrderDetail` probes it
 * above — a database without 0025 simply has no such column, and asking for
 * it unconditionally would 400 the whole query and, with it, every delivery
 * completion. `delivery_otp` and `total` predate 0025 and are always safe to
 * ask for.
 */
async function readDeliveryOtpOrder(
  supabase: AdminClient,
  orderId: string
): Promise<DeliveryOtpOrder | null> {
  const read = (columns: string) =>
    supabase
      .from("orders")
      .select(columns)
      .eq("id", orderId)
      .maybeSingle()
      .overrideTypes<DeliveryOtpOrder>();

  if (!columnKnownMissing(PAYMENT_COLUMNS)) {
    const { data, error } = await read("delivery_otp, total, payment_method");
    if (!error) {
      rememberColumn(PAYMENT_COLUMNS, true);
      return data;
    }
    if (!isMissingColumn(error)) throw error;
    rememberColumn(PAYMENT_COLUMNS, false);
  }

  const { data, error } = await read("delivery_otp, total");
  if (error) throw error;
  return data ? { ...data, payment_method: null } : null;
}

/**
 * Advance the driver's active delivery: pickup → on the way → delivered.
 * Completing the delivery requires the customer's handover OTP (proves the food
 * actually reached them) — verified against orders.delivery_otp.
 */
export async function advanceDelivery(
  driverId: string,
  orderId: string,
  otp?: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = createAdminClient();

  const { data: delivery, error: readErr } = await supabase
    .from("deliveries")
    .select("id, status")
    .eq("order_id", orderId)
    .eq("driver_id", driverId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!delivery) return { ok: false, error: "not_found" };

  if (delivery.status === "assigned") {
    // Picked up → order is on the way, gated by the kitchen's handover code.
    //
    // This transition used to check nothing. The rider was shown
    // `orders.pickup_otp` to read to the counter and could then mark the pickup
    // from anywhere, so the customer's road-leg ETA started from a departure
    // that may not have happened and the kitchen board moved to `on_the_way`
    // for food still sitting on the pass. The code is now the vendor's — shown
    // on their packed order — and the rider enters what they are told, which
    // makes possessing it evidence of having stood at the shop.
    //
    // An order with no code recorded stays ungated: refusing would strand a
    // rider holding real food, and a pre-0006 row genuinely has nothing to
    // check against.
    const { data: order } = await supabase
      .from("orders")
      .select("pickup_otp")
      .eq("id", orderId)
      .maybeSingle();

    const expected = (order?.pickup_otp ?? "").replace(/\D/g, "");
    if (expected && (otp ?? "").replace(/\D/g, "") !== expected) {
      return { ok: false, error: "bad_pickup_otp" };
    }

    // Conditional on the order still being `ready` — the only status a delivery
    // reaches `assigned` from. Without this, an order the vendor cancelled out
    // from under this rider (see cancelDeliveryForOrder) would get silently
    // resurrected to `on_the_way` here, purely because the rider's own delivery
    // row still says `assigned`.
    const { data: movedOrder, error: orderErr } = await supabase
      .from("orders")
      .update({ status: "on_the_way" })
      .eq("id", orderId)
      .eq("status", "ready")
      .select("id")
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!movedOrder) {
      return { ok: false, error: "order_not_active" };
    }

    const { error: deliveryErr } = await supabase
      .from("deliveries")
      .update({
        status: "picked_up",
        picked_up_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    if (deliveryErr) throw deliveryErr;

    await notifyOnTheWay(orderId);
    return { ok: true };
  }

  if (delivery.status === "picked_up") {
    // Verify the customer's delivery code before completing.
    const order = await readDeliveryOtpOrder(supabase, orderId);
    const expected = (order?.delivery_otp ?? "").replace(/\D/g, "");
    if (!expected || (otp ?? "").replace(/\D/g, "") !== expected) {
      return { ok: false, error: "bad_otp" };
    }

    // Same guard as above, for the same reason: the order must still actually
    // be `on_the_way` for this rider's `delivered` write to be trusted.
    const { data: movedOrder, error: orderErr } = await supabase
      .from("orders")
      .update({ status: "delivered" })
      .eq("id", orderId)
      .eq("status", "on_the_way")
      .select("id")
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!movedOrder) {
      return { ok: false, error: "order_not_active" };
    }

    const { error: deliveryErr } = await supabase
      .from("deliveries")
      .update({ status: "delivered", delivered_at: new Date().toISOString() })
      .eq("id", delivery.id);
    if (deliveryErr) throw deliveryErr;

    await notifyDelivered(orderId);

    // Deliberately NOT touching payment_status. A COD order that reaches this
    // line is cash sitting in a rider's pocket, and we hold the service-role key
    // so we *could* write 'paid' — but there is no cash reconciliation behind
    // that word yet: no rider float, no settlement run, nothing that records the
    // money actually reaching Deligro. Writing it would assert a control that
    // does not exist. An online order still at 'pending' here is likewise left
    // alone; it is a real anomaly (delivered but never settled) and it stays
    // visible to operators precisely because nothing papers over it.
    await recordCodCollection(supabase, delivery.id, order);

    return { ok: true };
  }

  return { ok: false, error: "bad_state" };
}

/**
 * Digital record of cash collected at the door, for a cash-on-delivery order.
 *
 * The physical cash stays with the rider until the next handover (see
 * cod-handovers.ts) — this write does not move money, it records that a
 * collection happened, for how much, so the collection itself is never an
 * untracked event. An online-paid order has nothing to collect and is left
 * alone. Best-effort: a rider's delivery must complete whether or not this
 * write succeeds, so failures here are swallowed rather than surfaced as a
 * failed delivery.
 */
async function recordCodCollection(
  supabase: AdminClient,
  deliveryId: string,
  order: { total: number | null; payment_method: PaymentMethod | null } | null
): Promise<void> {
  if (columnKnownMissing(COD_COLLECTED_COLUMN)) return;

  // No payment columns at all (pre-0025) means every order was COD by
  // construction, same reasoning as paymentInstruction() above. Otherwise,
  // only an explicit 'cod' order has cash to collect.
  const isCod = !order || order.payment_method == null || order.payment_method === "cod";
  if (!isCod) return;

  try {
    const { error } = await supabase
      .from("deliveries")
      .update({
        cod_collected_amount: order?.total ?? 0,
        cod_collected_at: new Date().toISOString(),
      })
      .eq("id", deliveryId);

    if (error) {
      if (isMissingColumn(error)) rememberColumn(COD_COLLECTED_COLUMN, false);
      return;
    }
    rememberColumn(COD_COLLECTED_COLUMN, true);
  } catch {
    // Never let a reporting write turn a completed delivery into a failed one.
  }
}

// ---------------------------------------------------------------------------
// Delivery history
// ---------------------------------------------------------------------------

/** One finished delivery, as the rider's History tab lists it. */
export interface DriverHistoryItem {
  /** `deliveries.order_id` — what the rider knows the job by. */
  orderId: string;
  /** ISO. Never null: the query only asks for rows that have one. */
  deliveredAt: string;
  restaurantName: string;
  /** The drop's short label — "Home", an area — or null when none was kept. */
  dropArea: string | null;
  /** Grand total of the order, in rupees. */
  total: number;
  itemCount: number;
}

export interface DriverHistoryPage {
  items: DriverHistoryItem[];
  /**
   * Pass back as `cursor` for the next page, or null at the end.
   *
   * Keyset, not an offset. A rider's history grows underneath them while they
   * scroll — every delivery they finish prepends a row — and offset paging
   * responds to that by repeating rows across page boundaries. The cursor is
   * the last `delivered_at` seen, so a new row at the top cannot shift it.
   */
  nextCursor: string | null;
}

const HISTORY_PAGE_SIZE = 20;

/**
 * What this rider has actually delivered, newest first.
 *
 * `driverId` comes from `requireRole("driver")` at the call site and is NEVER
 * read from a URL param. This runs through `createAdminClient()` like the rest
 * of this module — `deliveries` has no policy letting a rider read the table
 * broadly — so the `.eq("driver_id", ...)` below is the whole authorization,
 * and a driver id taken from a query string would be an IDOR onto every
 * rider's delivery history (AGENTS.md rule 5).
 *
 * Delivered only. Cancelled jobs are a separate screen with separate questions
 * ("who cancelled, and was I paid for it") and are already their own planned
 * task — folding them in here as grey rows would answer neither.
 */
export async function getDriverHistory(
  driverId: string,
  { cursor, limit = HISTORY_PAGE_SIZE }: { cursor?: string | null; limit?: number } = {}
): Promise<DriverHistoryPage> {
  const supabase = createAdminClient();

  // One extra row, discarded before returning: it answers "is there another
  // page" without a second COUNT over a table that only grows.
  const take = Math.min(Math.max(limit, 1), 50) + 1;

  let query = supabase
    .from("deliveries")
    .select("order_id, delivered_at, orders(total, address, restaurants(name), order_items(qty))")
    .eq("driver_id", driverId)
    .eq("status", "delivered")
    .not("delivered_at", "is", null)
    .order("delivered_at", { ascending: false })
    .limit(take);

  // Strictly less-than, so the row the cursor points at is not served twice.
  if (cursor) query = query.lt("delivered_at", cursor);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    order_id: string;
    delivered_at: string;
    orders: {
      total: number | string | null;
      address: unknown;
      restaurants: { name?: string | null } | { name?: string | null }[] | null;
      order_items: { qty: number | null }[] | null;
    } | null;
  }[];

  const hasMore = rows.length === take;
  const page = hasMore ? rows.slice(0, -1) : rows;

  const items: DriverHistoryItem[] = page.map((row) => {
    const order = row.orders;
    const shop = one(order?.restaurants ?? null);
    const address = (order?.address ?? {}) as { label?: unknown; area?: unknown };
    const label =
      typeof address.label === "string" && address.label.trim()
        ? address.label.trim()
        : typeof address.area === "string" && address.area.trim()
          ? address.area.trim()
          : null;

    return {
      orderId: row.order_id,
      deliveredAt: row.delivered_at,
      // A shop deleted since the delivery leaves the join empty. The delivery
      // still happened and the rider still did it, so the row stays and says
      // what it can rather than being filtered out of their own history.
      restaurantName: shop?.name?.trim() || "Former shop",
      dropArea: label,
      total: Number(order?.total ?? 0),
      itemCount: (order?.order_items ?? []).reduce(
        (n, i) => n + Number(i?.qty ?? 0),
        0
      ),
    };
  });

  return {
    items,
    nextCursor: hasMore ? (page[page.length - 1]?.delivered_at ?? null) : null,
  };
}
