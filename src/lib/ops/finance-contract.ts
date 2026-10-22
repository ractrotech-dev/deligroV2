/**
 * The Finance API's pinned shapes (Phase 6 plan, "API contract") and the pure
 * parsing and serialising around them. No queries.
 *
 * Money: whole rupees for orders and settlements; rider ledger money carries
 * up to 2 decimals. Dates: IST calendar days "YYYY-MM-DD", inclusive.
 */
import { isDayKey, istDayKey, addDays, rangeLength, type DateRange } from "@/lib/metrics";
import { MAX_RANGE_DAYS } from "@/lib/manager/stats-query";
import { isUuid } from "@/lib/auth/manager-scope";
import type { FinanceIssueType, ReconciliationState } from "@/lib/ops/finance-rules";
import type { PaymentRequest } from "@/lib/ops/rider-contract";

export interface Ref { id: string; name: string }

export interface FinanceFilters {
  from: string;
  to: string;
  zone: Ref | null;
}

export interface SettlementSummary {
  id: string;
  vendor: Ref;
  zone: Ref | null;
  kind: "batch" | "instant";
  status: "draft" | "paid" | "void";
  periodStart: string;
  periodEnd: string;
  orders: number;
  foodGross: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  refundsRecovered: number;
  netPayable: number;
  paymentRef: string | null;
  paidAt: string | null;
  paidBy: Ref | null;
  createdAt: string;
  createdBy: Ref | null;
  request: { id: string; status: PaymentRequest["status"] } | null;
}

export interface SettlementLine {
  orderId: string;
  orderCode: string;
  placedAt: string;
  paymentMethod: "cod" | "online" | null;
  orderTotal: number;
  deliveryFee: number;
  foodGross: number;
  commission: number;
  commissionGst: number;
  otherCharges: number;
  refundRecovered: number;
  vendorNet: number;
  contribution: number;
}

export interface SettlementCorrection {
  id: string;
  orderCode: string;
  amount: number;
  reason: string | null;
  status: "outstanding" | "applied" | "voided";
  originalSettlementId: string;
  appliedSettlementId: string | null;
  createdAt: string;
}

export interface VendorDue {
  vendor: Ref;
  zone: Ref | null;
  cycle: "weekly" | "monthly";
  unsettledOrders: number;
  oldestUnsettledAt: string | null;
  payable: number;
  recoverable: number;
  outstandingCorrections: number;
  lastPaidAt: string | null;
  delayed: boolean;
  pendingRequestId: string | null;
}

export interface RiderDue {
  rider: { id: string; name: string; code: string | null };
  unpaid: number;
  oldestUnpaidOn: string | null;
  lastPayout: { amount: number; paidOn: string; reference: string | null } | null;
  delayed: boolean;
  pendingRequestId: string | null;
}

export interface FinanceIssue {
  type: FinanceIssueType;
  severity: "warning" | "critical";
  title: string;
  detail: string | null;
  amount: number | null;
  since: string;
  subject: { kind: "order" | "vendor" | "settlement" | "refund" | "payment_request" | "rider"; id: string; label: string };
  reference: string | null;
}

export interface RefundItem {
  id: string;
  order: { id: string; code: string; total: number; paymentMethod: "cod" | "online" | null; placedAt: string };
  vendor: Ref;
  amount: number;
  reason: string | null;
  origin: "customer" | "vendor_rejected" | "admin" | "manager" | "system";
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  decidedBy: Ref | null;
  providerRefundId: string | null;
  settlementEffect: "none" | "draft_flagged" | "correction_created" | null;
}

export interface FinanceOverview {
  filters: FinanceFilters;
  generatedAt: string;
  sales: {
    grossSales: number;
    customerPaid: number;
    netSales: number;
    discounts: { vendor: number; platform: number; total: number };
    refunds: { total: number; count: number };
    adjustments: {
      correctionsOutstanding: { count: number; amount: number };
      correctionsApplied: { count: number; amount: number };
    };
    platformCommission: { commission: number; commissionGst: number; otherCharges: number; total: number };
    deliveryFees: number;
    riderEarnings: number;
    vendorPayable: number;
    vendorRecoverable: number;
    riderPayable: number;
    cancelled: { count: number; value: number };
  };
  payments: {
    vendorDue: number;
    vendorPaid: { amount: number; count: number };
    riderDue: number;
    riderPaid: { amount: number; count: number };
    issues: { warning: number; critical: number };
    pendingApprovals: number;
  };
  series: { date: string; customerPaid: number; netSales: number; commission: number; deliveryFees: number; refunds: number }[];
}

