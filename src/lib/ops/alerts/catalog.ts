import type { FeatureKey } from "@/lib/features/catalog";
import { OPS_ALERT_KINDS, type OpsAlertKind } from "@/lib/ops-alerts/kinds";

/**
 * The alert kinds (§14 1–13, §6.7, and §17's two that Phase 9 switches on) —
 * what each measures, in what unit, its platform default, who may receive it
 * and how it is evaluated. The database seeds the same defaults (0166) and its
 * `_ops_alert_unit()` repeats the units; scripts/qa/manager-alerts.ts holds the
 * two equal.
 *
 * Browser-safe. English only (owner's rule for the manager side).
 */

export type { OpsAlertKind };
export type AlertUnit = "minutes" | "percent" | "ratio" | "rupees" | "none";
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertKindDef {
  kind: OpsAlertKind;
  label: string;
  description: string;
  unit: AlertUnit;
  defaultThreshold: number | null;
  defaultWindowMinutes: number | null;
  /** A manager also needs this switch to receive or see the alert. */
  audiencePermission?: FeatureKey;
  /** Can a person switch its push off? (Incidents and emergency complaints cannot.) */
  mutable: boolean;
  /** "sweep": the evaluator raises and clears it; "event": raised where it happens; "phase9": not yet. */
  evaluated: "sweep" | "event" | "both" | "phase9";
  /**
   * Must not vanish by itself: an alert nobody has acknowledged stays open even
   * after its facts leave the window the evaluator reads (a failed delivery, a
   * cash gap); the sweep only clears it once someone has acknowledged it.
   */
  sticky?: boolean;
}

const label = (kind: OpsAlertKind) => OPS_ALERT_KINDS.find((k) => k.kind === kind)?.en ?? kind;

