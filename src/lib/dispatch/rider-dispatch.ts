import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { haversineKm } from "@/lib/geo/distance";
import { getSettings } from "@/lib/settings";
import { kitchenPrepMinutes } from "@/lib/orders/eta";
import {
  notifyDriverOrderCancelled,
  notifyDriverPickupOffered,
  notifyDriverPickupReady,
  stopRiderRing,
} from "@/lib/notifications/order-events";
import { deferNotify } from "@/lib/notifications/defer";
import { staleOfferee } from "@/lib/alerts/ring";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { eligibleCandidates } from "@/lib/dispatch/eligibility";
import type { RiderAvailability } from "@/lib/rider/availability";
import { OFFER_WINDOW_DEFAULT_SECONDS, normalizeOfferWindow } from "@/lib/rider/offer-window";
import { captureError } from "@/lib/obs/emit";

/**
 * Who should go and get this order.
 *
 * The rule, in the order the operators asked for it:
 *
 *   1. A rider who is not in the middle of a delivery. Someone already carrying
 *      dinner is not the right person to send to a second kitchen, however
 *      close they happen to be. An outstanding offer counts as being in the
 *      middle of one — otherwise three vendors accepting inside a minute would
 *      each be handed the same idle rider, and two of those orders would sit
 *      held for somebody already riding to the first shop.
 *   2. Among those, whoever is nearest the shop.
 *   3. If every rider is committed, fall back to the least-loaded, and among
 *      equals, whoever is nearest the shop — they will be free soonest and with
 *      the shortest ride to the pickup.
 *
 * ## Only riders who are working
 *
 * Before any of the rules above, the roster is cut down to riders who are
 * dispatchable (`eligibility.ts`): online, not on a break, and a position
 * newer than five minutes — read from `rider_status` (migration 0081). A rider
 * who has never gone online has no row and is not offered anything. The one
 * deliberate exception is a database where `rider_status` does not exist yet:
 * there is nobody to ask, so every driver profile is a candidate, exactly as
 * before the migration, and dispatch does not go dark between deploying this
 * code and applying 0081. That is the single place dispatch is not online-only,
 * and it ends the moment the table exists.
 *
 * Proximity is measured from the last position the rider's device actually
 * reported — `rider_status.last_*` while they are online, or
 * `deliveries.driver_lat/lng` (written by `reportDriverLocation`), whichever is
 * newer. A
 * fix older than MAX_FIX_AGE_MS is treated as no fix at all rather than as a
 * confident location — a rider who denied the location permission this morning
 * must not be dispatched across town on the strength of where they were at 9am.
 * Riders with no usable fix sort last, so a known-near rider always wins, and
 * they still get picked when nobody has a position (which is the state of a
 * fleet where nobody has granted location yet).
 *
 * ## The offer is a first refusal, not an assignment
 *
 * Dispatch writes `deliveries.offered_driver_id` (migration 0042) and leaves
 * `driver_id` null. For the offer window after the offer
 * (`platform_settings.rider_offer_window_seconds`, 0082; EXCLUSIVE_OFFER_MS on
 * a database without that column) the order is hidden from every other rider's
 * board and `acceptDelivery` refuses anyone else; after that it opens to the
 * whole pool. Nobody is ever *stuck* with an order they
 * didn't accept, and no order is ever stranded because the one rider we picked
 * had their phone in their pocket.
 *
 * Every function here is best-effort and swallows its own failures: dispatch
 * runs off the back of a vendor accepting an order, and a dispatch outage must
 * never roll back a transition the kitchen has already made. The worst case is
 * the behaviour this platform had before the module existed — the order lands
 * in the open pool at `ready` and the fastest thumb wins.
 */

/**
 * How long the chosen rider gets the order to themselves when no setting says
 * otherwise.
 *
 * Three minutes: long enough that a rider mid-ride can look at their phone at
 * the next light, short enough that an ignored offer costs an order far less
 * than the eight minutes at which the admin board starts calling it a dispatch
 * failure (UNASSIGNED_AFTER_MIN in admin-dispatch.ts).
 *
 * Since 0082 the live value is `platform_settings.rider_offer_window_seconds`
 * (`getOfferWindowSeconds`); this constant is the fallback for a database
 * without the column and must stay equal to the column's default (and to the
 * push ring's timeout, RING_TIMEOUT_SEC.rider).
 */
