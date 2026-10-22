import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadActiveOrderRows, loadRiderInfo } from "@/lib/data-access/manager-ops-orders";
import { financeIssuesForZone } from "@/lib/data-access/manager-finance";
import { readAllRows } from "@/lib/data-access/read-all";
import { readByIds } from "@/lib/data-access/scoped-riders";
import { COUNTED_ORDER_FILTER } from "@/lib/ops/queue";
import { liveFacts } from "@/lib/ops/order-row";
import { liveSignals, orderWaits, type RiderFacts } from "@/lib/ops/live-rules";
import { orderShortCode } from "@/lib/ops/order-contract";
import { exceptionLabel, type ExceptionKind } from "@/lib/rider/exception-rules";
import { addDays, istDayKey, istDayStart } from "@/lib/metrics";
import { ALERT_KINDS, effectiveRule, type OpsAlertKind, type ResolvedRule } from "./catalog";
import { emptyFacts, type AlertFacts } from "./evaluate";

/**
 * Loads what the evaluator needs, platform-wide (the engine runs as the
 * system; each alert carries its zone and the notifier scopes who hears it).
 * Every query is bounded: active orders, the last day's orders, open tickets,
 * the last two hours' failures, the current finance and cash lines.
 *
 * Each section fails on its own: a section that cannot be read marks its kinds
 * `unavailable`, and the engine then neither raises nor clears those kinds —
 * a read error must never look like "all clear".
 */