export const ALERT_KINDS: readonly AlertKindDef[] = [
  { kind: "order_needs_intervention", label: label("order_needs_intervention"), unit: "minutes", defaultThreshold: 5, defaultWindowMinutes: null, mutable: true, evaluated: "sweep",
    description: "A placed order the kitchen has not accepted, a rider's request waiting for a decision, or an order that has not moved for three times as long." },
  { kind: "order_unassigned", label: label("order_unassigned"), unit: "minutes", defaultThreshold: 5, defaultWindowMinutes: null, mutable: true, evaluated: "sweep",
    description: "Food is due or ready and no rider has the order." },
  { kind: "delivery_delayed", label: label("delivery_delayed"), unit: "minutes", defaultThreshold: 10, defaultWindowMinutes: null, mutable: true, evaluated: "sweep",
    description: "An order is past its promised delivery time." },
  { kind: "high_cancellation_rate", label: label("high_cancellation_rate"), unit: "percent", defaultThreshold: 20, defaultWindowMinutes: 60, mutable: true, evaluated: "sweep",
    description: "The share of the zone's orders cancelled in the window, once at least five were placed." },
  { kind: "vendor_downtime", label: label("vendor_downtime"), unit: "minutes", defaultThreshold: 30, defaultWindowMinutes: 60, mutable: true, evaluated: "sweep",
    description: "A shop closed during its own opening hours, or leaving two or more orders unaccepted or cancelled in the window." },
  { kind: "rider_shortage", label: label("rider_shortage"), unit: "ratio", defaultThreshold: 2, defaultWindowMinutes: null, mutable: true, evaluated: "sweep",
    description: "Orders without a rider for every idle online rider, or no riders online while orders are active." },
  { kind: "delivery_failed", label: label("delivery_failed"), unit: "none", defaultThreshold: null, defaultWindowMinutes: null, mutable: true, evaluated: "both", sticky: true,
    description: "A delivery was marked failed." },
  { kind: "settlement_delayed", label: label("settlement_delayed"), unit: "none", defaultThreshold: null, defaultWindowMinutes: null, audiencePermission: "manager.finance.view", mutable: true, evaluated: "sweep",
    description: "A shop is owed money past its settlement cycle plus three days, or a settlement has waited over 48 hours for approval." },
  { kind: "rider_payout_issue", label: label("rider_payout_issue"), unit: "none", defaultThreshold: null, defaultWindowMinutes: null, audiencePermission: "manager.finance.view", mutable: true, evaluated: "sweep",
    description: "A rider has unpaid ledger items older than 35 days, or a payout has waited over 48 hours for approval." },
  { kind: "marketing_request_new", label: label("marketing_request_new"), unit: "none", defaultThreshold: null, defaultWindowMinutes: null, audiencePermission: "manager.marketing.manage", mutable: true, evaluated: "both",
    description: "A shop sent a marketing request that is waiting for a decision." },
  { kind: "complaint_high_priority", label: label("complaint_high_priority"), unit: "minutes", defaultThreshold: 30, defaultWindowMinutes: null, audiencePermission: "manager.support.manage", mutable: false, evaluated: "both",
    description: "A high-priority or emergency ticket is open, or any ticket has had no reply for longer than the threshold." },
  { kind: "cash_discrepancy", label: label("cash_discrepancy"), unit: "rupees", defaultThreshold: 500, defaultWindowMinutes: 720, audiencePermission: "manager.finance.view", mutable: true, evaluated: "both", sticky: true,
    description: "A rider's cash collected and deposited differ by at least the threshold for longer than the window, or the day is disputed." },
  { kind: "incident", label: label("incident"), unit: "none", defaultThreshold: null, defaultWindowMinutes: null, mutable: false, evaluated: "both",
    description: "A technical incident is open, or a manager raised an operational one." },
  { kind: "rider_inactive", label: label("rider_inactive"), unit: "minutes", defaultThreshold: 5, defaultWindowMinutes: null, mutable: true, evaluated: "sweep",
    description: "A rider on an active delivery has sent no location for longer than the threshold." },
  { kind: "fraud_suspected", label: label("fraud_suspected"), unit: "none", defaultThreshold: null, defaultWindowMinutes: null, mutable: true, evaluated: "phase9",
    description: "Unusual activity (Phase 9)." },
  { kind: "sla_breach", label: label("sla_breach"), unit: "none", defaultThreshold: null, defaultWindowMinutes: null, mutable: true, evaluated: "phase9",
    description: "A service-level target missed (Phase 9)." },
];

export function alertKindDef(kind: OpsAlertKind): AlertKindDef {
  const d = ALERT_KINDS.find((k) => k.kind === kind);
  if (!d) throw new Error(`unknown alert kind ${kind}`);
  return d;
}

/** Threshold bounds per unit (the database enforces the same in ops_set_alert_rule). */
export const THRESHOLD_BOUNDS: Record<Exclude<AlertUnit, "none">, { min: number; max: number }> = {
  minutes: { min: 1, max: 1440 },
  percent: { min: 1, max: 100 },
  ratio: { min: 0.5, max: 20 },
  rupees: { min: 50, max: 100000 },
};

export interface ResolvedRule {
  kind: OpsAlertKind;
  zoneId: string | null;
  enabled: boolean;
  threshold: number | null;
  windowMinutes: number | null;
}

/** The rule in force for a kind in a zone: the zone's own row, else the platform default, else the catalog. */
export function effectiveRule(rules: readonly ResolvedRule[], kind: OpsAlertKind, zoneId: string | null): ResolvedRule {
  const own = zoneId ? rules.find((r) => r.kind === kind && r.zoneId === zoneId) : undefined;
  const platform = rules.find((r) => r.kind === kind && r.zoneId === null);
  if (own) return own;
  if (platform) return { ...platform, zoneId };
  const d = alertKindDef(kind);
  return { kind, zoneId, enabled: d.evaluated !== "phase9", threshold: d.defaultThreshold, windowMinutes: d.defaultWindowMinutes };
}