export const EXCLUSIVE_OFFER_MS = 180_000;

/**
 * The offer window in force, in seconds: the admin setting, clamped to 60-600,
 * or the default when settings cannot say. Every place that asks "is this offer
 * still exclusive?" (dispatch, accept, the board, the commitment check, the
 * sweep) takes its window from here, so they cannot disagree.
 */
export async function getOfferWindowSeconds(): Promise<number> {
  try {
    return normalizeOfferWindow((await getSettings()).riderOfferWindowSeconds);
  } catch {
    return OFFER_WINDOW_DEFAULT_SECONDS;
  }
}

/** Older than this and a reported position is history, not a location. */
const MAX_FIX_AGE_MS = 30 * 60_000;

/** 0042 arrives as one group, so one probe key covers all three columns. */
export const DISPATCH_COLUMNS = "deliveries.offered_driver_id";

/** 0081's presence table. Remembered for the degraded-schema warning, never used to skip the query. */
export const RIDER_STATUS_TABLE = "rider_status";

export interface RiderChoice {
  id: string;
  name: string;
  /** Straight-line km from the shop, when we know where they are. */
  distanceKm: number | null;
  /** Deliveries actually in flight — accepted, not yet delivered. */
  activeJobs: number;
  /**
   * Pickups this rider has been asked to take and has not accepted yet.
   *
   * Counted as load, which is the whole reason it is here. Without it, three
   * vendors accepting orders inside a minute would each be offered the *same*
   * nearest idle rider — every one of those offers reading "you are free" —
   * and two of the three would sit held for somebody who was already riding to
   * the first shop.
   */
  pendingOffers: number;
}

interface Candidate extends RiderChoice {
  /** activeJobs + pendingOffers: everything this rider is already committed to. */
  commitments: number;
  sortKey: number;
}

type Point = { lat: number; lng: number };

/** A position and the instant the device reported it. */
type Fix = { point: Point; at: number };

function pointOf(
  lat: number | null | undefined,
  lng: number | null | undefined
): Point | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * `rider_status` exists but could not be read (a revoked grant, an outage).
 * Distinct from "missing": that is the legacy path, this is dispatch standing
 * down, and `dispatchOrder` reports it instead of letting it look like an
 * evening with nobody online.
 */
export class PresenceUnreadableError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("rider_status could not be read; dispatch stood down");
    this.name = "PresenceUnreadableError";
    this.cause = cause;
  }
}

interface FixRow {
  driver_id: string | null;
  status: string;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_location_at: string | null;
}

interface StatusPresenceRow {
  driver_id: string;
  is_online: boolean;
  break_until: string | null;
  online_since: string | null;
  last_fix_at: string | null;
  last_lat: number | null;
  last_lng: number | null;
}

/**
 * `rider_status` for these riders: their availability, and where the device
 * last said it was. Null when the table does not exist (a database without
 * 0081) — and for nothing else: any other failure throws, so a database that is
 * refusing the read makes dispatch stand down (the order stays in the open
 * pool) rather than offer to riders it could not check.
 *
 * Always queried, never skipped on a remembered "missing": a latch would keep
 * an instance in the legacy everyone-is-a-candidate mode for the rest of its
 * life after 0081 is applied, and that is a fail-open nobody would notice. The
 * cost is one indexed read per dispatch.
 */
