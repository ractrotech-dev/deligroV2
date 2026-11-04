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

export type FeatureRole = "customer" | "vendor" | "manager" | "driver" | "admin";

/** Who a per-account override attaches to: a vendor's shop, or a person. */
export type FeatureSubjectKind = "restaurant" | "profile";

export interface FeatureDef {
  key: string;
  role: FeatureRole;
  /** Which group it sits under in Admin → App features. */
  group: string;
  label: string;
  /** What switching it off does, in words an operator would use. */
  offMeans: string;
  /**
   * The state with no switch stored. Absent = on. Sensitive manager powers
   * (payments, adjustments, customer contact…) are `false`: someone has to
   * grant them, and a failed switch read leaves them off.
   */
  defaultOn?: boolean;
  /**
   * Set while nothing in the apps can use this feature yet. The admin panel shows
   * this sentence and the switch stays at its default: turning it on would promise
   * something that isn't there. Delete this field when the feature is connected.
   */
  pending?: string;
}

export const FEATURES = [
  // ---- customer ----
  // Off is hidden in the app and website and refused by the server (API routes,
  // and RLS or the SQL function for what a customer's session can reach
  // directly: migration 0201). Guests follow the "for everyone" value.
  //
  // Not here on purpose: browsing, search, placing an order, tracking, the
  // receipt and the door photo are the job; the Help page is only Deligro's
  // contact details, which a customer with a complaint must always reach (there
  // are no customer tickets); grocery, Pick & Drop, pharmacy and online payment
  // have their own platform switches (Admin → Platform config).
  { key: "customer.promo_codes", role: "customer", group: "Ordering", label: "Promo codes", offMeans: "No promo code box at checkout, and the server refuses any code." },
  { key: "customer.tips", role: "customer", group: "Ordering", label: "Rider tips", offMeans: "No tip choice at checkout, and the server refuses an order with a tip." },
  { key: "customer.delivery_notes", role: "customer", group: "Ordering", label: "Delivery instructions", offMeans: "No note for the rider at checkout or later, and the server refuses one." },
  { key: "customer.reorder", role: "customer", group: "Ordering", label: "Order again", offMeans: "No Order again button. Customers add dishes from the menu instead." },
  { key: "customer.cancel", role: "customer", group: "Ordering", label: "Cancel within the time limit", offMeans: "No Cancel button after placing an order. Admin and managers can still cancel." },
  { key: "customer.wallet", role: "customer", group: "Ordering", label: "Wallet", offMeans: "No wallet balance, no code for a rider's change, and points can't be used at checkout." },
  { key: "customer.self_pickup", role: "customer", group: "Ordering", label: "Self pickup", offMeans: "Customers can't choose to collect an order from the shop.", defaultOn: false, pending: "Customers can't choose pickup in any app today. The owner must first decide how they pay while the app is cash only." },
  { key: "customer.reviews", role: "customer", group: "After the order", label: "Rate the order", offMeans: "No stars or review for the shop after delivery, and the server refuses one." },
  { key: "customer.rate_rider", role: "customer", group: "After the order", label: "Rate the rider", offMeans: "No stars for the rider after delivery, and the server refuses one." },
  { key: "customer.favorites", role: "customer", group: "Account", label: "Favourites", offMeans: "No hearts and no Favourites page. What they saved comes back when it is on." },
  { key: "customer.saved_addresses", role: "customer", group: "Account", label: "Saved addresses", offMeans: "No address book: the address is typed for each order and not kept. Old app versions can't add an address while this is off, so update them first." },
  { key: "customer.profile_edit", role: "customer", group: "Account", label: "Edit profile", offMeans: "Name, phone and photo are read-only." },
  // ---- vendor ----
  { key: "vendor.menu_edit", role: "vendor", group: "Menu", label: "Edit menu", offMeans: "Menu is read-only: no adding, editing, deleting, pricing or stock changes." },
  { key: "vendor.menu_import", role: "vendor", group: "Menu", label: "Menu import / export", offMeans: "No CSV import or export of the menu." },
  { key: "vendor.promotions", role: "vendor", group: "Growth", label: "Promotions", offMeans: "Promotions page and coupon creation are hidden." },
  { key: "vendor.earnings", role: "vendor", group: "Money", label: "Earnings & payments", offMeans: "Earnings, overview and Payments are hidden: no money figures, settlements or statements." },
  { key: "vendor.busy_mode", role: "vendor", group: "Shop", label: "Busy mode (+time)", offMeans: "No +10 / +20 / +30 minute pace control." },
  { key: "vendor.open_toggle", role: "vendor", group: "Shop", label: "Open / close shop", offMeans: "The shop cannot open, close, or set its hours or holidays; admin controls it." },
  { key: "vendor.shop_profile", role: "vendor", group: "Shop", label: "Edit shop profile", offMeans: "Shop details, logo, photos and map pin are read-only." },
  { key: "vendor.reject_orders", role: "vendor", group: "Orders", label: "Reject new orders", offMeans: "The kitchen can accept new orders but not reject them. A shop can never cancel an accepted order." },
  { key: "vendor.reports", role: "vendor", group: "Money", label: "Reports", offMeans: "The Reports tab is hidden: no sales report, sales charts or report exports." },
  { key: "vendor.reviews", role: "vendor", group: "Growth", label: "Customer reviews", offMeans: "Reviews are hidden: the shop can't read customer reviews or reply to them." },
  { key: "vendor.marketing", role: "vendor", group: "Growth", label: "Marketing requests", offMeans: "The shop can't ask Deligro for banners, featured spots or campaigns, or see past requests." },
  { key: "vendor.support", role: "vendor", group: "Help", label: "Help & support tickets", offMeans: "No new tickets, replies or ticket history in the app. Deligro can still call the shop." },
  // ---- manager ----
  { key: "manager.phone_orders", role: "manager", group: "Orders", label: "Phone orders", offMeans: "Cannot place orders for customers on the phone." },
  { key: "manager.cash", role: "manager", group: "Money", label: "Cash & expenses", offMeans: "Cannot record COD handovers or expenses." },
  { key: "manager.assign_rider", role: "manager", group: "Riders", label: "Assign rider", offMeans: "Cannot put a rider on an order by hand; dispatch still runs." },
  { key: "manager.move_status", role: "manager", group: "Orders", label: "Move order status", offMeans: "No Mark preparing / ready / on the way / delivered buttons, and no Cancel." },
  { key: "manager.call_customer", role: "manager", group: "Orders", label: "Call customer", offMeans: "Phone numbers and Call buttons on orders are hidden, for the customer and the rider." },
  // Manager app (design 2026-10-21). Screens and the actions on them.
  { key: "manager.orders.view", role: "manager", group: "Screens", label: "Orders", offMeans: "In the Manager app, the Orders tab and order details are hidden. The website's live board stays." },
  { key: "manager.live.view", role: "manager", group: "Screens", label: "Live map", offMeans: "In the Manager app, the Live tab (rider map and delivery lanes) is hidden. The website's live board stays." },
  { key: "manager.vendors.view", role: "manager", group: "Screens", label: "Vendors", offMeans: "Vendor list and vendor details are hidden." },
  { key: "manager.riders.view", role: "manager", group: "Screens", label: "Riders", offMeans: "Rider list, rider details and rider locations (on the Live map too) are hidden." },
  { key: "manager.products.view", role: "manager", group: "Screens", label: "Products", offMeans: "Product oversight is hidden." },
  { key: "manager.support.manage", role: "manager", group: "Screens", label: "Support tickets", offMeans: "Cannot see or work support tickets." },
  { key: "manager.reports.view", role: "manager", group: "Screens", label: "Reports", offMeans: "Reports and exports are hidden." },
  { key: "manager.reassign_rider", role: "manager", group: "Riders", label: "Reassign rider", offMeans: "Cannot move a delivery from one rider to another." },
  { key: "manager.orders.escalate", role: "manager", group: "Orders", label: "Escalate orders", offMeans: "Cannot raise an order issue to the admin team." },
  { key: "manager.alerts.configure", role: "manager", group: "Settings", label: "Alert thresholds", offMeans: "Alert thresholds are read-only." },
  { key: "manager.finance.view", role: "manager", group: "Money", label: "Finance", offMeans: "The Finance tab, finance reports and all shop and rider money are hidden. Order totals and a customer's spend stay, to help on a call." },
  { key: "manager.marketing.manage", role: "manager", group: "Growth", label: "Marketing", offMeans: "Cannot see or decide marketing requests and campaigns." },
  { key: "manager.offers.manage", role: "manager", group: "Growth", label: "Offers", offMeans: "Cannot create or change offers and promo codes." },
  { key: "manager.customers.view", role: "manager", group: "Customers", label: "Customers", offMeans: "Customer accounts are hidden." },
  { key: "manager.vendors.status", role: "manager", group: "Vendors", label: "Vendor status", offMeans: "Cannot approve, reject, suspend or reactivate vendors." },
  { key: "manager.riders.status", role: "manager", group: "Riders", label: "Rider status", offMeans: "Cannot approve, reject, suspend or reactivate riders." },
  { key: "manager.exceptions.decide", role: "manager", group: "Orders", label: "Decide delivery exceptions", offMeans: "Cannot approve, reject or acknowledge a rider's delivery exception." },
  { key: "manager.products.moderate", role: "manager", group: "Products", label: "Moderate listings", offMeans: "Cannot hide or approve product listings. Flagging one still works." },
  { key: "manager.weather.manage", role: "manager", group: "Settings", label: "Weather notices", offMeans: "Cannot set rain or storm notices for a zone; the automatic reading still runs." },
  // Sensitive: off until an admin grants them to a person or to all managers.
  { key: "manager.orders.correct", role: "manager", group: "Orders", label: "Correct orders", offMeans: "Cannot apply corrections to an order.", defaultOn: false },
  { key: "manager.vendors.onboard", role: "manager", group: "Vendors", label: "Onboard vendors", offMeans: "Cannot add new vendors.", defaultOn: false },
  { key: "manager.riders.onboard", role: "manager", group: "Riders", label: "Onboard riders", offMeans: "Cannot create rider accounts.", defaultOn: false },
  { key: "manager.finance.initiate_payment", role: "manager", group: "Money", label: "Initiate payments", offMeans: "Cannot put a settlement or payout up for approval.", defaultOn: false },
  { key: "manager.finance.approve_payment", role: "manager", group: "Money", label: "Approve payments", offMeans: "Cannot mark a settlement or payout as paid.", defaultOn: false },
  { key: "manager.finance.adjust", role: "manager", group: "Money", label: "Financial adjustments", offMeans: "Cannot record corrections and adjustments.", defaultOn: false },
  { key: "manager.customers.contact", role: "manager", group: "Customers", label: "Customer contact details", offMeans: "On the Customers screens phone numbers stay masked; no search by phone. Live orders follow Call customer.", defaultOn: false },
  { key: "manager.customers.suspend", role: "manager", group: "Customers", label: "Suspend customers", offMeans: "Cannot suspend or restrict customer accounts.", defaultOn: false },
  { key: "manager.products.adjust_stock", role: "manager", group: "Products", label: "Adjust stock", offMeans: "Stock stays with the vendor.", defaultOn: false },
  { key: "manager.products.bulk_menu", role: "manager", group: "Products", label: "Bulk menu upload", offMeans: "Can't change a menu from a sheet. Downloading and checking one still works.", defaultOn: false },
  { key: "manager.products.replace_photo", role: "manager", group: "Products", label: "Replace photos", offMeans: "Wrong photos can only be flagged.", defaultOn: false },
  { key: "manager.audit.view_zone", role: "manager", group: "Settings", label: "Zone audit log", offMeans: "Sees only their own activity, not their zones' audit log.", defaultOn: false },
  // ---- rider ----
  { key: "driver.history", role: "driver", group: "Work", label: "Delivery history", offMeans: "History tab is hidden." },
  { key: "driver.earnings", role: "driver", group: "Money", label: "Salary & payments", offMeans: "The Salary tab is hidden: salary, payments and statements. Today's delivery count on Home stays." },
  { key: "driver.performance", role: "driver", group: "Work", label: "Performance & ratings", offMeans: "The Performance screen is hidden: customer ratings, rates and the monthly report." },
  { key: "driver.cash", role: "driver", group: "Money", label: "Cash in hand & deposits", offMeans: "The Cash screen is hidden: no cash-in-hand figure or deposits in the app; a manager records handovers. Collecting cash on delivery still works." },
  { key: "driver.cod_change", role: "driver", group: "Money", label: "Cash change to wallet", offMeans: "The rider can't put a cash customer's extra money into their wallet; change is given back in cash." },
  { key: "driver.support", role: "driver", group: "Help", label: "Help tickets", offMeans: "No new tickets, replies or ticket history. Calling or WhatsApping Deligro, SOS and emergency reports still work." },
  { key: "driver.call_customer", role: "driver", group: "Work", label: "Call customer", offMeans: "Call buttons are hidden; the rider uses the delivery code only." },
  { key: "driver.navigation", role: "driver", group: "Work", label: "Navigation", offMeans: "No Navigate / Google Maps button. The map inside the app stays." },
  { key: "driver.profile_edit", role: "driver", group: "Account", label: "Edit profile", offMeans: "Profile is read-only." },
  // ---- admin console ----
  // Whole console screens, switched for every admin at once (no per-person
  // exceptions). Off hides the screen's menu entry and shortcuts, the route
  // shows a notice, and its Server Actions refuse. Turning it back on is this
  // same switch, so an admin can never lock themselves out of it. None today:
  // the first one went with the Refunds page (owner's rule, 2026-11-04).
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]["key"];

export const ROLE_SUBJECT: Record<FeatureRole, FeatureSubjectKind> = {
  customer: "profile",
  vendor: "restaurant",
  manager: "profile",
  driver: "profile",
  admin: "profile",
};

export const ROLE_LABEL: Record<FeatureRole, string> = {
  customer: "Customers",
  vendor: "Shops",
  manager: "Managers",
  driver: "Riders",
  admin: "Admin console",
};

/** Roles whose switches are role-wide only: no per-shop or per-person exceptions. */
export const ROLE_WIDE_ONLY: readonly FeatureRole[] = ["admin"];

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

/** One role's switches from a whole map: what is safe to hand to that role's app. */
export function pickRole(role: FeatureRole, map: FeatureMap): Record<string, boolean> {
  return Object.fromEntries(featuresFor(role).map((f) => [f.key, map[f.key as FeatureKey]]));
}

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

/**
 * Shown wherever a switched-off feature would have been. English only: manager,
 * shop and rider surfaces are, and a customer reads it the same way.
 */
export const FEATURE_OFF_MESSAGE = "This feature is turned off by Deligro admin.";
