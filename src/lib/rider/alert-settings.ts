/**
 * Admin → Settings → Riders: the three alert thresholds (0087), parsed.
 *
 *   high_demand_ratio        waiting orders per online idle rider that counts
 *                            as high demand, 0.5–20 (two decimals)
 *   pickup_reminder_minutes  minutes an order may sit ready before the rider
 *                            is reminded, 2–60
 *   delay_alert_minutes      minutes past the ETA before rider and ops are
 *                            told, 2–60
 *
 * The bounds are 0087's CHECKs. Each field is read only when the form posted
 * it, so a client that omits one never rewrites the stored value; junk keeps
 * the stored value; out-of-range is clamped to the bound (the same rule as the
 * other rider settings). Pure, so the QA script runs it bare.
 */

export const ALERT_BOUNDS = {
  highDemandRatio: { min: 0.5, max: 20 },
  pickupReminderMinutes: { min: 2, max: 60 },
  delayAlertMinutes: { min: 2, max: 60 },
} as const;

export interface AlertThresholds {
  highDemandRatio: number;
  pickupReminderMinutes: number;
  delayAlertMinutes: number;
}

function read(form: FormData, name: string): number | null {
  if (!form.has(name)) return null;
  const raw = form.get(name);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function parseAlertThresholds(form: FormData, current: AlertThresholds): AlertThresholds {
  const ratio = read(form, "highDemandRatio");
  const reminder = read(form, "pickupReminderMinutes");
  const delay = read(form, "delayAlertMinutes");
  const b = ALERT_BOUNDS;
  return {
    highDemandRatio:
      ratio === null
        ? current.highDemandRatio
        : Math.round(clamp(ratio, b.highDemandRatio.min, b.highDemandRatio.max) * 100) / 100,
    pickupReminderMinutes:
      reminder === null
        ? current.pickupReminderMinutes
        : clamp(Math.round(reminder), b.pickupReminderMinutes.min, b.pickupReminderMinutes.max),
    delayAlertMinutes:
      delay === null ? current.delayAlertMinutes : clamp(Math.round(delay), b.delayAlertMinutes.min, b.delayAlertMinutes.max),
  };
}
