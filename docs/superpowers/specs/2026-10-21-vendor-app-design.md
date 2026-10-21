# Deligro Partner (vendor) app — design

Date: 2026-10-21 · Branch: `feat/vendor-app` · App: `apps/vendor`

## Intent

A native Android app for the store owner to run their shop on Deligro without
the website: take and prepare orders (with a loud ring), watch sales, reconcile
earnings and settlements, manage menu and stock, run offers, ask Deligro for
marketing, read reviews, issue invoices and raise support tickets.

The source of truth for scope is the client's *Deligro Vendor App — Complete
Feature Requirements Document* (sections 1–17) and their 12-screen mockup. The
owner's instruction: **every section complete — nothing partial**, built in
phases; the dashboard laid out as the client's mockup, but in **our** UI and
aesthetic (the customer app's design system), not the mockup's green.

Out of scope, as the document says: staff accounts, and section 14 (future
phase: forecasting, multi-branch management beyond the existing shop switcher,
offline sync, benchmarks, tax summaries).

## Current state (audit, 2026-10-21)

See `vendor-app-audit-2026-10-21.html`. Summary: orders, menu, open/busy,
vendor coupons, review replies, earnings maths and the ring exist; marketing
requests, support tickets, in-app notifications, invoices, order status
history, stock, variants/add-ons and holidays do not; vendors cannot read their
own settlements or refunds (refunds read as zero today — a bug); the vendor web
portal runs on Server Actions, so there are only four vendor `/api` routes.

## Decisions

Calls made by Claude unless marked *owner*.

### App

- Flutter, `apps/vendor`, same structure and patterns as `apps/customer`
  (Riverpod, go_router, Supabase SDK, `/api` via the rebuilt `@supabase/ssr`
  cookie, OneSignal). Code is copied and adapted, not shared through a package
  yet: refactoring the shipped customer app is a risk this project doesn't need.
- App ID `com.ractrotech.deligro.partner` (the Capacitor vendor app, so it
  installs as an update), version `2.0.0+3` (Capacitor is at versionCode 2).
- Look *(owner)*: the customer app's tokens — Inter, warm off-white surfaces,
  orange accent, JetBrains Mono for figures, light and dark. Layouts follow the
  mockup: dashboard metric grid, filter-chip order list, tinted money cards,
  bottom bar **Home · Orders · Reports · Payments · More**, everything else
  under More.
- Language: every string is an English/Hindi pair with a switch in More →
  Settings, English by default. The document asks for Hindi "where feasible";
  the website's `HINDI_ENABLED` is off by an owner decision of 3 Oct for
  non-customer surfaces, so the switch is there but nothing forces Hindi.
- Login: phone OTP (existing routes), mobile + password (new REST route
  mirroring `signInWithMobileAction`), email + password (Supabase directly).
- Multi-shop owners pick a shop; the choice is sent as the existing
  `vendor_restaurant_slug` cookie so server routes resolve the same shop.
- New orders: OneSignal push plus the native ring service ported from
  `mobile/native/RingService.java` / `DeligroNotificationExtension.java`
  (same `{ring:'start'|'stop', ringId}` protocol). The order list polls the
  board API every 8 s while open, like the web board. No Supabase realtime.

### Backend

- New tables and columns arrive as migrations `0061`+, each with a PGlite
  validation script in `scripts/qa/sql/` like 0055–0060, and a rollback block.
  **Applying them to the live database and deploying the website is the
  owner's step** — nothing is applied from here.
- Every app feature that writes goes through a vendor `/api` route
  (`requireRole`-equivalent vendor check, rate limit, shop resolved on the
  server). Reads that RLS already scopes correctly may go to Supabase directly.
  Order status changes always use `PATCH /api/orders/[id]/status` (pushes,
  dispatch, refunds, ring stop live there).
- Existing Server Actions keep working; shared logic moves into data-access
  functions both call, so web and app cannot drift.

### Statuses (document §3, §16.4)

The database keeps `placed → kitchen → ready → on_the_way → delivered`, plus
`cancelled`. The app's six statuses map onto it without a new enum value (an
enum change ripples through rider, manager, customer and web):

