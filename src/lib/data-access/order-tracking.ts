import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_CENTER } from "@/lib/maps/config";
import {
  computeRiderPosition,
  restaurantPointForOrder,
  type TrackPoint,
} from "@/lib/tracking/rider-position";
import { computeOrderEta, type OrderEta } from "@/lib/orders/eta";
import { roadLegBetween } from "@/lib/orders/road-leg";
import { kitchenPace } from "@/lib/orders/kitchen-pace";
import { getSettings } from "@/lib/settings";
import { dbStatusToUi, shortOrderId } from "@/lib/utils/order-map";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import type { OrderStatus, Rider } from "@/types";

/**
 * Where the courier pin on the customer's map actually came from.
 *
 * `gps` is the only value that means "this is where the rider is". Anything else
 * means the dot was drawn from the route and the clock — which, for the entire
 * life of this feature, was every dot: `driver_lat/lng` were written once at
 * accept with a hardcoded offset from the centre of Bemetara and never touched
 * again, and the customer was shown the result as a live position.
 */
export type RiderPositionSource = "gps" | "estimated" | "none";

export interface OrderTrackingSnapshot {
  status: OrderStatus;
  /**
   * The live estimate, and whether it has slipped. Replaces the flat
   * `etaMinutes: restaurant.eta_min ?? 25` that never moved between checkout
   * and the doorstep.
   */
  eta: OrderEta;
  rider: Rider | null;
  restaurant: TrackPoint;
  destination: TrackPoint;
  riderPosition: TrackPoint | null;
  riderPositionSource: RiderPositionSource;
  deliveryStatus: string | null;
  /** Fields for client-side smooth rider animation between polls. */
  interp: {
    orderStatus: string;
    deliveryStatus: string | null;
    assignedAt: string | null;
    pickedUpAt: string | null;
    storedRider: (TrackPoint & { at: string | null }) | null;
    /** The road leg only — the trip time the interpolation should span. */
    rideMinutes: number;
  };
}

interface AddressJson {
  label?: string;
  line?: string;
  lat?: number;
  lng?: number;
}

/**
 * Matches the freshness window inside `computeRiderPosition`, which stops
 * trusting a stored fix at the same age. If the two drift apart, this label
 * starts describing a dot the map is no longer drawing.
 */
const GPS_FIX_MAX_AGE_MS = 45_000;

/** 0026's lifecycle timestamps arrive together, so one probe covers them. */
const LIFECYCLE_COLUMNS = "orders.accepted_at";
/** Also 0026, but a different table and a different query. */
const LOCATION_SOURCE_COLUMN = "deliveries.driver_location_source";

interface RestaurantRef {
  eta_min?: number | null;
  eta_max?: number | null;
  lat?: number | null;
  lng?: number | null;
  /** 0036 — this kitchen's own prep leg. Absent before the migration. */
  prep_minutes?: number | null;
  /** 0036 — the "we're slammed" bump. Same grant as prep_minutes. */
  busy_until?: string | null;
  busy_extra_minutes?: number | null;
}

interface TrackedOrderRow {
  id: string;
  status: string;
  created_at: string;
  /** 0026. Absent, not merely null, on a database that predates the migration. */
  accepted_at?: string | null;
  ready_at?: string | null;
  address: unknown;
  restaurant_id: string;
  restaurants: RestaurantRef | RestaurantRef[] | null;
}

interface DeliveryRow {
  status: string | null;
  assigned_at: string | null;
  picked_up_at: string | null;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_location_at: string | null;
  /** 0026. */
  driver_location_source?: string | null;
  driver_id: string | null;
}

interface QueryResult<T> {
  data: T | null;
  error: { code?: string } | null;
}

/** `restaurants.prep_minutes` arrives with 0036, independently of 0026. */
const PREP_MINUTES_COLUMN = "restaurants.prep_minutes";

function orderColumns(withLifecycle: boolean, withPrep: boolean): string {
  return [
    "id, status, created_at, address, restaurant_id",
    withLifecycle ? ", accepted_at, ready_at" : "",
    // busy_until/busy_extra_minutes are the same 0036 migration and the same
    // grant statement as prep_minutes, so they ride the same probe flag.
    `, restaurants ( eta_min, eta_max, lat, lng${withPrep ? ", prep_minutes, busy_until, busy_extra_minutes" : ""} )`,
  ].join("");
}

