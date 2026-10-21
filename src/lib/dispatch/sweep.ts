import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import { UNASSIGNED_AFTER_MIN } from "@/lib/data-access/admin-dispatch";
import {
  DISPATCH_COLUMNS,
  EXCLUSIVE_OFFER_MS,
  dispatchOrder,
} from "@/lib/dispatch/rider-dispatch";
import {
  notifyOpsKitchenSlow,
  notifyOpsNoRider,
  notifyOpsStuck,
  notifyVendorStillWaiting,
} from "@/lib/notifications/order-events";
import { columnKnownMissing } from "@/lib/data-access/schema-probe";

/**
 * The part of dispatch that has to happen when nobody is doing anything.
 *
 * Everything else in dispatch runs off an action — a vendor accepting, a rider
 * tapping — and so does nothing about the orders where the problem is that no
 * action came:
 *
 *   1. **A lapsed offer.** Dispatch holds a ready order for one rider for
 *      EXCLUSIVE_OFFER_MS. If they ignore it the window closes *passively*: the
 *      order becomes open to everyone, but nobody is told, so it waits for a
 *      rider who happens to look. Here it is re-offered to the next-best rider,
 *      excluding the one who let it lapse, and that rider is pushed.
 *   2. **A kitchen that hasn't accepted** in KITCHEN_SLOW_MIN — ops is told, and the
 *      kitchen's phones ring again (notifyVendorStillWaiting).
 *   3. **A ready order with no rider** after UNASSIGNED_AFTER_MIN — the same
 *      threshold the admin board uses to call it a dispatch failure.
 *   4. **A stuck order** — still open STUCK_AFTER_H after it was placed. Two
 *      orders sat "Preparing" for 26 days before anyone noticed, showing their
 *      customer "27 days late". Not auto-cancelled: whether it was eaten, is
 *      owed a refund or is a test is a human call; the push makes sure a human
 *      makes it, once a day until they do.
 *
 * (2)–(4) push every admin and manager, once per order per alarm: the
 * `rateLimit` bucket is the latch, so a sweep every minute does not become a
 * push every minute.
 *
 * Runs from two places: `/api/cron/dispatch-sweep` on a real schedule, and
 * `maybeSweepDispatch()` piggy-backed on the vendor and rider boards' polls, so
 * it works on a deployment with no cron configured. Both are idempotent and
 * the throttle makes concurrent callers harmless.
 */

const KITCHEN_SLOW_MIN = 3;
const STUCK_AFTER_H = 2;
/** Stuck orders keep nagging this far back; older ones are a data cleanup. */
const STUCK_LOOKBACK_MS = 60 * 24 * 60 * 60_000;
const STUCK_LATCH_MS = 24 * 60 * 60_000;
/** Don't raise alarms about orders from hours ago — that is cleanup, not ops. */
const LOOKBACK_MS = 3 * 60 * 60_000;
/** Bounded per run; a backlog bigger than this is visible on the admin board. */
const BATCH = 20;
/** How long an alarm stays latched once sent. */
const ALARM_LATCH_MS = 60 * 60_000;

export interface SweepResult {
  reoffered: number;
  kitchenAlarms: number;
  riderAlarms: number;
  stuckAlarms: number;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

type ShopName = { name: string | null };
/** The embedded shop, as PostgREST may return it: one row, an array, or nothing. */
type ShopJoin = ShopName | ShopName[] | null;

/** First caller per order per alarm wins; everyone after is latched out. */
async function claimAlarm(
  kind: string,
  orderId: string,
  latchMs = ALARM_LATCH_MS
): Promise<boolean> {
  const latch = await rateLimit(`ops-alarm:${kind}:${orderId}`, 1, latchMs);
  return latch.ok;
}

async function reofferLapsed(
  supabase: ReturnType<typeof createAdminClient>,
  now: number
): Promise<number> {
  if (columnKnownMissing(DISPATCH_COLUMNS)) return 0;

  const { data, error } = await supabase
    .from("deliveries")
    .select("order_id, offered_driver_id, orders!inner(status)")
    .eq("status", "unassigned")
    .not("offered_driver_id", "is", null)
    .lt("offered_at", new Date(now - EXCLUSIVE_OFFER_MS).toISOString())
    .gt("offered_at", new Date(now - LOOKBACK_MS).toISOString())
    // Only at ready: an offer at `kitchen` is a heads-up, and it is re-run at
    // ready anyway. Re-offering heads-ups would ping half the fleet per order.
    .eq("orders.status", "ready")
    .limit(BATCH)
    .overrideTypes<{ order_id: string; offered_driver_id: string | null }[]>();
  if (error || !data) return 0;

  let count = 0;
  for (const row of data) {
    const result = await dispatchOrder(row.order_id, "ready", {
      excludeRiderIds: row.offered_driver_id ? [row.offered_driver_id] : [],
    });
    if (result.offered) count++;
  }
  return count;
}

async function alarmSlowKitchens(
  supabase: ReturnType<typeof createAdminClient>,
  now: number
): Promise<number> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, created_at, restaurants(name)")
    .eq("status", "placed")
    // Only orders the kitchen can actually act on: COD at once, online once
    // paid. An abandoned checkout is not a slow kitchen.
    .or("payment_method.eq.cod,payment_status.in.(paid,authorized)")
    .lt("created_at", new Date(now - KITCHEN_SLOW_MIN * 60_000).toISOString())
    .gt("created_at", new Date(now - LOOKBACK_MS).toISOString())
    .limit(BATCH)
    .overrideTypes<{ id: string; created_at: string; restaurants: ShopJoin }[]>();
  if (error || !data) return 0;

