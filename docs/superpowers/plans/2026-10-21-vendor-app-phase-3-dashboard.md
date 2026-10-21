# Vendor App — Phase 3: Dashboard and analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Requirements §1 (dashboard, 13 figures, auto-updating) and §2 (sales statistics and growth: day / week / month / year / custom, comparison with the previous period, totals, order count, average order value, best days, peak hours, best and slow sellers) — laid out as the client's mockup, in our design system.

**Architecture:** One money vocabulary on the server, built on `src/lib/settlements/math.ts` (the arithmetic every settlement already uses): a vendor ledger in `admin-settlements.ts` prices every delivered order and marks it paid or unpaid; dashboard and analytics routes read it and the orders table. The app renders with `fl_chart`.

**Spec:** design doc, "Money (document §4, §5, §17)".

## Definitions (shared by dashboard, analytics, payments, reports)

- **Sale / food value** of an order = `breakdownOrder().foodGross` = total − delivery fee − tax − tip + Deligro-funded discount. Counted for orders the kitchen accepted (`kitchen`, `ready`, `on_the_way`, `delivered`) — the same set the web earnings page counts. Cancelled orders are excluded and reported separately.
- **Today** is the IST calendar day (`lib/utils/ist-time`).
- **Vendor earnings** of a delivered order = `vendorNet − refundRecovered`. **Total vendor earnings** = sum over every delivered order.
- **Paid order** = in a non-void, paid settlement; **unpaid** = delivered and not; **payment due** = Σ `contribution` of unpaid delivered orders minus outstanding corrections (positive: Deligro owes the shop; negative: the shop owes Deligro, e.g. COD commission).
- **Average order value** = sales ÷ accepted orders in the period.

## Tasks

### Task 1: Server — vendor ledger and dashboard
`admin-settlements.ts`: `vendorLedger(restaurantId, {from?, to?})` → `{ terms, lines: (SettlementLine & {paid, settlementStatus, paidAt, paymentRef, createdAt})[], corrections }`, paging all delivered orders (1000 per page), reusing `termsFor`, `selectOrders`, `lineFor`, `loadApprovedRefunds`, `settlementMembership`, `outstandingCorrectionsFor`. `math.ts`: export `orderFoodValue()`. `src/lib/data-access/vendor-dashboard.ts`: `getVendorDashboard(restaurantId)` → today's sale (+ yesterday), total sale (+ this month vs last), live counts (new/accepted/preparing/ready, paid-or-COD), completed and cancelled today, payment due, paid / unpaid / partly paid order counts, total vendor earnings, marketing request counts by status (zeros with `available:false` until Phase 6's table exists). Route `GET /api/vendor/dashboard` (vendorApiContext; `vendor.earnings` switch gates the money block, which then returns `null`). QA: `scripts/qa/vendor-money.ts` — definitions on fixtures (food value with a Deligro vs vendor discount, payment due sign on COD vs online, cancelled excluded).

### Task 2: Server — analytics
`src/lib/data-access/vendor-analytics.ts`: `getVendorAnalytics(restaurantId, {granularity, from, to})` → buckets (sales, orders) for the period and the equal-length previous period; totals with % change; best days (top 3 by sales); peak hours (sales by IST hour, top window); best sellers (top 5 by qty with revenue) and slow movers (menu items with the fewest — including zero — units in the period). Route `GET /api/vendor/analytics?granularity=day|week|month|year|custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (validated, max 366 days, `to ≥ from`). QA cases for range validation and bucket boundaries in IST.

### Task 3: App — dashboard
`lib/features/home/home_screen.dart` (replaces the placeholder): shop header card (switcher, open state), 2-column metric grid in the mockup's order — Today's sale, Total sale (with change), New, Accepted, Preparing, Ready, Completed, Cancelled, Payment due, Paid orders, Unpaid orders, Total vendor earnings — then a Marketing requests row; every tile taps through to its screen. Refreshes every 30 s while visible and on pull; money tiles hidden with a note when `vendor.earnings` is off.

### Task 4: App — sales analytics
`lib/features/reports/analytics_screen.dart` as the Reports tab's first view: Day/Week/Month/Year/Custom chips, date range, total sales with % vs previous period, bar (current) + line (previous) chart, total orders and AOV with changes, best days, peak hours, best sellers and slow movers. Custom range uses `showDateRangePicker`.