function deliveryColumns(withSource: boolean): string {
  return [
    "status, assigned_at, picked_up_at",
    ", driver_lat, driver_lng, driver_location_at",
    withSource ? ", driver_location_source" : "",
    ", driver_id",
  ].join("");
}

/**
 * Run a query that wants a column migration 0026 may not have added yet.
 *
 * Asking PostgREST for a column that doesn't exist is a hard 400, not a null, so
 * without this the tracking screen goes dark in any environment running one
 * migration behind. Same shape as `selectOrders` in `orders.ts`: try optimistic,
 * remember the answer, and degrade to a narrower select rather than to nothing.
 * See `schema-probe.ts` — every entry here is a promise to delete once the
 * migration is everywhere.
 */
async function selectProbed<T>(
  key: string,
  columns: (withColumn: boolean) => string,
  run: (columns: string) => PromiseLike<QueryResult<T>>
): Promise<{ data: T | null; present: boolean }> {
  let present = !columnKnownMissing(key);

  let { data, error } = await run(columns(present));

  if (error && present && isMissingColumn(error)) {
    rememberColumn(key, false);
    present = false;
    ({ data, error } = await run(columns(false)));
  }

  if (error) throw error;
  if (present) rememberColumn(key, true);

  return { data: data ?? null, present };
}

/**
 * The order row, tolerating a database missing 0026, 0036, or both.
 *
 * Two independent optional groups, so one `selectProbed` key cannot cover it:
 * an environment can have the lifecycle timestamps and not the per-kitchen prep
 * leg, or the reverse. The newer group is dropped first — losing a prep override
 * costs one input to an estimate, whereas losing `accepted_at` costs the whole
 * "in kitchen" stage.
 */
async function selectOrderRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orderId: string
): Promise<Record<string, unknown> | null> {
  const run = (columns: string) =>
    supabase
      .from("orders")
      .select(columns)
      .eq("id", orderId)
      .maybeSingle()
      .overrideTypes<Record<string, unknown>>();

  if (!columnKnownMissing(PREP_MINUTES_COLUMN)) {
    const withLifecycle = !columnKnownMissing(LIFECYCLE_COLUMNS);
    const { data, error } = await run(orderColumns(withLifecycle, true));
    if (!error) {
      rememberColumn(PREP_MINUTES_COLUMN, true);
      if (withLifecycle) rememberColumn(LIFECYCLE_COLUMNS, true);
      return data ?? null;
    }
    if (!isMissingColumn(error)) throw error;
    rememberColumn(PREP_MINUTES_COLUMN, false);
  }

  const { data } = await selectProbed<Record<string, unknown>>(
    LIFECYCLE_COLUMNS,
    (withLifecycle) => orderColumns(withLifecycle, false),
    run
  );
  return data;
}

function parseDestination(address: unknown): TrackPoint {
  return destinationPin(address) ?? DEFAULT_CENTER;
}

/**
 * The address's own coordinates, or null when it has none.
 *
 * The difference from `parseDestination` is the whole point: that one falls back
 * to the centre of Bemetara so the map always has somewhere to draw, and the
 * distance model must never see that fallback. Measuring from a shop to a
 * city-centre stand-in produces a real number describing a delivery nobody is
 * making — which is exactly the class of invention this module has been pulling
 * out of the tracking screen.
 */
