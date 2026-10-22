import { istDayKey, istHourWeekday } from "@/lib/metrics/ist";
import type { DbOrderStatus } from "@/lib/ops/order-contract";
import { ALERT_KINDS, effectiveRule, type AlertSeverity, type OpsAlertKind, type ResolvedRule } from "./catalog";

/**
 * The alert evaluator — pure. Facts in (already loaded and scoped by
 * facts.ts), the alerts that should be open out, one list per kind. The engine
 * raises each and clears whatever of that kind is no longer in the list.
 *
 * Minutes in the facts are measured from the moment something became due
 * (food due, the order placed, the promised time passed); a threshold is
 * compared with them directly. English only.
 */

export interface AlertOrderFact {
  id: string;
  code: string;
  zoneId: string | null;
  status: DbOrderStatus;
  vendorName: string;
  createdAt: string;
  /** The order's latest step (placed, accepted, ready, picked up). */
  lastChangeAt: string;
  /** A placed order: minutes since it could be accepted (COD at once, online once paid). */
  acceptWaitMinutes: number | null;
  /** No rider: minutes since the food was due (negative or null = not yet). */
  unassignedMinutes: number | null;
  /** Minutes past the delivery promise. */
  lateByMinutes: number | null;
  hasRider: boolean;
}

export interface AlertFacts {
  now: Date;
  zones: { id: string; name: string }[];
  /** Active (not delivered, not cancelled) counted orders. */
  orders: AlertOrderFact[];
  /** Orders created in the last day (for cancellation rates). */
  recentOrders: { zoneId: string | null; status: string; createdAt: string }[];
  /** Deliveries that failed in the last two hours. */
  failed: { deliveryId: string; orderId: string; orderCode: string; zoneId: string | null; vendorName: string; riderName: string | null }[];
  /** Riders online or carrying an order. */
  riders: { id: string; zoneIds: string[]; online: boolean; onBreak: boolean; activeDeliveries: number }[];
  /** Riders on an active delivery whose last fix is old (Phase 3 signal). */
  inactive: { riderId: string; riderName: string; orderId: string; orderCode: string; zoneId: string | null; minutes: number }[];
  vendors: {
    id: string;
    name: string;
    zoneId: string | null;
    /** Inside the shop's own opening hours (not a holiday or weekly off). */
    scheduledOpen: boolean;
    /** Switched off, or "closed for a while". */
    closed: boolean;
    /** Minutes since the shop's availability last changed; null = unknown. */
    closedMinutes: number | null;
    /** When orders the shop left unaccepted, or cancelled itself, were placed (last day). */
    troubledOrderTimes: string[];
  }[];
  /** Open tickets (not resolved, not closed). */
  tickets: { id: string; number: number; subject: string; zoneId: string | null; priority: string; status: string; createdAt: string; firstResponseAt: string | null }[];
  financeIssues: {
    zoneId: string | null;
    type: string;
    severity: "warning" | "critical";
    subjectKind: string;
    subjectId: string;
    subjectLabel: string;
    detail: string | null;
    amount: number | null;
    since: string;
  }[];
  cashDays: {
    zoneId: string | null;
    riderId: string;
    riderName: string;
    day: string;
    collected: number;
    deposited: number;
    disputed: boolean;
    /** Hours since that IST day ended (negative for today). */
    hoursSinceDayEnd: number;
  }[];
  marketingPending: { id: string; number: number; zoneId: string | null; title: string; vendorName: string }[];
  incidents: { id: number; shortId: string; title: string; severity: string }[];
  exceptionsPending: { id: string; orderId: string; orderCode: string; zoneId: string | null; kindLabel: string; createdAt: string }[];
}

export interface DesiredAlert {
  kind: OpsAlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  zoneId: string | null;
  entity: { type: string; id: string };
  dedupeKey: string;
}

/** An order that has not moved for this long is stuck, whatever the thresholds. */
export const STUCK_MINUTES = 180;

export function emptyFacts(now: Date): AlertFacts {
  return {
    now, zones: [], orders: [], recentOrders: [], failed: [], riders: [], inactive: [], vendors: [], tickets: [],
    financeIssues: [], cashDays: [], marketingPending: [], incidents: [], exceptionsPending: [],
  };
}

