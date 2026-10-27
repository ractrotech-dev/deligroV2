/**
 * Every feature the admin can switch off for a role — the one list the admin
 * control panel, the server guards and the UI all read.
 *
 * Core work is deliberately NOT here and cannot be switched off: a vendor
 * seeing, accepting and readying orders, a rider going online, accepting and
 * completing deliveries (cash collection included), a manager seeing the live
 * board. Those are the job; turning them off would strand orders, not restrict
 * a feature. Nor is a rider's safety: SOS, emergency reports and calling
 * Deligro have no switch, and `driver.support` stops only ordinary tickets.
 *
 * Safe for the browser: no server imports. Resolution rules live in
 * `resolve.ts`, database access in `flags.server.ts`.
 */

export type FeatureRole = "vendor" | "manager" | "driver";

/** Who a per-account override attaches to: a vendor's shop, or a person. */
export type FeatureSubjectKind = "restaurant" | "profile";

export interface FeatureDef {
  key: string;
  role: FeatureRole;
  label: string;
  /** What switching it off does, in words an operator would use. */
  offMeans: string;
  /**
   * The state with no switch stored. Absent = on. Sensitive manager powers
   * (payments, adjustments, customer contact…) are `false`: someone has to
   * grant them, and a failed switch read leaves them off.
   */
  defaultOn?: boolean;
}

export const FEATURES = [
  // ---- vendor ----
  { key: "vendor.menu_edit", role: "vendor", label: "Edit menu", offMeans: "Menu is read-only: no adding, editing, deleting, pricing or stock changes." },
  { key: "vendor.menu_import", role: "vendor", label: "Menu import / export", offMeans: "No CSV import or export of the menu." },
  { key: "vendor.promotions", role: "vendor", label: "Promotions", offMeans: "Promotions page and coupon creation are hidden." },
  { key: "vendor.earnings", role: "vendor", label: "Earnings & payments", offMeans: "Earnings, overview and Payments are hidden: no money figures, settlements or statements." },
  { key: "vendor.busy_mode", role: "vendor", label: "Busy mode (+time)", offMeans: "No +10 / +20 / +30 minute pace control." },
  { key: "vendor.open_toggle", role: "vendor", label: "Open / close shop", offMeans: "The shop cannot open or close itself; admin controls it." },
  { key: "vendor.shop_profile", role: "vendor", label: "Edit shop profile", offMeans: "Shop details, logo, photos and map pin are read-only." },
  { key: "vendor.reject_orders", role: "vendor", label: "Reject / cancel orders", offMeans: "The kitchen can accept and ready orders but not reject or cancel them." },
  { key: "vendor.reports", role: "vendor", label: "Reports", offMeans: "The Reports tab is hidden: no sales report, sales charts or report exports." },
  { key: "vendor.reviews", role: "vendor", label: "Customer reviews", offMeans: "Reviews are hidden: the shop can't read customer reviews or reply to them." },
  { key: "vendor.marketing", role: "vendor", label: "Marketing requests", offMeans: "The shop can't ask Deligro for banners, featured spots or campaigns, or see past requests." },
  { key: "vendor.support", role: "vendor", label: "Help & support tickets", offMeans: "No new tickets, replies or ticket history in the app. Deligro can still call the shop." },
  // ---- manager ----
  { key: "manager.phone_orders", role: "manager", label: "Phone orders", offMeans: "Cannot place orders for customers on the phone." },
  { key: "manager.cash", role: "manager", label: "Cash & expenses", offMeans: "Cannot record COD handovers or expenses." },
  { key: "manager.assign_rider", role: "manager", label: "Assign rider", offMeans: "Cannot put a rider on an order by hand; dispatch still runs." },
  { key: "manager.move_status", role: "manager", label: "Move order status", offMeans: "No Mark preparing / ready / on the way / delivered buttons." },
  { key: "manager.call_customer", role: "manager", label: "Call customer", offMeans: "Customer phone numbers and Call buttons are hidden." },
  // Manager app (design 2026-10-21). Screens and the actions on them.
  { key: "manager.orders.view", role: "manager", label: "Orders", offMeans: "The Orders tab and order details are hidden." },
  { key: "manager.live.view", role: "manager", label: "Live map", offMeans: "The Live tab (rider map and delivery lanes) is hidden." },
  { key: "manager.vendors.view", role: "manager", label: "Vendors", offMeans: "Vendor list and vendor details are hidden." },
  { key: "manager.riders.view", role: "manager", label: "Riders", offMeans: "Rider list, rider details and rider locations are hidden." },
  { key: "manager.products.view", role: "manager", label: "Products", offMeans: "Product oversight is hidden." },
  { key: "manager.support.manage", role: "manager", label: "Support tickets", offMeans: "Cannot see or work support tickets." },
  { key: "manager.reports.view", role: "manager", label: "Reports", offMeans: "Reports and exports are hidden." },
  { key: "manager.reassign_rider", role: "manager", label: "Reassign rider", offMeans: "Cannot move a delivery from one rider to another." },
  { key: "manager.orders.escalate", role: "manager", label: "Escalate orders", offMeans: "Cannot raise an order issue to the admin team." },
  { key: "manager.alerts.configure", role: "manager", label: "Alert thresholds", offMeans: "Alert thresholds are read-only." },
  { key: "manager.finance.view", role: "manager", label: "Finance", offMeans: "Every money figure, the Finance tab and finance reports are hidden." },
  { key: "manager.marketing.manage", role: "manager", label: "Marketing", offMeans: "Cannot see or decide marketing requests and campaigns." },
  { key: "manager.offers.manage", role: "manager", label: "Offers", offMeans: "Cannot create or change offers and promo codes." },
  { key: "manager.customers.view", role: "manager", label: "Customers", offMeans: "Customer accounts are hidden." },
  { key: "manager.vendors.status", role: "manager", label: "Vendor status", offMeans: "Cannot approve, reject, suspend or reactivate vendors." },
  { key: "manager.riders.status", role: "manager", label: "Rider status", offMeans: "Cannot approve, reject, suspend or reactivate riders." },
  { key: "manager.exceptions.decide", role: "manager", label: "Decide delivery exceptions", offMeans: "Cannot approve, reject or acknowledge a rider's delivery exception." },
  { key: "manager.products.moderate", role: "manager", label: "Moderate listings", offMeans: "Cannot flag, hide or approve product listings." },
  // Sensitive: off until an admin grants them to a person or to all managers.
  { key: "manager.orders.correct", role: "manager", label: "Correct orders", offMeans: "Cannot apply corrections to an order.", defaultOn: false },
  { key: "manager.vendors.onboard", role: "manager", label: "Onboard vendors", offMeans: "Cannot add new vendors.", defaultOn: false },
  { key: "manager.riders.onboard", role: "manager", label: "Onboard riders", offMeans: "Cannot create rider accounts.", defaultOn: false },
  { key: "manager.finance.initiate_payment", role: "manager", label: "Initiate payments", offMeans: "Cannot put a settlement or payout up for approval.", defaultOn: false },
  { key: "manager.finance.approve_payment", role: "manager", label: "Approve payments", offMeans: "Cannot mark a settlement or payout as paid.", defaultOn: false },
  { key: "manager.finance.adjust", role: "manager", label: "Financial adjustments", offMeans: "Cannot decide refunds or record corrections and adjustments.", defaultOn: false },
  { key: "manager.customers.contact", role: "manager", label: "Customer contact details", offMeans: "Customer phone numbers stay masked; no search by phone.", defaultOn: false },
  { key: "manager.customers.suspend", role: "manager", label: "Suspend customers", offMeans: "Cannot suspend or restrict customer accounts.", defaultOn: false },
  { key: "manager.products.adjust_stock", role: "manager", label: "Adjust stock", offMeans: "Stock stays with the vendor.", defaultOn: false },
  { key: "manager.products.bulk_menu", role: "manager", label: "Bulk menu upload", offMeans: "Menu sheets stay with the vendor and Admin.", defaultOn: false },
  { key: "manager.products.replace_photo", role: "manager", label: "Replace photos", offMeans: "Wrong photos can only be flagged.", defaultOn: false },
  { key: "manager.audit.view_zone", role: "manager", label: "Zone audit log", offMeans: "Sees only their own activity, not their zones' audit log.", defaultOn: false },
  // ---- rider ----
  { key: "driver.history", role: "driver", label: "Delivery history", offMeans: "History tab is hidden." },
  { key: "driver.earnings", role: "driver", label: "Earnings & payouts", offMeans: "The Earnings tab is hidden: pay, payouts, statements, money totals and trip counts." },
  { key: "driver.incentives", role: "driver", label: "Incentives & targets", offMeans: "Incentive targets and bonus progress are hidden. Bonuses already earned still count in earnings." },
  { key: "driver.performance", role: "driver", label: "Performance & ratings", offMeans: "The Performance screen is hidden: delivery targets, customer ratings, rates and the monthly report." },
  { key: "driver.cash", role: "driver", label: "Cash in hand & deposits", offMeans: "The Cash screen is hidden: no cash-in-hand figure or deposits in the app; a manager records handovers. Collecting cash on delivery still works." },
  { key: "driver.support", role: "driver", label: "Help tickets", offMeans: "No new tickets, replies or ticket history. Calling or WhatsApping Deligro, SOS and emergency reports still work." },
  { key: "driver.call_customer", role: "driver", label: "Call customer", offMeans: "Call buttons are hidden; the rider uses the delivery code only." },
  { key: "driver.navigation", role: "driver", label: "Navigation", offMeans: "No Navigate / Google Maps hand-off button." },
  { key: "driver.profile_edit", role: "driver", label: "Edit profile", offMeans: "Profile is read-only." },
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]["key"];

