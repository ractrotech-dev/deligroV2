/**
 * Rider rules for the Manager app (§5): the live state a manager reads, number
 * masking, the documents approval needs, the actions a manager is offered, and
 * the pinned rider detail. Pure: scripts/qa/manager-riders.ts runs it under tsx.
 *
 * Privacy (§5.7, §16.10), enforced here so every route inherits it:
 *   * position and route only while the rider is online or carrying an order;
 *   * Aadhaar, PAN and licence numbers only as "XXXX" + last 4;
 *   * the `money` block only with manager.finance.view;
 *   * never a payout account, never who left a rating.
 */
import { RIDER_PRESENCE_MS } from "@/lib/rider/availability";
import type { PersonRef, TicketSummary } from "./vendor-contract";
import {
  REQUIRED_RIDER_DOCS,
  type Account,
  type ActiveDelivery,
  type CashDeposit,
  type CashDispute,
  type DeliveryException,
  type Payout,
  type PaymentRequest,
  type RiderAllowed,
  type RiderDetail,
  type RiderDocType,
  type RiderDocument,
  type RiderPerformanceView,
  type RiderRatings,
  type RiderState,
  type Verification,
} from "./rider-contract";

/**
 * The state a manager reads. Carrying an order outranks everything (even a
 * rider whose app says offline is still on that job); then offline, break,
 * a fix older than RIDER_PRESENCE_MS (dispatch skips them), else available.
 */
export function riderState(
  s: { isOnline: boolean; breakUntil: Date | null; lastFixAt: Date | null; activeDeliveries: number },
  now: Date
): RiderState {
  if (s.activeDeliveries > 0) return "on_delivery";
  if (!s.isOnline) return "offline";
  if (s.breakUntil && s.breakUntil.getTime() > now.getTime()) return "break";
  if (!s.lastFixAt || Math.abs(now.getTime() - s.lastFixAt.getTime()) >= RIDER_PRESENCE_MS) return "stale";
  return "available";
}

/** "XXXX" + the last 4 characters; a number of 4 or fewer is masked entirely. */
export function maskNumber(n: string | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  const clean = n.replace(/\s+/g, "");
  if (clean === "") return null;
  return clean.length <= 4 ? "XXXX" : `XXXX${clean.slice(-4)}`;
}

/** The required documents (Aadhaar, driving licence, photo) not yet verified, in that order. */
export function requiredRiderDocsMissing(docs: { type: string; status: string }[]): RiderDocType[] {
  return REQUIRED_RIDER_DOCS.filter((t) => !docs.some((d) => d.type === t && d.status === "verified"));
}

/** Expiring within `days` (default 30), or already expired. */
export function documentExpiring(expiresOn: string | null, now: Date, days = 30): boolean {
  if (!expiresOn) return false;
  const t = Date.parse(`${expiresOn}T23:59:59+05:30`);
  if (!Number.isFinite(t)) return false;
  return t - now.getTime() <= days * 86_400_000;
}

/** What the rider detail offers this viewer. The routes and RPCs re-check everything. */
export function allowedRiderActions(
  r: { verification: string; account: string; activeDeliveries: number },
  perms: Record<string, boolean>
): RiderAllowed {
  const status = perms["manager.riders.status"] === true;
  const idle = r.activeDeliveries === 0;
  const active = r.account === "active";
  return {
    approve: status && ["unverified", "pending", "rejected"].includes(r.verification),
    reject: status && ["unverified", "pending"].includes(r.verification) && idle,
    suspend: status && active && idle,
    reactivate: status && r.account === "suspended",
    forceOffline: status && active && idle,
    reviewDocuments: status,
    uploadDocuments: perms["manager.riders.onboard"] === true,
    addAdjustment: perms["manager.finance.adjust"] === true,
    requestPayout: perms["manager.finance.initiate_payment"] === true,
    assign: (perms["manager.assign_rider"] === true || perms["manager.reassign_rider"] === true)
      && active && r.verification !== "rejected",
  };
}

