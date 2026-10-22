/**
 * Build plan + live delivery tracker — single source of truth for `/build`.
 *
 * The original plan was a 5-week (~35 day) run from "static UI + partial
 * backend" to a shippable v1. That window closed on 2026-08-06 with payments
 * and the production deploy still open, and with a second body of work — vendor
 * management, the manager role, storefront depth, the first security audit —
 * shipped alongside it. Both are recorded here: the original weeks keep their
 * numbering, and the work that landed outside the plan is filed under its own
 * later milestone rather than backdated into a week it did not belong to.
 *
 * Update `status` as tasks land; the tracker route renders straight from this
 * file, so the page is always in sync with reality. A task marked "done" must
 * actually work end to end — if it half-works, say so in `detail` and leave it
 * "active". A stale tracker is worse than none (see AGENTS.md).
 *
 * status: "done" | "active" | "todo" | "blocked"
 *
 * ---------------------------------------------------------------------------
 * Verified against the code on 2026-08-13. That pass was worth doing: this file
 * had drifted in *both* directions, which is the part worth remembering.
 *
 *   * Work shipped and never ticked off — the manager board and rider dispatch
 *     (slice E), and the refund deny path, which this file still described as
 *     broken long after it was fixed. Reading it, you would have rebuilt three
 *     things that already worked.
 *   * Work described more kindly than it was — "coupons: half-wired" when in
 *     fact nothing in the app had ever called the endpoint, so there was no
 *     wiring at all; "pickup OTP: no UI" when the rider's half shipped and only
 *     the kitchen's check is missing.
 *   * A decision filed as debt — a nonce-based CSP sat here as a `todo` while
 *     its own `detail` said it was an accepted risk. It now lives only in
 *     docs/SECURITY_AUDIT.md, where accepted risks belong.
 *
 * Neither direction is harmless: the first wastes a rebuild, the second hides
 * a gap, the third inflates what is left. When you change a status, check the
 * code rather than your memory of it — and when a `detail` states a fact about
 * the codebase ("no UI", "the deny path fails"), that is a claim with a shelf
 * life, so re-read it before trusting it.
 * ---------------------------------------------------------------------------
 */

export type TaskStatus = "done" | "active" | "todo" | "blocked";

export type BuildTab = "customer" | "vendor" | "driver" | "manager" | "admin";

interface Task {
  title: string;
  detail?: string;
  /** Postgres table / column this task touches — shown on `/build`. */
  db?: string;
  status: TaskStatus;
}

export interface Milestone {
  week: number;
  range: string; // human dates within the 1-month window
  title: string;
  goal: string;
  tasks: Task[];
}

export interface BuildTabConfig {
  id: BuildTab;
  label: string;
  portal: string;
  summary: string;
}

export const BUILD_TABS: BuildTabConfig[] = [
  {
    id: "customer",
    label: "Customer",
    portal: "/",
    summary: "Browse, OTP login, checkout, tracking",
  },
  {
    id: "vendor",
    label: "Vendor",
    portal: "/vendor",
    summary: "Restaurant owners — orders, menu, earnings",
  },
  {
    id: "driver",
    label: "Driver",
    portal: "/driver",
    summary: "Salary riders — jobs, routes, attendance (no commission UI)",
  },
  {
    id: "manager",
    label: "Manager",
    portal: "/manager",
    summary: "Scoped ops — phone orders, dispatch, no finance",
  },
  {
    id: "admin",
    label: "Admin",
    portal: "/admin",
    summary: "Platform ops — vendors, orders, refunds, team",
  },
];

/**
 * Project window. `ship` was 2026-08-06 for the original v1 scope; that date
 * passed with payments, key rotation and the production deploy outstanding, so
 * it now points at the revised target — change it to the real one.
 */
export const PROJECT = {
  name: "Deligro",
  tagline: "Craving to doorstep",
  start: "2026-07-07",
  ship: "2026-08-21",
  durationLabel: "6 weeks · v1 scope + hardening",
};