export type LoadedFacts = AlertFacts & { unavailable: OpsAlertKind[] };

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function loadAlertFacts(now: Date, rules: readonly ResolvedRule[]): Promise<LoadedFacts> {
  const facts: LoadedFacts = { ...emptyFacts(now), unavailable: [] };
  const supabase = createAdminClient();
  const down = (...kinds: OpsAlertKind[]) => facts.unavailable.push(...kinds);
  const section = async (kinds: OpsAlertKind[], fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      down(...kinds);
    }
  };

  await section(ALERT_KINDS.map((k) => k.kind), async () => {
    const { data, error } = await supabase.from("delivery_zones").select("id, name").eq("is_active", true);
    if (error) throw error;
    facts.zones = (data ?? []) as { id: string; name: string }[];
  });
  if (facts.unavailable.length > 0) return facts;

  // Active orders, riders, inactivity.
  await section(["order_needs_intervention", "order_unassigned", "delivery_delayed", "rider_shortage", "rider_inactive"], async () => {
    const rows = await loadActiveOrderRows({ all: true });
    const carrying = new Map<string, string[]>();
    for (const r of rows) {
      const d = r.delivery;
      if (d?.driverId && (d.status === "assigned" || d.status === "picked_up")) {
        carrying.set(d.driverId, [...(carrying.get(d.driverId) ?? []), r.id]);
      }
    }
    facts.orders = rows.map((r) => {
      const w = orderWaits(liveFacts(r), now);
      const d = r.delivery;
      return {
        id: r.id,
        code: orderShortCode(r.id),
        zoneId: r.zoneId,
        status: r.status,
        vendorName: r.vendor.name,
        createdAt: r.createdAt,
        lastChangeAt: w.lastChangeAt,
        acceptWaitMinutes: w.acceptWait,
        unassignedMinutes: w.unassigned,
        lateByMinutes: w.lateBy,
        hasRider: !!d?.driverId && (d.status === "assigned" || d.status === "picked_up"),
      };
    });

    type St = { driver_id: string; is_online: boolean; break_until: string | null; last_fix_at: string | null };
    const online = await readAllRows<St>((from, to) =>
      supabase.from("rider_status").select("driver_id, is_online, break_until, last_fix_at").eq("is_online", true)
        .order("driver_id").range(from, to) as unknown as PromiseLike<{ data: St[] | null; error: unknown }>
    );
    if (online.error) throw online.error;
    const status = new Map(online.data.map((s) => [s.driver_id, s]));
    const missing = [...carrying.keys()].filter((id) => !status.has(id));
    for (const s of await readByIds<St>("rider_status", "driver_id, is_online, break_until, last_fix_at", "driver_id", missing)) {
      status.set(s.driver_id, s);
    }
    const ids = [...new Set([...status.keys(), ...carrying.keys()])];
    const zones = await readByIds<{ user_id: string; zone_id: string }>("staff_zones", "user_id, zone_id", "user_id", ids);
    const zonesOf = new Map<string, string[]>();
    for (const z of zones) zonesOf.set(z.user_id, [...(zonesOf.get(z.user_id) ?? []), z.zone_id]);

    const riderFacts: (RiderFacts & { activeOrderIds: string[] })[] = ids.map((id) => {
      const s = status.get(id);
      return {
        id, isOnline: s?.is_online ?? false, breakUntil: s?.break_until ?? null, lastFixAt: s?.last_fix_at ?? null,
        lat: null, lng: null, zoneIds: zonesOf.get(id) ?? [], suspended: false,
        activeDeliveries: carrying.get(id)?.length ?? 0, activeOrderIds: carrying.get(id) ?? [],
      };
    });
    facts.riders = riderFacts.map((r) => ({
      id: r.id, zoneIds: r.zoneIds, online: r.isOnline,
      onBreak: !!r.breakUntil && Date.parse(r.breakUntil) > now.getTime(),
      activeDeliveries: r.activeDeliveries,
    }));

    const inactive = liveSignals([], riderFacts, now).filter((s) => s.kind === "rider_inactive" && s.riderId && s.orderId);
    const info = await loadRiderInfo(inactive.map((s) => s.riderId!));
    const orderZone = new Map(rows.map((r) => [r.id, r.zoneId]));
    // liveSignals counts a rider "inactive" from INACTIVE_MINUTES; the engine
    // re-applies each zone's own threshold to the same minutes.
    facts.inactive = inactive.map((s) => ({
      riderId: s.riderId!, riderName: info.get(s.riderId!)?.name ?? "Rider",
      orderId: s.orderId!, orderCode: orderShortCode(s.orderId!), zoneId: orderZone.get(s.orderId!) ?? null, minutes: s.minutes,
    }));
  });

  // Orders of the last day (cancellation rate).
  await section(["high_cancellation_rate"], async () => {
    const window = Math.max(60, ...facts.zones.map((z) => effectiveRule(rules, "high_cancellation_rate", z.id).windowMinutes ?? 60));
    type R = { zone_id: string | null; status: string; created_at: string };
    const res = await readAllRows<R>((from, to) =>
      supabase.from("orders").select("zone_id, status, created_at")
        .gte("created_at", new Date(now.getTime() - window * 60_000).toISOString())
        .or(COUNTED_ORDER_FILTER).order("created_at").range(from, to) as unknown as PromiseLike<{ data: R[] | null; error: unknown }>
    );
    if (res.error) throw res.error;
    facts.recentOrders = res.data.map((r) => ({ zoneId: r.zone_id, status: String(r.status), createdAt: r.created_at }));
  });

  // Failed deliveries, last two hours.
  await section(["delivery_failed"], async () => {
    type F = { id: string; order_id: string; driver_id: string | null; orders: One<{ zone_id: string | null; restaurants: One<{ name: string | null }> }> };
    const { data, error } = await supabase.from("deliveries")
      .select("id, order_id, driver_id, orders!inner(zone_id, restaurants(name))")
      .eq("status", "failed").gte("failed_at", new Date(now.getTime() - 2 * 3_600_000).toISOString())
      .order("failed_at", { ascending: false }).limit(500);
    if (error) throw error;
    const rows = (data ?? []) as unknown as F[];
    const info = await loadRiderInfo(rows.map((r) => r.driver_id).filter((x): x is string => !!x));
    facts.failed = rows.map((r) => {
      const o = one(r.orders);
      return {
        deliveryId: r.id, orderId: r.order_id, orderCode: orderShortCode(r.order_id), zoneId: o?.zone_id ?? null,
        vendorName: one(o?.restaurants ?? null)?.name?.trim() || "the shop", riderName: r.driver_id ? (info.get(r.driver_id)?.name ?? null) : null,
      };
    });
  });

  // Shops (0167).
  await section(["vendor_downtime"], async () => {
    const window = Math.max(60, ...facts.zones.map((z) => effectiveRule(rules, "vendor_downtime", z.id).windowMinutes ?? 60));
    type V = { restaurant_id: string; name: string | null; zone_id: string | null; scheduled_open: boolean; closed: boolean; closed_minutes: number | null; troubled_order_times: string[] | null };
    const { data, error } = await supabase.rpc("ops_vendor_downtime_facts", {
      p_now: now.toISOString(), p_window_minutes: window, p_zone_ids: null, p_all: true,
    });
    if (error) throw error;
    facts.vendors = ((data ?? []) as V[]).map((v) => ({
      id: v.restaurant_id, name: v.name?.trim() || "Shop", zoneId: v.zone_id, scheduledOpen: v.scheduled_open,
      closed: v.closed, closedMinutes: v.closed_minutes, troubledOrderTimes: v.troubled_order_times ?? [],
    }));
  });

  // Open tickets.
  await section(["complaint_high_priority"], async () => {
    type T = { id: string; number: number; subject: string; zone_id: string | null; priority: string; status: string; created_at: string; first_response_at: string | null };
    const res = await readAllRows<T>((from, to) =>
      supabase.from("support_tickets").select("id, number, subject, zone_id, priority, status, created_at, first_response_at")
        .not("status", "in", "(resolved,closed)").order("created_at").range(from, to) as unknown as PromiseLike<{ data: T[] | null; error: unknown }>
    );
    if (res.error) throw res.error;
    facts.tickets = res.data.map((t) => ({
      id: t.id, number: Number(t.number), subject: t.subject, zoneId: t.zone_id, priority: t.priority, status: t.status,
      createdAt: t.created_at, firstResponseAt: t.first_response_at,
    }));
  });

  // Money: the Finance screen's own issues, per zone.
  await section(["settlement_delayed", "rider_payout_issue"], async () => {
    for (const z of facts.zones) {
      for (const i of await financeIssuesForZone(z.id, now)) {
        facts.financeIssues.push({
          zoneId: z.id, type: i.type, severity: i.severity, subjectKind: i.subject.kind, subjectId: i.subject.id,
          subjectLabel: i.subject.label, detail: i.detail, amount: i.amount, since: i.since,
        });
      }
    }
  });

  // Cash: yesterday and the two days before, plus today (disputes).
  await section(["cash_discrepancy"], async () => {
    const today = istDayKey(now);
    type Day = { day: string; riderId: string; collected: number; deposited: number; disputed: boolean };
    const days: (Day & { zoneId: string })[] = [];
    for (const z of facts.zones) {
      const { data, error } = await supabase.rpc("ops_cash_reconciliation", {
        p_zone_ids: [z.id], p_from: addDays(today, -3), p_to: today, p_rider: null,
      });
      if (error) throw error;
      for (const d of ((data as { riders?: Day[] } | null)?.riders ?? [])) days.push({ ...d, zoneId: z.id });
    }
    const info = await loadRiderInfo(days.map((d) => d.riderId));
    facts.cashDays = days.map((d) => ({
      zoneId: d.zoneId, riderId: d.riderId, riderName: info.get(d.riderId)?.name ?? "Rider", day: d.day,
      collected: Number(d.collected), deposited: Number(d.deposited), disputed: d.disputed === true,
      hoursSinceDayEnd: (now.getTime() - istDayStart(addDays(d.day, 1)).getTime()) / 3_600_000,
    }));
  });

  // Marketing requests waiting for a decision.
  await section(["marketing_request_new"], async () => {
    type M = { id: string; number: number; title: string; restaurants: One<{ name: string | null; zone_id: string | null }> };
    const { data, error } = await supabase.from("marketing_requests")
      .select("id, number, title, restaurants!inner(name, zone_id)").eq("status", "pending").limit(1000);
    if (error) throw error;
    facts.marketingPending = ((data ?? []) as unknown as M[]).map((m) => ({
      id: m.id, number: Number(m.number), title: m.title, zoneId: one(m.restaurants)?.zone_id ?? null,
      vendorName: one(m.restaurants)?.name?.trim() || "A shop",
    }));
  });

  // Technical incidents (observability).
  await section(["incident"], async () => {
    type I = { id: number; short_id: string; title: string; severity: string };
    const { data, error } = await supabase.from("obs_incidents")
      .select("id, short_id, title, severity").not("status", "in", "(resolved,closed)").limit(100);
    if (error) throw error;
    facts.incidents = ((data ?? []) as I[]).map((i) => ({ id: Number(i.id), shortId: i.short_id, title: i.title, severity: i.severity }));
  });

  // A rider waiting for ops to decide.
  await section(["order_needs_intervention"], async () => {
    type X = { id: string; order_id: string; kind: string; created_at: string; orders: One<{ zone_id: string | null }> };
    const { data, error } = await supabase.from("delivery_exceptions")
      .select("id, order_id, kind, created_at, orders!inner(zone_id)").eq("status", "pending").limit(500);
    if (error) throw error;
    facts.exceptionsPending = ((data ?? []) as unknown as X[]).map((x) => ({
      id: x.id, orderId: x.order_id, orderCode: orderShortCode(x.order_id), zoneId: one(x.orders)?.zone_id ?? null,
      kindLabel: exceptionLabel(x.kind as ExceptionKind), createdAt: x.created_at,
    }));
  });

  return facts;
}
