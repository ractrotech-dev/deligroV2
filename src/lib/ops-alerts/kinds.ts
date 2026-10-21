/**
 * Every operational alert a manager can receive — the client document's
 * fourteen-section list (§14), plus rider inactivity (§6.7) and the two from
 * §17 (fraud, SLA). The alert engine (Phase 8) raises them; notification
 * preferences (migration 0141) switch their pushes per person.
 *
 * Browser-safe: labels only.
 */
export const OPS_ALERT_KINDS = [
  { kind: "order_needs_intervention", en: "Orders needing intervention", hi: "जिन ऑर्डर पर ध्यान चाहिए" },
  { kind: "order_unassigned", en: "Unassigned orders", hi: "बिना राइडर के ऑर्डर" },
  { kind: "delivery_delayed", en: "Delayed deliveries", hi: "देर से डिलीवरी" },
  { kind: "high_cancellation_rate", en: "High cancellation rate", hi: "ज़्यादा कैंसलेशन" },
  { kind: "vendor_downtime", en: "Vendor downtime", hi: "वेंडर बंद" },
  { kind: "rider_shortage", en: "Rider shortage", hi: "राइडर की कमी" },
  { kind: "delivery_failed", en: "Failed deliveries", hi: "असफल डिलीवरी" },
  { kind: "settlement_delayed", en: "Vendor settlement delays", hi: "वेंडर भुगतान में देरी" },
  { kind: "rider_payout_issue", en: "Rider payout issues", hi: "राइडर भुगतान की समस्या" },
  { kind: "marketing_request_new", en: "New marketing requests", hi: "नए मार्केटिंग अनुरोध" },
  { kind: "complaint_high_priority", en: "High-priority complaints", hi: "ज़रूरी शिकायतें" },
  { kind: "cash_discrepancy", en: "Cash reconciliation discrepancies", hi: "नकद मिलान में अंतर" },
  { kind: "incident", en: "Technical or operational incidents", hi: "तकनीकी या संचालन घटनाएँ" },
  { kind: "rider_inactive", en: "Rider inactive on a delivery", hi: "डिलीवरी पर राइडर निष्क्रिय" },
  { kind: "fraud_suspected", en: "Unusual activity (fraud)", hi: "असामान्य गतिविधि" },
  { kind: "sla_breach", en: "Service-level breaches", hi: "सेवा-स्तर उल्लंघन" },
] as const;

export type OpsAlertKind = (typeof OPS_ALERT_KINDS)[number]["kind"];

export function isOpsAlertKind(value: unknown): value is OpsAlertKind {
  return typeof value === "string" && OPS_ALERT_KINDS.some((k) => k.kind === value);
}