const MILESTONES: Milestone[] = [
  {
    week: 0,
    range: "Already shipped",
    title: "Foundation (done before Day 1)",
    goal: "Static customer UI + first backend slice already merged.",
    tasks: [
      { title: "Customer app UI/UX", detail: "Bento home, glass cart, tracking, dark mode", status: "done" },
      { title: "Cold-start splash + onboarding carousel", detail: "3 brand slides, once per device", status: "done" },
      { title: "Role portals scaffold", detail: "/vendor, /driver, /admin dashboards", status: "done" },
      { title: "Supabase auth + RLS backend", detail: "3-check model, security headers, Upstash/KV rate limit (memory fallback)", status: "done" },
      { title: "Live catalog + orders API + vendor board", detail: "Phase 2 wiring", status: "done" },
    ],
  },
  {
    week: 1,
    range: "Days 1–10",
    title: "Legacy DB → Supabase",
    goal: "Move real Bemetara data off the old MySQL export into the new app — catalog first, then customers & history.",
    tasks: [
      {
        title: "Legacy DB audit",
        detail: "scripts/lib/legacy-db.ts scopes — ~49 tables, 5 active / 62 Bemetara shops",
        status: "done",
      },
      {
        title: "Catalog ETL + SQL seed generator",
        detail: "import-legacy-catalog.ts + generate-legacy-seed-sql.ts (SQL is generated, not committed)",
        status: "done",
      },
      {
        title: "Unsplash images for migrated catalog",
        detail: "Moved off Pexels — scripts/lib/unsplash-images.ts + db:migrate-images backfill category-matched CDN URLs where legacy storage paths are unavailable",
        status: "done",
      },
      {
        title: "Seed catalog in Supabase",
        detail: "62 Bemetara shops + ~3.7k legacy menu items — active & inactive (is_open from legacy status)",
        db: "restaurants · menu_items",
        status: "done",
      },
      {
        title: "Legacy delivery rules in app",
        detail: "Fee, free-delivery threshold, min order and radius now read from the platform_settings row and bill through lib/pricing.ts; checkout blocks below the minimum",
        db: "platform_settings · orders.delivery_fee",
        status: "done",
      },
      {
        title: "Per-restaurant vendor accounts",
        detail: "One owner per migrated shop — not all under vendor@deligro.demo",
        db: "auth.users · profiles.role = restaurant · restaurants.owner_id",
        status: "done",
      },
      {
        title: "Customer import (phone OTP)",
        detail: "3,578 unique phones imported — no plaintext passwords; OTP re-verify",
        db: "auth.users · profiles.role = customer · profiles.phone",
        status: "done",
      },
      {
        title: "Order history import",
        detail: "~13.2k orders imported — pname HTML → order_items (db:import-legacy-orders)",
        status: "done",
      },
      {
        title: "Reviews import",
        detail: "Ratings rolled into restaurants via catalog ETL; 491 legacy rows still not written to reviews (in-app reviews ship separately — see Week 6)",
        db: "restaurants.rating · reviews",
        status: "todo",
      },
    ],
  },
  {
    week: 2,
    range: "Days 11–17",
    title: "Guest browse + phone-OTP order gate",
    goal: "Anyone can explore without an account; login is demanded only at order — via phone OTP.",
    tasks: [
      { title: "Skip onboarding for signed-in users", detail: "Gate the 3-slide carousel on auth, not just localStorage", status: "done" },
      { title: "Phone-number OTP login", detail: "Custom Renflair SMS OTP + magic-link session; the customer door at /login (operators sign in at their own portal's page)", status: "done" },
      { title: "OTP verify screen", detail: "6-digit code entry, 30s resend cooldown, DB rate limit (6/hour)", status: "done" },
      { title: "\"Order\" triggers auth", detail: "Proxy gates checkout/orders/profile → /login?next=… (OTP first); portal paths bounce to their own login instead", status: "done" },
      { title: "Post-login profile bootstrap", detail: "First name + save on first order — edit sheet exists, still not forced", status: "todo" },
    ],
  },
  {
    week: 3,
    range: "Days 15–21",
    title: "Real ordering flow (address → order now → success)",
    goal: "End-to-end order from a real saved address to a live-tracked, successful order.",
    tasks: [
      { title: "Saved addresses (CRUD)", detail: "Per-user rows + RLS; mock ADDRESSES only when Supabase unset", status: "done" },
      { title: "Add-address sheet", detail: "Map pin + manual entry, set default", status: "done" },
      { title: "Checkout on live data", detail: "Saved address + tip → POST /api/orders (COD implicit; no timing picker)", status: "done" },
      { title: "Order success screen", detail: "Hand-off via /orders/[id]?placed=1 toast on tracking", status: "done" },
      { title: "Live order tracking", detail: "Status stepper + polled /api/orders/[id]/tracking", status: "done" },
      { title: "Cancel an order", detail: "POST /api/orders/[id]/cancel — customer-initiated, rate limited", db: "orders.status", status: "done" },
    ],
  },
  {
    week: 4,
    range: "Days 22–28",
    title: "Restaurant · Driver · Admin on live data",
    goal: "All three operator portals run on the real DB, not mocks.",
    tasks: [
      { title: "Restaurant order board (live)", detail: "Accept/Reject → Food ready; AutoRefresh poll (not Supabase Realtime)", status: "done" },
      { title: "Menu availability toggles", detail: "Owner writes menu_items.available via /vendor/menu toggle + RLS", status: "done" },
      { title: "Driver flow", detail: "Accept → picked up → delivered + delivery OTP; salary model (no commission/earnings on board); online toggle still local; pickup OTP still missing", status: "active" },
      {
        title: "Admin orders + refunds",
        detail: "Live /admin/orders + /admin/refunds. Approve and deny both work — the deny path no longer writes the 'rejected' value that refund_status has never accepted",
        db: "refunds.status",
        status: "done",
      },
      {
        title: "Role assignment tooling",
        detail: "Admin → Settings → Team creates manager and driver logins (service-role, past the lock_role trigger); vendors get accounts from the registration wizard",
        db: "profiles.role · lock_role()",
        status: "done",
      },
    ],
  },
  {
    week: 5,
    range: "Days 29–35",
    title: "Payments, hardening, QA & launch",
    goal: "Payments live, security tightened, tested, deployed.",
    tasks: [
      {
        title: "Online payments (UPI/cards)",
        detail: "Razorpay wired end to end — order → checkout → signature verify → idempotent webhook, with payments recorded and the kitchen board gated on payment. Ships OFF: the customer sees \"Available soon\" until an admin enables it and the keys are set",
        db: "payments · orders.payment_status (migration 0025)",
        // Built and gated correctly; what remains is switching it on, which is
        // the "Go live on Razorpay" task below and not a code change.
        status: "done",
      },
      {
        title: "Payment signature tests",
        detail: "npm run test:payments — replay, tampering, wrong-secret and raw-body cases over lib/payments/signatures.ts. Offline; runs first in test:qa",
        status: "done",
      },
      {
        title: "Go live on Razorpay",
        detail: "Live keys, webhook registered at /api/payments/razorpay/webhook, a real test transaction, then flip Settings → Platform → Online payment",
        status: "todo",
      },
      { title: "Distributed rate limit", detail: "Upstash/Vercel KV so limits hold across instances; memory fallback when unset", status: "done" },
      {
        title: "First full security audit + remediation",
        detail: "3 Critical / 5 High / 10 Medium / 9 Low across app + migrations 0001–0021; closed in migration 0024 and app changes. docs/SECURITY_AUDIT.md",
        status: "done",
      },
      {
        title: "Deployment audit checklist",
        detail: "docs/DEPLOYMENT_AUDIT.md — run before every promotion; sign-off table still empty",
        status: "done",
      },
      {
        title: "Rotate vendor passwords + Supabase keys",
        detail: "Outstanding action from the audit — restaurants.temp_password held live credentials on a publicly readable row until 0024 dropped it. Passwords issued before then are still live and should be rotated; 0039 keeps their replacements in a service-role-only table instead",
        db: "auth.users",
        status: "todo",
      },
      {
        // Was "Nonce-based CSP", carried as a todo while its own detail said it
        // was an accepted risk. It lives in docs/SECURITY_AUDIT.md under
        // accepted risks (M-5); a task list is for things someone intends to
        // do, and counting a decision as debt makes the tracker read wrong.
        title: "Checkout could not complete an order",
        detail:
          "0024 locked `total` against non-admins, and recompute_order_total() — the only thing that writes an authoritative total — was blocked by that same guard, so every checkout 500'd after writing an orphan order and its items. The guard assumed SECURITY DEFINER changed the caller's identity; it changes privileges, not auth.uid(). Fixed in 0030 by testing current_user from a SECURITY INVOKER guard. `total` is now pinned at INSERT too, so it cannot be forged past the app either",
        db: "guard_order_update() · recompute_order_total() (migration 0030)",
        status: "done",
      },
      { title: "Per-portal sign-in", detail: "The global /login is gone: /admin/login, /vendor/login, /manager/login, /driver/login each admit only their own portal; /login is the customer door. MFA removed with it", status: "done" },
      { title: "E2E QA + IDOR tests", detail: "npm run test:qa — RLS/HTTP cross-account 404s + E2E smoke; ZAP via test:zap on staging", status: "done" },
      {
        title: "Production deploy",
        detail:
          "Vercel + Supabase prod, env + migrations 0001–0031 — no sign-off recorded yet. 0028–0031 are not on the live database; 0030 is the urgent one, because without it no customer can complete a checkout",
        status: "todo",
      },
    ],
  },
  {
    week: 6,
    range: "Shipped past the plan",
    title: "Storefront depth",
    goal: "Customer-facing surface that was never in the 5-week plan but is live today.",
    tasks: [
      {
        title: "Search + category browse",
        detail: "/search over the live catalog with category pre-filter",
        db: "restaurants · menu_items",
        status: "done",
      },
      {
        title: "All-stores directory",
        detail: "/stores — full shop list with real distances from the picked location",
        db: "restaurants.lat · restaurants.lng",
        status: "done",
      },
      {
        title: "Favorites",
        detail: "Heart a shop; /profile/favorites + /api/favorites, RLS to the owning user",
        db: "favorites",
        status: "done",
      },
      {
        title: "Ratings & reviews (in app)",
        detail: "POST /api/reviews — insert gated by RLS to the customer's own delivered order; averages feed the vendor profile",
        db: "reviews · restaurants.rating",
        status: "done",
      },
      {
        title: "Promo banners + tracking",
        detail: "Admin-managed carousel with impression/click events",
        db: "banners · banner_events",
        status: "done",
      },
      {
        title: "Coupons",
        detail:
          "Wired end to end (closes audit M-7). Checkout has a code field and an itemised bill; the discount is re-derived server-side by apply_coupon_to_order() from the order's own items and recorded in coupon_redemptions in the same transaction. Codes are single-use per customer by default — before this they had no limit of any kind, so any code was a permanent price cut. 0041 made them creatable: /admin/coupons and /vendor/promotions, codes scoped to one shop, funded_by recorded on the order so settlement bills the right party, and the shop's offer badge derived from its own live codes instead of typed into a free-text field",
        db: "coupons · coupon_redemptions · orders.discount · orders.discount_funded_by · restaurants.offer (migrations 0031, 0041)",
        status: "done",
      },
      {
        title: "Push notifications",
        detail: "OneSignal web push — SDK init in the customer layout, subscription saved via /api/notifications/register, order events fan out server-side",
        db: "profiles (push id)",
        status: "done",
      },
      {
        title: "Profile avatar upload",
        detail: "POST /api/profile/avatar to Supabase Storage",
        db: "profiles.avatar_url",
        status: "done",
      },
      {
        title: "Location picker on Google Maps",
        detail: "Pin-drop + geocode, pinned to Bemetara; no forced permission popup on cold start",
        db: "addresses.lat · addresses.lng",
        status: "done",
      },
      {
        title: "Help, About & notification settings",
        detail: "/profile/help · /profile/about · /profile/notifications",
        status: "done",
      },
      {
        title: "Modals contained in the phone frame",
        detail: "Dialogs render inside the device shell instead of the browser viewport",
        status: "done",
      },
    ],
  },
];