/** Everything the detail needs, as the data layer reads it (numbers unmasked). */
export interface RiderDetailInput {
  id: string;
  riderCode: string | null;
  name: string | null;
  phone: string | null;
  photoUrl: string | null;
  isOnline: boolean;
  breakUntil: string | null;
  onlineSince: string | null;
  lastFixAt: string | null;
  lat: number | null;
  lng: number | null;
  zones: { id: string; name: string }[];
  verification: Verification;
  account: Account;
  accountReason: string | null;
  accountChangedAt: string | null;
  accountChangedBy: PersonRef | null;
  verifiedAt: string | null;
  verifiedBy: PersonRef | null;
  activeDeliveries: number;
  deliveredToday: number;
  rating: number | null;
  ratingCount: number;
  pendingDocuments: number;
  expiringDocuments: number;
  openComplaintsCount: number;
  profile: {
    vehicleType: RiderDetail["profile"]["vehicleType"];
    vehicleOwner: "deligro" | "rider" | null;
    vehicleRegistration: string | null;
    licenceNumber: string | null;
    licenceExpiresOn: string | null;
    address: string | null;
    pincode: string | null;
    emergency: { name: string | null; phone: string | null; relation: string | null };
    joinedAt: string;
  };
  active: ActiveDelivery[];
  performance: RiderPerformanceView;
  ratings: RiderRatings;
  documents: {
    id: string; type: RiderDocType; number: string | null; expiresOn: string | null;
    status: RiderDocument["status"]; remarks: string | null; reviewedBy: PersonRef | null; reviewedAt: string | null; uploadedAt: string;
  }[];
  money: { pending: number; paidTotal: number; lastPayout: Payout | null; pendingRequests: PaymentRequest[] };
  cash: { collectedToday: number; depositedToday: number; pendingDeposit: number; openDeposits: CashDeposit[]; openDisputes: CashDispute[] };
  openExceptions: DeliveryException[];
  openComplaints: TicketSummary[];
}

export function toRiderDocument(d: RiderDetailInput["documents"][number]): RiderDocument {
  return {
    id: d.id,
    type: d.type,
    numberMasked: maskNumber(d.number),
    expiresOn: d.expiresOn,
    status: d.status,
    remarks: d.remarks,
    reviewedBy: d.reviewedBy,
    reviewedAt: d.reviewedAt,
    uploadedAt: d.uploadedAt,
  };
}

function fixAge(lastFixAt: string | null, now: Date): number | null {
  if (!lastFixAt) return null;
  const t = Date.parse(lastFixAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 1000)) : null;
}

export function buildRiderDetail(input: RiderDetailInput, perms: Record<string, boolean>, now: Date): RiderDetail {
  const state = riderState(
    {
      isOnline: input.isOnline,
      breakUntil: input.breakUntil ? new Date(input.breakUntil) : null,
      lastFixAt: input.lastFixAt ? new Date(input.lastFixAt) : null,
      activeDeliveries: input.activeDeliveries,
    },
    now
  );
  const tracked = input.isOnline || input.activeDeliveries > 0;
  const position =
    tracked && input.lat !== null && input.lng !== null && input.lastFixAt
      ? { lat: input.lat, lng: input.lng, at: input.lastFixAt }
      : null;
  const detail: RiderDetail = {
    id: input.id,
    riderCode: input.riderCode,
    name: input.name,
    phone: input.phone,
    photoUrl: input.photoUrl,
    state,
    lastFixAt: input.lastFixAt,
    fixAgeSeconds: fixAge(input.lastFixAt, now),
    zones: input.zones,
    verification: input.verification,
    account: input.account,
    activeDeliveries: input.activeDeliveries,
    deliveredToday: input.deliveredToday,
    rating: input.rating,
    ratingCount: input.ratingCount,
    pendingDocuments: input.pendingDocuments,
    expiringDocuments: input.expiringDocuments,
    accountReason: input.accountReason,
    accountChangedAt: input.accountChangedAt,
    accountChangedBy: input.accountChangedBy,
    verifiedAt: input.verifiedAt,
    verifiedBy: input.verifiedBy,
    profile: {
      vehicleType: input.profile.vehicleType,
      vehicleOwner: input.profile.vehicleOwner ?? "deligro",
      vehicleRegistration: input.profile.vehicleRegistration,
      licenceNumberMasked: maskNumber(input.profile.licenceNumber),
      licenceExpiresOn: input.profile.licenceExpiresOn,
      address: input.profile.address,
      pincode: input.profile.pincode,
      emergency: input.profile.emergency,
      joinedAt: input.profile.joinedAt,
    },
    availability: { onlineSince: input.isOnline ? input.onlineSince : null, breakUntil: input.breakUntil, position },
    // A route is a position; neither is sent for a rider who is not working.
    active: tracked ? input.active : [],
    performance: input.performance,
    ratings: input.ratings,
    documents: input.documents.map(toRiderDocument),
    cash: input.cash,
    openExceptions: input.openExceptions,
    openComplaints: input.openComplaints,
    allowed: allowedRiderActions(
      { verification: input.verification, account: input.account, activeDeliveries: input.activeDeliveries },
      perms
    ),
  };
  if (perms["manager.finance.view"] === true) detail.money = input.money;
  return detail;
}
