/**
 * Vendor rules for the Manager app (§4): the status transitions a manager may
 * make, what the detail screen offers, which documents an approval needs, and
 * the cancellation / rejection / speed figures. Pure; the database enforces the
 * same transitions (ops_set_vendor_status, migration 0145).
 */

export type VendorStatus = "pending" | "active" | "inactive" | "suspended" | "rejected";
export type VendorAction = "approve" | "reject" | "suspend" | "reactivate";

/** What an approval needs verified (0145: `documents_unverified` otherwise). */
export const REQUIRED_DOCUMENTS = ["fssai", "bank_proof"] as const;

const TRANSITIONS: Record<VendorAction, { from: readonly VendorStatus[]; to: VendorStatus }> = {
  approve: { from: ["pending", "rejected"], to: "active" },
  reject: { from: ["pending"], to: "rejected" },
  suspend: { from: ["active", "inactive"], to: "suspended" },
  reactivate: { from: ["suspended", "inactive"], to: "active" },
};

/** Where `action` takes a shop in `from`, or null when it isn't allowed. */
export function nextVendorStatus(from: VendorStatus, action: VendorAction): VendorStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(from) ? t.to : null;
}

export interface AllowedVendorActions {
  approve: boolean;
  reject: boolean;
  suspend: boolean;
  reactivate: boolean;
  reviewDocuments: boolean;
  uploadDocuments: boolean;
  /** Upload a menu sheet for this shop (manager.products.bulk_menu). */
  menuSheet: boolean;
}

export function allowedVendorActions(v: { status: VendorStatus }, perms: Record<string, boolean>): AllowedVendorActions {
  const decide = perms["manager.vendors.status"] === true;
  const can = (a: VendorAction) => decide && nextVendorStatus(v.status, a) !== null;
  return {
    approve: can("approve"),
    reject: can("reject"),
    suspend: can("suspend"),
    reactivate: can("reactivate"),
    reviewDocuments: decide,
    uploadDocuments: perms["manager.vendors.onboard"] === true,
    menuSheet: perms["manager.products.view"] === true && perms["manager.products.bulk_menu"] === true,
  };
}

/** Required document types with no verified copy, in REQUIRED_DOCUMENTS order. */
export function missingRequiredDocuments(docs: { type: string; status: string }[]): string[] {
  return REQUIRED_DOCUMENTS.filter((t) => !docs.some((d) => d.type === t && d.status === "verified"));
}

export interface VendorRateOrder {
  status: string;
  cancelledBy: string | null;
  createdAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
}

export interface VendorRates {
  orders: number;
  cancellationRate: number;
  rejectionRate: number;
  avgAcceptMinutes: number | null;
  avgPrepMinutes: number | null;
}

const minutesBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;

function mean(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v) && v >= 0);
  return finite.length === 0 ? null : finite.reduce((s, v) => s + v, 0) / finite.length;
}

/**
 * §4.13. Cancellation = cancelled ÷ all orders; rejection = cancelled by the
 * vendor ÷ all orders; accept = created → accepted over accepted orders; prep
 * = accepted → ready over orders with both.
 */
export function vendorRates(orders: VendorRateOrder[]): VendorRates {
  const n = orders.length;
  const cancelled = orders.filter((o) => o.status === "cancelled");
  const rejected = cancelled.filter((o) => o.cancelledBy === "vendor");
  return {
    orders: n,
    cancellationRate: n === 0 ? 0 : cancelled.length / n,
    rejectionRate: n === 0 ? 0 : rejected.length / n,
    avgAcceptMinutes: mean(orders.filter((o) => o.acceptedAt).map((o) => minutesBetween(o.createdAt, o.acceptedAt as string))),
    avgPrepMinutes: mean(
      orders.filter((o) => o.acceptedAt && o.readyAt).map((o) => minutesBetween(o.acceptedAt as string, o.readyAt as string))
    ),
  };
}

/** Count of 1–5 star ratings; anything outside 1–5 is ignored. */
export function ratingDistribution(ratings: number[]): Record<"1" | "2" | "3" | "4" | "5", number> {
  const out = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const r of ratings) {
    const k = String(Math.round(r));
    if (k in out) out[k as keyof typeof out] += 1;
  }
  return out;
}
