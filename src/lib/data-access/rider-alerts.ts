import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import { captureError } from "@/lib/obs/emit";
import { computeOrderEta } from "@/lib/orders/eta";
import {
  columnKnownMissing,
  isMissingColumn,
  rememberColumn,
} from "@/lib/data-access/schema-probe";
import {
  HIGH_DEMAND_LOOKBACK_DAYS,
  HIGH_DEMAND_REPEAT_MINUTES,
  isHighDemand,
  minutesPast,
  needsDelayAlert,
  needsPickupReminder,
} from "@/lib/rider/alert-rules";
import {
  notifyOpsDelayAlert,
  notifyRiderDelayAlert,
  notifyRiderPickupReminder,
  notifyRidersHighDemand,
} from "@/lib/notifications/order-events";
import { DEFAULT_SETTINGS } from "@/lib/settings-defaults";

/**
 * The dispatch sweep's three rider alerts (§11), run from `sweepDispatch`:
 *
 *   * **Pickup reminder** — an accepted delivery whose order has been ready
 *     `pickup_reminder_minutes` and the rider is not at the shop: the rider is
 *     pushed (`pickup_reminders`), once.
 *   * **Delay alert** — a picked-up delivery `delay_alert_minutes` past its
 *     ETA (`computeOrderEta`, the same model the customer's countdown uses):
 *     the rider (`delivery_updates`) and ops are pushed, once each.
 *   * **High demand** — waiting orders per online idle rider at or above
 *     `high_demand_ratio` (minimum 3 waiting): offline riders who were online
 *     in the last 14 days are pushed (`high_demand`), at most once per 30
 *     minutes each (a rate-limit latch per rider).
 *
 * "Once" is a stamp on the delivery (0087 `pickup_reminded_at`,
 * `delay_alerted_at`) written conditionally — `where … is null` — BEFORE the
 * push: of two concurrent sweeps exactly one wins the stamp and pushes. A
 * database without the stamps sends nothing at all rather than risk a push
 * every minute.
 *
 * Service role; the sweep has no caller to authorise (cron route / board
 * poll heartbeat). Each part fails on its own and returns 0.
 */

export interface AlertSettings {
  highDemandRatio: number;
  pickupReminderMinutes: number;
  delayAlertMinutes: number;
  defaultPrepMinutes: number;
}

/** Mirrors the 0087 column defaults. */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  highDemandRatio: 2,
  pickupReminderMinutes: 10,
  delayAlertMinutes: 10,
  defaultPrepMinutes: DEFAULT_SETTINGS.defaultPrepMinutes,
};

const SETTINGS_COLUMN = "platform_settings.high_demand_ratio";
/** Deliveries older than this are cleanup, not alerts. */
const LOOKBACK_MS = 6 * 60 * 60_000;
const BATCH = 50;
const MINUTE = 60_000;

type AdminClient = ReturnType<typeof createAdminClient>;

const num = (v: unknown, fallback: number) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The thresholds, read with the service role (0087 grants them to nobody else). */
export async function getAlertSettings(): Promise<AlertSettings> {
  if (columnKnownMissing(SETTINGS_COLUMN)) return DEFAULT_ALERT_SETTINGS;
  try {
    const { data, error } = await createAdminClient()
      .from("platform_settings")
      .select("high_demand_ratio, pickup_reminder_minutes, delay_alert_minutes, default_prep_minutes")
      .limit(1)
      .maybeSingle()
      .overrideTypes<Record<string, unknown>>();
    if (error) {
      if (isMissingColumn(error)) rememberColumn(SETTINGS_COLUMN, false);
      return DEFAULT_ALERT_SETTINGS;
    }
    return {
      highDemandRatio: num(data?.high_demand_ratio, DEFAULT_ALERT_SETTINGS.highDemandRatio),
      pickupReminderMinutes: num(data?.pickup_reminder_minutes, DEFAULT_ALERT_SETTINGS.pickupReminderMinutes),
      delayAlertMinutes: num(data?.delay_alert_minutes, DEFAULT_ALERT_SETTINGS.delayAlertMinutes),
      defaultPrepMinutes: num(data?.default_prep_minutes, DEFAULT_ALERT_SETTINGS.defaultPrepMinutes),
    };
  } catch {
    return DEFAULT_ALERT_SETTINGS;
  }
}

interface OrderRow {
  id: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  restaurant_id: string | null;
}

interface ShopRow {
  id: string;
  name: string | null;
  eta_min: number | null;
  eta_max: number | null;
  prep_minutes: number | null;
}