const minutesSince = (iso: string, now: Date) => Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One builder per kind, shared with the event hooks so keys and text never differ. */
export const alertFor = {
  deliveryFailed(f: AlertFacts["failed"][number]): DesiredAlert {
    return {
      kind: "delivery_failed", severity: "critical", zoneId: f.zoneId,
      title: `Delivery failed — order ${f.orderCode}`,
      body: `${f.riderName?.trim() || "The rider"} could not deliver the order from ${f.vendorName}. Decide the refund or a new attempt.`,
      entity: { type: "order", id: f.orderId }, dedupeKey: `delivery_failed:${f.deliveryId}`,
    };
  },
  marketing(r: AlertFacts["marketingPending"][number]): DesiredAlert {
    return {
      kind: "marketing_request_new", severity: "info", zoneId: r.zoneId,
      title: `Marketing request #${r.number} from ${r.vendorName}`,
      body: `“${r.title}” is waiting for a decision.`,
      entity: { type: "marketing_request", id: r.id }, dedupeKey: `marketing_request_new:${r.id}`,
    };
  },
  ticket(t: AlertFacts["tickets"][number], thresholdMinutes: number, now: Date): DesiredAlert | null {
    if (t.status === "resolved" || t.status === "closed") return null;
    const urgent = t.priority === "high" || t.priority === "emergency";
    const unanswered = !t.firstResponseAt && minutesSince(t.createdAt, now) >= thresholdMinutes;
    if (!urgent && !unanswered) return null;
    const severity: AlertSeverity = t.priority === "emergency" ? "critical" : "warning";
    const why = t.priority === "emergency" ? "Emergency ticket" : t.priority === "high" ? "High-priority ticket" : "Ticket without a reply";
    return {
      kind: "complaint_high_priority", severity, zoneId: t.zoneId,
      title: `${why} #${t.number}`,
      body: unanswered
        ? `“${t.subject}” has had no reply for ${minutesSince(t.createdAt, now)} min.`
        : `“${t.subject}” is ${t.status.replace(/_/g, " ")}.`,
      entity: { type: "ticket", id: t.id }, dedupeKey: `complaint_high_priority:${t.id}`,
    };
  },
  cash(d: AlertFacts["cashDays"][number], threshold: number, windowMinutes: number): DesiredAlert | null {
    const gap = d.collected - d.deposited;
    if (!d.disputed && !(gap >= threshold && d.hoursSinceDayEnd >= windowMinutes / 60)) return null;
    return {
      kind: "cash_discrepancy", severity: d.disputed ? "critical" : "warning", zoneId: d.zoneId,
      title: d.disputed ? `Cash dispute — ${d.riderName}, ${d.day}` : `Cash not deposited — ${d.riderName}, ${d.day}`,
      body: `Collected ${rupees(d.collected)}, deposited ${rupees(d.deposited)}${d.disputed ? "; the day is disputed." : "."}`,
      entity: { type: "cash_day", id: `${d.riderId}:${d.day}` }, dedupeKey: `cash_discrepancy:${d.riderId}:${d.day}`,
    };
  },
  incident(i: AlertFacts["incidents"][number]): DesiredAlert {
    return {
      kind: "incident", severity: i.severity === "critical" || i.severity === "high" ? "critical" : "warning", zoneId: null,
      title: `Incident ${i.shortId}: ${i.title}`, body: "A technical incident is open. Check the status before promising times to customers.",
      entity: { type: "incident", id: `obs:${i.id}` }, dedupeKey: `incident:obs:${i.id}`,
    };
  },
};

function bySeverity(minutes: number, threshold: number, criticalFactor = 3): AlertSeverity | null {
  if (minutes < threshold) return null;
  return minutes >= threshold * criticalFactor ? "critical" : "warning";
}

