# Manager App — Phase 2: Dashboard & statistics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The client's eighteen-figure dashboard (§1) and the business statistics (§2) — live, zone-scoped, permission-aware — computed from the one metrics module so a tile, a chart and a report always agree (§18.4); exportable as CSV, Excel and PDF from the app.

**Architecture:** A scoped row loader (`src/lib/data-access/ops-metrics.ts`) maps Supabase rows onto `src/lib/metrics` types; the admin dashboard's money figures are re-expressed through the same loader and functions; two read-only routes (`/api/manager/dashboard`, `/api/manager/stats`) open with `managerApiContext`; the Flutter Home becomes the dashboard, a Statistics screen draws the §2 items with `fl_chart`, and exports are built on the device.

**Tech Stack:** Next.js route handlers, Supabase (service role under `managerApiContext`, every read through the zone scope), Flutter 3.47 / Riverpod 3 / go_router, `fl_chart`, `excel`, `pdf` + `printing`, `share_plus`, `path_provider`.

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§1, §2, Money definitions). Phase 1 plan: `2026-10-21-manager-app-phase-1-foundation.md`.

## Global Constraints

- Phase 1's Global Constraints apply unchanged (worktree, AGENTS.md rules, migration range 0141–0199, app ID/version, F:\dev build env, release-APK smoke test, commit trailer).
- English only — no Hindi (owner).
- **No new migration in this phase.** Everything reads existing tables with the service role behind `managerApiContext`; every query goes through `applyZoneScope` / `scopeZoneIds` (orders by `zone_id`, deliveries by `orders.zone_id`, restaurants by `zone_id`, riders by `staff_zones`). The manager RLS read policies on restaurants / menu_items / settlements / refunds / coupons / reviews remain deferred to the phases that read them through RLS (4, 6, 7) — Phase 1 review 10c.
- **Audited writes** (none in this phase) follow the Phase 1 pattern: one RPC that changes and logs, never a log call after the fact.
- Period attribution, IST days, sales/gross/net, refunds-once, cancelled-separate: exactly `src/lib/metrics` (no second arithmetic anywhere).
- Dashboard tiles use the spec's words verbatim, in the spec's order: Today's Total Sales · Total Sales · Today's Orders · Total Orders · Pending Orders · Completed Orders · Cancelled Orders · Active Vendors · Online Vendors · Active Riders · Online Riders · Riders Currently on Delivery · Total Delivery Fees · Total Platform Commission · Vendor Payments Due · Rider Payments Due · Pending Marketing Requests · Pending Support Tickets.
- Money: `₹12,340` (en-IN, whole rupees) in JetBrains Mono; counts in JetBrains Mono; labels Inter.

## Claude's calls

