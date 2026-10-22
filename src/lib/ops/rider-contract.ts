/**
 * The pinned Phase 5 rider contract (plan: API contract): the JSON shapes the
 * Manager app reads, and the query parsing for the rider routes. Pure.
 */

import { decodeHistoryCursor } from "@/lib/rider/figures";
import { isUuid } from "@/lib/auth/manager-scope";
import { decodeNameCursor, parseLimit, type PersonRef, type TicketSummary } from "./vendor-contract";

export type RiderState = "online" | "available" | "on_delivery" | "break" | "stale" | "offline";
export const RIDER_STATES: readonly RiderState[] = ["online", "available", "on_delivery", "break", "stale", "offline"];
export type Verification = "unverified" | "pending" | "verified" | "rejected";
export const VERIFICATIONS: readonly Verification[] = ["unverified", "pending", "verified", "rejected"];
export type Account = "active" | "suspended" | "restricted";
export const ACCOUNTS: readonly Account[] = ["active", "suspended", "restricted"];
export type RiderDocType = "aadhaar" | "pan" | "driving_licence" | "vehicle_rc" | "insurance" | "puc" | "photo";
export const RIDER_DOC_TYPES: readonly RiderDocType[] = ["aadhaar", "pan", "driving_licence", "vehicle_rc", "insurance", "puc", "photo"];
/** Documents that must be verified before a rider is approved (unless overridden). */
export const REQUIRED_RIDER_DOCS: readonly RiderDocType[] = ["aadhaar", "driving_licence", "photo"];
/** Documents that need an expiry date. */
export const EXPIRING_RIDER_DOCS: readonly RiderDocType[] = ["driving_licence", "insurance", "puc"];

export interface RiderListItem {
  id: string;
  riderCode: string | null;
  name: string | null;
  phone: string | null;
  photoUrl: string | null;
  state: RiderState;
  lastFixAt: string | null;
  fixAgeSeconds: number | null;
  zones: { id: string; name: string }[];
  verification: Verification;
  account: Account;
  activeDeliveries: number;
  deliveredToday: number;
  rating: number | null;
  ratingCount: number;
  pendingDocuments: number;
  expiringDocuments: number;
  openComplaints: number;
}

export interface RiderCounts {
  all: number;
  online: number;
  available: number;
  on_delivery: number;
  break: number;
  stale: number;
  offline: number;
  suspended: number;
  needs_review: number;
}

export interface RiderDocument {
  id: string;
  type: RiderDocType;
  numberMasked: string | null;
  expiresOn: string | null;
  status: "pending" | "verified" | "rejected" | "expired" | "replaced";
  remarks: string | null;
  reviewedBy: PersonRef | null;
  reviewedAt: string | null;
  uploadedAt: string;
}

export interface RiderHistoryItem {
  orderId: string;
  code: string;
  shop: string;
  dropArea: string | null;
  outcome: "delivered" | "failed" | "cancelled" | "reassigned";
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  endedAt: string;
  distanceKm: number | null;
  reason: string | null;
  cancelledBy: string | null;
  proof: "code" | "photo" | "ops_approved" | "staff" | "vendor" | null;
  itemCount: number;
  orderValue: number;
}

export interface LedgerRow {
  id: string;
  type: "earning" | "incentive" | "salary" | "bonus" | "deduction" | "adjustment";
  amount: number;
  date: string;
  reason: string | null;
  orderCode: string | null;
  payoutId: string | null;
  status: "pending" | "paid";
  createdBy: PersonRef | null;
}

export interface Payout {
  id: string;
  amount: number;
  method: "bank" | "upi" | "cash" | "other";
  reference: string | null;
  paidOn: string;
  periodEnd: string;
  items: number;
  requestId: string | null;
}

export interface PaymentRequest {
  id: string;
  kind: "rider_payout" | "vendor_settlement" | "settlement_reversal";
  subject: { id: string; name: string; code: string | null };
  zone: { id: string; name: string } | null;
  amount: number;
  periodEnd: string | null;
  salaryAmount: number | null;
  method: "bank" | "upi" | "cash" | "other" | null;
  note: string | null;
  status: "pending_approval" | "approved" | "rejected" | "cancelled";
  requestedBy: PersonRef;
  requestedAt: string;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  reference: string | null;
  paidOn: string | null;
  resultId: string | null;
  /** An admin approved their own request under the one-admin switch (0152). */
  selfApproved: boolean;
  /** The settlement a vendor request pays (null for rider payouts). */
  settlementId: string | null;
  canDecide: boolean;
}

