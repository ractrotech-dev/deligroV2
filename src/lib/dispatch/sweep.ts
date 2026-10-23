import "server-only";
import { syncCampaigns } from "@/lib/data-access/manager-marketing";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import {
  DISPATCH_COLUMNS,
  dispatchOrder,
  getOfferWindowSeconds,
} from "@/lib/dispatch/rider-dispatch";
import {
  redispatchTargets,
  presenceExpired,
  type RedispatchRow,
} from "@/lib/dispatch/sweep-select";
import { notifyVendorStillWaiting, stopRiderRing } from "@/lib/notifications/order-events";
import { evaluateAlerts } from "@/lib/ops/alerts/engine";
import { deferNotify } from "@/lib/notifications/defer";
import {
  columnKnownMissing,
  isMissingColumn,
  isMissingTable,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import { notifyShop } from "@/lib/notifications/notify-user";
import { forceRiderOffline } from "@/lib/data-access/rider-status";
import { sendCashReminders } from "@/lib/data-access/rider-cash";
import {
  alertDelays,
  alertHighDemand,
  getAlertSettings,
  remindPickups,
} from "@/lib/data-access/rider-alerts";
import { pushStartedAnnouncements } from "@/lib/data-access/announcements";
import { captureError } from "@/lib/obs/emit";

/**
 * The part of dispatch that has to happen when nobody is doing anything.
 *
 * Everything else in dispatch runs off an action — a vendor accepting, a rider
 * tapping — and so does nothing about the orders where the problem is that no
 * action came:
 *
 *   1. **A lapsed offer.** Dispatch holds a ready order for one rider for the
 *      offer window (`rider_offer_window_seconds`). If they ignore it the window
 *      closes *passively*: the order becomes open to everyone, but nobody is
 *      told, so it waits for a rider who happens to look. Here the lapse is
 *      logged (`delivery_events.lapsed`) and the order is re-offered to the
 *      next-best rider, excluding everyone who has already rejected it or let
 *      it lapse, and that rider is pushed. The same pass offers a ready order
 *      that was *never* offered (nobody was online at the time, or a rejection
 *      left it open); `sweep-select.ts` decides which rows those are.
 *   1b. **A rider who is online on paper only.** No position for 20 minutes
 *      and no delivery in flight: taken offline, shift closed at the last fix.
 *   2. **A kitchen that hasn't accepted** in KITCHEN_SLOW_MIN — the kitchen's
 *      phones ring again (notifyVendorStillWaiting).
 *   3. **Operations alerts** (Phase 8, `lib/ops/alerts`): the kitchen not
 *      accepting, orders with no rider, late deliveries, stuck orders, riders
 *      gone quiet, shortages, downtime, money, cash, tickets — evaluated once
 *      a minute platform-wide (a database lease), raised once each per
 *      condition, scoped to the zone's managers and cleared when the
 *      condition goes. They replace the old zone-blind ops pushes here.
 *
 *   5. **Rider cash held too long or too large** (0085) — a push to the rider
 *      past `rider_cash_limit` / `rider_cash_max_hours`, at most once every 6
 *      hours each. The scan reads every rider's collections, so it runs at most
 *      every 10 minutes however often the sweep does.
 *   6. **Rider alerts** (Phase 7, `data-access/rider-alerts.ts`): the pickup
 *      reminder, the delay alert (rider and ops) and the high-demand call to
 *      offline riders — each once, by a stamp on the delivery or a per-rider
 *      latch. Also the fan-out of scheduled announcements once they start
 *      (`pushStartedAnnouncements`, once each: the row's `pushed_at` claim).
 *
 * (2) rings once per order: the `rateLimit` bucket is the latch, so a sweep
 * every minute does not become a ring every minute.
 *
 * Runs from two places: `/api/cron/dispatch-sweep` on a real schedule, and
 * `maybeSweepDispatch()` piggy-backed on the vendor and rider boards' polls, so
 * it works on a deployment with no cron configured. Both are idempotent and
 * the throttle makes concurrent callers harmless.
 */

const KITCHEN_SLOW_MIN = 3;
/** Don't raise alarms about orders from hours ago — that is cleanup, not ops. */
const LOOKBACK_MS = 3 * 60 * 60_000;
/** Bounded per run; a backlog bigger than this is visible on the admin board. */
const BATCH = 20;
/** How long an alarm stays latched once sent. */
const ALARM_LATCH_MS = 60 * 60_000;
/** How long before the sweep tries the same order in the same state again. */
const REDISPATCH_LATCH_MS = 3 * 60_000;

export interface SweepResult {
  reoffered: number;
  /** Riders taken offline for 20 minutes of silence. */
  offlined: number;
  /** Kitchens rung again for an order they have not accepted. */
  kitchenAlarms: number;
  /** Operations alerts raised, cleared and pushed (0 when another instance held the lease). */
  alertsRaised: number;
  alertsCleared: number;
  alertsPushed: number;
  /** Riders reminded to deposit cash. */
  cashReminders: number;
  /** Phase 7 rider alerts. */
  pickupReminders: number;
  delayAlerts: number;
  highDemandPushes: number;
  /** Scheduled announcements fanned out at their start. */
  announcementPushes: number;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}


/** First caller per order per alarm wins; everyone after is latched out. */
async function claimAlarm(
  kind: string,
  orderId: string,
  latchMs = ALARM_LATCH_MS
): Promise<boolean> {
  const latch = await rateLimit(`ops-alarm:${kind}:${orderId}`, 1, latchMs);
  return latch.ok;
}

/** What the sweep needs to know about every rider who has already said no, or not answered. */
async function priorDecliners(
  supabase: ReturnType<typeof createAdminClient>,
  orderIds: string[]
): Promise<Map<string, Set<string>> | null> {
  const out = new Map<string, Set<string>>();
  if (orderIds.length === 0) return out;
  const { data, error } = await supabase
    .from("delivery_events")
    .select("order_id, driver_id")
    .in("order_id", orderIds)
    .in("kind", ["rejected", "lapsed"])
    .overrideTypes<{ order_id: string; driver_id: string | null }[]>();
  if (error) {
    // 0081 not applied: there is no history to read, and the sweep falls back to
    // excluding the rider whose offer just lapsed (the old behaviour).
    if (isMissingTable(error)) return out;
    // Unreadable is not "nobody declined": re-offering to a rider who said no
    // is exactly what this exists to prevent. Skip the pass; the next one retries.
    return null;
  }
  for (const row of data ?? []) {
    if (!row.driver_id) continue;
    const set = out.get(row.order_id) ?? new Set<string>();
    set.add(row.driver_id);
    out.set(row.order_id, set);
  }
  return out;
}

/** Record that a rider let an offer lapse, and open the order to the pool. */
async function recordLapse(
  supabase: ReturnType<typeof createAdminClient>,
  orderId: string,
  deliveryId: string,
  riderId: string
): Promise<boolean> {
  // Conditional on the offer still being that rider's and the delivery still
  // unassigned: a rider who accepted a heartbeat ago is not a lapse. Clearing
  // the offer is also what stops the next pass logging the same lapse again
  // when nobody else is eligible - the order is now open to the pool.
  const { data, error } = await supabase
    .from("deliveries")
    .update({ offered_driver_id: null, offered_at: null })
    .eq("id", deliveryId)
    .eq("status", "unassigned")
    .eq("offered_driver_id", riderId)
    .select("id")
    .overrideTypes<{ id: string }[]>();
  if (error || (data ?? []).length === 0) return false;

  const { error: eventError } = await supabase
    .from("delivery_events")
    .insert({ delivery_id: deliveryId, order_id: orderId, driver_id: riderId, kind: "lapsed" });
  if (eventError && !isMissingTable(eventError)) {
    // The exclusion for THIS pass still holds (the caller adds the rider); what
    // is lost is the durable record, so say so.
    captureError(eventError, {
      source: "dispatch/sweep",
      orderId,
      driverId: riderId,
      attrs: { event: "lapse_not_recorded" },
    });
  }
  deferNotify(() => stopRiderRing(riderId, orderId));
  return true;
}

/**
 * Offer ready orders again: the ones whose offer lapsed, and the ones nobody was
 * ever offered (no rider was online when the kitchen marked them ready, or a
 * rejection left them open and no one else qualified at the time).
 *
 * Every rider who has already rejected or let the order lapse is excluded, from
 * `delivery_events`, so an order is never offered twice to the same person. The
 * which-rows decision is `redispatchTargets` (pure, tested); this reads the
 * rows, writes the lapse and dispatches.
 */
export async function redispatchOrders(now: number, windowSeconds: number): Promise<number> {
  if (columnKnownMissing(DISPATCH_COLUMNS)) return 0;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("orders")
    .select("id, status, ready_at, deliveries(id, status, offered_driver_id, offered_at)")
    // Only at ready: an offer at `kitchen` is a heads-up, and it is re-run at
    // ready anyway. Re-offering heads-ups would ping half the fleet per order.
    .eq("status", "ready")
    .gt("ready_at", new Date(now - LOOKBACK_MS).toISOString())
    .order("ready_at", { ascending: true })
    .limit(200)
    .overrideTypes<
      {
        id: string;
        status: string;
        ready_at: string | null;
        deliveries: DeliveryJoin | DeliveryJoin[] | null;
      }[]
    >();
  if (error) {
    if (isMissingColumn(error)) rememberColumn(DISPATCH_COLUMNS, false);
    return 0;
  }

  const delivery = new Map<string, DeliveryJoin | null>();
  const rows: RedispatchRow[] = (data ?? []).map((o) => {
    const d = one(o.deliveries);
    delivery.set(o.id, d);
    return {
      orderId: o.id,
      orderStatus: o.status,
      readyAt: o.ready_at,
      deliveryStatus: d?.status ?? null,
      offeredDriverId: d?.offered_driver_id ?? null,
      offeredAt: d?.offered_at ?? null,
    };
  });

  const targets = redispatchTargets(rows, new Date(now), windowSeconds);
  if (targets.length === 0) return 0;

  const decliners = await priorDecliners(
    supabase,
    targets.map((t) => t.orderId)
  );
  if (!decliners) return 0;

  let attempted = 0;
  let count = 0;
  for (const target of targets) {
    // The batch is a budget of ATTEMPTS, not of rows: an order nobody can take
    // (every eligible rider has declined it, or no one is online) is retried at
    // most once per REDISPATCH_LATCH_MS, so the oldest hopeless orders cannot
    // sit at the front of the queue every minute and starve newer ones. The key
    // carries the state the attempt is about (a lapse is keyed by its offer), so
    // a fresh lapse is never held back by the latch of the offer before it.
    if (attempted >= BATCH) break;
    const d = delivery.get(target.orderId);
    const latchKey = `redispatch:${target.orderId}:${target.kind}:${d?.offered_at ?? "-"}`;
    if (!(await rateLimit(latchKey, 1, REDISPATCH_LATCH_MS)).ok) continue;
    attempted++;

    const exclude = new Set(decliners.get(target.orderId) ?? []);

    if (target.kind === "lapsed" && target.lapsedDriverId) {
      exclude.add(target.lapsedDriverId);
      // The lapse write is conditional on the offer still being that rider's.
      // Losing it means the order moved (a reject -> re-offer, an accept): the
      // newer state stands and there is nothing for this pass to dispatch.
      if (!d?.id || !(await recordLapse(supabase, target.orderId, d.id, target.lapsedDriverId))) {
        continue;
      }
    }

    const result = await dispatchOrder(target.orderId, "ready", {
      excludeRiderIds: [...exclude],
    });
    if (result.offered) count++;
  }
  return count;
}

interface DeliveryJoin {
  id: string;
  status: string;
  offered_driver_id: string | null;
  offered_at: string | null;
}

/**
 * Take riders offline who are online on paper only: no position for 20 minutes
 * and no delivery in flight. The phone died, the app was killed, or the rider
 * walked away without tapping Go offline; until now they stayed "online" for
 * ever, held a shift open and counted as supply on the admin board.
 *
 * The shift is closed at the last fix (or at `online_since` when there never
 * was one), so the hours are the hours the phone was seen. The write is
 * conditional on no fix having arrived since the read (`onlyIfLastFixAt`).
 * Returns how many riders went offline.
 */
export async function offlineExpiredRiders(now: Date): Promise<number> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("rider_status")
    .select("driver_id, is_online, last_fix_at, online_since")
    .eq("is_online", true)
    .limit(500)
    .overrideTypes<
      {
        driver_id: string;
        is_online: boolean;
        last_fix_at: string | null;
        online_since: string | null;
      }[]
    >();
  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  const online = data ?? [];
  if (online.length === 0) return 0;

  const { data: busy, error: busyError } = await supabase
    .from("deliveries")
    .select("driver_id")
    .in(
      "driver_id",
      online.map((r) => r.driver_id)
    )
    .in("status", ["assigned", "picked_up"])
    .overrideTypes<{ driver_id: string | null }[]>();
  // If we cannot tell who is carrying a delivery, no one is taken offline: the
  // wrong answer here cuts a rider off mid-job.
  if (busyError) throw busyError;
  const carrying = new Set((busy ?? []).map((d) => d.driver_id));

  const expired = presenceExpired(
    online.map((r) => ({
      driverId: r.driver_id,
      isOnline: r.is_online,
      lastFixAt: r.last_fix_at,
      onlineSince: r.online_since,
      hasActiveDelivery: carrying.has(r.driver_id),
    })),
    now
  );

  const seen = new Map(online.map((r) => [r.driver_id, r.last_fix_at]));
  let count = 0;
  for (const { driverId, endedAt } of expired) {
    try {
      const wentOffline = await forceRiderOffline(driverId, "presence", {
        endedAt,
        onlyIfLastFixAt: seen.get(driverId) ?? null,
      });
      if (wentOffline) count++;
    } catch (e) {
      captureError(e, {
        source: "dispatch/sweep",
        driverId,
        attrs: { event: "presence_sweep_failed" },
      });
    }
  }
  return count;
}

