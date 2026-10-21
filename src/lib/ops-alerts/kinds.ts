/**
 * Every operational alert a manager can receive — the client document's
 * fourteen-section list (§14), plus rider inactivity (§6.7) and the two from
 * §17 (fraud, SLA). The alert engine (Phase 8) raises them; notification
 * preferences (migration 0141) switch their pushes per person.
 *
 * Browser-safe: labels only. English only — the manager side has no Hindi
 * (owner, 2026-10-21).
 */
export const OPS_ALERT_KINDS = [
  { kind: "order_needs_intervention", en: "Orders needing intervention" },
  { kind: "order_unassigned", en: "Unassigned orders" },
  { kind: "delivery_delayed", en: "Delayed deliveries" },
  { kind: "high_cancellation_rate", en: "High cancellation rate" },
  { kind: "vendor_downtime", en: "Vendor downtime" },
  { kind: "rider_shortage", en: "Rider shortage" },
  { kind: "delivery_failed", en: "Failed deliveries" },
  { kind: "settlement_delayed", en: "Vendor settlement delays" },
  { kind: "rider_payout_issue", en: "Rider payout issues" },
  { kind: "marketing_request_new", en: "New marketing requests" },
  { kind: "complaint_high_priority", en: "High-priority complaints" },
  { kind: "cash_discrepancy", en: "Cash reconciliation discrepancies" },
  { kind: "incident", en: "Technical or operational incidents" },
  { kind: "rider_inactive", en: "Rider inactive on a delivery" },
  { kind: "fraud_suspected", en: "Unusual activity (fraud)" },
  { kind: "sla_breach", en: "Service-level breaches" },
] as const;

export type OpsAlertKind = (typeof OPS_ALERT_KINDS)[number]["kind"];

export function isOpsAlertKind(value: unknown): value is OpsAlertKind {
  return typeof value === "string" && OPS_ALERT_KINDS.some((k) => k.kind === value);
}