export interface ReconciliationOrderItem {
  orderId: string;
  orderCode: string;
  vendor: Ref;
  deliveredAt: string;
  state: ReconciliationState;
  expected: number;
  settled: number | null;
  difference: number;
  settlementId: string | null;
  correctionId: string | null;
}

export interface ReconciliationOnlineItem {
  orderId: string;
  orderCode: string;
  orderTotal: number;
  paidAmount: number | null;
  paymentId: string | null;
  state: "matched" | "online_mismatch" | "missing_payment";
}

export interface ReconciliationCashItem {
  day: string;
  rider: { id: string; name: string; code: string | null };
  collected: number;
  deposited: number;
  pending: number;
  status: "settled" | "pending" | "disputed";
  depositIds: string[];
}

export type ReconciliationPayload =
  | { section: "orders"; filters: FinanceFilters; summary: Record<ReconciliationState, number>; items: ReconciliationOrderItem[]; nextCursor: string | null }
  | { section: "online"; filters: FinanceFilters; summary: { matched: number; online_mismatch: number; missing_payment: number }; items: ReconciliationOnlineItem[]; nextCursor: string | null }
  | {
      section: "cash";
      filters: FinanceFilters;
      summary: { collected: number; deposited: number; pending: number; disputedDays: number };
      items: ReconciliationCashItem[];
      managers: { manager: Ref; day: string; received: number; handedOn: number; pending: number }[];
      nextCursor: string | null;
    };

// ── parsing ──────────────────────────────────────────────────────────────

export type RangeError = "bad_range";

/**
 * `from` / `to` (IST days, inclusive), default the last 30 days ending today;
 * at most 366 days; never in the future. `zone` must be a uuid when given.
 */
export function parseFinanceRange(
  params: URLSearchParams,
  now: Date
): { ok: true; range: DateRange; zone: string | null } | { ok: false; error: "bad_range" | "bad_request"; field?: string } {
  const today = istDayKey(now);
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const to = rawTo ?? today;
  const from = rawFrom ?? addDays(to, -29);
  if (!isDayKey(from) || !isDayKey(to) || from > to || to > today) return { ok: false, error: "bad_range" };
  const range = { from, to };
  if (rangeLength(range) > MAX_RANGE_DAYS) return { ok: false, error: "bad_range" };
  const zone = params.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, error: "bad_request", field: "zone" };
  return { ok: true, range, zone: zone ? zone.toLowerCase() : null };
}

/** A keyset cursor of (instant-or-day, id). */
export function encodeKeyCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");
}
export function decodeKeyCursor(s: string | null): { at: string; id: string } | null | "bad" {
  if (!s) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return "bad";
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") return "bad";
    if (!isUuid(v[1]) && !/^[^\s]{1,80}$/.test(v[1])) return "bad";
    return { at: v[0], id: v[1] };
  } catch {
    return "bad";
  }
}

const METHODS = ["bank", "upi", "cash", "other"] as const;
export type SettlementMethod = (typeof METHODS)[number];

export interface InitiateSettlementInput {
  clientActionId: string;
  vendorId: string;
  range: DateRange | null;
  orderId: string | null;
  method: SettlementMethod;
  note: string | null;
}

type Fail = { ok: false; status: 400; error: string; field?: string };

/** POST /finance/settlements: exactly one of a period (from/to) or an order. */
export function parseInitiateBody(body: Record<string, unknown> | null, now: Date): { ok: true; input: InitiateSettlementInput } | Fail {
  if (!body) return { ok: false, status: 400, error: "bad_request" };
  const { clientActionId, vendorId, from, to, orderId, method, note } = body;
  if (typeof clientActionId !== "string" || !isUuid(clientActionId)) return { ok: false, status: 400, error: "bad_request", field: "clientActionId" };
  if (typeof vendorId !== "string" || !isUuid(vendorId)) return { ok: false, status: 400, error: "bad_request", field: "vendorId" };
  const hasRange = from !== undefined && from !== null || to !== undefined && to !== null;
  const hasOrder = orderId !== undefined && orderId !== null;
  if (hasRange === hasOrder) return { ok: false, status: 400, error: "bad_request", field: "period" };
  let range: DateRange | null = null;
  if (hasRange) {
    if (typeof from !== "string" || typeof to !== "string" || !isDayKey(from) || !isDayKey(to)) return { ok: false, status: 400, error: "bad_range" };
    if (from > to || to > istDayKey(now) || rangeLength({ from, to }) > MAX_RANGE_DAYS) return { ok: false, status: 400, error: "bad_range" };
    range = { from, to };
  }
  if (hasOrder && (typeof orderId !== "string" || !isUuid(orderId))) return { ok: false, status: 400, error: "bad_request", field: "orderId" };
  if (typeof method !== "string" || !(METHODS as readonly string[]).includes(method)) return { ok: false, status: 400, error: "bad_request", field: "method" };
  let n: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== "string" || note.trim().length > 500) return { ok: false, status: 400, error: "bad_request", field: "note" };
    n = note.trim() || null;
  }
  return {
    ok: true,
    input: {
      clientActionId: clientActionId.toLowerCase(),
      vendorId: vendorId.toLowerCase(),
      range,
      orderId: hasOrder ? (orderId as string).toLowerCase() : null,
      method: method as SettlementMethod,
      note: n,
    },
  };
}