async function alarmSlowKitchens(
  supabase: ReturnType<typeof createAdminClient>,
  now: number
): Promise<number> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, created_at")
    .eq("status", "placed")
    // Only orders the kitchen can actually act on: COD at once, online once
    // paid. An abandoned checkout is not a slow kitchen.
    .or("payment_method.eq.cod,payment_status.in.(paid,authorized)")
    .lt("created_at", new Date(now - KITCHEN_SLOW_MIN * 60_000).toISOString())
    .gt("created_at", new Date(now - LOOKBACK_MS).toISOString())
    .limit(BATCH)
    .overrideTypes<{ id: string; created_at: string }[]>();
  if (error || !data) return 0;

  let count = 0;
  for (const order of data) {
    if (!(await claimAlarm("kitchen", order.id))) continue;
    const minutes = Math.round((now - Date.parse(order.created_at)) / 60_000);
    // The shop's own phones ring again in case the first ring went unheard;
    // operations hear about it through the alert engine (order_needs_intervention).
    await notifyVendorStillWaiting(order.id, minutes);
    count++;
  }
  return count;
}

/** A delivered order older than this and still not in a paid settlement is a late payout. */
const PAYOUT_LATE_DAYS = 10;
const PAYOUT_LOOKBACK_DAYS = 45;
const PAYOUT_CHECK_MS = 6 * 60 * 60_000;
const PAYOUT_LATCH_MS = 24 * 60 * 60_000;