function destinationPin(address: unknown): TrackPoint | null {
  const a = (address ?? {}) as AddressJson;
  if (typeof a.lat === "number" && typeof a.lng === "number") {
    return { lat: a.lat, lng: a.lng };
  }
  return null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Can we honestly call this dot the rider's position?
 *
 * Only when three things hold: 0026 is applied so the question is answerable at
 * all, the delivery row says a device reported it (`gps`), and that fix is still
 * young enough that `computeRiderPosition` is using it rather than quietly
 * interpolating past it. Every other combination — a database without the
 * column, a `null` source, which is what every pre-existing row has, a stale
 * fix — is `estimated`. The default has to fall that way round: claiming a live
 * position we do not have is the exact failure this column was added to end.
 */
function riderPositionSourceFor({
  riderPosition,
  hasSourceColumn,
  reportedSource,
  fixAt,
  now,
}: {
  riderPosition: TrackPoint | null;
  hasSourceColumn: boolean;
  reportedSource: string | null | undefined;
  fixAt: string | null;
  now: number;
}): RiderPositionSource {
  if (!riderPosition) return "none";
  if (!hasSourceColumn || reportedSource !== "gps") return "estimated";

  const at = fixAt ? Date.parse(fixAt) : NaN;
  if (!Number.isFinite(at)) return "estimated";

  return now - at < GPS_FIX_MAX_AGE_MS ? "gps" : "estimated";
}

/** Live tracking payload for the customer order screen (RLS-scoped). */
export async function getOrderTrackingSnapshot(
  orderId: string
): Promise<OrderTrackingSnapshot | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Anon key, so RLS decides: a row comes back only for the customer who placed
  // this order, the restaurant cooking it, the driver carrying it, or an admin.
  // Getting past the null check below IS the authorization for everything after.
  const orderRow = await selectOrderRow(supabase, orderId);

  if (!orderRow) return null;
  const order = orderRow as unknown as TrackedOrderRow;

  const restaurant = one(order.restaurants);
  const destination = parseDestination(order.address);

  // The shop's actual position, now that vendors pin it (migration 0009). This
  // query used not to select lat/lng at all, so the restaurant marker was always
  // Bemetara's centre plus a made-up offset — and if that landed near the
  // customer, it was re-placed 0.8 km away at an angle hashed from the
  // restaurant's UUID. The pin the customer watched their food leave from was
  // fiction. The synthetic point remains only as a fallback for a shop that
  // hasn't pinned itself yet.
  const pinned =
    typeof restaurant?.lat === "number" && typeof restaurant?.lng === "number"
      ? { lat: restaurant.lat, lng: restaurant.lng }
      : null;

  const restaurantPoint =
    pinned ??
    restaurantPointForOrder(order.restaurant_id, destination, {
      lat: DEFAULT_CENTER.lat + 0.012,
      lng: DEFAULT_CENTER.lng - 0.008,
    });

  // Service role, and therefore past RLS. Permitted only because the read above
  // already established that this caller may see this order: `deliveries` has no
  // policy that would let a customer read their courier's row directly.
  const admin = createAdminClient();

  let delivery: DeliveryRow | null = null;
  let hasSourceColumn = !columnKnownMissing(LOCATION_SOURCE_COLUMN);
  try {
    const probed = await selectProbed<Record<string, unknown>>(
      LOCATION_SOURCE_COLUMN,
      deliveryColumns,
      (columns) =>
        admin
          .from("deliveries")
          .select(columns)
          .eq("order_id", orderId)
          .maybeSingle()
          .overrideTypes<Record<string, unknown>>()
    );
    delivery = (probed.data as unknown as DeliveryRow | null) ?? null;
    hasSourceColumn = probed.present;
  } catch {
    // No courier assigned yet is the common case and returns null, not an error.
    // A genuine failure degrades the map to restaurant-and-destination rather
    // than taking the screen down — and leaves `hasSourceColumn` where it was,
    // so nothing gets promoted to "live" on the strength of a failed read.
    delivery = null;
  }

  let rider: Rider | null = null;
  if (delivery?.driver_id) {
    const { data: driver } = await admin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", delivery.driver_id)
      .maybeSingle();
    if (driver) {
      // Name and phone are real. Rating and vehicle are simply not known — we
      // don't rate riders and we don't record what they drive — so they are left
      // out rather than filled in with a flattering "4.9 ★ · Bike".
      rider = {
        name: driver.full_name?.trim() || "Your courier",
        // The same short form order codes use. It is what the ID card shows and
        // what a customer would read out to support — a UUID is not something
        // anybody says down a phone.
        id: shortOrderId(delivery.driver_id),
        phone: driver.phone?.trim() || "",
      };
    }
  }

  const status = dbStatusToUi(order.status);
  const settings = await getSettings();

  // Bumped by any live "we're slammed" band, the same way the storefront card
  // this customer ordered from was — otherwise an order running exactly on the
  // schedule it was actually promised reads as late here.
  const pace = kitchenPace({
    etaMin: restaurant?.eta_min ?? null,
    etaMax: restaurant?.eta_max ?? null,
    busyUntil: restaurant?.busy_until ?? null,
    busyExtraMinutes: restaurant?.busy_extra_minutes ?? null,
  });

  // `pinned`, not `restaurantPoint`: the latter falls back to a marker hashed
  // from the restaurant's UUID so the map has something to draw, and a distance
  // measured to a fabricated pin is a fabrication carrying a number.
  const roadLeg = roadLegBetween(pinned, destinationPin(order.address));

  const eta = computeOrderEta({
    status,
    createdAt: order.created_at,
    acceptedAt: order.accepted_at ?? null,
    readyAt: order.ready_at ?? null,
    pickedUpAt: delivery?.picked_up_at ?? null,
    restaurantPrepMinutes: restaurant?.prep_minutes ?? null,
    etaMin: pace.etaMin,
    etaMax: pace.etaMax,
    defaultPrepMinutes: settings.defaultPrepMinutes,
    straightLineKm: roadLeg?.straightLineKm ?? null,
  });

  const storedRider =
    delivery?.driver_lat != null && delivery?.driver_lng != null
      ? {
          lat: delivery.driver_lat,
          lng: delivery.driver_lng,
          at: delivery.driver_location_at,
        }
      : null;

  const riderPosition = computeRiderPosition({
    orderStatus: order.status,
    deliveryStatus: delivery?.status ?? null,
    assignedAt: delivery?.assigned_at ?? null,
    pickedUpAt: delivery?.picked_up_at ?? null,
    restaurant: restaurantPoint,
    destination,
    storedRider,
    // The road leg, not the door-to-door promise. Handing the interpolation the
    // whole band is why the pin used to crawl: it spread a ten-minute ride over
    // twenty-five minutes of animation.
    etaMinutes: eta.rideMinutes,
  });

  return {
    status,
    eta,
    rider,
    restaurant: restaurantPoint,
    destination,
    riderPosition,
    riderPositionSource: riderPositionSourceFor({
      riderPosition,
      hasSourceColumn,
      reportedSource: delivery?.driver_location_source,
      fixAt: delivery?.driver_location_at ?? null,
      now: Date.now(),
    }),
    deliveryStatus: delivery?.status ?? null,
    interp: {
      orderStatus: order.status,
      deliveryStatus: delivery?.status ?? null,
      assignedAt: delivery?.assigned_at ?? null,
      pickedUpAt: delivery?.picked_up_at ?? null,
      storedRider,
      rideMinutes: eta.rideMinutes,
    },
  };
}