async function ordersById(supabase: AdminClient, ids: string[]): Promise<Map<string, OrderRow>> {
  const out = new Map<string, OrderRow>();
  if (ids.length === 0) return out;
  const { data } = await supabase
    .from("orders")
    .select("id, status, created_at, accepted_at, ready_at, restaurant_id")
    .in("id", ids)
    .overrideTypes<OrderRow[]>();
  for (const o of data ?? []) out.set(o.id, o);
  return out;
}

async function shopsById(supabase: AdminClient, ids: string[]): Promise<Map<string, ShopRow>> {
  const out = new Map<string, ShopRow>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const { data } = await supabase
    .from("restaurants")
    .select("id, name, eta_min, eta_max, prep_minutes")
    .in("id", unique)
    .overrideTypes<ShopRow[]>();
  for (const r of data ?? []) out.set(r.id, r);
  return out;
}

/** Set a once-only stamp; true for the caller that set it. */
async function claimStamp(
  supabase: AdminClient,
  deliveryId: string,
  column: "pickup_reminded_at" | "delay_alerted_at",
  at: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("deliveries")
    .update({ [column]: at })
    .eq("id", deliveryId)
    .is(column, null)
    .select("id")
    .overrideTypes<{ id: string }[]>();
  return !error && (data ?? []).length === 1;
}

export async function remindPickups(now: number, settings?: AlertSettings): Promise<number> {
  const s = settings ?? (await getAlertSettings());
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("deliveries")
    .select("id, order_id, driver_id, status, assigned_at, arrived_pickup_at, pickup_reminded_at")
    .eq("status", "assigned")
    .is("pickup_reminded_at", null)
    .is("arrived_pickup_at", null)
    .gt("assigned_at", new Date(now - LOOKBACK_MS).toISOString())
    // Oldest first: within a capped batch, the rider waiting longest is reminded first.
    .order("assigned_at", { ascending: true })
    .limit(BATCH)
    .overrideTypes<
      {
        id: string;
        order_id: string;
        driver_id: string | null;
        status: string;
        assigned_at: string | null;
        arrived_pickup_at: string | null;
        pickup_reminded_at: string | null;
      }[]
    >();
  if (error || !data?.length) return 0;

  const orders = await ordersById(supabase, data.map((d) => d.order_id));
  const shops = await shopsById(supabase, [...orders.values()].map((o) => o.restaurant_id ?? ""));
  const at = new Date(now);
  let count = 0;
  for (const d of data) {
    const o = orders.get(d.order_id);
    if (!d.driver_id || !o) continue;
    const due = needsPickupReminder({
      deliveryStatus: d.status,
      orderStatus: o.status,
      assignedAt: d.assigned_at,
      readyAt: o.ready_at,
      arrivedPickupAt: d.arrived_pickup_at,
      remindedAt: d.pickup_reminded_at,
      now: at,
      minutes: s.pickupReminderMinutes,
    });
    if (!due || !(await claimStamp(supabase, d.id, "pickup_reminded_at", at.toISOString()))) continue;
    await notifyRiderPickupReminder(d.driver_id, {
      orderId: d.order_id,
      restaurantName: shops.get(o.restaurant_id ?? "")?.name?.trim() || "The shop",
      minutes: Math.max(1, Math.round((now - Date.parse(o.ready_at ?? at.toISOString())) / MINUTE)),
    });
    count++;
  }
  return count;
}

export async function alertDelays(now: number, settings?: AlertSettings): Promise<number> {
  const s = settings ?? (await getAlertSettings());
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("deliveries")
    .select("id, order_id, driver_id, status, picked_up_at, delay_alerted_at")
    .eq("status", "picked_up")
    .is("delay_alerted_at", null)
    .gt("picked_up_at", new Date(now - LOOKBACK_MS).toISOString())
    .order("picked_up_at", { ascending: true })
    .limit(BATCH)
    .overrideTypes<
      { id: string; order_id: string; driver_id: string | null; status: string; picked_up_at: string | null; delay_alerted_at: string | null }[]
    >();
  if (error || !data?.length) return 0;

  const orders = await ordersById(supabase, data.map((d) => d.order_id));
  const shops = await shopsById(supabase, [...orders.values()].map((o) => o.restaurant_id ?? ""));
  const at = new Date(now);
  let count = 0;
  for (const d of data) {
    const o = orders.get(d.order_id);
    if (!d.driver_id || !o) continue;
    const shop = shops.get(o.restaurant_id ?? "");
    const eta = computeOrderEta({
      status: "ON_THE_WAY",
      createdAt: o.created_at,
      acceptedAt: o.accepted_at,
      readyAt: o.ready_at,
      pickedUpAt: d.picked_up_at,
      etaMin: shop?.eta_min ?? null,
      etaMax: shop?.eta_max ?? null,
      defaultPrepMinutes: s.defaultPrepMinutes,
      restaurantPrepMinutes: shop?.prep_minutes ?? null,
      now,
    }).expectedAt;
    const due = needsDelayAlert({ deliveryStatus: d.status, etaAt: eta, alertedAt: d.delay_alerted_at, now: at, minutes: s.delayAlertMinutes });
    if (!due || !(await claimStamp(supabase, d.id, "delay_alerted_at", at.toISOString()))) continue;
    const late = minutesPast(eta, at);
    let riderName: string | null = null;
    try {
      const { data: p } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", d.driver_id)
        .maybeSingle()
        .overrideTypes<{ full_name: string | null }>();
      riderName = p?.full_name ?? null;
    } catch {
      // the alert goes without the name
    }
    await notifyRiderDelayAlert(d.driver_id, { orderId: d.order_id, minutesLate: late });
    await notifyOpsDelayAlert(d.order_id, { riderName, minutesLate: late });
    count++;
  }
  return count;
}

