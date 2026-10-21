# Deligro Manager app — design

Date: 2026-10-21 · Branch: `feat/manager-app` · Worktree: `F:\hub26\deligro-manager` · App: `apps/manager`

## Intent

A native Android app for a Deligro operations manager to run a city from a
phone (or tablet): see the day's figures, work every order in flight, manage
vendors, riders, products and customers, follow the money, approve marketing
and offers, resolve tickets, receive the alerts that need a human, and export
the reports the business closes its books with — all within the cities, zones
and powers their role grants, with every sensitive action on the record.

Source of truth for scope: the client's *Deligro Manager App — Complete
Feature Requirements Document*, sections 1–18 (cited below as §N.M). The
owner's instructions: **every section complete — nothing partial or "mostly"**,
built in phases without stopping; the dashboard shows the client's eighteen
figures, in **our** UI and aesthetic (the customer app's design system). The
owner chose a native Flutter app over extending the web `/manager` console.

## Current state (audit, 2026-10-21)

The Manager APK today (`com.ractrotech.deligro.manager` 1.0.0) is the
Capacitor wrapper around the website's `/manager` portal: a live cross-vendor
order board (in flight / awaiting kitchen / needs a rider), forward-only status
moves, assign-a-rider (only when none is assigned), phone orders, COD
handovers and expenses, five per-manager feature switches, and two ops pushes
(kitchen not accepting, no rider). RLS (0023) gives managers profiles, orders,
order items, deliveries, and cash records; nothing on restaurants, menus,
settlements, refunds, coupons, banners or settings. The admin console has much
of §1–§4, §7, §9, §10, §13 for admins only. Absent everywhere: zones/cities,
support tickets, marketing requests, a general audit log, rider management,
customer suspension, product change history, alert thresholds. Roughly a
fifth of the document.

## Neighbouring work (read before building)

Two other sessions are building native apps on their own branches. Their
designs are binding where they name a shared table:

- **Partner app**, `feat/vendor-app` (`F:\hub26\deligro-vendor`), migrations
  `0061`–`0080`: `order_status_events` (0061, merged into this branch at its
  base), `POST /api/auth/password-login` (merged), `orders.preparing_at`,
  stock (`menu_items.stock_qty`), store hours/holidays, `marketing_requests`,
  invoices, support tickets.
- **Rider app**, `feat/rider-app` (`F:\hub26\deligro-rider`), migrations
  `0081`–`0140`: `rider_status`, `rider_shifts`, `delivery_events`,
  `delivery_exceptions`, `rider_profiles` (rider ID `DR-0001`),
  `rider_documents`, `rider_payout_accounts`, `rider_earnings`,
  `rider_adjustments`, `rider_payouts`, `cash_deposits`, `rider_ratings`, the
  `failed` delivery status, support tickets, `user_notifications`,
  `announcements`.

**Rule:** before a phase that needs one of these, merge the owning branch
(`git merge feat/vendor-app` / `git merge feat/rider-app`). If the piece has
not landed yet, build it here **with exactly the name and shape the owning
design gives**, role-generic, in this branch's migration range, and say so in
the commit — whichever branch lands first builds it, the other merges it
(AGENTS.md: one source of truth). Never write a second copy of a shared table.

Never touch `F:\hub26\deligro` (another session's uncommitted work), nor the
other two worktrees.

## Decisions

Calls made by Claude unless marked *owner*.

### App

- Flutter, `apps/manager`, same structure as `apps/customer` (Riverpod 3,
  go_router, supabase_flutter, `/api` through the `@supabase/ssr` cookie
  bridge, OneSignal vendored copy). Copied and adapted, not shared through a
  package — same reasoning as the Partner and Rider apps.
- App ID `com.ractrotech.deligro.manager` (installs over the Capacitor Manager
  app, versionCode 1), display name **Deligro Manager**, version `2.0.0+2`.
  Released on a new `manager` track of `/api/app-version`
  (`platform_settings.manager_apk_*`, as 0045 / 0061 did for the others).
- Look *(owner: "use our UI and aesthetic")*: the customer app's tokens —
  Inter, warm off-white surfaces, orange accent, JetBrains Mono for figures —
  light and dark. Figures in JetBrains Mono, money as `₹12,340` (en-IN).
- Navigation: bottom bar **Home · Orders · Live · Finance · More**. More holds
  Vendors, Riders, Customers, Products, Marketing, Offers, Support, Reports,
  Alerts, Audit log, Insights (§17), Profile & permissions, Settings. A
  screen whose permission is off is not in the menu, and its API refuses.
- Width: phone-first; at ≥ 840 dp (tablet / landscape) list screens become
  list + detail side by side and the dashboard grid widens from 2 to 4
  columns. Never a stretched phone layout.
- Language: every string an English/Hindi pair via `tr(en, hi)`, English by
  default, switch in Settings (matches the other two apps).
- Login: mobile + password (`/api/auth/password-login`), phone OTP
  (`/api/auth/otp/*`), email + password. Only `profiles.role in ('manager',
  'admin')` passes the gate; anyone else is told plainly and offered
  sign-out. An admin in the app has every permission and every zone.
- Updates: Live and Orders poll every 10 s while foregrounded, Home every
  30 s, other screens on open and pull-to-refresh; pushes cover the
  background. No Supabase realtime (one transport to debug, as the other
  apps).
- Charts `fl_chart`; maps `flutter_map` with OSM tiles (as the customer app);
  exports built on the device from the API's rows: CSV, Excel (`excel`
  package) and PDF (`pdf` + `printing`), shared or saved through the share
  sheet. Every exported file and printed report carries its generation date
  and time, the filters used, and the manager who generated it (§13).
- Every list: server-side pagination (cursor or `page`/`pageSize`, 50 per
  page), loading skeleton, `Empty` line for a filtered-empty list, full-screen
  empty state for an empty section, error with Retry (§18.6–18.7).

### Backend

- Migrations **`0141`–`0199`** (vendor owns 0061–0080, rider 0081–0140). Each
  ships a PGlite proof in `scripts/qa/sql/migration-NNNN.mjs` and a rollback
  block in its header, house style. **Applying them to the live database and
  deploying the website is the owner's step.**
- Every app call goes through a `/api/manager/*` route that opens with
  `managerApiContext(permission?)` (`src/lib/auth/manager-api.server.ts`):
  503 `not_configured`, 401 `unauthenticated`, 403 `forbidden` (wrong role),
  403 `permission_denied` (switch off). It returns `{ profile, scope,
  permissions }`; `scope` is `{ all: true }` for admins or `{ all: false,
  zoneIds: string[] }`. Writes are rate-limited (`user.id`). The manager id
  is always the session's, never the body's.
- `createAdminClient()` only below that check, and **every service-role read
  is filtered by `scope`** through one helper (`applyZoneScope(query,
  scope, column)`), never by hand. RLS for managers is re-scoped to zones in
  the database too (below), so the two layers agree.
- **One data layer, two callers.** The admin `data-access/admin-*` functions
  that currently call `requireRole("admin")` inside are split into a pure
  query taking `scope` and a thin admin wrapper. Admin pages keep calling the
  wrapper; manager routes call the query after `managerApiContext`. Web and
  app can never compute a figure differently.
- The web `/manager` portal keeps working; its Server Actions are moved onto
  the same data-access functions where they overlap. It is not extended with
  the new features — the app replaces it. Admin-only configuration the app
  needs (cities and zones, manager zone assignment, manager permissions,
  alert thresholds) gets admin console screens following `AGENTS.md`'s
  console rules (two shells, tokens only, container queries).

### Cities, zones and scope (§3, §6.11, §13, §15.3, §15 last line, §17.8)

- `cities (id, name, slug unique, is_active)` and `delivery_zones (id,
  city_id, name, slug, center_lat, center_lng, radius_km, polygon jsonb
  null, is_active)`. Seed: city **Bemetara**, zone **Bemetara** (centre and
  radius from the existing service-area settings).
- `restaurants.zone_id` (not null after seeding every existing shop into
  Bemetara); `orders.zone_id` set by trigger from the restaurant at insert,
  locked afterwards (granted `select` to authenticated, per AGENTS.md rule 1).
  Riders: `staff_zones (user_id, zone_id)` — managers and riders both; a
  rider's live position decides which zone's map shows them, `staff_zones`
  decides which managers may act on them.
- Manager scope = their `staff_zones`. **A manager with no zones sees
  nothing** (fail closed); the migration seeds every existing manager into
  Bemetara so nothing breaks on deploy. Admins assign zones in Admin →
  Settings → Team.
- 0023's blanket `is_manager()` policies are replaced by
  `manager_can_see_zone(zone_id)` on orders, order items, deliveries, cash
  records, and the new manager read policies on restaurants, menu items,
  settlements, refunds, coupons, reviews.
- Multi-city (§17.8): the app's zone picker groups zones by city; a manager
  with several zones filters every screen by "All my zones" or one zone.

### Permissions (§15.4, §15.9, §7, §16.8–16.9, §18.5)

The existing role feature switches (0052, `src/lib/features/catalog.ts`,
Admin → Feature access, role-wide or per person) carry every manager power.
The catalog gains a `defaultOn` field; **sensitive powers default off**. Keys
(existing five kept):

| Key | Default |
|---|---|
| `manager.orders.view`, `manager.live.view`, `manager.vendors.view`, `manager.riders.view`, `manager.products.view`, `manager.support.manage`, `manager.reports.view` | on |
| `manager.move_status`, `manager.assign_rider`, `manager.reassign_rider`, `manager.phone_orders`, `manager.cash`, `manager.call_customer`, `manager.orders.escalate`, `manager.alerts.configure` | on |
| `manager.finance.view`, `manager.marketing.manage`, `manager.offers.manage`, `manager.customers.view`, `manager.vendors.status`, `manager.riders.status`, `manager.products.moderate` | on |
| `manager.orders.correct`, `manager.vendors.onboard`, `manager.riders.onboard`, `manager.finance.initiate_payment`, `manager.finance.approve_payment`, `manager.finance.adjust`, `manager.customers.contact`, `manager.customers.suspend`, `manager.products.adjust_stock`, `manager.audit.view_zone` | **off** |

The app's Profile screen lists every permission with its state (§15.4).
Reports a manager may not see are absent from the report picker and refused
by the route (§15.9). Finance figures are hidden entirely without
`finance.view`.

### Audit log (§3.16, §6.10, §16)

- `ops_audit_log (id bigint identity, actor_id, actor_role, action text,
  entity_type text, entity_id text, zone_id null, reason text null, before
  jsonb null, after jsonb null, client_action_id text unique null,
  created_at)`. Insert only, through a `security definer` function
  `log_ops_action(...)` called by the data layer in the **same transaction**
  as the change (an RPC that does both, or the change's own trigger). A
  trigger refuses `update` and `delete` for every role including service role
  (§16 "not editable by ordinary managers" — nobody edits it).
- Actions logged: order status correction, reassignment, escalation,
  cancellation, manual intervention; vendor and rider status changes,
  document decisions, onboarding; product moderation, stock adjustment;
  customer suspension and contact reveal; settlement initiate/approve/mark
  paid, corrections, adjustments; offer and campaign create/change; marketing
  decisions; ticket assignment/escalation/resolution; permission and zone
  changes made by admins; alert threshold changes.
- **A reason is mandatory** on every manual intervention, correction, status
  change, suspension, adjustment and reassignment (§6.10).
- Read: admins all; a manager their own actions (Profile → Activity, §15.8);
  with `audit.view_zone`, their zones' entries (Audit log screen).

### Money definitions (§1, §7, §13, §18.4)

One server module, `src/lib/metrics/` (pure functions over rows + the
existing `src/lib/settlements/math.ts`), used by the dashboard, finance,
statistics and every report, so the figures match to the rupee:

- Period attribution by the order's `created_at` in **IST** (`Asia/Kolkata`);
  "today" is the IST calendar day. Ranges are inclusive dates.
- **Gross sales** — items subtotal (qty × price) of non-cancelled orders.
  **Total customer paid** — order totals of non-cancelled orders.
- **Discounts** — from `coupon_redemptions` / order discount, split by
  `coupons.funded_by` (`vendor` / `platform`; Deligro-funded = `platform`).
- **Refunds and adjustments** — approved refunds counted **once each**, by
  refund id, attributed to the order's date; settlement corrections listed
  separately and never subtracted twice.
- **Net sales** — gross − all discounts − approved refunds. Cancelled orders
  are excluded and reported separately (count and value).
- **Delivery fees collected**, **platform commission** (+ commission GST,
  other charges) per settlement maths, **vendor earnings payable** = net
  payable of completed orders not in a paid settlement; **vendor payments
  completed** = paid settlements.
- **Rider side** *(owner: riders are on a fixed salary paid outside the
  app)*: no per-order pay formula is invented here. Rider earnings, payouts
  and dues come from the Rider app's ledger (`rider_earnings`,
  `rider_adjustments` kind `salary`, `rider_payouts`); with its rate card at
  ₹0, "rider earnings payable" is recorded salary not yet paid. "Rider
  delivery earnings" therefore shows the ledger total, which is the salary
  record.
- Payment execution: Deligro moves money outside the app (bank / UPI); the
  app records it. **Maker–checker**: a manager with `initiate_payment` moves a
  settlement or rider payout to `pending_approval`; a *different* person with
  `approve_payment` (or an admin) marks it paid with the transaction
  reference. The same person can never do both. Completed financial records
  are never edited: a correction is a new row (0048's rule).

### Alerts (§14, §6.7–6.8)

- `ops_alert_rules (kind, zone_id null = all, enabled, threshold numeric,
  window_minutes, updated_by)` and `ops_alerts (id, kind, zone_id,
  entity_type, entity_id, severity info/warning/critical, title, body,
  status open/acknowledged/resolved, opened_at, acknowledged_by/at,
  resolved_at, dedupe_key unique)`.
- Thirteen kinds, one per §14 item: `order_needs_intervention`,
  `order_unassigned`, `delivery_delayed`, `high_cancellation_rate`,
  `vendor_downtime`, `rider_shortage`, `delivery_failed`,
  `settlement_delayed`, `rider_payout_issue`, `marketing_request_new`,
  `complaint_high_priority`, `cash_discrepancy`, `incident` — plus
  `rider_inactive` (§6.7) and §17's `fraud_suspected` and `sla_breach`.
  Thresholds configurable for the measurable ones (minutes, rates, counts,
  rupees) by admins and managers with `alerts.configure`, per zone.
- Evaluated by the existing dispatch sweep (`lib/dispatch/sweep.ts`, cron
  route) plus event hooks where the event is the alert (failed delivery, new
  marketing request, high-priority ticket). Each alert opens once
  (`dedupe_key`), pushes the zone's managers through `notifyOps` (re-scoped
  by zone), writes `user_notifications`, and resolves itself when the
  condition clears.
- §6.7 rider inactivity: a rider on an active delivery whose last fix is
  older than the threshold (default 5 min) while the delivery is not
  delivered — "where meaningful" = only on active deliveries.
- §6.12 stale GPS: every rider marker shows "updated N min ago" and turns
  grey past 2 minutes.

### Sections → features

**§1 Dashboard.** Eighteen tiles exactly in the document's order and words,
two columns on a phone, each tapping through to its list (e.g. Pending Orders
→ Orders filtered to pending). Pending = `placed`/`kitchen`/`ready`/
`on_the_way`; Active vendors = status active; Online vendors = active and
open now; Active riders = not suspended; Online riders = `rider_status.
is_online`; On delivery = rider with an assigned/picked-up delivery. Finance
tiles hidden without `finance.view`. Zone picker at the top. Refresh 30 s.

**§2 Statistics.** Day-by-day sales chart; Day / Week / Month / Year / Custom
range; growth vs the previous equal period (sales and orders, ±%); completed
vs cancelled (counts, value, rate, reasons by `cancelled_by`); AOV; peak hours
(hour-of-day × weekday heat grid); best vendors (sales, orders, rating);
best categories; per city and zone; export as a report (§13).

**§3 Orders.** Paged list with Order-ID search (full id or short code),
date-time range, vendor, rider, status, payment status, zone filters; detail
with items, pickup and drop addresses, timeline (`order_status_events` +
`delivery_events`), rider and progress with mini-map; queues for delayed and
unassigned; cancelled with reason and who; actions: advance status (existing
rule), cancel with reason, **reassign** to another eligible rider (cancels the
current leg, logs `reassigned`, notifies both riders and the vendor),
escalate (opens a high-priority ticket linked to the order), **corrections**
(`orders.correct`: status correction backward/forward with reason, delivery
address note, item-unavailable marking that triggers the existing refund
path) — always with an audit row. Financial fields of a delivered order are
never editable from the app; money changes go through refunds or settlement
corrections.

**§4 Vendors.** List (status, open/closed, zone, rating, today's orders);
onboarding with the existing registration wizard's fields on mobile
(`vendors.onboard`); review registration details and documents
(`vendor_documents`: verify / reject with remarks); approve / reject /
suspend / reactivate with reason (`vendors.status`); contact, store info and
hours (Partner app's hours tables when merged); order history; sales stats;
ratings and reviews; commission rate, settlements and pending payment (with
`finance.view`); cancellation and rejection rates; call / WhatsApp; vendor
complaints = tickets filtered to that vendor.

**§5 Riders.** List with online / available / on delivery / offline, last
fix, rider ID; onboarding: create a rider account (`riders.onboard`), review
documents (`rider_documents`: verify / reject), approve / reject / suspend /
reactivate with reason (`riders.status`; suspension takes them offline and out
of dispatch); live location on the map (only while online, per the Rider
app's disclosure); active route and ETA; assign / reassign; delivery history,
completed and failed; ratings and performance (acceptance rate, average
delivery time, failed rate, online hours); earnings and payout status from the
ledger, record a salary payment (`finance.initiate_payment`, maker–checker);
cash collection vs deposits with confirm/dispute of `cash_deposits`; rider
complaints and support = tickets.

**§6 Live operations.** Full-screen map of riders (available green, on
delivery orange, stale grey) and active orders (shop and drop pins); lanes by
status; unassigned and delayed queues; estimated pickup and delivery times
(the customer-ETA model); vendor preparation delays (ready later than
`prep_minutes`); inactivity and failure alerts; reassign; manual intervention
with recorded reason; zone filter; last-update times.

**§7 Finance.** Sales & commission (the nine §7 figures) and payment tracking
(the nine §7 items): vendor dues and paid, rider dues and paid, failed or
delayed transactions (failed online payments, settlements past their cycle,
payouts pending > N days), settlement history with references, date-wise
report, and **reconciliation** — every completed order matched to the
settlement line that paid it, unmatched orders and mismatched amounts listed.

**§8 Marketing.** The Partner app's `marketing_requests` (statuses Pending,
Approved, Rejected, In Progress, Completed) with remarks; `campaigns` (kinds
featured store, banner, seasonal/festival, sponsored product; zone; vendor
and items; start and end; budget; `funded_by` vendor/deligro/shared with
share %; status) — a featured-store campaign drives the existing vendor slot
positions for its window, a banner campaign owns a `banners` row; performance
from `banner_events` (impressions, clicks) and **attributed sales** (orders
using the campaign's coupon, plus orders from the campaign's vendor/items by
customers who clicked it within 24 h before ordering); active and expired
lists.

**§9 Offers.** Create and edit coupons/promotions (`offers.manage`) with
validity window (`starts_at` from the Partner branch), eligible vendors and
items, minimum order, discount cap, total and per-customer redemption limits,
`funded_by`; usage and performance from `coupon_redemptions`; expired or
inactive offers are refused at checkout server-side (already) and cannot be
re-enabled without a new validity; every rule change is a `coupon_changes`
row (before/after) and an audit row.

**§10 Customers.** Search by customer id; by phone only with
`customers.contact` (each reveal audited); profile with masked contact;
order history; complaints (tickets); refund requests (review and decide only
with `finance.adjust`, else view); repeat-order and retention metrics
(repeat rate, 30/60/90-day retention cohorts); ratings and feedback they left;
**suspend / restrict** (`customers.suspend`, reason required): suspended =
cannot sign in to order; restricted = can sign in, cannot place orders. New
`profiles.account_status`, `status_reason`, `status_changed_by/at`, enforced
in the order route and OTP login.

**§11 Support.** The shared `support_tickets` / `support_messages` /
`support-attachments`; manager extensions: `assigned_to`, `team`,
`escalation_level`, `first_response_at`, `resolved_at`, `resolution`,
internal notes (`support_messages.is_internal`, never shown to the
requester); filters (requester role, category, status, date, priority);
statuses Open, In Progress, Escalated, Resolved, Closed; average resolution
and first-response time; recurring problems (top categories, vendors and
riders by ticket count over the period).

**§12 Products.** Items across vendors (paged, search); availability and
out-of-stock (Partner branch `stock_qty`); categories; price-change and
availability history (`menu_item_changes` written by trigger); frequently
unavailable (availability flips / hours unavailable in the period); listings
and images review; **flag** an inaccurate or inappropriate listing
(`listing_flags`; a flagged item can be hidden from customers with
`products.moderate`); restricted changes: categories marked `restricted`
make a new item or price change `pending_approval` and invisible to customers
until a manager approves; product sales performance; stock adjustment only
with `products.adjust_stock`.

**§13 Reports.** The twelve reports, `GET /api/manager/reports?kind=…`, From
and To dates, filters by vendor, rider, status and zone where meaningful;
rows, totals and a generated-at stamp from the server; CSV, Excel and PDF in
the app. The existing five admin reports are re-expressed through
`src/lib/metrics` so admin web and app agree.

**§14 Alerts** — above. Plus the in-app Alerts screen (open / acknowledged /
resolved, acknowledge, jump to the entity) and Settings → thresholds.

**§15 Profile.** Name, phone, role, zones, permissions; password change and
OTP; **sessions**: list this account's sessions (device, last seen) and sign
out one or all (`auth.admin` sign-out by session); notification preferences
per alert kind; activity history from the audit log.

**§16 Audit & security** — above, plus: customer and rider phone numbers and
addresses are shown only where a permission and a live need (active order,
assigned ticket) allow; screenshots are not blocked (operational app) but
the finance and customer screens are excluded from the Android recent-apps
thumbnail (`FLAG_SECURE` on those routes).

**§17 Insights** (owner: complete these too):
1. *Demand forecast* by zone and hour: mean of the same weekday-hour over the
   last 8 weeks, weighted to recent weeks, with a trend factor; chart for the
   next 7 days.
2. *Rider demand forecast*: forecast orders ÷ median deliveries per rider-hour
   = riders needed per hour, against riders usually online (`rider_shifts`).
3. *Zone optimisation*: drop-point density map, average delivery time and
   distance by zone and by 1 km grid cell, cells far from any zone centre,
   with plain suggestions ("12% of Bemetara drops are > 6 km; consider a zone
   centred at …").
4. *Automated rider assignment*: the existing dispatch; per-zone setting for
   offer-then-assign (today) or direct auto-assign to the best eligible rider,
   with the same eligibility rules.
5. *Vendor benchmarking*: each vendor vs the zone median on prep time,
   acceptance time, cancellation rate, rating, AOV, repeat rate.
6. *Fraud alerts*: rules → `fraud_suspected` alerts — customer cancellations
   or COD refusals ≥ N in 7 days; one device/phone redeeming a code beyond its
   per-customer limit across accounts; refund rate per customer; rider cash
   gap > ₹N for > N hours; unusual order value (> 3 × zone p95).
7. *Automated reports*: schedules (daily / weekly, kind, filters, recipients
   among managers) run by cron; the report is generated as a PDF into a
   private bucket and delivered as a push + inbox item with a signed link.
8. *Multi-city* — cities and zones above, admin screens to add them.
9. *SLA monitoring*: per-zone targets (accept within, prep within, pickup
   within, deliver within); breach rates by vendor, rider and zone;
   `sla_breach` alerts.
10. *Accounting export*: date range → Tally-compatible XML vouchers (sales,
    commission, payouts) and a generic double-entry journal CSV.

**§18 Developer requirements** — covered by the rules above; testing: each
phase ends with migrations proven in PGlite, routes covered by QA scripts
(`scripts/qa/manager-*.ts`), metric functions unit-tested against fixed
fixtures (dashboard = report = finance for the same rows, §18.4), allocation,
reconciliation and permission tests, Flutter unit and widget tests, analyzer
clean, every new screen checked on the emulator from the **release** APK.
The last phase produces a signed test build for approval (§18.11).

## Phases

Each phase ends with: migrations validated in PGlite, `npm run typecheck`
and `npm run lint` clean, QA scripts passing, `flutter analyze` clean,
`flutter test` passing, new screens checked on the emulator from a release
APK, a commit per task on `feat/manager-app`, and a short report.

| Phase | Contents | Sections |
|---|---|---|
| 1 Foundation | 0141: cities, zones, `staff_zones`, `orders.zone_id`, zone-scoped manager RLS, `ops_audit_log`, permission catalog with defaults, manager release track; `managerApiContext`, zone scope helper; admin screens for zones and manager zones; Flutter scaffold, login, gate, shell, More menu, update check, Profile & permissions, sessions, Settings | §15, §16.1, §16.7–16.8, §18.1–18.2, §18.5 |
| 2 Dashboard & statistics | `src/lib/metrics` with fixtures; admin data-access split; `/api/manager/dashboard`, `/stats`; Home with eighteen tiles, statistics screens | §1, §2, §18.4 |
| 3 Orders & live ops | order list/detail/timeline/actions, reassign, escalate (needs tickets: build or merge), corrections, live map, queues, ETAs, stale GPS, inactivity/failure via alerts groundwork | §3, §6 |
| 4 Vendors & products | vendor management, documents, status; products, history, flags, restricted approvals, stock | §4, §12 |
| 5 Riders | merge rider branch (or build its tables to its shapes); rider management, documents, status, map, performance, ledger, cash deposits | §5 |
| 6 Finance & reports | finance overview, payment tracking, maker–checker, reconciliation; twelve reports with exports | §7, §13 |
| 7 Marketing, offers, customers | marketing requests, campaigns, attribution; offers with funding and change log; customers, retention, suspension | §8, §9, §10 |
| 8 Support, alerts, audit | tickets with manager extensions; alert engine, thirteen kinds, thresholds, Alerts screen, inbox; audit log screen | §11, §14, §16 |
| 9 Insights | the ten §17 features | §17 |
| 10 Release | Hindi pass, `FLAG_SECURE` routes, SECURITY_AUDIT and DEPLOYMENT_AUDIT walked and logged, full QA, signed release APK, handover notes | §16, §18.10–18.11 |

## Owner steps outside this repo

- Apply migrations `0141`+ to staging, then production (after the Partner
  and Rider ranges they depend on); deploy the website.
- Assign each manager's zones and switch on the sensitive permissions per
  person in Admin.
- Distribute the signed APK (the release keystore's `manager` alias).