- **Finance tiles** = Total Delivery Fees, Total Platform Commission, Vendor Payments Due, Rider Payments Due. Omitted from the payload (keys absent, not zero) without `manager.finance.view`. Sales and order counts are operational and always shown.
- **"Total …" tiles are all-time** for the scope; "Today's …" are the IST day. Pending / Completed / Cancelled are all-time counts (so pending + completed + cancelled = total, as the metrics module defines).
- **Unavailable figures**: Rider Payments Due (rider ledger is the Rider branch's, not merged yet), Pending Marketing Requests (`marketing_requests`, Partner phase 6), Pending Support Tickets (`support_tickets`) → `null` in `figures` and listed in `unavailable`; the app shows "—" with "Arrives with <feature>". Each is probed with `isMissingTable`, so the figure lights up the day the table exists, without an app release.
- **Active vendors** = `restaurants.status = 'active'` in scope. **Online vendors** = active and `is_open = true` (the shop's own open switch; hours enforcement is the Partner branch's). **Active riders** = drivers in scope (no suspension state exists yet; Phase 5 adds it and this count will exclude suspended). **Online riders** = `rider_status.is_online` and not on a break (`break_until` null or past); before 0081 → null/unavailable. **Riders currently on delivery** = distinct `driver_id` of `deliveries` in `assigned`/`picked_up` for orders in scope.
- **Statistics permission** = `manager.reports.view` (it is the analytics and the "downloadable performance reports" of §2.12). Dashboard needs only a manager/admin session.
- Custom range: both dates required, `from ≤ to`, at most 366 days, never after today (IST). Week/Month/Year presets run from the start of the current period to today (`presetRange`), compared with the equal-length period just before (`previousPeriod`).
- Screenshots for review use the Partner app's `test_screens/` golden approach (fixture data, Windows fonts), not a fixture mode in the app.

## Review Focus

1. **A manager with several zones picks one zone on Home** → every tile and every statistic recomputes for that zone only; a zone id that is not theirs yields all zeros (never the whole city). (Task 3 + Task 4 route tests with `narrowScope`.)
2. **A manager without `manager.finance.view`** → the dashboard payload carries no fee, commission or payment-due keys at all, and the app shows no gap where they were. (Task 3 QA, Task 5 widget test.)
3. **A table that doesn't exist yet** (marketing, support, rider ledger) or a failed count → that tile shows "—" with its note; the other seventeen still render. A failure of the *orders* read → the whole dashboard shows the error with Retry, never zeros. (Task 1 QA, Task 5 widget test.)
4. **Custom range edge cases**: from after to, a 400-day range, a date in the future, a malformed date → 400 with a code the app turns into a sentence; the IST midnight boundary puts a 23:50 order on its own day. (Task 4 QA.)
5. **The same orders counted three ways agree**: dashboard Total Sales for a range = sum of the stats daily series = the metrics `customerPaid` for those rows; and the admin dashboard's "Revenue today" equals the manager's "Today's Total Sales" for an all-zones admin. (Task 2 parity QA, Task 3 QA.)

---

### Task 1: Scoped metrics loader

**Files:**
- Create: `src/lib/data-access/ops-metrics.ts`
- Create: `scripts/qa/ops-metrics-loader.ts` (add `"test:ops-metrics"` to `package.json`)

**Interfaces — Produces:**
- `toMetricOrder(row: OrderRow, items?: ItemRow[]): MetricOrder` — pure mapper (numbers coerced, `discount_funded_by` → `discountFundedBy`, `payment_status` passed through unchanged, `zone_id` → `zoneId`).
- `loadMetricOrders(scope: ManagerScope, opts: { range?: DateRange; withItems?: boolean }): Promise<MetricOrder[]>` — service role, `readAllRows` paging, `applyZoneScope` on `orders.zone_id`, explicit column list (never `*`), range bounds from `rangeBounds()`; items joined with `menu_items(category)` when `withItems`.
- `loadRefunds(orderIds: string[]): Promise<MetricRefund[]>` (chunks of 500 ids).
- `loadPricing(): Promise<PricingContext>` (effective commission per shop via `effectiveCommissionPct`, other charges, commission GST — same sources as `admin-reports.ts`).
- `loadPaidOrderIds(scope): Promise<Set<string>>` (lines of `paid` settlements, scoped through the order).
- `loadDashboardCounts(scope, now: Date): Promise<{ counts: DashboardCounts; unavailable: UnavailableKey[] }>` where `type UnavailableKey = "onlineRiders" | "riderPaymentsDue" | "pendingMarketingRequests" | "pendingSupportTickets"`; an unavailable count is 0 in `counts` and named in `unavailable`. Missing table (`isMissingTable`) → unavailable; any other error throws.

- [x] **Step 1: Write `scripts/qa/ops-metrics-loader.ts`** — `toMetricOrder` on a raw row with string numerics (`"249.00"`) → numbers; `discount_funded_by: null` → `null`; `payment_status: "refunded"` stays `"refunded"`; `zone_id` carried; items mapped with `category` from the embedded `menu_items`; structural: every exported `load*` in `ops-metrics.ts` that reads `orders`, `deliveries`, `restaurants` or `cod_handovers` applies `applyZoneScope` or `scopeZoneIds`; the file never contains `select("*")`.
- [x] **Step 2: Run** `npx tsx scripts/qa/ops-metrics-loader.ts` — expect FAIL (module missing).
- [x] **Step 3: Implement** `ops-metrics.ts` (`import "server-only"`).
- [x] **Step 4: Run** the QA script (PASS), `npx tsc --noEmit`, eslint on the file.
- [x] **Step 5: Commit** `feat(metrics): scoped loader from Supabase rows to the ops metrics`.

### Task 2: Admin money figures through the same arithmetic

**Files:**
- Modify: `src/lib/data-access/admin-stats.ts` (`getAdminDashboard`: revenue today, orders today, platform earnings today, AOV and their trends computed by `loadMetricOrders({ all: true }, …)` + `customerPaid` / `platformCommission` / `averageOrderValue` / `growth`), `src/lib/data-access/admin-series.ts` (`getAdminSeries` daily revenue/orders/AOV via `dailySeries`)
- Modify: `src/lib/data-access/admin-reports.ts` only if the `refunded → null` payment-status mapping contradicts `platformHeldPayment` in `src/lib/settlements/math.ts` (read both; fix to pass the status through and add a parity case)
- Create: `scripts/qa/admin-metrics-parity.ts`

**Interfaces — Consumes:** Task 1 loaders; `src/lib/metrics` (`customerPaid`, `platformCommission`, `averageOrderValue`, `growth`, `dailySeries`). **Produces:** unchanged exported signatures of `getAdminDashboard`, `getAdminSeries` (admin pages untouched).

- [x] **Step 1: Write the parity QA** — copy the *current* formulas (revenue = Σ total of non-cancelled orders in the window, AOV = revenue ÷ count, platform earnings as admin-stats computes it today) into the script as `legacy*` reference functions; fixtures with a cancelled order, a refunded online order, a discounted order and an order at 23:50 IST; assert `metrics` result === legacy result for each figure, and the daily series equals the legacy bucketing. If a legacy formula differs from the metrics definition on purpose (e.g. refunds), the case documents which one is right per the design's Money definitions and asserts the metrics value.
- [x] **Step 2: Run** `npx tsx scripts/qa/admin-metrics-parity.ts` — expect FAIL until the functions it imports exist (`legacy*` are local; the assertion imports the new pure helpers `adminTodayFigures(orders, refunds, pricing, now)` and `adminDailyPoints(orders, range)` exported from `admin-stats.ts` / `admin-series.ts`).
- [x] **Step 3: Implement** — extract those pure helpers, call them from `getAdminDashboard` / `getAdminSeries`; keep the `requireRole("admin")` inside the admin wrappers.
- [x] **Step 4: Run** the parity QA, `npx tsx scripts/qa/metrics.ts`, `npx tsx scripts/qa/finance-scenarios.ts`, `npx tsc --noEmit`, eslint, and `npx next build` (admin pages still compile).
- [x] **Step 5: Commit** `refactor(admin): dashboard and series figures from the shared ops metrics`.

### Task 3: `GET /api/manager/dashboard`

**Files:**
- Create: `src/app/api/manager/dashboard/route.ts`, `src/lib/manager/dashboard-payload.ts` (pure)
- Create: `scripts/qa/manager-dashboard.ts`

**Interfaces — Produces:**
- `GET /api/manager/dashboard?zone=<uuid>` → `200 { today: "YYYY-MM-DD", generatedAt: ISO, zone: string | null, figures: Partial<Record<FigureKey, number | null>>, unavailable: FigureKey[], order: FigureKey[] }`. `order` is the eighteen keys in spec order minus any omitted for permission. 401/403 as `managerApiContext`; 500 `load_failed` when the orders read fails.
- `dashboardPayload(d: Dashboard, opts: { canSeeFinance: boolean; unavailable: UnavailableKey[]; zone: string | null; now: Date }): DashboardPayload` — strips finance keys when `!canSeeFinance`, sets unavailable keys to `null`.
- `FINANCE_FIGURES = ["totalDeliveryFees", "totalPlatformCommission", "vendorPaymentsDue", "riderPaymentsDue"] as const`.

- [x] **Step 1: Write `scripts/qa/manager-dashboard.ts`** — offline part: `dashboardPayload` without finance → none of the four keys present and `order` has 14 entries in spec order; with finance → 18; `unavailable: ["pendingSupportTickets"]` → that figure `null`; parity: for fixture orders, `figures.totalSales` equals the sum of `dailySeries(...)` sales over the same rows. Online part (skips with a notice when `BASE` unreachable): no cookie → 401; `?zone=not-a-uuid` with a QA manager → all-zero figures (narrowed to nothing), never 500.
- [x] **Step 2: Run** — expect FAIL.
- [x] **Step 3: Implement** the route: `managerApiContext()`; `narrowScope(ctx.scope, zone)`; `Promise.all([loadMetricOrders(scope), loadRefunds(…), loadPricing(), loadPaidOrderIds(scope), loadDashboardCounts(scope, now)])`; `computeDashboard`; `dashboardPayload`. `export const dynamic = "force-dynamic"`.
- [x] **Step 4: Run** QA (PASS offline; online half with `npm run dev`), `npx tsc --noEmit`, eslint.
- [x] **Step 5: Commit** `feat(api): manager dashboard — the eighteen figures, scoped and permission-aware`.

### Task 4: `GET /api/manager/stats`

**Files:**
- Create: `src/app/api/manager/stats/route.ts`, `src/lib/manager/stats-query.ts` (pure), `src/lib/manager/stats-payload.ts` (pure)
- Create: `scripts/qa/manager-stats.ts`

**Interfaces — Produces:**
- `parseStatsQuery(params: URLSearchParams, now: Date): { ok: true; granularity: Granularity | "custom"; range: DateRange; previous: DateRange; zone: string | null } | { ok: false; error: "bad_granularity" | "bad_date" | "range_reversed" | "range_too_long" | "range_in_future" }`.
- `GET /api/manager/stats?granularity=day|week|month|year|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&zone=<uuid>` (permission `manager.reports.view`) → `200 { generatedAt, granularity, range, previous, zone, salesSeries: [{ day, sales, orders }], bucketSeries: [{ key, label, sales, orders }], growth: { sales: Growth, orders: Growth }, completedVsCancelled: { completed, cancelled, completionRate, cancellationRate, cancelledValue, byWho: [{ who, count }], topReasons: [{ reason, count }] }, averageOrderValue: { current, previous, growth: Growth }, peakHours: { grid: number[7][24], topHours: [{ weekday, hour, orders }] }, bestVendors: [{ id, name, sales, orders, rating }], bestCategories: [{ category, sales, qty }], byZone: [{ zoneId, zoneName, cityName, sales, orders }] }`; 400 with the parse error code.
- `statsPayload(...)` assembling the above from `computeStats` + names (vendor names and ratings from `restaurants`, zone and city names from `listCitiesWithZones`).

- [x] **Step 1: Write `scripts/qa/manager-stats.ts`** — `parseStatsQuery`: `day` → today..today and previous = yesterday; `month` on 2026-10-21 → 2026-10-01..2026-10-21, previous 2026-09-10..2026-09-30 (21 days); custom 2026-10-05..2026-10-01 → `range_reversed`; 400 days → `range_too_long`; to = tomorrow → `range_in_future`; `from=2026-13-01` → `bad_date`; `granularity=hour` → `bad_granularity`. `statsPayload` for fixtures: Σ `salesSeries.sales` = `growth.sales.current`; `bestVendors` sorted by sales desc with names; `byZone` names resolved; a 23:50 IST order lands on its own day. Online: no cookie → 401; manager without `manager.reports.view` → 403 `permission_denied` (when QA creds exist).
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement** parser, payload and route (`loadMetricOrders(scope, { range: union(range, previous), withItems: true })` once, split in memory).
- [x] **Step 4: Run** QA, `npx tsc --noEmit`, eslint, `npx next build`.
- [x] **Step 5: Commit** `feat(api): manager statistics — periods, growth, peaks, best vendors and categories`.

### Task 5: Home — the dashboard

**Files:**
- Modify: `apps/manager/pubspec.yaml` (`fl_chart`, `excel`, `pdf`, `printing`, `share_plus`, `path_provider`)
- Create: `apps/manager/lib/models/dashboard.dart`, `apps/manager/lib/state/dashboard.dart`, `apps/manager/lib/features/home/dashboard_grid.dart`, `apps/manager/lib/features/home/figure_tile.dart`
- Modify: `apps/manager/lib/data/manager_repository.dart` (`dashboard({String? zoneId})`), `apps/manager/lib/features/home/home_screen.dart`, `apps/manager/lib/core/format.dart` (`rupees(int)`, `count(int)` if absent)
- Test: `apps/manager/test/dashboard_test.dart`

**Interfaces — Produces:**
- `enum FigureKey { todaysTotalSales, totalSales, …, pendingSupportTickets }` with `isMoney`, `en`, `hi` (spec words), `target` (route path a tap opens: Orders tab filtered — `/orders?status=pending|completed|cancelled|today`, `/more/vendors?filter=active|online`, `/more/riders?filter=active|online|on_delivery`, `/finance`, `/more/marketing?status=pending`, `/more/support?status=open`); targets of later phases resolve to their existing placeholders.
- `DashboardData { DateTime generatedAt; String today; List<FigureKey> order; Map<FigureKey, num?> figures; Set<FigureKey> unavailable }` (`fromJson`).
- `dashboardProvider` — `AsyncNotifier<DashboardData>.autoDispose`, watches `activeZoneProvider` and `signedInProvider`, re-fetches every 30 s while the app is resumed (timer cancelled on pause/dispose), keeps the previous data visible while refreshing.
- `DashboardGrid` — 2 columns below 840 dp, 4 at or above; `FigureTile(key, value, unavailable, onTap)`; skeleton tiles while first loading; `ErrorRetry` on error; "—" + note for unavailable.

- [x] **Step 1: Write `dashboard_test.dart`** — renders the 18 labels in spec order from a fixture payload; a payload without finance keys renders 14 tiles and none of the four labels; an unavailable figure shows "—" and "Arrives with support tickets"; money tiles show `₹12,340`; tapping "Pending Orders" pushes `/orders?status=pending` (a fake router records it); at width 900 the grid has 4 columns, at 390 it has 2; an API error shows Retry; zone change triggers a refetch with `zoneId`.
- [x] **Step 2: Run** `flutter test test/dashboard_test.dart` — FAIL.
- [x] **Step 3: Implement**; Home keeps greeting + zone chip + no-zones notice above the grid and gains a "Statistics" row (opens `/stats`) below it.
- [x] **Step 4: Run** `flutter analyze`, `flutter test` (all PASS).
- [x] **Step 5: Commit** `feat(manager-app): Home dashboard — the eighteen figures`.

### Task 6: Statistics screen

**Files:**
- Create: `apps/manager/lib/models/stats.dart`, `apps/manager/lib/state/stats.dart`, `apps/manager/lib/features/stats/stats_screen.dart`, `apps/manager/lib/features/stats/stats_charts.dart`, `apps/manager/lib/features/stats/peak_hours_grid.dart`
- Modify: `apps/manager/lib/router.dart` (`/stats` on the root navigator), `apps/manager/lib/data/manager_repository.dart` (`stats(StatsQuery q)`)
- Test: `apps/manager/test/stats_test.dart`

**Interfaces — Produces:**
- `StatsQuery { Period period (day|week|month|year|custom); DateTimeRange? custom; String? zoneId }` → query string; `StatsData.fromJson`.
- `statsQueryProvider` (`Notifier<StatsQuery>`, default `month`), `statsProvider` (autoDispose, watches query + zone).
- Screen sections, in §2 order: period selector (Day · Week · Month · Year · Custom → `showDateRangePicker`, last 366 days, not after today); sales line chart day by day; growth badges (sales, orders: ▲/▼ %, "New" when `pct` null); orders bar chart; completed vs cancelled (two figures, rates, reasons list by who); average order value with growth; peak hours heat grid (7 × 24, accent intensity, top three hours listed); best vendors (top 10, rank, name, sales, orders, rating); best categories (top 10); by zone (city · zone, sales, orders); "Download report" button (Task 7). Without `manager.reports.view` the Home row is hidden and the route shows the permission notice.

- [x] **Step 1: Write `stats_test.dart`** — from a fixture payload: every section title present in order; growth `pct: null` renders "New"; negative growth renders a down arrow; selecting Custom with a range calls the repository with `granularity=custom&from&to`; the peak grid has 168 cells and the busiest is labelled; an empty period (no orders) shows the filtered-empty line, not zeros everywhere; 400 `range_too_long` shows "Pick a range of a year or less".
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `flutter analyze`, `flutter test`.
- [x] **Step 5: Commit** `feat(manager-app): statistics — periods, growth, peaks, vendors, categories, zones`.

### Task 7: Downloadable performance report (§2.12)

**Files:**
- Create: `apps/manager/lib/features/stats/stats_export.dart`
- Test: `apps/manager/test/stats_export_test.dart`

**Interfaces — Produces:**
- `ReportMeta { String title; DateTime generatedAt; String generatedBy; String period; String zone }`.
- `String statsCsv(StatsData d, ReportMeta m)`, `List<int> statsXlsx(StatsData d, ReportMeta m)`, `Future<Uint8List> statsPdf(StatsData d, ReportMeta m)`; `Future<void> shareReport(...)` writes to the temp dir and opens the share sheet (`share_plus`), PDF also offered through `printing` (Save as PDF / print).
- Every format starts with: title, "Generated <dd MMM yyyy, HH:mm> IST by <name>", "Period <from – to>", "Zone <name | All my zones>"; then summary (sales, orders, AOV, growth, completed/cancelled), the daily table, best vendors, best categories, by zone.

- [x] **Step 1: Write `stats_export_test.dart`** — CSV first four lines are the meta lines; CSV quotes a vendor name containing a comma; rupees are plain integers in CSV/Excel (no ₹, so a spreadsheet can sum them) and `₹` formatted in PDF; the Excel workbook has sheets `Summary`, `Daily`, `Vendors`, `Categories`, `Zones` and the Daily sheet's sales sum equals `growth.sales.current`; the PDF bytes start with `%PDF`.
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement**; wire the button on the stats screen (bottom sheet: CSV · Excel · PDF).
- [x] **Step 4: Run** `flutter analyze`, `flutter test`.
- [x] **Step 5: Commit** `feat(manager-app): download the performance report as CSV, Excel or PDF`.

### Task 8: Release check, screenshots, records

**Files:**
- Create: `apps/manager/test_screens/screens_test.dart` (pattern: `apps/vendor/test_screens/screens_test.dart`; outputs gitignored) — Home dashboard (phone light, phone dark, tablet), Statistics (phone light).
- Modify: `docs/SECURITY_AUDIT.md` (row: two read routes — authz, scope, no PII, no writes), `docs/superpowers/plans/2026-10-21-manager-app-phase-2-dashboard.md` (tick boxes, record deviations).

- [x] **Step 1:** `flutter test test_screens --update-goldens`; review the PNGs (tiles in spec order, no overflow at 390 dp, 4 columns on tablet, dark mode legible).
- [x] **Step 2:** `flutter build apk --release --dart-define-from-file=env/prod.json` with the F:\dev env; install on `deligro_test`; cold start → login; no `FATAL` / `E/flutter` in logcat; screenshot.
- [x] **Step 3:** run every QA script touched in this phase, `npx tsc --noEmit`, eslint, `npx next build`, `flutter analyze`, `flutter test`; record results here.
- [x] **Step 4: Commit** `docs(manager-app): phase 2 records — screenshots reviewed, release build checked`.

---

## Records (2026-10-21)

**Verification, final run:** `npx tsc --noEmit` clean; eslint clean on every touched path; `npx next build` green (routes `/api/manager/dashboard`, `/api/manager/stats`); QA — metrics 67, ops-metrics-loader 18, admin-metrics-parity 13, manager-dashboard 16, manager-stats 27, manager-scope 24, manager-audit-atomic 16, manager-cash-scope 23, role-features 27, app-version 63, platform-separation 38, finance-scenarios 51 (all 0 failed); PGlite proofs 0055–0141 all pass (0141: 104); `flutter analyze` clean; `flutter test` 66 passed; `flutter test test_screens --update-goldens` 4 screenshots reviewed (Home phone light/dark, Home tablet four columns, Statistics); release APK 64.0 MB built and cold-started on `deligro_test` to the login screen, no FATAL / `E/flutter`.

**Not verified:** signed-in dashboard and statistics on a device or against the API (no QA manager credentials; 0141 not applied to any database).

**Deviations from this plan (Claude's calls):**
- Task 2's pure helpers live in `src/lib/metrics/admin.ts` (`adminPulse`, `adminEarnings`, `adminDailyPoints`) rather than being exported from `admin-stats.ts` / `admin-series.ts`, which are `server-only` and cannot be imported by a tsx QA script.
- Payload key for "Riders Currently on Delivery" is `ridersOnDelivery` (the metrics module's name), not a second spelling.
- The mapper lives in `ops-metrics-map.ts` (pure) next to `ops-metrics.ts` (loaders) so it can be tested offline; it also exports `toSettlementPaymentStatus`, which `admin-reports.ts` now uses.
- Rider ratings on the statistics screen use a star icon, not a "★" character (missing from some fonts; drew as a box in the screenshot).
- The PDF report bundles Roboto (Apache 2.0, licence in `assets/fonts/`) for the ₹ sign.
- Tasks 6/7: the Download-report widget test was written before the button but not run against the stub before the button landed.