/**
 * Shops with delivered orders more than ten days old that no paid settlement
 * covers hear about it, once a day at most (requirements §13 "failed or
 * delayed payments"). Runs at most every six hours across instances.
 */
async function alertDelayedPayouts(supabase: ReturnType<typeof createAdminClient>, now: number): Promise<number> {
  const gate = await rateLimit("payout-delay-sweep", 1, PAYOUT_CHECK_MS);
  if (!gate.ok) return 0;
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, restaurant_id")
    .eq("status", "delivered")
    .gte("created_at", new Date(now - PAYOUT_LOOKBACK_DAYS * 86_400_000).toISOString())
    .lt("created_at", new Date(now - PAYOUT_LATE_DAYS * 86_400_000).toISOString())
    .limit(3000);
  if (error || !orders?.length) return 0;

  const paid = new Set<string>();
  for (let i = 0; i < orders.length; i += 150) {
    const ids = orders.slice(i, i + 150).map((o) => o.id as string);
    const { data } = await supabase
      .from("vendor_settlement_orders")
      .select("order_id, vendor_settlements!inner(status)")
      .in("order_id", ids)
      .eq("vendor_settlements.status", "paid");
    for (const r of data ?? []) paid.add(r.order_id as string);
  }
  const lateByShop = new Map<string, number>();
  for (const o of orders) {
    if (!paid.has(o.id as string)) lateByShop.set(o.restaurant_id as string, (lateByShop.get(o.restaurant_id as string) ?? 0) + 1);
  }
  let told = 0;
  for (const [rid, n] of lateByShop) {
    const latch = await rateLimit(`payout-late:${rid}`, 1, PAYOUT_LATCH_MS);
    if (!latch.ok) continue;
    await notifyShop(rid, {
      category: "payments",
      title: "Payout running late",
      body: `${n} delivered ${n === 1 ? "order" : "orders"} from more than ${PAYOUT_LATE_DAYS} days ago ${n === 1 ? "hasn't" : "haven't"} been paid out yet. Deligro has been asked to settle ${n === 1 ? "it" : "them"}.`,
      url: "/payments",
    });
    told++;
  }
  return told;
}