  let count = 0;
  for (const order of data) {
    if (!(await claimAlarm("kitchen", order.id))) continue;
    const minutes = Math.round((now - Date.parse(order.created_at)) / 60_000);
    // Ops and the kitchen at once: ops to phone the shop, the shop's own
    // phones to ring again in case the first ring went unheard.
    await Promise.all([
      notifyOpsKitchenSlow(order.id, {
        restaurantName: one(order.restaurants)?.name?.trim() || "a restaurant",
        minutes,
      }),
      notifyVendorStillWaiting(order.id, minutes),
    ]);
    count++;
  }
  return count;
}

async function alarmRiderless(
  supabase: ReturnType<typeof createAdminClient>,
  now: number
): Promise<number> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, ready_at, restaurants(name)")
    .eq("status", "ready")
    .lt("ready_at", new Date(now - UNASSIGNED_AFTER_MIN * 60_000).toISOString())
    .gt("ready_at", new Date(now - LOOKBACK_MS).toISOString())
    .limit(BATCH)
    .overrideTypes<{ id: string; ready_at: string; restaurants: ShopJoin }[]>();
  if (error || !data || data.length === 0) return 0;

  const { data: covered } = await supabase
    .from("deliveries")
    .select("order_id")
    .in("order_id", data.map((o) => o.id))
    .in("status", ["assigned", "picked_up"]);
  const hasRider = new Set((covered ?? []).map((d) => d.order_id as string));

  let count = 0;
  for (const order of data) {
    if (hasRider.has(order.id)) continue;
    if (!(await claimAlarm("no-rider", order.id))) continue;
    await notifyOpsNoRider(order.id, {
      restaurantName: one(order.restaurants)?.name?.trim() || "a restaurant",
      minutes: Math.round((now - Date.parse(order.ready_at)) / 60_000),
    });
    count++;
  }
  return count;
}

async function alarmStuck(
  supabase: ReturnType<typeof createAdminClient>,
  now: number
): Promise<number> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, status, created_at, restaurants(name)")
    .in("status", ["placed", "kitchen", "ready", "on_the_way"])
    .or("payment_method.eq.cod,payment_status.in.(paid,authorized)")
    .lt("created_at", new Date(now - STUCK_AFTER_H * 60 * 60_000).toISOString())
    .gt("created_at", new Date(now - STUCK_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(BATCH)
    .overrideTypes<{ id: string; status: string; created_at: string; restaurants: ShopJoin }[]>();
  if (error || !data) return 0;

  let count = 0;
  for (const order of data) {
    if (!(await claimAlarm("stuck", order.id, STUCK_LATCH_MS))) continue;
    await notifyOpsStuck(order.id, {
      restaurantName: one(order.restaurants)?.name?.trim() || "a restaurant",
      hours: Math.round((now - Date.parse(order.created_at)) / 3_600_000),
      status: order.status,
    });
    count++;
  }
  return count;
}

/** One full pass. Never throws: each part fails on its own. */
export async function sweepDispatch(now = Date.now()): Promise<SweepResult> {
  const supabase = createAdminClient();
  const safe = (p: Promise<number>) => p.catch(() => 0);
  const [reoffered, kitchenAlarms, riderAlarms, stuckAlarms] = await Promise.all([
    safe(reofferLapsed(supabase, now)),
    safe(alarmSlowKitchens(supabase, now)),
    safe(alarmRiderless(supabase, now)),
    safe(alarmStuck(supabase, now)),
    // 0064: put up the shop badge for offers whose start time has passed.
    // Absent before 0064 (the RPC errors and counts as 0).
    safe(Promise.resolve(supabase.rpc("refresh_due_offers")).then(({ data }) => Number(data) || 0)),
  ]);
  return { reoffered, kitchenAlarms, riderAlarms, stuckAlarms };
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