export async function alertHighDemand(now: number, settings?: AlertSettings): Promise<number> {
  const s = settings ?? (await getAlertSettings());
  const supabase = createAdminClient();

  // Waiting: cooking or ready in the last 3 hours, with no rider on it.
  const { data: open, error: openError } = await supabase
    .from("orders")
    .select("id")
    .in("status", ["kitchen", "ready"])
    .gt("created_at", new Date(now - 3 * 60 * MINUTE).toISOString())
    .limit(500)
    .overrideTypes<{ id: string }[]>();
  if (openError || !open?.length) return 0;
  const { data: covered } = await supabase
    .from("deliveries")
    .select("order_id, driver_id, status")
    .in("order_id", open.map((o) => o.id))
    .in("status", ["assigned", "picked_up"])
    .overrideTypes<{ order_id: string; driver_id: string | null; status: string }[]>();
  const withRider = new Set((covered ?? []).filter((d) => d.driver_id).map((d) => d.order_id));
  const waiting = open.filter((o) => !withRider.has(o.id)).length;

  // Idle: online, not on a break, not carrying anything.
  const { data: online, error: onlineError } = await supabase
    .from("rider_status")
    .select("driver_id, is_online, break_until")
    .eq("is_online", true)
    .limit(1000)
    .overrideTypes<{ driver_id: string; is_online: boolean; break_until: string | null }[]>();
  if (onlineError) return 0;
  const onlineIds = (online ?? []).map((r) => r.driver_id);
  const available = (online ?? []).filter((r) => !r.break_until || Date.parse(r.break_until) <= now).map((r) => r.driver_id);
  let busy = new Set<string>();
  if (available.length) {
    const { data: carrying } = await supabase
      .from("deliveries")
      .select("driver_id")
      .in("driver_id", available)
      .in("status", ["assigned", "picked_up"])
      .overrideTypes<{ driver_id: string | null }[]>();
    busy = new Set((carrying ?? []).map((d) => d.driver_id ?? ""));
  }
  const idle = available.filter((id) => !busy.has(id)).length;
  if (!isHighDemand({ waitingOrders: waiting, idleOnlineRiders: idle, ratio: s.highDemandRatio })) return 0;

  // Who to call: offline riders with a shift in the last 14 days.
  const { data: shifts, error: shiftError } = await supabase
    .from("rider_shifts")
    .select("driver_id, started_at")
    .gte("started_at", new Date(now - HIGH_DEMAND_LOOKBACK_DAYS * 24 * 60 * MINUTE).toISOString())
    .limit(5000)
    .overrideTypes<{ driver_id: string; started_at: string }[]>();
  if (shiftError) return 0;
  const onlineSet = new Set(onlineIds);
  const candidates = [...new Set((shifts ?? []).map((r) => r.driver_id))].filter((id) => !onlineSet.has(id));
  const toCall: string[] = [];
  for (const id of candidates) {
    const latch = await rateLimit(`high-demand:${id}`, 1, HIGH_DEMAND_REPEAT_MINUTES * MINUTE);
    if (latch.ok) toCall.push(id);
  }
  if (toCall.length === 0) return 0;
  try {
    await notifyRidersHighDemand(toCall, { waiting });
  } catch (e) {
    captureError(e, { source: "dispatch/high-demand", attrs: { event: "high_demand_push_failed" } });
  }
  return toCall.length;
}