/** The cash scan is heavier than the other parts: once every ten minutes. */
const CASH_SCAN_EVERY_MS = 10 * 60_000;

async function remindCash(now: number): Promise<number> {
  if (!(await rateLimit("cash-reminder-scan", 1, CASH_SCAN_EVERY_MS)).ok) return 0;
  return sendCashReminders(new Date(now));
}

/** One full pass. Never throws: each part fails on its own. */
export async function sweepDispatch(now = Date.now()): Promise<SweepResult> {
  const supabase = createAdminClient();
  const safe = (p: Promise<number>) => p.catch(() => 0);
  const [windowSeconds, alertSettings] = await Promise.all([getOfferWindowSeconds(), getAlertSettings()]);
  const [
    reoffered,
    offlined,
    kitchenAlarms,
    alerts,
    // Offers refreshed and late-payout notices: run for their effect, not reported.
    ,
    ,
    cashReminders,
    pickupReminders,
    delayAlerts,
    highDemandPushes,
    announcementPushes,
  ] = await Promise.all([
    safe(redispatchOrders(now, windowSeconds)),
    safe(offlineExpiredRiders(new Date(now))),
    safe(alarmSlowKitchens(supabase, now)),
    evaluateAlerts(new Date(now)).catch(() => ({ skipped: "error" as const })),
    // 0064: put up the shop badge for offers whose start time has passed.
    // Absent before 0064 (the RPC errors and counts as 0).
    safe(Promise.resolve(supabase.rpc("refresh_due_offers")).then(({ data }) => Number(data) || 0)),
    safe(alertDelayedPayouts(supabase, now)),
    safe(remindCash(now)),
    safe(remindPickups(now, alertSettings)),
    safe(alertDelays(now, alertSettings)),
    safe(alertHighDemand(now, alertSettings)),
    safe(pushStartedAnnouncements(now)),
  ]);
  // 0160: campaign statuses follow their windows, and shops hear when theirs
  // starts or ends. Customer surfaces read the window and never wait on this.
  await safe(syncCampaigns(new Date(now), { force: true }).then((r) => r.changed.length));
  return {
    reoffered,
    offlined,
    kitchenAlarms,
    alertsRaised: "raised" in alerts ? alerts.raised : 0,
    alertsCleared: "cleared" in alerts ? alerts.cleared : 0,
    alertsPushed: "pushed" in alerts ? alerts.pushed : 0,
    cashReminders,
    pickupReminders,
    delayAlerts,
    highDemandPushes,
    announcementPushes,
  };
}

/** Per-instance fast path, so most polls never touch the shared limiter. */
let lastLocalRun = 0;
const SWEEP_EVERY_MS = 55_000;

/**
 * Run a sweep if nobody has in the last minute.
 *
 * Called after the response on the vendor and rider board renders, which poll
 * every 8 s and 4 s whenever anyone is working — a heartbeat that exists
 * exactly when there are orders to sweep. The shared rate-limit bucket keeps
 * it to about one sweep a minute across every instance and every screen.
 */
export async function maybeSweepDispatch(): Promise<void> {
  const now = Date.now();
  if (now - lastLocalRun < SWEEP_EVERY_MS) return;
  lastLocalRun = now;
  try {
    const gate = await rateLimit("dispatch-sweep", 1, SWEEP_EVERY_MS);
    if (!gate.ok) return;
    await sweepDispatch(now);
  } catch {
    // Best-effort by design — the next poll tries again.
  }
}