export const ROLE_SUBJECT: Record<FeatureRole, FeatureSubjectKind> = {
  vendor: "restaurant",
  manager: "profile",
  driver: "profile",
};

export const ROLE_LABEL: Record<FeatureRole, string> = {
  vendor: "Vendors (per shop)",
  manager: "Managers",
  driver: "Riders",
};

export function featuresFor(role: FeatureRole): FeatureDef[] {
  return FEATURES.filter((f) => f.role === role);
}

export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURES.some((f) => f.key === value);
}

export function featureDef(key: FeatureKey): FeatureDef {
  return FEATURES.find((f) => f.key === key)!;
}

export type FeatureMap = Record<FeatureKey, boolean>;

/** Every feature on — what an admin acting through a portal gets. */
export function allOn(): FeatureMap {
  return Object.fromEntries(FEATURES.map((f) => [f.key, true])) as FeatureMap;
}

export function isDefaultOn(f: FeatureDef): boolean {
  return f.defaultOn ?? true;
}

/** The state before any switch exists: on, except the default-off powers. */
export function defaults(): FeatureMap {
  return Object.fromEntries(FEATURES.map((f) => [f.key, isDefaultOn(f)])) as FeatureMap;
}

/** Shown wherever a switched-off feature would have been. */
export const FEATURE_OFF_MESSAGE =
  "This feature is turned off by Deligro admin. / यह सुविधा एडमिन ने बंद की है।";
