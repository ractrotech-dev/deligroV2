/**
 * When the dispatch sweep tells a rider something nobody asked about (§11):
 * high demand, a pickup reminder, a delay alert. Pure — the sweep reads the
 * rows and asks these; the QA script runs them at their thresholds.
 *
 * The thresholds are admin settings (`platform_settings`, 0087):
 * `high_demand_ratio` (2.0), `pickup_reminder_minutes` (10) and
 * `delay_alert_minutes` (10). Each alert is sent once — the sweep stamps the
 * delivery (`pickup_reminded_at`, `delay_alerted_at`) conditionally before it
 * pushes — and these functions also refuse anything already stamped.
 */

const MINUTE = 60_000;

/** Below this many waiting orders it is never "high demand", whatever the ratio. */
export const HIGH_DEMAND_MIN_WAITING = 3;
/** Offline riders told about high demand: those online in the last N days. */
export const HIGH_DEMAND_LOOKBACK_DAYS = 14;
/** At most one high-demand push per rider in this many minutes. */
export const HIGH_DEMAND_REPEAT_MINUTES = 30;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

/**
 * Waiting orders per online idle rider at or above `ratio`, with at least
 * HIGH_DEMAND_MIN_WAITING waiting. Nobody idle and enough waiting is high
 * demand by definition.
 */
export function isHighDemand(input: { waitingOrders: number; idleOnlineRiders: number; ratio: number }): boolean {
  const { waitingOrders, idleOnlineRiders, ratio } = input;
  if (!(waitingOrders >= HIGH_DEMAND_MIN_WAITING)) return false;
  if (idleOnlineRiders <= 0) return true;
  return waitingOrders / idleOnlineRiders >= ratio;
}

/** Was the rider online within the look-back window? */
export function recentlyOnline(lastOnlineAt: string | null | undefined, now: Date, days = HIGH_DEMAND_LOOKBACK_DAYS): boolean {
  const at = ms(lastOnlineAt);
  return at !== null && now.getTime() - at <= days * 24 * 60 * MINUTE;
}

/**
 * An accepted delivery whose order is ready, the rider not at the shop yet,
 * `minutes` after the later of "ready" and "accepted" — a rider who took the
 * job a minute ago has not been slow. Once only.
 */
export function needsPickupReminder(input: {
  deliveryStatus: string;
  orderStatus: string;
  assignedAt: string | null;
  readyAt: string | null;
  arrivedPickupAt: string | null;
  remindedAt: string | null;
  now: Date;
  minutes: number;
}): boolean {
  if (input.deliveryStatus !== "assigned" || input.orderStatus !== "ready") return false;
  if (input.arrivedPickupAt || input.remindedAt) return false;
  const ready = ms(input.readyAt);
  const assigned = ms(input.assignedAt);
  if (ready === null || assigned === null) return false;
  return input.now.getTime() - Math.max(ready, assigned) >= input.minutes * MINUTE;
}

/** A picked-up delivery `minutes` past its ETA. Once only. */
export function needsDelayAlert(input: {
  deliveryStatus: string;
  etaAt: string | null;
  alertedAt: string | null;
  now: Date;
  minutes: number;
}): boolean {
  if (input.deliveryStatus !== "picked_up" || input.alertedAt) return false;
  const eta = ms(input.etaAt);
  if (eta === null) return false;
  return input.now.getTime() - eta >= input.minutes * MINUTE;
}

/** Whole minutes past the ETA, floored at 0. */
export function minutesPast(etaAt: string | null, now: Date): number {
  const eta = ms(etaAt);
  if (eta === null) return 0;
  return Math.max(0, Math.floor((now.getTime() - eta) / MINUTE));
}
