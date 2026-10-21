/**
 * Vendor lifecycle status — a client-safe module (no "server-only"), so both the
 * server data-access layer and client components (filters, row actions) can
 * share one source of truth without pulling server code into the browser bundle.
 */
export type VendorStatus = "pending" | "active" | "inactive" | "suspended" | "rejected";

export const VENDOR_STATUSES: VendorStatus[] = [
  "pending",
  "active",
  "inactive",
  "suspended",
  "rejected",
];