/** The alerts that should be open now, per kind (only enabled, sweep-evaluated kinds appear). */
export function evaluate(facts: AlertFacts, rules: readonly ResolvedRule[]): Map<OpsAlertKind, DesiredAlert[]> {
  const out = new Map<OpsAlertKind, DesiredAlert[]>();
  const now = facts.now;
  const swept = ALERT_KINDS.filter((k) => k.evaluated === "sweep" || k.evaluated === "both");
  for (const k of swept) out.set(k.kind, []);
  const rule = (kind: OpsAlertKind, zoneId: string | null) => effectiveRule(rules, kind, zoneId);
  const push = (a: DesiredAlert | null) => {
    if (!a) return;
    const r = rule(a.kind, a.zoneId);
    if (!r.enabled) return;
    out.get(a.kind)?.push(a);
  };
  const zoneName = (id: string | null) => facts.zones.find((z) => z.id === id)?.name ?? "the zone";

  for (const o of facts.orders) {
    // §14.1 — the kitchen has not accepted.
    if (o.status === "placed" && o.acceptWaitMinutes !== null) {
      const t = rule("order_needs_intervention", o.zoneId).threshold ?? 5;
      const severity = bySeverity(o.acceptWaitMinutes, t);
      if (severity) push({
        kind: "order_needs_intervention", severity, zoneId: o.zoneId,
        title: `Order ${o.code} not accepted`,
        body: `${o.vendorName} has not accepted it for ${o.acceptWaitMinutes} min. Call the shop.`,
        entity: { type: "order", id: o.id }, dedupeKey: `order_needs_intervention:accept:${o.id}`,
      });
    }
    // An order that has not moved for hours.
    if (minutesSince(o.lastChangeAt, now) >= STUCK_MINUTES) {
      const hours = Math.floor(minutesSince(o.lastChangeAt, now) / 60);
      push({
        kind: "order_needs_intervention", severity: "warning", zoneId: o.zoneId,
        title: `Order ${o.code} stuck`,
        body: `It has been ${o.status.replace(/_/g, " ")} for ${hours} h at ${o.vendorName}. Deliver or cancel it.`,
        entity: { type: "order", id: o.id }, dedupeKey: `order_needs_intervention:stuck:${o.id}`,
      });
    }
    // §14.2 — no rider once the food is due.
    if (!o.hasRider && o.unassignedMinutes !== null) {
      const t = rule("order_unassigned", o.zoneId).threshold ?? 5;
      const severity = bySeverity(o.unassignedMinutes, t);
      if (severity) push({
        kind: "order_unassigned", severity, zoneId: o.zoneId,
        title: `Order ${o.code} has no rider`,
        body: `Food due ${o.unassignedMinutes} min ago at ${o.vendorName}. Assign a rider.`,
        entity: { type: "order", id: o.id }, dedupeKey: `order_unassigned:${o.id}`,
      });
    }
    // §14.3 — past the delivery promise.
    if (o.lateByMinutes !== null) {
      const t = rule("delivery_delayed", o.zoneId).threshold ?? 10;
      const severity = bySeverity(o.lateByMinutes, t);
      if (severity) push({
        kind: "delivery_delayed", severity, zoneId: o.zoneId,
        title: `Order ${o.code} running late`,
        body: `${o.lateByMinutes} min past its delivery time (${o.vendorName}).`,
        entity: { type: "order", id: o.id }, dedupeKey: `delivery_delayed:${o.id}`,
      });
    }
  }

  // A rider's request waiting for a decision (§14.1).
  for (const x of facts.exceptionsPending) {
    const t = rule("order_needs_intervention", x.zoneId).threshold ?? 5;
    const waited = minutesSince(x.createdAt, now);
    const severity = bySeverity(waited, t);
    if (severity) push({
      kind: "order_needs_intervention", severity, zoneId: x.zoneId,
      title: `Rider waiting for a decision — order ${x.orderCode}`,
      body: `${x.kindLabel}, asked ${waited} min ago.`,
      entity: { type: "order", id: x.orderId }, dedupeKey: `order_needs_intervention:exception:${x.id}`,
    });
  }

  // §14.4 — cancellation rate per zone over its window.
  const hourKey = `${istDayKey(now)}-${String(istHourWeekday(now).hour).padStart(2, "0")}`;
  for (const z of facts.zones) {
    const r = rule("high_cancellation_rate", z.id);
    const window = r.windowMinutes ?? 60;
    const inWindow = facts.recentOrders.filter((o) => o.zoneId === z.id && minutesSince(o.createdAt, now) <= window);
    const placed = inWindow.length;
    if (placed < 5) continue;
    const cancelled = inWindow.filter((o) => o.status === "cancelled").length;
    const pct = (cancelled / placed) * 100;
    const t = r.threshold ?? 20;
    if (pct < t) continue;
    push({
      kind: "high_cancellation_rate", severity: pct >= t * 2 ? "critical" : "warning", zoneId: z.id,
      title: `High cancellations in ${z.name}`,
      body: `${cancelled} of ${placed} orders (${Math.round(pct)}%) cancelled in the last ${window} min.`,
      entity: { type: "zone", id: z.id }, dedupeKey: `high_cancellation_rate:${z.id}:${hourKey}`,
    });
  }

  // §14.5 — a shop down in its own hours.
  for (const v of facts.vendors) {
    const r = rule("vendor_downtime", v.zoneId);
    const t = r.threshold ?? 30;
    const window = r.windowMinutes ?? 60;
    const closedLong = v.scheduledOpen && v.closed && v.closedMinutes !== null && v.closedMinutes >= t;
    const troubled = v.troubledOrderTimes.filter((at) => minutesSince(at, now) <= window).length;
    if (!closedLong && troubled < 2) continue;
    push({
      kind: "vendor_downtime", severity: "warning", zoneId: v.zoneId,
      title: `${v.name} may be down`,
      body: closedLong
        ? `Closed for ${v.closedMinutes} min during its opening hours.`
        : `${plural(troubled, "order")} left unaccepted or cancelled by the shop in the last ${window} min.`,
      entity: { type: "restaurant", id: v.id }, dedupeKey: `vendor_downtime:${v.id}:${istDayKey(now)}`,
    });
  }

  // §14.6 — riders short per zone.
  for (const z of facts.zones) {
    const waiting = facts.orders.filter((o) => o.zoneId === z.id && !o.hasRider && o.unassignedMinutes !== null && o.unassignedMinutes >= 0).length;
    const active = facts.orders.filter((o) => o.zoneId === z.id).length;
    const zoneRiders = facts.riders.filter((r) => r.zoneIds.includes(z.id) && r.online);
    const idle = zoneRiders.filter((r) => !r.onBreak && r.activeDeliveries === 0).length;
    const t = rule("rider_shortage", z.id).threshold ?? 2;
    if (zoneRiders.length === 0 && active > 0) {
      push({
        kind: "rider_shortage", severity: "critical", zoneId: z.id,
        title: `No riders online in ${zoneName(z.id)}`,
        body: `${plural(active, "active order")} and nobody online to deliver.`,
        entity: { type: "zone", id: z.id }, dedupeKey: `rider_shortage:${z.id}`,
      });
      continue;
    }
    if (waiting === 0) continue;
    const ratio = waiting / Math.max(1, idle);
    if (ratio < t) continue;
    push({
      kind: "rider_shortage", severity: "warning", zoneId: z.id,
      title: `Rider shortage in ${zoneName(z.id)}`,
      body: `${plural(waiting, "order")} waiting for ${plural(idle, "idle rider")}.`,
      entity: { type: "zone", id: z.id }, dedupeKey: `rider_shortage:${z.id}`,
    });
  }

  // §14.7 / §6.8 — failed deliveries.
  for (const f of facts.failed) push(alertFor.deliveryFailed(f));

  // §14.8 / §14.9 — money (the Finance screen's own lines).
  for (const i of facts.financeIssues) {
    if (i.type === "settlement_delayed") {
      push({
        kind: "settlement_delayed", severity: i.severity, zoneId: i.zoneId,
        title: `Settlement late — ${i.subjectLabel}`,
        body: `${i.detail ?? "Unsettled orders past the cycle"}${i.amount !== null ? `; ${rupees(i.amount)} owed` : ""}.`,
        entity: { type: "restaurant", id: i.subjectId }, dedupeKey: `settlement_delayed:${i.subjectId}`,
      });
    } else if (i.type === "rider_payout_delayed") {
      push({
        kind: "rider_payout_issue", severity: i.severity, zoneId: i.zoneId,
        title: `Rider pay overdue — ${i.subjectLabel}`,
        body: `${i.detail ?? "Unpaid ledger items"}${i.amount !== null ? `; ${rupees(i.amount)} unpaid` : ""}.`,
        entity: { type: "rider", id: i.subjectId }, dedupeKey: `rider_payout_issue:${i.subjectId}`,
      });
    } else if (i.type === "approval_overdue") {
      const vendor = /vendor/i.test(i.subjectLabel);
      push({
        kind: vendor ? "settlement_delayed" : "rider_payout_issue", severity: i.severity, zoneId: i.zoneId,
        title: `${vendor ? "Vendor settlement" : "Rider payout"} waiting for approval`,
        body: `A payment request${i.amount !== null ? ` for ${rupees(i.amount)}` : ""} has waited over 48 hours for its second approver.`,
        entity: { type: "payment_request", id: i.subjectId },
        dedupeKey: `${vendor ? "settlement_delayed" : "rider_payout_issue"}:req:${i.subjectId}`,
      });
    }
  }

  // §14.12 — cash.
  for (const d of facts.cashDays) {
    const r = rule("cash_discrepancy", d.zoneId);
    push(alertFor.cash(d, r.threshold ?? 500, r.windowMinutes ?? 720));
  }

  // §14.10, §14.11, §14.13.
  for (const r of facts.marketingPending) push(alertFor.marketing(r));
  for (const t of facts.tickets) push(alertFor.ticket(t, rule("complaint_high_priority", t.zoneId).threshold ?? 30, now));
  for (const i of facts.incidents) push(alertFor.incident(i));

  // §6.7 — a rider gone quiet on an active delivery.
  for (const r of facts.inactive) {
    const t = rule("rider_inactive", r.zoneId).threshold ?? 5;
    if (r.minutes < t) continue;
    push({
      kind: "rider_inactive", severity: "warning", zoneId: r.zoneId,
      title: `${r.riderName} has gone quiet`,
      body: `No location for ${r.minutes} min while carrying order ${r.orderCode}. Call the rider.`,
      entity: { type: "rider", id: r.riderId }, dedupeKey: `rider_inactive:${r.riderId}:${r.orderId}`,
    });
  }

  return out;
}