/**
 * The estimate alone, for the tracking page's first server render.
 *
 * Much cheaper than a whole snapshot, and it answers the only question the
 * initial paint asks: what number goes in the big text. It has no delivery row,
 * so an `on_the_way` order is anchored on `ready_at` rather than
 * `picked_up_at`; the first poll lands within a frame and corrects it.
 *
 * Returns null for an order the caller may not see — RLS decides, exactly as
 * above — which is indistinguishable from an order that does not exist.
 */
export async function getOrderEta(orderId: string): Promise<OrderEta | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const orderRow = await selectOrderRow(supabase, orderId);

  if (!orderRow) return null;
  const order = orderRow as unknown as TrackedOrderRow;

  const restaurant = one(order.restaurants);
  const settings = await getSettings();

  const pace = kitchenPace({
    etaMin: restaurant?.eta_min ?? null,
    etaMax: restaurant?.eta_max ?? null,
    busyUntil: restaurant?.busy_until ?? null,
    busyExtraMinutes: restaurant?.busy_extra_minutes ?? null,
  });

  // Same distance input as the full snapshot above. If only one of the two
  // knew about distance, the server-rendered first paint and the poll that
  // lands a frame later would show different numbers for the same order.
  const pinnedShop =
    typeof restaurant?.lat === "number" && typeof restaurant?.lng === "number"
      ? { lat: restaurant.lat, lng: restaurant.lng }
      : null;

  return computeOrderEta({
    status: dbStatusToUi(order.status),
    createdAt: order.created_at,
    acceptedAt: order.accepted_at ?? null,
    readyAt: order.ready_at ?? null,
    restaurantPrepMinutes: restaurant?.prep_minutes ?? null,
    etaMin: pace.etaMin,
    etaMax: pace.etaMax,
    defaultPrepMinutes: settings.defaultPrepMinutes,
    straightLineKm:
      roadLegBetween(pinnedShop, destinationPin(order.address))
        ?.straightLineKm ?? null,
  });
}