export interface CashDeposit {
  id: string;
  rider: { id: string; name: string; code: string | null };
  amount: number;
  method: "cash" | "upi";
  reference: string | null;
  hasPhoto: boolean;
  note: string | null;
  status: "submitted" | "confirmed" | "disputed" | "withdrawn";
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  handoverId: string | null;
  createdAt: string;
}

export interface CashDispute {
  id: string;
  rider: { id: string; name: string; code: string | null };
  day: string;
  claimedAmount: number | null;
  message: string;
  status: "open" | "resolved";
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export type ExceptionKind =
  | "customer_unreachable" | "wrong_address" | "complete_without_code" | "failed_delivery" | "manual_pickup" | "go_offline"
  | "return_to_shop" | "missing_items" | "wrong_package" | "vendor_delay" | "other_issue";

export interface DeliveryException {
  id: string;
  orderId: string;
  orderCode: string;
  rider: { id: string; name: string; code: string | null; phone: string | null };
  kind: ExceptionKind;
  reason: string;
  notes: string | null;
  hasPhoto: boolean;
  lat: number | null;
  lng: number | null;
  status: "pending" | "approved" | "rejected" | "acknowledged";
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  decisions: ("approve" | "reject" | "acknowledge")[];
}

export interface ActiveDelivery {
  orderId: string;
  code: string;
  status: "assigned" | "picked_up";
  shop: { name: string; lat: number; lng: number };
  drop: { area: string | null; lat: number; lng: number };
  etaPickupAt: string | null;
  etaDeliveryAt: string | null;
  route: [number, number][];
  delay: { kind: "prep" | "pickup" | "delivery" | "unassigned" | "accept"; minutes: number } | null;
}

export interface RiderAllowed {
  approve: boolean;
  reject: boolean;
  suspend: boolean;
  reactivate: boolean;
  forceOffline: boolean;
  reviewDocuments: boolean;
  uploadDocuments: boolean;
  addAdjustment: boolean;
  requestPayout: boolean;
  assign: boolean;
}

export interface RiderPerformanceView {
  from: string;
  to: string;
  delivered: number;
  failed: number;
  cancelled: number;
  acceptanceRate: number | null;
  avgDeliverMinutes: number | null;
  avgPickupToDeliverMinutes: number | null;
  failedRate: number | null;
  onlineHours: number;
  months: { month: string; delivered: number; failed: number; cancelled: number; acceptanceRate: number | null; avgDeliverMin: number | null; onlineHours: number }[];
}

export interface RiderRatings {
  average: number | null;
  count: number;
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  recent: { rating: number; comment: string | null; at: string; orderCode: string }[];
}

export interface RiderMoney {
  pending: number;
  paidTotal: number;
  lastPayout: Payout | null;
  pendingRequests: PaymentRequest[];
}

export interface RiderCash {
  collectedToday: number;
  depositedToday: number;
  pendingDeposit: number;
  openDeposits: CashDeposit[];
  openDisputes: CashDispute[];
}

export interface RiderDetail extends Omit<RiderListItem, "openComplaints"> {
  accountReason: string | null;
  accountChangedAt: string | null;
  accountChangedBy: PersonRef | null;
  verifiedAt: string | null;
  verifiedBy: PersonRef | null;
  profile: {
    vehicleType: "ev_bike" | "bike" | "scooter" | "bicycle" | "other" | null;
    vehicleOwner: "deligro" | "rider";
    vehicleRegistration: string | null;
    licenceNumberMasked: string | null;
    licenceExpiresOn: string | null;
    address: string | null;
    pincode: string | null;
    emergency: { name: string | null; phone: string | null; relation: string | null };
    joinedAt: string;
  };
  availability: { onlineSince: string | null; breakUntil: string | null; position: { lat: number; lng: number; at: string } | null };
  active: ActiveDelivery[];
  performance: RiderPerformanceView;
  ratings: RiderRatings;
  documents: RiderDocument[];
  money?: RiderMoney;
  cash: RiderCash;
  openExceptions: DeliveryException[];
  openComplaints: TicketSummary[];
  allowed: RiderAllowed;
}

// ── queries ──────────────────────────────────────────────────────────────────

export const RIDER_FILTERS = ["needs_review", "expiring"] as const;
export type RiderFilter = (typeof RIDER_FILTERS)[number];

export interface RiderQuery {
  q: string | null;
  states: RiderState[];
  verification: Verification | null;
  account: Account | null;
  zone: string | null;
  filter: RiderFilter | null;
  cursor: { name: string; id: string } | null;
  limit: number;
}

type Parsed<T> = { ok: true; query: T } | { ok: false; field: string };

export function parseRiderQuery(params: URLSearchParams): Parsed<RiderQuery> {
  const qRaw = (params.get("q") ?? "").trim();
  if (qRaw !== "" && (qRaw.length < 2 || qRaw.length > 80)) return { ok: false, field: "q" };
  const states = (params.get("state") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (states.some((s) => !RIDER_STATES.includes(s as RiderState))) return { ok: false, field: "state" };
  const verification = params.get("verification");
  if (verification && !VERIFICATIONS.includes(verification as Verification)) return { ok: false, field: "verification" };
  const account = params.get("account");
  if (account && !ACCOUNTS.includes(account as Account)) return { ok: false, field: "account" };
  const zone = params.get("zone");
  if (zone && !isUuid(zone)) return { ok: false, field: "zone" };
  const filter = params.get("filter");
  if (filter && !RIDER_FILTERS.includes(filter as RiderFilter)) return { ok: false, field: "filter" };
  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw ? decodeNameCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return { ok: false, field: "cursor" };
  const limit = parseLimit(params.get("limit"));
  if (limit === null) return { ok: false, field: "limit" };
  return {
    ok: true,
    query: {
      q: qRaw || null,
      states: states as RiderState[],
      verification: (verification as Verification) || null,
      account: (account as Account) || null,
      zone: zone ? zone.toLowerCase() : null,
      filter: (filter as RiderFilter) || null,
      cursor,
      limit,
    },
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Keyset cursor for time-ordered pages: [iso, id]. */
export function encodeTimeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");
}
export function decodeTimeCursor(s: string): { at: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") return null;
    if (Number.isNaN(Date.parse(v[0]))) return null;
    return { at: v[0], id: v[1] };
  } catch {
    return null;
  }
}

export interface HistoryQuery {
  from: string | null;
  to: string | null;
  outcome: RiderHistoryItem["outcome"] | null;
  /** The Rider app's history cursor (`encodeHistoryCursor`), passed through as-is. */
  cursor: string | null;
}

/**
 * A Rider-app percentage (0–100, one decimal: `rider/figures.ts` percent()) as
 * the manager contract's ratio (0–1). The manager rider screen reads the Rider
 * app's own performance figures, so both apps show one calculation.
 */
export function percentToRatio(percent: number | null): number | null {
  return percent === null ? null : Math.round(percent * 10) / 1000;
}

export function parseHistoryQuery(params: URLSearchParams): Parsed<HistoryQuery> {
  const from = params.get("from");
  const to = params.get("to");
  if (from && !validDay(from)) return { ok: false, field: "from" };
  if (to && !validDay(to)) return { ok: false, field: "to" };
  if (from && to && from > to) return { ok: false, field: "from" };
  const outcome = params.get("outcome");
  if (outcome && !["delivered", "failed", "cancelled", "reassigned"].includes(outcome)) return { ok: false, field: "outcome" };
  const cursor = params.get("cursor");
  if (cursor && !decodeHistoryCursor(cursor)) return { ok: false, field: "cursor" };
  return { ok: true, query: { from, to, outcome: (outcome as HistoryQuery["outcome"]) || null, cursor: cursor || null } };
}

export interface LedgerQuery {
  from: string | null;
  to: string | null;
  status: "pending" | "paid" | null;
  cursor: { at: string; id: string } | null;
}

export function parseLedgerQuery(params: URLSearchParams): Parsed<LedgerQuery> {
  const from = params.get("from");
  const to = params.get("to");
  if (from && !validDay(from)) return { ok: false, field: "from" };
  if (to && !validDay(to)) return { ok: false, field: "to" };
  if (from && to && from > to) return { ok: false, field: "from" };
  const status = params.get("status");
  if (status && status !== "pending" && status !== "paid") return { ok: false, field: "status" };
  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw ? decodeTimeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return { ok: false, field: "cursor" };
  return { ok: true, query: { from, to, status: (status as LedgerQuery["status"]) || null, cursor } };
}