async function loadPresence(
  supabase: ReturnType<typeof createAdminClient>,
  riderIds: string[]
): Promise<{
  availability: Map<string, RiderAvailability>;
  fixes: Map<string, Fix>;
} | null> {
  const { data, error } = await supabase
    .from("rider_status")
    .select("driver_id, is_online, break_until, online_since, last_fix_at, last_lat, last_lng")
    .in("driver_id", riderIds)
    .overrideTypes<StatusPresenceRow[]>();
  if (error) {
    if (isMissingTable(error)) {
      rememberColumn(RIDER_STATUS_TABLE, false);
      return null;
    }
    throw new PresenceUnreadableError(error);
  }
  rememberColumn(RIDER_STATUS_TABLE, true);

  const availability = new Map<string, RiderAvailability>();
  const fixes = new Map<string, Fix>();
  for (const row of data ?? []) {
    availability.set(row.driver_id, {
      isOnline: row.is_online,
      breakUntil: row.break_until,
      onlineSince: row.online_since,
      lastFixAt: row.last_fix_at,
    });
    const at = row.last_fix_at ? Date.parse(row.last_fix_at) : Number.NaN;
    const point = pointOf(row.last_lat, row.last_lng);
    if (point && Number.isFinite(at)) fixes.set(row.driver_id, { point, at });
  }
  return { availability, fixes };
}

/**
 * Every rider dispatch may offer to, with how loaded they are and where they
 * last were.
 *
 * Who counts is `loadPresence` + `eligibleCandidates`: online, not on a break,
 * a position under five minutes old. For that set, a few queries rather than a
 * few per rider: what each is carrying, and where each last was. The position
 * query reads every delivery row a rider has a recent fix on, newest first, and
 * keeps the first hit per rider — that is "last known position" for a free
 * rider (their previous job) and "current position" for a busy one, updated
 * every ten seconds by their device. `rider_status.last_*` competes with it and
 * the newer of the two wins: a free rider's presence fix is minutes fresher
 * than the delivery they finished earlier.
 *
 * `exceptOrderId` is the order being dispatched. Its own standing offer must
 * not count against the rider it is currently offered to, or re-dispatching at
 * `ready` would read that rider as busy *because of this very order* and hand
 * it to somebody else.
 */
async function loadCandidates(
  supabase: ReturnType<typeof createAdminClient>,
  from: Point | null,
  now: number,
  exceptOrderId?: string
): Promise<Candidate[]> {
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("role", "driver");
  if (error) throw error;

  const roster = (profiles ?? []) as { id: string; full_name: string | null }[];
  if (roster.length === 0) return [];

  const presence = await loadPresence(
    supabase,
    roster.map((r) => r.id)
  );
  // No rider_status table: today's behaviour, every driver profile (see the
  // module header). With it: only riders dispatchable right now.
  const riders = presence
    ? eligibleCandidates(roster, presence.availability, new Date(now))
    : roster;
  if (riders.length === 0) return [];

  const ids = riders.map((r) => r.id);

  const [{ data: liveRows }, { data: fixRows }, offerRows] = await Promise.all([
    supabase
      .from("deliveries")
      .select("driver_id, status, driver_lat, driver_lng, driver_location_at")
      .in("driver_id", ids)
      .in("status", ["assigned", "picked_up"])
      .overrideTypes<FixRow[]>(),
    supabase
      .from("deliveries")
      .select("driver_id, status, driver_lat, driver_lng, driver_location_at")
      .in("driver_id", ids)
      // Bounded by the staleness rule rather than by row count. Without the
      // time filter the `limit` would be the thing deciding which riders have a
      // position — and on a busy day that is "whoever happens to be in the most
      // recent 500 delivery rows", which is not a dispatch rule anybody chose.
      .gte("driver_location_at", new Date(now - MAX_FIX_AGE_MS).toISOString())
      .order("driver_location_at", { ascending: false })
      .limit(500)
      .overrideTypes<FixRow[]>(),
    pendingOffersByRider(supabase, ids, exceptOrderId),
  ]);

  const load = new Map<string, number>();
  for (const row of liveRows ?? []) {
    if (row.driver_id) load.set(row.driver_id, (load.get(row.driver_id) ?? 0) + 1);
  }

  // Newest first, so the first row seen for a rider is their latest fix.
  const lastFix = new Map<string, Fix>();
  for (const row of fixRows ?? []) {
    if (!row.driver_id || lastFix.has(row.driver_id)) continue;
    const at = row.driver_location_at ? Date.parse(row.driver_location_at) : Number.NaN;
    if (!Number.isFinite(at) || now - at > MAX_FIX_AGE_MS) continue;
    const point = pointOf(row.driver_lat, row.driver_lng);
    if (point) lastFix.set(row.driver_id, { point, at });
  }
  // The presence fix replaces the delivery row's only when it is newer.
  for (const [id, fix] of presence?.fixes ?? []) {
    const delivery = lastFix.get(id);
    if (!delivery || fix.at > delivery.at) lastFix.set(id, fix);
  }

  return riders.map((r) => {
    const point = lastFix.get(r.id)?.point ?? null;
    const distanceKm = from && point ? haversineKm(from, point) : null;
    const activeJobs = load.get(r.id) ?? 0;
    const pendingOffers = offerRows.get(r.id) ?? 0;
    return {
      id: r.id,
      name: r.full_name?.trim() || "Rider",
      activeJobs,
      pendingOffers,
      commitments: activeJobs + pendingOffers,
      distanceKm,
      // Unknown position sorts last without ever excluding the rider: a fleet
      // where nobody has granted location still dispatches, just not by distance.
      sortKey: distanceKm ?? Number.POSITIVE_INFINITY,
    };
  });
}