/** Role-specific trackers — vendor / driver / manager / admin portals + DB wiring. */
const ROLE_MILESTONES: Record<Exclude<BuildTab, "customer">, Milestone[]> = {
  vendor: [
    {
      week: 0,
      range: "Shipped",
      title: "Vendor portal foundation",
      goal: "Restaurant owners can sign in and see their kitchen board scaffold.",
      tasks: [
        {
          title: "Portal routes + nav",
          detail: "/vendor · /vendor/overview · /vendor/menu · /vendor/earnings · /vendor/profile · /vendor/settings",
          db: "—",
          status: "done",
        },
        {
          title: "Role gate (restaurant only)",
          detail: "Superseded by the ownership gate — see Week 3",
          db: "profiles.role = 'restaurant'",
          status: "done",
        },
        {
          title: "Kitchen order board UI",
          detail: "Incoming / preparing columns — VendorOrdersBoard",
          db: "orders.status · order_items",
          status: "done",
        },
        {
          title: "Live board from Supabase",
          detail: "listKitchenOrders() when configured; mock fallback",
          db: "orders WHERE restaurant_id = owns_restaurant()",
          status: "done",
        },
      ],
    },
    {
      week: 1,
      range: "Legacy migration",
      title: "Vendor data in Postgres",
      goal: "Every Bemetara shop has a listing, menu, and its own owner account.",
      tasks: [
        {
          title: "Legacy restaurant catalog",
          detail: "62 Bemetara shops + ~3.7k menu items seeded",
          db: "restaurants · menu_items.external_id LIKE 'legacy-%'",
          status: "done",
        },
        {
          title: "Per-shop owner accounts",
          detail: "Auth users linked via restaurants.owner_id (~63 restaurant profiles)",
          db: "auth.users · profiles.role = restaurant · restaurants.owner_id",
          status: "done",
        },
        {
          title: "Owner login credentials",
          detail: "Owners sign in with their mobile number and a password. The value is kept in vendor_login_credentials (0039) — service-role only, admin-readable — so the desk can read it back; the publicly readable restaurants.temp_password that audit C-2 found was dropped in 0024 and is not coming back",
          db: "auth.users",
          status: "done",
        },
        {
          title: "Menu availability toggles (live)",
          detail: "Owner writes menu_items.available via /vendor/menu + RLS",
          db: "menu_items.available · owns_restaurant()",
          status: "done",
        },
        {
          title: "Restaurant open/closed toggle",
          detail: "Owner flips restaurants.is_open from the vendor portal (RestaurantOpenToggle)",
          db: "restaurants.is_open",
          status: "done",
        },
      ],
    },
    {
      week: 2,
      range: "Operations",
      title: "Vendor on live orders",
      goal: "Accept → prepare → ready flows hit real rows, not mocks.",
      tasks: [
        {
          title: "Accept / reject incoming orders",
          detail: "Status placed → kitchen or cancelled via PATCH /api/orders/[id]/status",
          db: "orders.status",
          status: "done",
        },
        {
          title: "Mark food ready",
          detail: "kitchen → ready; driver pool reads orders.status = ready",
          db: "orders.status",
          status: "done",
        },
        {
          title: "Near-realtime order updates",
          detail: "AutoRefresh poll every 8s on kitchen board (runs while hidden) — not a Supabase Realtime channel",
          db: "orders (poll)",
          status: "done",
        },
        {
          title: "Earnings from real orders",
          detail: "/vendor/earnings aggregates delivered orders.total",
          db: "orders.total",
          status: "done",
        },
      ],
    },
    {
      week: 3,
      range: "Shipped past the plan",
      title: "A portal a kitchen can actually run on",
      goal: "Mobile-first tools for a busy counter — menu production, real analytics, correct days.",
      tasks: [
        {
          title: "Mobile kitchen-ops hardening",
          detail: "Touch-sized order board, sticky headers, loading states, sidebar rework",
          status: "done",
        },
        {
          title: "Menu production tools",
          detail: "Create/edit items in a sheet, strike-through discount price, and a customer-eye preview of the live menu",
          db: "menu_items · menu_items.discount_price",
          status: "done",
        },
        {
          title: "Earnings analytics",
          detail: "/vendor/earnings charts + /api/vendor/earnings — payouts, order mix, trend",
          db: "orders.total · orders.delivery_fee",
          status: "done",
        },
        {
          title: "Order history",
          detail: "/api/vendor/orders/history — paged past orders beyond the live board",
          db: "orders",
          status: "done",
        },
        {
          title: "Store profile self-service",
          detail: "Owner edits shop details, hours and imagery from /vendor/profile",
          db: "restaurants",
          status: "done",
        },
        {
          title: "IST day boundaries",
          detail: "lib/utils/ist-time.ts — 'today' means the vendor's day, not UTC's",
          status: "done",
        },
        {
          title: "Overview dashboard",
          detail: "/vendor/overview — the day at a glance on live rows",
          db: "orders · menu_items",
          status: "done",
        },
      ],
    },
    {
      week: 4,
      range: "Shipped past the plan",
      title: "Owner onboarding & access",
      goal: "A real shop can be onboarded end to end by an operator, without a role swap costing the owner their customer account.",
      tasks: [
        {
          title: "Ownership-based portal gate",
          detail: "hasVendorAccess() — access follows restaurants.owner_id, not profiles.role, so the gate no longer depends on a role change",
          db: "restaurants.owner_id",
          status: "done",
        },
        {
          title: "\"Stay both\" — customer becomes a vendor",
          detail: "An existing customer can own a shop and keep role='customer', so order-insert RLS still lets them shop",
          db: "profiles.role · restaurants.owner_id",
          status: "done",
        },
        {
          title: "Owner phone OTP verification",
          detail: "Verified during registration or later from Edit; non-blocking",
          db: "restaurants.owner_phone_verified",
          status: "done",
        },
        {
          title: "Shop logo upload",
          detail: "Public vendor-logos storage bucket, wired into the wizard",
          db: "storage: vendor-logos",
          status: "done",
        },
        {
          title: "Legal documents (FSSAI/GST/PAN)",
          detail: "Private vendor-docs bucket + registry; served only via short-lived signed URLs from admin-gated code",
          db: "vendor_documents",
          status: "done",
        },
        {
          title: "One-time credential handoff",
          detail: "Password generated, shown once, never stored — replaces the plaintext column dropped in 0024",
          db: "auth.users",
          status: "done",
        },
        {
          title: "Vendor payouts / settlements",
          detail:
            "/admin/settlements — manual IST date-range ledger: draft from delivered orders (online remits vendor net, COD deducts commission), Mark paid with UTR, Void releases orders (migration 0028)",
          db: "vendor_settlements · vendor_settlement_orders",
          status: "done",
        },
      ],
    },
  ],
  driver: [
    {
      week: 0,
      range: "Shipped",
      title: "Driver portal foundation",
      goal: "Delivery partner UI scaffold with demo jobs.",
      tasks: [
        {
          title: "Portal route + layout",
          detail: "/driver — DriverBoard component",
          db: "—",
          status: "done",
        },
        {
          title: "Role gate (driver only)",
          detail: "requireRole('driver') in driver layout",
          db: "profiles.role = 'driver'",
          status: "done",
        },
        {
          title: "Demo job board",
          detail: "AVAILABLE_JOBS mock when Supabase unavailable",
          db: "—",
          status: "done",
        },
        {
          title: "Live board from Supabase",
          detail: "getDriverBoard() for assigned driver",
          db: "deliveries · orders",
          status: "done",
        },
      ],
    },
    {
      week: 1,
      range: "Schema",
      title: "Driver data model",
      goal: "Deliveries table links orders to drivers with status machine.",
      tasks: [
        {
          title: "Deliveries table + RLS",
          detail: "assigned → picked_up → delivered (accept inserts assigned)",
          db: "deliveries.status · deliveries.driver_id",
          status: "done",
        },
        {
          title: "Driver profile seed",
          detail: "Demo driver@deligro.demo from db:seed-users",
          db: "profiles.role = 'driver'",
          status: "done",
        },
        {
          title: "Legacy driver import",
          detail: "No driver table in legacy MySQL — onboard fresh",
          db: "—",
          status: "done",
        },
        {
          title: "Rider accounts from the admin panel",
          detail: "Admin → Settings → Team creates driver logins with a one-time password",
          db: "profiles.role = 'driver'",
          status: "done",
        },
      ],
    },
    {
      week: 2,
      range: "Operations",
      title: "Live jobs — no commission UI",
      goal: "Riders are on salary. Board shows jobs and trip progress only — never commission, per-trip payout, or earnings.",
      tasks: [
        {
          title: "Salary model on the board",
          detail:
            "Done. `DriverBoardData.today.earnings` and `DeliveryJob.payout` are both gone — the FIELDS, not just the tiles, so a screen cannot put them back. `payoutFor()` is deleted from driver-orders.ts. The parked per-order commission helper in pricing.ts and the Settings form's commission / minimum-payout fields were deleted in rider app Phase 3: rider pay is now the admin rate card (migration 0083), written to the rider_earnings ledger by the database at delivery, so the per-delivery, salary-plus-incentives and pure-salary models are all settings, not code.",
          db: "rider_commission / rider_min_payout columns (unread) · rider_earnings (0083)",
          status: "done",
        },
        {
          title: "Dispatch — offer the pickup to one rider",
          detail:
            "At vendor-accept, chooseRider() picks whoever is not mid-delivery and, among those, nearest the shop (last reported fix, ignored past 30 min); an unanswered offer counts as load, so several vendors accepting at once fan out instead of piling on one idle rider. If the whole fleet is committed it falls back to least-loaded then nearest. The pick is recorded as deliveries.offered_driver_id and pushed to that rider with the kitchen's prep estimate, then re-run at `ready`. It is a first refusal, not an assignment: after EXCLUSIVE_OFFER_MS the order opens to everyone, so an ignored offer never strands an order",
          db: "deliveries.offered_driver_id · offered_at",
          status: "done",
        },
        {
          title: "Accept available delivery",
          detail:
            "acceptDelivery claims the order for the rider (service role): it updates the standing offer row where one exists and inserts otherwise, refusing an order still inside another rider's exclusivity window",
          db: "deliveries",
          status: "done",
        },
        {
          title: "Addresses a rider can actually navigate to",
          detail:
            "DeliveryJob carries a DeliveryStop at each end — label, full street line, landmark, pin — instead of the old pickupArea/dropArea, which were the shop's name repeated and the customer's saved LABEL (\"Home\"). Navigate opens the maps app on the pin, falling back to a geocode of the written address for the many shops no vendor has pinned",
          db: "orders.address · restaurants.address/lat/lng",
          status: "done",
        },
        {
          title: "Arrival notification at 500 m",
          detail:
            "The rider's own position report fires a one-time push to the customer when they first come within ARRIVAL_RADIUS_M of the drop, latched on deliveries.arrival_notified_at so a ten-second location ping cannot become a ten-second notification",
          db: "deliveries.arrival_notified_at",
          status: "done",
        },
        {
          title: "Pickup OTP verification",
          detail:
            "Half done: the rider's board shows the code to read to the counter (getPickupOtp, RLS-scoped to the parties to that handover). The kitchen has no screen to check it against, so nothing yet *verifies* the courier — it is a code read aloud and trusted",
          db: "orders.pickup_otp",
          status: "active",
        },
        {
          title: "Delivery OTP verification",
          detail: "Customer shows OTP; driver verifies in advanceDelivery",
          db: "orders.delivery_otp",
          status: "done",
        },
        {
          title: "Current job clarity",
          detail:
            "Mostly there: `DriverActive.leg` is a real TO_PICKUP/TO_CUSTOMER phase, and the card now carries the full address of whichever end the leg is heading for plus a cash-vs-prepaid instruction. What is missing is *what they are delivering* — the job still says `items: 4`, a count, so a rider cannot check the bag against the order",
          db: "deliveries.status · order_items",
          status: "active",
        },
        {
          title: "Trip history (no money)",
          detail: "Today's trip count on the board exists; full history of delivered + cancelled jobs with destinations still missing",
          db: "deliveries.delivered_at · orders.cancelled_at",
          status: "todo",
        },
      ],
    },
    {
      week: 3,
      range: "Attendance & visibility",
      title: "On duty, location, admin oversight",
      goal: "Rider app on/off and live location are real server state so admin/manager can see who is working and where they are on the road.",
      tasks: [
        {
          title: "Online / offline toggle (persisted)",
          detail: "Still local useState in DriverBoard — going offline does not leave the dispatch pool on the server",
          db: "profiles.is_online (TBD) or driver_shifts",
          status: "todo",
        },
        {
          title: "Attendance with location",
          detail: "Clock-on / shift record with last known lat/lng + timestamp so attendance is auditable, not just a boolean",
          db: "driver_shifts or profiles.driver_lat/lng",
          status: "todo",
        },
        {
          title: "Live GPS while on a job",
          detail: "POST /api/driver/location already writes deliveries.driver_lat/lng; ensure phase (pickup vs dropoff) is obvious from deliveries.status",
          db: "deliveries.driver_lat · driver_location_source",
          status: "active",
        },
        {
          title: "Admin sees rider on/off + route phase",
          detail: "Admin/manager can see which riders have the app on, who is idle vs going to vendor vs going to customer, and last fix time",
          db: "deliveries · profiles",
          status: "todo",
        },
        {
          title: "Cancelled jobs for the rider",
          detail: "Rider history includes cancelled deliveries (and who cancelled) so disputes are visible without digging in admin",
          db: "orders.cancelled_at · deliveries",
          status: "todo",
        },
      ],
    },
    {
      week: 4,
      range: "COD change → wallet",
      title: "Safe customer wallet top-up from COD",
      goal:
        "When a COD customer overpays (e.g. ₹500 for a ₹490 order), the rider can credit only the calculated excess to that customer's wallet — never free-form amounts. The schema is already there: `wallet_transactions` and `profiles.wallet_balance` have existed since 0006 and nothing has ever written to either. This is the feature, not the table.",
      tasks: [
        {
          title: "COD cash-received entry",
          detail: "On COD handover, rider taps Add change → enters amount received (e.g. 500); UI never asks for a wallet credit amount directly",
          db: "orders.payment_method = cash",
          status: "todo",
        },
        {
          title: "Server computes excess only",
          detail: "excess = cash_received − order.total; reject if ≤ 0, non-COD, not this rider's active/delivered job, or cash_received above a hard cap",
          db: "wallet_transactions · orders.total",
          status: "todo",
        },
        {
          title: "Confirm credit to that customer",
          detail: "App shows 'Add ₹{excess} to {customer} wallet?' — confirm writes wallet_transactions (service role) + bumps profiles.wallet_balance for the order's customer only",
          db: "wallet_transactions.order_id · profiles.wallet_balance",
          status: "todo",
        },
        {
          title: "Anti-fraud guards",
          detail: "One wallet credit per order (unique on order_id + reason); require delivery OTP verified first; rate-limit; rider cannot pick arbitrary user_id; admin audit trail",
          db: "wallet_transactions reason = 'cod_change'",
          status: "todo",
        },
      ],
    },
  ],
  manager: [
    {
      week: 0,
      range: "Shipped past the plan",
      title: "A real, scoped operator role",
      goal: "An operations sub-admin who can move orders and riders but cannot touch money, config or vendors.",
      tasks: [
        {
          title: "`manager` as a real profile role",
          detail: "Added as its own enum value in its own migration — Postgres refuses to USE a new label in the transaction that adds it",
          db: "user_role enum · migration 0022",
          status: "done",
        },
        {
          title: "Manager RLS policies",
          detail: "Order and delivery access without finance, platform settings or vendor management",
          db: "migration 0023",
          status: "done",
        },
        {
          title: "Gated portal",
          detail: "/manager layout + landing; no longer an alias for admin",
          db: "profiles.role = 'manager'",
          status: "done",
        },
        {
          title: "Manager accounts",
          detail: "Created from Admin → Settings → Team with a one-time password",
          db: "profiles.role · lock_role()",
          status: "done",
        },
      ],
    },
    {
      week: 1,
      range: "Shipped",
      title: "Manager tools",
      goal: "The three jobs the portal named. All three now do them.",
      tasks: [
        {
          title: "Phone-in orders",
          detail:
            "/manager/new-order — look the caller up by mobile, build the order off the live menu, take the address, place it. Priced server-side from the same settings the app bills with; cash on delivery, because there is no way to take a card on a call",
          db: "orders · order_items",
          status: "done",
        },
        {
          title: "Phone orders are attributable",
          detail:
            "channel + placed_by on every order, locked against later edits by guard_order_update(). The desk refuses to run on a database that cannot record who took the call, rather than writing an anonymous order in a customer's name",
          db: "orders.channel · orders.placed_by · migration 0029",
          status: "done",
        },
        {
          title: "One account per mobile",
          detail:
            "A caller with no account gets one, created by the same resolver OTP login uses — so ringing up and signing in later land on the same customer, not two halves of one",
          db: "profiles.phone · auth.users",
          status: "done",
        },
        {
          title: "Cross-vendor live order board",
          detail:
            "Every order in flight across every shop, oldest first, auto-refreshing; advance one stage at a time. Shipped with the portal in slice E — this tracker was the last thing that hadn't noticed",
          db: "orders.status",
          status: "done",
        },
        {
          title: "Rider dispatch",
          detail:
            "Assign a delivery to a named rider, least-loaded first, instead of waiting for one to accept. Loses the race gracefully when a driver self-assigns at the same moment",
          db: "deliveries.driver_id",
          status: "done",
        },
      ],
    },
  ],
  admin: [
    {
      week: 0,
      range: "Shipped",
      title: "Admin portal foundation",
      goal: "Platform operator dashboards and navigation.",
      tasks: [
        {
          title: "Portal routes + nav",
          detail: "/admin · /admin/orders · /admin/refunds · /admin/settlements · /admin/banners · /admin/coupons · /admin/vendors · /admin/customers · /admin/settings",
          db: "—",
          status: "done",
        },
        {
          title: "Role gate (admin only)",
          detail: "requireRole('admin') in admin layout",
          db: "profiles.role = 'admin' · is_admin()",
          status: "done",
        },
        {
          title: "Overview dashboard UI",
          detail: "Metrics cards from getAdminMetrics() — live when Supabase configured",
          db: "orders · restaurants · profiles",
          status: "done",
        },
      ],
    },
    {
      week: 1,
      range: "Data oversight",
      title: "Admin on live platform data",
      goal: "Metrics and queues reflect real Postgres rows.",
      tasks: [
        {
          title: "Live platform metrics",
          detail: "Orders today, GMV, riders on job, pending approvals from DB",
          db: "orders · restaurants · profiles",
          status: "done",
        },
        {
          title: "Restaurant approval queue",
          detail: "Toggle restaurants.approved for new vendors",
          db: "restaurants.approved",
          status: "done",
        },
        {
          title: "All-orders list (live)",
          detail: "/admin/orders on orders + profiles join",
          db: "orders · profiles · restaurants",
          status: "done",
        },
        {
          title: "Refund queue (live)",
          detail:
            "/admin/refunds — approve and deny both work. The deny path used to write 'rejected', which no refund_status enum has ever accepted, so every deny failed at the database while the UI reported it as recorded; the vocabulary is now the database's throughout. Approving an online-paid order calls Razorpay and leaves the request pending if the gateway refuses",
          db: "refunds.status",
          status: "done",
        },
      ],
    },
    {
      week: 2,
      range: "Governance",
      title: "User & role management",
      goal: "Safely promote users to vendor / driver / manager / admin.",
      tasks: [
        {
          title: "Role assignment tooling",
          detail: "Settings → Team creates manager and driver logins via the service role, past the lock_role trigger; still never client-writable",
          db: "profiles.role · lock_role()",
          status: "done",
        },
        {
          title: "Audit log for admin actions",
          detail: "refunds.decided_by references profiles — still no general admin_actions table",
          db: "refunds.decided_by",
          status: "active",
        },
        {
          title: "Admin portal gate",
          detail: "requireRole('admin') in the layout, reached only through /admin/login. MFA was removed in 0033 — a password (or the vendor door's OTP) is now the whole check, and role + RLS carry the rest",
          db: "profiles.role · is_admin()",
          status: "done",
        },
        {
          title: "Legacy order history import",
          detail: "~13.2k orders + order_items via db:import-legacy-orders",
          db: "orders · order_items · address.legacy_order_id",
          status: "done",
        },
      ],
    },
    {
      week: 3,
      range: "Shipped past the plan",
      title: "Vendor management console",
      goal: "Onboard, edit, order and categorise every shop from the admin panel.",
      tasks: [
        {
          title: "Vendor records (list · view · edit)",
          detail: "/admin/vendors — owner and contact snapshot, commercials, hours, payout details, legal identifiers, lifecycle status, T&C audit trail",
          db: "restaurants (migration 0017)",
          status: "done",
        },
        {
          title: "Registration wizard with resumable drafts",
          detail: "Auto-saves progress; the restaurant and auth account are created only at Review, so an abandoned wizard leaves no orphan shop or login",
          db: "vendor_registration_drafts",
          status: "done",
        },
        {
          title: "Owner phone OTP in the wizard",
          detail: "/api/admin/vendors/verify-phone — admin-gated and rate limited",
          db: "restaurants.owner_phone_verified",
          status: "done",
        },
        {
          title: "Logo + legal document upload",
          detail: "Public vendor-logos bucket; private vendor-docs behind signed URLs",
          db: "vendor_documents",
          status: "done",
        },
        {
          title: "Vendor category taxonomy",
          detail: "/admin/vendors/categories — admin-owned, replaces free-text cuisine strings",
          db: "vendor_categories",
          status: "done",
        },
        {
          title: "Storefront ordering",
          detail: "Drag-free position select decides where a shop appears on the customer home",
          db: "restaurants.sort_position (migration 0021)",
          status: "done",
        },
        {
          title: "Customer directory",
          detail: "/admin/customers — real profiles, no mock rows",
          db: "profiles.role = 'customer'",
          status: "done",
        },
        {
          title: "Admin UI system",
          detail: "Shared admin-ui primitives + colourful iconography across every admin screen",
          status: "done",
        },
      ],
    },
    {
      week: 4,
      range: "Shipped past the plan",
      title: "Platform settings & security posture",
      goal: "Configuration and staff live in the product, not in SQL.",
      tasks: [
        {
          title: "Platform settings screen",
          detail: "/admin/settings/platform — fees, tax, min order, free-delivery threshold, radius, prep time, support details, feature flags. These bill live orders",
          db: "platform_settings",
          status: "done",
        },
        {
          title: "Team management",
          detail: "/admin/settings/employees — create manager and driver accounts, one-time password shown once",
          db: "profiles.role",
          status: "done",
        },
        {
          title: "Column-level grants on restaurants",
          detail: "Audit C-1: RLS filters rows, not columns, and 0017/0020 had added payout and KYC columns to a publicly-readable table. Explicit column privileges close it",
          db: "grants on restaurants (migration 0024)",
          status: "done",
        },
        {
          title: "Rate limiting on every write endpoint",
          detail: "user.id when authenticated, clientIp(request) when not — applied across the API surface in the audit remediation",
          status: "done",
        },
        {
          title: "Promo banner management",
          detail: "/admin/banners — create, duplicate, schedule, activate, with impression and click counts",
          db: "banners · banner_events",
          status: "done",
        },
      ],
    },
  ],
};

export function isBuildTab(value: string | undefined): value is BuildTab {
  return BUILD_TABS.some((t) => t.id === value);
}

export function milestonesForTab(tab: BuildTab): Milestone[] {
  if (tab === "customer") return MILESTONES;
  return ROLE_MILESTONES[tab];
}

export const STATUS_META: Record<TaskStatus, { label: string; tint: string }> = {
  done: { label: "Done", tint: "var(--green)" },
  active: { label: "In progress", tint: "var(--accent)" },
  todo: { label: "To do", tint: "var(--muted)" },
  blocked: { label: "Blocked", tint: "var(--blue)" },
};

export function planProgress(milestones: Milestone[] = MILESTONES) {
  const all = milestones.flatMap((m) => m.tasks);
  const done = all.filter((t) => t.status === "done").length;
  const active = all.filter((t) => t.status === "active").length;
  return { done, active, total: all.length, pct: Math.round((done / all.length) * 100) };
}
