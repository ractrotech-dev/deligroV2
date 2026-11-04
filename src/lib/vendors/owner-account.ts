/**
 * What happens to a shop owner's login when an order-free shop is deleted. Pure.
 *
 * "Stay both" (attachVendorToExistingUser) hangs a shop on an existing customer's
 * account and leaves their role as `customer`, so a login can belong to someone who
 * also shops here. Deleting a shop must never take that account with it. A login
 * goes only when it was purely a vendor login: role `restaurant`, no other shop,
 * and nothing that shows they ever used it as a customer.
 */

export interface OwnerFacts {
  /** profiles.role, or null if there is no profile. */
  role: string | null;
  /** Shops they own other than the one being deleted. */
  otherShops: number;
  /** Orders placed as a customer. */
  customerOrders: number;
  /** Saved delivery addresses. */
  addresses: number;
}

export type OwnerOutcome =
  /** Purely a vendor login: delete it. */
  | "remove_login"
  /** Nothing to change: the shop link went with the shop row. */
  | "keep_login"
  /** Signed up as a vendor but has also shopped: keep them, as a customer. */
  | "make_customer";

export function ownerAccountOutcome(f: OwnerFacts): OwnerOutcome {
  if (f.role !== "restaurant" || f.otherShops > 0) return "keep_login";
  return f.customerOrders > 0 || f.addresses > 0 ? "make_customer" : "remove_login";
}