/**
 * rider id → how many pickups they have been offered and not yet accepted.
 *
 * Empty on a database without 0042 — where there are no offers, so nobody is
 * committed to one, which is the correct answer rather than a degraded one.
 */
async function pendingOffersByRider(
  supabase: ReturnType<typeof createAdminClient>,
  riderIds: string[],
  exceptOrderId?: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (columnKnownMissing(DISPATCH_COLUMNS)) return out;

  let query = supabase
    .from("deliveries")
    .select("offered_driver_id")
    .eq("status", "unassigned")
    .in("offered_driver_id", riderIds);
  if (exceptOrderId) query = query.neq("order_id", exceptOrderId);

  const { data, error } = await query.overrideTypes<
    { offered_driver_id: string | null }[]
  >();
  if (error) {
    if (isMissingColumn(error)) rememberColumn(DISPATCH_COLUMNS, false);
    return out;
  }
  rememberColumn(DISPATCH_COLUMNS, true);

  for (const row of data ?? []) {
    if (row.offered_driver_id) {
      out.set(row.offered_driver_id, (out.get(row.offered_driver_id) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Pick the rider to offer a pickup at `from` to, or null when there are no
 * riders on the platform at all.
 *
 * Exported so an operator screen (or a test) can ask "who would this go to?"
 * without also sending a notification.
 */
export async function chooseRider(
  from: Point | null,
  opts: { now?: number; exceptOrderId?: string; excludeRiderIds?: string[] } = {}
): Promise<RiderChoice | null> {
  const supabase = createAdminClient();
  const now = opts.now ?? Date.now();

  // Riders who already let an offer for this order lapse (see sweep.ts). Asking
  // the same person again is how an ignored offer used to become a stranded one.
  const excluded = new Set(opts.excludeRiderIds ?? []);
  const candidates = (
    await loadCandidates(supabase, from, now, opts.exceptOrderId)
  ).filter((c) => !excluded.has(c.id));
  if (candidates.length === 0) return null;

  // Rule 1: anyone not already committed — neither mid-delivery nor holding an
  // offer they haven't answered. Only if the whole fleet is committed do we
  // consider the rest, and then the least-loaded first, so a rider on their
  // second job is not handed a third while somebody else carries one.
  const free = candidates.filter((c) => c.commitments === 0);
  const pool = free.length > 0 ? free : candidates;

  // Within the pool: nearest the shop wins. That is rule 2 for a free fleet and
  // rule 3 for a busy one — the tie-break on `commitments` above means the
  // distance comparison only ever runs between equally-loaded riders.
  const best = [...pool].sort(
    (a, b) =>
      a.commitments - b.commitments ||
      a.sortKey - b.sortKey ||
      a.name.localeCompare(b.name)
  )[0];

  return best
    ? {
        id: best.id,
        name: best.name,
        distanceKm: best.distanceKm,
        activeJobs: best.activeJobs,
        pendingOffers: best.pendingOffers,
      }
    : null;
}

interface DispatchOrderRow {
  id: string;
  status: string;
  restaurants:
    | DispatchShop
    | DispatchShop[]
    | null;
}

interface DispatchShop {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  prep_minutes: number | null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * What happened when we tried to record the offer.
 *
 * "taken" and "unsupported" both mean no row was written, and they lead to
 * opposite decisions: an order somebody is already carrying must not have a
 * second rider sent to its shop, whereas a database that simply predates 0042
 * should still get the heads-up push — the message is most of the value and it
 * costs nothing to send without a row behind it.
 *
 * "superseded" is a third kind of no-write: the offer on the row changed between
 * our read and our update (a rider rejected and the order was already offered to
 * someone else, or the sweep got there first). The newer offer stands, and this
 * dispatch neither overwrites it nor pushes its rider.
 */
type OfferOutcome = "offered" | "taken" | "unsupported" | "superseded";

/** The outcome, and who held the offer before this write (their ring must stop). */
interface OfferWrite {
  outcome: OfferOutcome;
  previousOfferee: string | null;
}

/**
 * Record the offer on the delivery row.
 *
 * Never touches `driver_id` or `status`: an offer is not an assignment, and the
 * two screens that read this table to answer "who is carrying this order?" (the
 * customer's tracker, the admin live board) must keep saying "nobody" until
 * somebody actually accepts.
 */
async function writeOffer(
  supabase: ReturnType<typeof createAdminClient>,
  orderId: string,
  driverId: string,
  now: number
): Promise<OfferWrite> {
  const result = (outcome: OfferOutcome, previousOfferee: string | null = null): OfferWrite => ({
    outcome,
    previousOfferee,
  });
  if (columnKnownMissing(DISPATCH_COLUMNS)) return result("unsupported");

  const { data: existing, error: readError } = await supabase
    .from("deliveries")
    .select("id, status, offered_driver_id")
    .eq("order_id", orderId)
    .maybeSingle();
  if (readError) {
    if (isMissingColumn(readError)) {
      rememberColumn(DISPATCH_COLUMNS, false);
      return result("unsupported");
    }
    throw readError;
  }

  if (existing && existing.status !== "unassigned") return result("taken");
  const previous = (existing?.offered_driver_id as string | null | undefined) ?? null;

  const offer = {
    offered_driver_id: driverId,
    offered_at: new Date(now).toISOString(),
  };

  if (existing) {
    // Conditional on the offer being the one we read: a concurrent reject ->
    // re-offer (or sweep) must not be overwritten by a dispatch that read the
    // row a moment earlier.
    const held = supabase
      .from("deliveries")
      .update(offer)
      .eq("id", existing.id)
      .eq("status", "unassigned");
    const { data: written, error } = await (previous === null
      ? held.is("offered_driver_id", null)
      : held.eq("offered_driver_id", previous)
    )
      .select("id")
      .overrideTypes<{ id: string }[]>();
    if (error) {
      if (isMissingColumn(error)) {
        rememberColumn(DISPATCH_COLUMNS, false);
        return result("unsupported");
      }
      throw error;
    }
    rememberColumn(DISPATCH_COLUMNS, true);
    if ((written ?? []).length === 0) return result("superseded");
    return result("offered", previous);
  }

  const { error } = await supabase
    .from("deliveries")
    .insert({ order_id: orderId, status: "unassigned", ...offer });
  if (error) {
    if (isMissingColumn(error)) {
      rememberColumn(DISPATCH_COLUMNS, false);
      return result("unsupported");
    }
    // 23505: `deliveries.order_id` is unique (0001), so a rider accepted between
    // our read and our insert. They own the order now — nothing left to offer.
    if ((error as { code?: string }).code === "23505") return result("taken");
    throw error;
  }
  rememberColumn(DISPATCH_COLUMNS, true);
  return result("offered", previous);
}

/**
 * The order and its shop, on whatever columns this database actually has.
 *
 * `address` arrives with 0009 and `prep_minutes` with 0036, so the full select
 * is a hard 400 on an environment that predates either — and dispatch going
 * dark is a worse outcome than dispatch without a street name in the push.
 */
async function readDispatchOrder(
  supabase: ReturnType<typeof createAdminClient>,
  orderId: string
): Promise<DispatchOrderRow | null> {
  const read = (shopColumns: string) =>
    supabase
      .from("orders")
      .select(`id, status, restaurants(${shopColumns})`)
      .eq("id", orderId)
      .maybeSingle()
      .overrideTypes<DispatchOrderRow>();

  const { data, error } = await read("name, address, lat, lng, prep_minutes");
  if (!error) return data ?? null;
  if (!isMissingColumn(error)) return null;

  const { data: legacy, error: legacyError } = await read("name");
  if (legacyError) return null;
  return legacy ?? null;
}

export type DispatchStage = "accepted" | "ready";

export interface DispatchResult {
  rider: RiderChoice | null;
  /** False when the offer could not be recorded (pre-0042, or already taken). */
  offered: boolean;
}

/**
 * Offer an order's pickup to the best available rider, and tell them.
 *
 * Called twice in an order's life, for two different reasons:
 *
 *   `accepted` — the vendor took the order. Nothing is cooked yet, so the
 *     message is a heads-up carrying the prep estimate. This is the whole point
 *     of the feature: a rider who sets off now is at the counter when the bag
 *     is, instead of being told about the order once it is already going cold.
 *
 *   `ready`  — it is packed. Re-run rather than reuse the earlier answer,
 *     because twenty minutes have passed and the rider we picked then may now
 *     be halfway across town with somebody else's dinner.
 *
 * Never throws. A dispatch failure degrades to the behaviour that existed
 * before this module: the order sits in the open pool and any rider may take it.
 */
export async function dispatchOrder(
  orderId: string,
  stage: DispatchStage,
  opts: { excludeRiderIds?: string[] } = {}
): Promise<DispatchResult> {
  const empty: DispatchResult = { rider: null, offered: false };
  try {
    const supabase = createAdminClient();
    const now = Date.now();

    const data = await readDispatchOrder(supabase, orderId);
    if (!data) return empty;

    // Cancelled between the transition and here. Nothing to send anyone.
    if (data.status === "cancelled" || data.status === "delivered") return empty;

    const shop = one(data.restaurants);
    const from = pointOf(shop?.lat, shop?.lng);

    const rider = await chooseRider(from, {
      now,
      exceptOrderId: orderId,
      excludeRiderIds: opts.excludeRiderIds,
    });
    if (!rider) return empty;

    const { outcome, previousOfferee } = await writeOffer(supabase, orderId, rider.id, now);
    // Someone else's newer offer stands: not ours to ring, not ours to stop.
    if (outcome === "superseded") return { rider, offered: false };
    // Offered again to someone else (heads-up at accept, re-offer at ready):
    // the first rider stops ringing for an order now held for the second.
    const stale = staleOfferee(previousOfferee, rider.id);
    if (stale) deferNotify(() => stopRiderRing(stale, orderId));
    // Somebody already has this order. Pushing "head over" at a third party
    // would send them to a shop with nothing waiting for them.
    if (outcome === "taken") return { rider, offered: false };

    const offered = outcome === "offered";
    const restaurantName = shop?.name?.trim() || "the restaurant";

    // The ring lasts as long as the live offer window, not a fixed 180 s.
    const windowSeconds = await getOfferWindowSeconds();

    if (stage === "ready") {
      // Held (the ring ignores the rider's sound switches) only when this rider
      // really holds the offer; anything else is a plain ring.
      deferNotify(() => notifyDriverPickupReady(rider.id, { orderId, restaurantName, held: offered, windowSeconds }));
      return { rider, offered };
    }

    const settings = await getSettings();
    const readyInMinutes = kitchenPrepMinutes({
      restaurantPrepMinutes: shop?.prep_minutes,
      defaultPrepMinutes: settings.defaultPrepMinutes,
    });
    deferNotify(() =>
      notifyDriverPickupOffered(rider.id, {
        orderId,
        restaurantName,
        readyInMinutes,
        pickupArea: shop?.address ?? null,
        windowSeconds,
      })
    );
    return { rider, offered };
  } catch (error) {
    // Swallowed by contract (see the module header) - but not silently. A
    // revoked grant on rider_status used to be indistinguishable from "no
    // riders are online": the order sat in the open pool and nothing anywhere
    // said dispatch had stood down. captureError never throws and never delays.
    const unreadable = error instanceof PresenceUnreadableError;
    captureError(unreadable ? error.cause : error, {
      source: "dispatch/standdown",
      orderId,
      attrs: {
        event: "dispatch_standdown",
        reason: unreadable ? "rider_status_unreadable" : "dispatch_failed",
        stage,
      },
    });
    return empty;
  }
}

/**
 * Stop any delivery in progress for an order that is no longer proceeding.
 *
 * An `unassigned` delivery row is created at vendor-accept and normally becomes
 * a real delivery when a rider takes it. An order that is *cancelled* while
 * still just an offer never gets that far, and the row is deleted outright —
 * read by every board load, forever, for an order that no longer exists as far
 * as anyone is concerned.
 *
 * A rider who has already accepted the job (`assigned`/`picked_up`) is a
 * different case: deleting that row would make an active delivery vanish out
 * from under them mid-trip rather than stop it, so it is marked `cancelled`
 * instead. `getDriverBoard`'s active-delivery query
 * (`.in("status", ["assigned", "picked_up"])`) already excludes that status, so
 * the job disappears from the rider's board the same way a completed one would.
 * Without this, a rider whose order is cancelled after they accepted it keeps
 * seeing it as their active job, can still complete it, and `advanceDelivery`
 * would walk the order back through `on_the_way`/`delivered` — resurrecting an
 * order that is cancelled and refunded.
 *
 * Best-effort, like the offer-clearing it replaces: this runs after the
 * order's own status write has already succeeded, so a failure here must not
 * fail the cancellation itself — it leaves a stale delivery row rather than an
 * order the caller believes is cancelled but isn't.
 */
export async function cancelDeliveryForOrder(orderId: string): Promise<void> {
  try {
    const supabase = createAdminClient();

    // Who has to be told, read before the row changes. A rider holding a live
    // offer or carrying the job used to find out only by looking at the screen
    // — one already riding to the shop kept riding.
    const { data: row } = await supabase
      .from("deliveries")
      .select(
        columnKnownMissing(DISPATCH_COLUMNS)
          ? "driver_id, status"
          : "driver_id, status, offered_driver_id"
      )
      .eq("order_id", orderId)
      .maybeSingle()
      .overrideTypes<{
        driver_id: string | null;
        status: string;
        offered_driver_id?: string | null;
      }>();

    if (!columnKnownMissing(DISPATCH_COLUMNS)) {
      // Checked, not fire-and-forget: since 0083 the database refuses to delete
      // a delivery that carries a rider earning (`guard_delivery_delete`,
      // ruling P3-R8 — e.g. one corrected out of delivered back to the pool).
      // The cancellation itself still stands; the refusal is recorded.
      const { error: deleteError } = await supabase
        .from("deliveries")
        .delete()
        .eq("order_id", orderId)
        .eq("status", "unassigned");
      if (deleteError) {
        captureError(deleteError, {
          source: "dispatch/cancel-delivery",
          orderId,
          attrs: { event: "unassigned_delivery_delete_refused", code: deleteError.code ?? null },
        });
      }
    }
    await supabase
      .from("deliveries")
      .update({ status: "cancelled" })
      .eq("order_id", orderId)
      .in("status", ["assigned", "picked_up"]);

    if (row) {
      const carrying =
        (row.status === "assigned" || row.status === "picked_up") && row.driver_id
          ? row.driver_id
          : null;
      // Told even after their exclusive window lapsed: "head over" may have
      // already put them on the road.
      const offered =
        row.status === "unassigned" ? (row.offered_driver_id ?? null) : null;
      const riderId = carrying ?? offered;
      if (riderId) {
        deferNotify(() =>
          notifyDriverOrderCancelled(riderId, {
            orderId,
            pickedUp: row.status === "picked_up",
          })
        );
      }
    }
  } catch {
    // swallow — see the module header
  }
}

export interface OfferRow {
  offeredDriverId: string | null;
  offeredAt: string | null;
}
