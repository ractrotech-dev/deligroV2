/**
 * Rider counting and rate functions over plain rows — the Rider plan's
 * `figures.ts` (rider phase 4), created here first for the Manager app's rider
 * screens; the Rider app's dashboard, history and performance use the same
 * definitions, so a rider and their manager never see different numbers.
 *
 * Pure, no I/O: scripts/qa/manager-riders.ts exercises it under tsx.
 *
 *   acceptanceRate = accepted ÷ offered            (delivery_events)
 *   failedRate     = failed ÷ (delivered + failed)
 *   avgDeliverMin  = mean accepted → delivered
 *   onlineHours    = rider_shifts overlap with the window (an open shift to now)
 *   months         = IST calendar months
 */

export type HistoryOutcome = "delivered" | "failed" | "cancelled" | "reassigned";

/** A ratio, or null when there is nothing to divide by (never 0/0 = 0). */
export function rate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function failedRate(c: { delivered: number; failed: number }): number | null {
  return rate(c.failed, c.delivered + c.failed);
}

/**
 * How a delivery ended for THIS rider. A `reassigned` event naming the rider
 * (they lost the job) wins: whatever happened to the order afterwards happened
 * to somebody else's delivery.
 */
export function historyOutcome(r: { deliveryStatus: string; orderStatus: string; reassignedAway: boolean }): HistoryOutcome {
  if (r.reassignedAway) return "reassigned";
  if (r.deliveryStatus === "delivered") return "delivered";
  if (r.deliveryStatus === "failed") return "failed";
  return "cancelled";
}

/** Mean minutes between pairs of instants; pairs missing either end are skipped. */
export function avgMinutes(pairs: { from: string | null; to: string | null }[]): number | null {
  let sum = 0;
  let n = 0;
  for (const p of pairs) {
    if (!p.from || !p.to) continue;
    const a = Date.parse(p.from);
    const b = Date.parse(p.to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    sum += (b - a) / 60_000;
    n += 1;
  }
  return n === 0 ? null : Math.round((sum / n) * 10) / 10;
}

/** Hours of the shifts that fall inside [from, now]; an open shift runs to now. */
export function onlineHours(shifts: { startedAt: string; endedAt: string | null }[], from: Date, now: Date): number {
  let ms = 0;
  for (const s of shifts) {
    const start = Math.max(Date.parse(s.startedAt), from.getTime());
    const end = Math.min(s.endedAt ? Date.parse(s.endedAt) : now.getTime(), now.getTime());
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) ms += end - start;
  }
  return Math.round((ms / 3_600_000) * 10) / 10;
}

const IST_OFFSET_MS = 330 * 60_000;

/** "YYYY-MM" of an instant in India time. */
export function istMonth(iso: string): string {
  return new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 7);
}

/** "YYYY-MM-DD" of an instant in India time. */
export function istDay(iso: string | Date): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export interface FigureDelivery {
  outcome: HistoryOutcome;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  endedAt: string;
}

export interface FigureEvent {
  kind: "offered" | "accepted" | string;
  at: string;
}

export interface PerformanceBlock {
  delivered: number;
  failed: number;
  cancelled: number;
  acceptanceRate: number | null;
  avgDeliverMinutes: number | null;
  avgPickupToDeliverMinutes: number | null;
  failedRate: number | null;
  onlineHours: number;
}

/** The figures over one window. `events` are this rider's offered/accepted events in it. */
export function performanceOf(
  deliveries: FigureDelivery[],
  events: FigureEvent[],
  shifts: { startedAt: string; endedAt: string | null }[],
  from: Date,
  now: Date
): PerformanceBlock {
  const delivered = deliveries.filter((d) => d.outcome === "delivered");
  const failed = deliveries.filter((d) => d.outcome === "failed").length;
  const cancelled = deliveries.filter((d) => d.outcome === "cancelled").length;
  const offered = events.filter((e) => e.kind === "offered").length;
  const accepted = events.filter((e) => e.kind === "accepted").length;
  return {
    delivered: delivered.length,
    failed,
    cancelled,
    acceptanceRate: rate(accepted, offered),
    avgDeliverMinutes: avgMinutes(delivered.map((d) => ({ from: d.acceptedAt, to: d.deliveredAt }))),
    avgPickupToDeliverMinutes: avgMinutes(delivered.map((d) => ({ from: d.pickedUpAt, to: d.deliveredAt }))),
    failedRate: failedRate({ delivered: delivered.length, failed }),
    onlineHours: onlineHours(shifts, from, now),
  };
}

export interface MonthRow {
  month: string;
  delivered: number;
  failed: number;
  cancelled: number;
  acceptanceRate: number | null;
  avgDeliverMin: number | null;
  onlineHours: number;
}

/** One row per IST month present in the data, newest first. */
export function monthsOf(
  deliveries: FigureDelivery[],
  events: FigureEvent[],
  shifts: { startedAt: string; endedAt: string | null }[],
  now: Date
): MonthRow[] {
  const months = new Set<string>([
    ...deliveries.map((d) => istMonth(d.endedAt)),
    ...events.map((e) => istMonth(e.at)),
    ...shifts.map((s) => istMonth(s.startedAt)),
  ]);
  return [...months]
    .sort((a, b) => (a < b ? 1 : -1))
    .map((month) => {
      const inMonth = <T,>(rows: T[], at: (r: T) => string) => rows.filter((r) => istMonth(at(r)) === month);
      const ds = inMonth(deliveries, (d) => d.endedAt);
      const es = inMonth(events, (e) => e.at);
      // Month bounds in UTC for the shift overlap: IST month start = UTC − 5:30.
      const [y, m] = month.split("-").map(Number);
      const start = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);
      const end = new Date(Math.min(Date.UTC(y, m, 1) - IST_OFFSET_MS, now.getTime()));
      const block = performanceOf(ds, es, shifts, start, end);
      return {
        month,
        delivered: block.delivered,
        failed: block.failed,
        cancelled: block.cancelled,
        acceptanceRate: block.acceptanceRate,
        avgDeliverMin: block.avgDeliverMinutes,
        onlineHours: block.onlineHours,
      };
    });
}