| App | Database |
|---|---|
| New / Pending | `placed` |
| Accepted | `kitchen`, `preparing_at` null |
| Preparing | `kitchen`, `preparing_at` set |
| Ready for Pickup | `ready` |
| Completed | `on_the_way` or `delivered` (the kitchen's part is done) |
| Cancelled | `cancelled` |

New `orders.preparing_at` (set by a "Start preparing" action) and
`orders.prep_minutes` (chosen on accept, default the shop's). Every status
change is recorded in a new `order_status_events` table by trigger (who, from,
to, when, reason). Payment status stays a separate column and a separate chip.

### Money (document §4, §5, §17)

One definitions module, used by dashboard, payments and reports alike, so the
figures match (§16.3):

- **Gross sales** — items subtotal of non-cancelled orders in the period
  (`order_items` qty × price), before discounts. Delivery fee, tax and tip are
  not the vendor's sales and are shown separately.
- **Net sales** — gross − vendor-funded discounts − refunds recovered from the
  vendor. Cancelled orders are excluded and listed separately.
- **Platform commission** — per the existing settlement maths
  (`src/lib/settlements/math.ts`: shop `commission_pct` else platform default,
  plus commission GST and per-order other charges).
- **Net vendor earnings** — net sales − commission − commission GST − other
  charges (the same `net_payable` a settlement would compute).
- **Paid order** — its vendor share is in a `paid` settlement. **Unpaid** —
  completed but not yet in a paid settlement. **Payment due / pending
  settlement** — sum of net earnings of unpaid completed orders. **Amount
  already settled** — sum of `net_payable` of paid settlements.
- **Partially paid** — an order whose settlement line was corrected
  (`settlement_corrections`) so that less than its net was paid; shown as its
  own count. Customer payment status (`cod/online`, `pending/paid/…`) is shown
  per order, separately from settlement status.

Vendors get read access (own shop, non-draft) to `vendor_settlements`,
`vendor_settlement_orders`, `settlement_corrections`, and to `refunds` of their
own orders — which also fixes the zero-refunds bug on the web. Writes stay
admin-only.

### Features that need new server pieces

- **Store** (§8): vendor-editable opening/closing time, weekly off, delivery /
  pickup flags, shop phone; `store_holidays` (date ranges); `closed_until` for
  "temporarily close"; hours and holidays **enforced** at order placement and
  shown on the storefront.
- **Inventory** (§7): `menu_items.stock_qty` (null = not tracked),
  `low_stock_at`; stock decremented when an order is placed and restored on
  cancel, item auto-marked out of stock at 0, low-stock push. Availability
  schedule: days of week + time window per item.
- **Variants and add-ons** (§7.9): `menu_item_variants`,
  `menu_item_addon_groups`, `menu_item_addons`; `order_items.options` snapshot;
  the order API prices them server-side; the customer app and website let
  customers choose them. This touches the customer side and ships in the
  inventory phase.
- **Offers** (§9): `coupons.starts_at`; usage and earnings impact from
  `coupon_redemptions`; Deligro (platform-funded) promotions listed read-only;
  approval requests go through Marketing Requests (type "Discount & offer").
- **Marketing requests** (§6): `marketing_requests` + admin screen to approve /
  reject / progress with remarks; vendor push on each change.
- **Support** (§12): `support_tickets`, `support_messages`, private
  `support-attachments` bucket; admin screen; push on status change / reply.
- **Notifications** (§13): `vendor_notifications` inbox written wherever a
  vendor push is sent; `announcements` (admin creates, fans out); new pushes
  for pending-order reminders, settlements, failed/delayed payouts, marketing,
  low stock, reviews, tickets.
- **Invoices** (§11): `orders.invoice_no` assigned when the kitchen's part is
  done (per shop, per financial year, gapless); invoice and receipt PDFs built
  in the app with tax lines; print through the Android print service
  (Bluetooth/thermal via the system's print plugins); share via the share sheet.
- **Reports** (§5): `GET /api/vendor/reports` returns the period's rows and
  totals; the app builds CSV, Excel and PDF from it; statements likewise.
- **Reviews** (§10): push and inbox entry on a new review; repeat customers,
  frequency and AOV from orders, showing names only — never phone numbers
  outside an active order.
- **App updates**: a `vendor` release track on `/api/app-version`.
- **Audit trail** (§15.3): `order_status_events` plus the existing settlement
  `paid_by`/`paid_at`; settlement and payment adjustments stay admin-only.

## Phases

Each phase ends with: migrations validated in PGlite, API routes typechecked
and covered by QA scripts, Flutter tests, analyzer clean, every new screen
checked on the emulator against the release build, a commit on
`feat/vendor-app`, and a short report.

1. **Foundation** — backend groundwork migration (Preparing step, status
   events, vendor money read access, refunds fix, vendor release track);
   vendor API base (`/api/vendor/me`, mobile-password login; the active shop
   travels as the existing cookie); app scaffold: theme, login, shop picker,
   shell and More menu, update check.
2. **Orders** — board with status tabs and search, order detail with every §3
   field, accept with prep time, start preparing, ready, reject with reason,
   status timeline, past and cancelled orders, push and native ring, pending
   reminders.
3. **Dashboard and analytics** — the mockup's dashboard in our style (all 13
   figures), sales analytics with day/week/month/year/custom, comparison,
   best days, peak hours, best and slow sellers.
4. **Store, products and inventory** — store profile, hours, holidays,
   temporary close, delivery/pickup, prep time; product CRUD with images and
   categories, availability, stock and low stock, schedules, variants and
   add-ons end to end including the customer side, product performance.
5. **Money** — payments and settlements with history and statements, sales
   report with filters and CSV/Excel/PDF, invoices and receipts with print and
   share.
6. **Growth and support** — offers, reviews and customer insights, marketing
   requests (with admin screen), support tickets (with admin screen),
   notification inbox and announcements (with admin screen).
7. **Release** — Hindi pass, security and deployment checklists, QA, signed
   release build, handover notes.

## Owner steps outside this repo

- Apply migrations `0061`+ to staging, then production; deploy the website.
- Sign the release APK with the existing `deligro-release.jks` partner alias.
- Confirm a staging Supabase project exists for end-to-end testing before
  production; without one, new features can only be exercised against a local
  Postgres and the live read paths.