export interface RefundDecisionInput {
  clientActionId: string;
  decision: "approve" | "deny";
  reason: string;
}

export function parseRefundDecideBody(body: Record<string, unknown> | null): { ok: true; input: RefundDecisionInput } | Fail {
  if (!body) return { ok: false, status: 400, error: "bad_request" };
  const { clientActionId, decision, reason } = body;
  if (typeof clientActionId !== "string" || !isUuid(clientActionId)) return { ok: false, status: 400, error: "bad_request", field: "clientActionId" };
  if (decision !== "approve" && decision !== "deny") return { ok: false, status: 400, error: "bad_request", field: "decision" };
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length < 3 || r.length > 300) return { ok: false, status: 400, error: "reason_required", field: "reason" };
  return { ok: true, input: { clientActionId: clientActionId.toLowerCase(), decision, reason: r } };
}

// ── serialising ──────────────────────────────────────────────────────────

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v) || 0);
const istDay = (iso: string): string => istDayKey(iso);

export interface SettlementHeaderRow {
  id: string;
  restaurant_id: string;
  period_start: string;
  period_end: string;
  food_gross: number | null;
  commission: number | null;
  commission_gst?: number | null;
  other_charges?: number | null;
  refunds_recovered: number | null;
  net_payable: number | null;
  status: string;
  kind?: string | null;
  payment_ref: string | null;
  paid_at: string | null;
  paid_by: string | null;
  created_at: string;
  created_by: string | null;
}

export const SETTLEMENT_HEADER_COLUMNS =
  "id, restaurant_id, period_start, period_end, food_gross, commission, commission_gst, other_charges, refunds_recovered, net_payable, status, kind, payment_ref, paid_at, paid_by, created_at, created_by";

export interface FinanceNames {
  shop(id: string): Ref;
  zoneOfShop(id: string): Ref | null;
  person(id: string | null | undefined): Ref | null;
}

/** period_end is stored as the instant AFTER the last day; the contract shows the last day. */
export function toSettlementSummary(
  r: SettlementHeaderRow,
  names: FinanceNames,
  orders: number,
  request: SettlementSummary["request"]
): SettlementSummary {
  return {
    id: r.id,
    vendor: names.shop(r.restaurant_id),
    zone: names.zoneOfShop(r.restaurant_id),
    kind: r.kind === "instant" ? "instant" : "batch",
    status: (r.status as SettlementSummary["status"]) ?? "draft",
    periodStart: istDay(r.period_start),
    periodEnd: addDays(istDay(r.period_end), -1),
    orders,
    foodGross: n(r.food_gross),
    commission: n(r.commission),
    commissionGst: n(r.commission_gst),
    otherCharges: n(r.other_charges),
    refundsRecovered: n(r.refunds_recovered),
    netPayable: n(r.net_payable),
    paymentRef: r.payment_ref,
    paidAt: r.paid_at,
    paidBy: names.person(r.paid_by),
    createdAt: r.created_at,
    createdBy: names.person(r.created_by),
    request,
  };
}

export const ISSUE_TITLES: Record<FinanceIssueType, string> = {
  failed_payment: "Online payment failed",
  stuck_payment: "Online payment stuck",
  refund_unsent: "Approved refund not sent",
  settlement_delayed: "Vendor settlement overdue",
  draft_stale: "Draft settlement waiting",
  approval_overdue: "Payment waiting for approval",
  rider_payout_delayed: "Rider pay overdue",
};

/** Newest first, then by id — the issues list's order. */
export function sortIssues(items: FinanceIssue[]): FinanceIssue[] {
  return [...items].sort((a, b) => (a.since === b.since ? (a.subject.id < b.subject.id ? 1 : -1) : a.since < b.since ? 1 : -1));
}
