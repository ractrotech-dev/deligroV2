# Manager App — Phase 9: Insights (§17) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ten §17 features, complete: a demand forecast by zone and hour with its error stated honestly, riders needed against riders usually online, a zone optimisation map with plain suggestions, per-zone automatic rider assignment, vendor benchmarking against the zone median, five fraud rules feeding the alert engine with dismissals, scheduled PDF reports delivered to permitted managers, multi-city filtering and city rollups everywhere a zone breakdown exists, SLA monitoring with breach alerts, and a Tally / journal accounting export that reconciles with Finance.

**Architecture:** Task P0 merges the sibling branches. Five migrations: `0170` (hourly demand and rider-supply rollup tables with an idempotent refresh RPC and backfill), `0171` (zone grid, vendor benchmark and SLA RPCs; `ops_sla_targets` with an audited setter), `0172` (per-zone dispatch mode, `deliveries.assignment_source`, the shared `rider_eligible_for_order()` predicate, `ops_auto_assign_delivery`, audited mode setter), `0173` (fraud rules, dismissals, hashed order client metadata, `ops_fraud_candidates`, `ops_sla_live`, audited fraud RPCs; enables `fraud_suspected` and `sla_breach`), `0174` (report schedules and runs, private `ops-reports` bucket, `accounting_settings`, `ops_accounting_lines`). Heavy work is always SQL (RPCs or rollup tables refreshed by cron); Node only reads bounded rollup rows (≤ 10 weeks × 168 hours per zone) or RPC results. Pure modules under `src/lib/ops/insights/` hold the forecast maths, suggestion rules, benchmark verdicts, fraud and SLA evaluators, voucher builder and Tally/CSV writers — each unit-tested on fixtures. The Flutter app adds an Insights hub under More and upgrades the zone picker to a city-aware area picker everywhere, coded against the JSON pinned below with fake repositories.

**Tech Stack:** Supabase Postgres (RPCs, rollup tables, storage), Next.js route handlers (read `node_modules/next/dist/docs/` first), `pdf-lib` + `@pdf-lib/fontkit` (server PDF, no headless browser), OneSignal via Phase 8 `notifyStaff`, Flutter 3.47 / Riverpod 3 / go_router / `fl_chart` / `flutter_map` / `share_plus`.

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§17 items 1–10, Permissions, Audit log, Alerts, Money definitions). Earlier plans: Phase 1 (`managerApiContext`, `applyZoneScope`, `narrowScope`, cities/zones, `staff_zones`, catalog `defaultOn`, admin Settings → Zones), Phase 2 + fix `0144` (`ops_counts_as_order`, `ops_order_breakdown`, `ops_dashboard_rollup`, `ops_stats_rollup`, `src/lib/metrics`), Phase 3 (`live-rules.ts` `riderEligibility`/`rankCandidates`, `ops_assign_rider`, `ops_require_staff`, `_ops_set_actor`, `_ops_log`, contract emitter), Phase 4 (`vendor-rules.ts` `vendorRates`), Phase 5 (`rider-rules.ts`, `cash_deposits`, `payment_requests`, rider ledger), Phase 6 (`registry.ts` `REPORTS`/`runReport`/`permittedKinds`, `getFinanceOverview`, `finance-rules.ts`, Flutter generic exporter), Phase 7 (customers, `coupons.max_per_customer`), Phase 8 (`ops_alert_rules`, `ops_raise_alert`, `ops_clear_alerts`, `ops_alert_runs` lease, `ALERT_KINDS` with `fraud_suspected`/`sla_breach` `evaluated: "phase9"`, `evaluate()`, `notifyStaff`, `user_notifications`).

## Execution layout — two halves in parallel

| Half | Worktree | Branch | Touches |
|---|---|---|---|
| **Part S (server)** | `F:\hub26\deligro-manager-p9s` | `feat/manager-p9-server` | `supabase/`, `scripts/`, `src/`, `next.config.ts`, `package.json`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md`, `apps/customer/` (device id header only, S6) |
| **Part A (app)** | `F:\hub26\deligro-manager-p9a` | `feat/manager-p9-app` | `apps/manager/` only |

P0 runs first in `F:\hub26\deligro-manager` on `feat/manager-app`; both halves branch from the commit that closes P0. They share no files. When both are done: merge S, then A, into `feat/manager-app`, then run **Task I1**. Remove both worktrees afterwards (`git worktree remove`, `git branch -d`). Copy `.env.local` and `apps/manager/env/*.json` into each new worktree (gitignored).

## Global Constraints

- Phase 1–8 Global Constraints apply (AGENTS.md rules; migrations 0141–0199, this phase **0170–0174**; F:\dev build env; release-APK smoke test; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`.
- **English only on the manager side (owner rule).** No `tr(...)`, no Hindi strings, no `labelHi` on any `manager.*` key this phase adds, no Hindi in suggestion text, fraud evidence, report PDFs, push or inbox text. QA asserts no Devanagari (`[\u0900-\u097F]`) in `src/lib/ops/insights/**`, the new routes' fixtures and `apps/manager/lib/**`.
- **Never an unbounded row pull in Node.** Every insight route calls an RPC or reads a rollup table with a bounded window (forecast inputs ≤ 10 weeks × 168 hours × zones in scope; zone grid returns cells, not drops; vendor benchmarks return one row per vendor; accounting returns aggregated lines). A structural QA (S1) fails if any file under `src/app/api/manager/insights/**` or `src/lib/ops/insights/**` imports `loadMetricOrders` or calls `readAll`.
- **Scope:** every insight read takes the narrowed `ManagerScope` (Phase 1 `narrowScope`, extended in S1 for `city`); RPCs receive `p_zone_ids uuid[]` + `p_all boolean` and filter in SQL. A `zone`/`city` the caller does not hold narrows to nothing (all-empty payload), never widens.
- **Every audited write is one RPC that changes and logs in the same transaction** (`_ops_log`; pattern from 0142: `security definer set search_path = public`, `_ops_set_actor`, `ops_require_staff(actor, zone)` first, replay-safe on `p_client_action_id`, `revoke execute … from public, anon, authenticated; grant execute … to service_role`). Platform-default rows (`zone_id null`) are admin-only (`forbidden`).
- **New permission keys** (catalog, English labels only): `manager.insights.view` (default **on**) — forecast, riders, zones, vendor benchmarks, SLA read; `manager.dispatch.configure` (**off**) — dispatch mode; `manager.accounting.export` (**off**, and also requires `manager.finance.view`); fraud cases need `manager.insights.view` **and** `manager.customers.view`; fraud rule thresholds and SLA targets edit need `manager.alerts.configure`; report schedules need `manager.reports.view` plus each kind's registry permission. Admins have all.
- **Times:** IST (`Asia/Kolkata`) hours and days throughout; `hourStart` values are ISO-8601 UTC instants of IST hour starts.
- Polling: none on Insights screens (open + pull-to-refresh); dispatch screen refreshes on open.

## Claude's calls

- **Demand forecast (§17.1).** Input: `ops_hourly_demand` (orders counted with Phase 2's `ops_counts_as_order` predicate, by `orders.zone_id` and IST hour of `created_at`). For a target hour *h* (weekday *d*, hour-of-day *t*): values `v₁…v₈` = orders in the same weekday-hour 1…8 weeks before *h*'s week (missing hours = 0 once the zone has data that week, else excluded); weights `wₖ = 0.75^(k−1)`; `base = Σwₖvₖ / Σwₖ` over included weeks. Trend factor `τ = clamp(S₁₋₄ / S₅₋₈, 0.75, 1.25)` where `Sₐ₋ᵦ` = total orders of weeks a–b before the forecast start; `τ = 1` when `S₅₋₈ = 0`. Forecast = `base × τ`, rounded to 1 decimal. `insufficientHistory = true` when fewer than 2 complete weeks of data exist for the area (forecast still returned, flagged). Band: `low/high = forecast × (1 ∓ wape)` (wape capped at 1, low ≥ 0). **Backtest (honest error):** for each hour of the last 14 complete IST days, forecast it with only the 8 weeks preceding that day; `mape` = mean |f−a|/a over hours with `a > 0` (`null` if none); `wape` = Σ|f−a| / Σa (`null` if Σa = 0); both shown, with `hoursCompared`. Forecast horizon: the next 7 IST days (168 hours) from the next full hour.
- **Rider demand (§17.2).** `ops_hourly_rider_supply`: online rider-minutes per zone-hour from `rider_shifts` (open shifts end at `now()`), a rider with *n* zones contributing `1/n` to each; `onlineRiders = riderMinutes / 60`. Productivity = median, over the last 28 days' zone-hours with `onlineRiders ≥ 1`, of `delivered ÷ onlineRiders` (needs ≥ 20 such hours, else platform-wide median, else default **2.0** deliveries per rider-hour, `productivitySource: "zone"|"platform"|"default"`). Riders needed = `ceil(forecastOrders ÷ productivity)`, `0` when `forecastOrders < 0.5`. Riders usually online = median `onlineRiders` (1 decimal) for that weekday-hour over the last 4 weeks. `gap = needed − usual` (positive = short).
- **Zone grid (§17.3).** Drops = delivered orders in range with `address.lat/lng`. Cell = 1 km square anchored at the zone centre's latitude: `latStep = 1/111.32`, `lngStep = 1/(111.32·cos(refLat))`, `refLat` = the drop's nearest zone centre (or 21.7 when no zones); key `"<floor(lat/latStep)>:<floor(lng/lngStep)>"`. Per cell: drops, avg/median delivery minutes (`created_at → delivered_at`), avg distance km (shop → drop haversine), nearest zone and distance to its centre, `insideZone` (within any zone's radius or polygon). **Cells with fewer than 3 drops are omitted** (no single-household markers); their drops still count in zone totals. Suggestions (pure, thresholds as constants): `new_zone` — a zone with ≥ 10 % of its drops outside its radius and ≥ 30 such drops → "N% of <Zone> drops are beyond its <r> km radius; consider a zone centred at <lat,lng>" (centre = drop-weighted centroid of the outside cells); `uncovered_demand` — cells outside every zone totalling ≥ 20 drops in the range; `slow_area` — a cell with ≥ 20 drops whose median delivery minutes ≥ 1.5 × its zone's median; `resize_zone` — a zone whose 95th-percentile drop distance from centre < 60 % of its radius (≥ 50 drops) → "could shrink to <km> km"; `merge_zone` — a zone averaging < 1 order/day over a ≥ 14-day range. Text is plain English, figures rounded.
- **Automated assignment (§17.4).** `delivery_zones.dispatch_mode` `offer` (today, default) | `auto_assign`, `auto_assign_max_load smallint default 0` (max active deliveries a rider may already hold; 0 = idle riders only). In `dispatchOrder`, an order whose zone is `auto_assign` takes `chooseRider`'s ranked candidates filtered by Phase 3 `riderEligibility` and the max load, and calls `ops_auto_assign_delivery(order, rider)` for up to 3 candidates; the RPC re-checks `rider_eligible_for_order()` in SQL and assigns atomically (`assignment_source = 'auto'`), else returns the reason. All 3 refused or none eligible → falls back to the offer path unchanged (alerts as today). Auto assignment is a system action: recorded in `delivery_events` (the 0081 trigger) and `deliveries.assignment_source`, not `ops_audit_log`; **the mode change** is audited (`zone.dispatch_mode`, reason required).
- **Vendor benchmarks (§17.5).** Per vendor over the range (orders by `ops_counts_as_order`): `prepMinutes` median `accepted_at → ready_at`; `acceptMinutes` median `created_at → accepted_at`; `cancellationRate` cancelled ÷ placed (all causes, same as Phase 4 `vendorRates`); `rating` `restaurants.rating` (`null` when `rating_count = 0`); `aov` customer paid ÷ non-cancelled orders; `repeatRate` customers with ≥ 2 orders at the vendor ÷ distinct customers. Vendors with < 5 orders get `not_enough_data` verdicts and are excluded from medians. Zone median = median of eligible vendors' values. Verdict per metric: `in_line` when |Δ| ≤ 10 % of the median (or ≤ 0.1 absolute for rating, ≤ 2 pp for rates), else `better`/`worse` by the metric's direction (lower is better for prep, accept, cancellation).
- **Fraud (§17.6).** Five rules in `ops_fraud_rules (rule, zone_id null = default, enabled, threshold, window_days)`; the `fraud_suspected` row in `ops_alert_rules` is the master switch. Defaults: `customer_cancellations` — customer-cancelled orders (`cancelled_by = 'customer'`) plus failed COD deliveries whose exception kind is `customer_unreachable` ≥ **3** in **7** days; `code_sharing` — one code redeemed by ≥ 2 accounts sharing a device hash or a drop point (address lat/lng rounded to 4 dp) with total redemptions in the group > `coupons.max_per_customer` (window **30** days); `refund_rate` — approved refunds ÷ delivered orders ≥ **30 %** with ≥ 3 delivered orders in **30** days; `rider_cash_gap` — collected − deposited > **₹2,000** pending > **48** hours (stricter than `cash_discrepancy`, and not raised while a dispute is open); `unusual_order_value` — an order total > **3** × the zone's 30-day p95 (p95 needs ≥ 50 orders). Dedupe key `fraud_suspected:<rule>:<subject id>:<IST ISO week>`; severity `warning` (`critical` when the measure ≥ 2 × threshold). **Device hash:** the customer app sends `x-device-id` (random install UUID in prefs) and the web sets a first-party `dlg_did` cookie; the order route stores `sha256(device_id || DEVICE_HASH_PEPPER)` in `order_client_meta` (service role only, never in any payload, 180-day retention by cron); missing pepper → nothing stored (fail closed: the rule falls back to drop point only). **Dismissal:** `ops_dismiss_fraud(actor, alert, reason, days 7–90)` resolves the alert with note `false positive: <reason>`, records `ops_fraud_dismissals (rule, subject_key, until)`, and the evaluator skips that subject until `until` unless its measure reaches 2 × the value at dismissal (stored).
- **Scheduled reports (§17.7).** `report_schedules` (name, kind, filters, frequency `daily|weekly`, `weekday` 1–7 for weekly, `hour_ist` 0–23, `range_preset` `yesterday|last_7_days|last_week|month_to_date|last_month`, `zone_ids uuid[]` (null = creator's whole scope), recipients, `active`, `next_run_at`). Runs are unique per `(schedule_id, period_from, period_to)` — overlapping crons cannot double-send. A run generates **one** PDF with the schedule's area and filters via `runReport` (Phase 6 registry, `canSeeFinance` = the kind's permission), stores it at `ops-reports/<schedule>/<run>.pdf` (private bucket, 90-day retention), then delivers to each recipient who **at send time** still has `reports.view` + the kind's permission and every zone of the schedule (admins always); skipped recipients are listed on the run and the owner gets an inbox note. Delivery = Phase 8 `notifyStaff` push + inbox row whose `data.url` is `/more/insights/reports/runs/<id>` — **no file URL in the push**; the app fetches a 5-minute signed URL from the download route after a fresh permission check. Reports over 10,000 rows (Phase 6 cap) produce a run with `status = 'too_large'` and an inbox note instead of a file. PDF: `pdf-lib` with embedded Roboto (₹ glyph), A4 landscape, header (report label, area, period, filters, "Generated <IST time> for <recipient list>"), the registry's columns and totals, page numbers; font files traced into the server bundle with `outputFileTracingIncludes`.
- **Multi-city (§17.8).** Every manager route that accepts `zone` also accepts `city` (zone wins when both are sent); `narrowScope(scope, { zone, city })` intersects with the caller's zones. Wherever a payload has a per-zone breakdown, it gains a sibling `cities` array built by one helper (`rollupByCity`) that **sums numerators and denominators and recomputes rates** (never averages percentages; medians are recomputed from the underlying rows in SQL where the payload carries medians). Admin console: the dashboard and Reports gain a city filter; Settings → Zones already manages cities (Phase 1).
- **SLA (§17.9).** `ops_sla_targets (zone_id null = default, accept_minutes 5, prep_minutes 20, pickup_minutes 10, deliver_minutes 45)`. Stages: accept `created_at → accepted_at` (vendor), prep `accepted_at → ready_at` (vendor; target = the order's `prep_minutes` when set, else the zone target), pickup `ready_at → picked_up_at` (rider), deliver `created_at → delivered_at` (end to end; attributed to the rider for the rider table). A stage breaches when its duration exceeds the target; an unfinished stage already past its target counts as a breach in the live check. Breach rate = breaches ÷ orders that reached the stage. `sla_breach` alerts (enabled from this phase): per zone and stage, trailing 60 min breach rate ≥ the `ops_alert_rules` threshold (default **25 %**) with ≥ 5 orders at that stage; dedupe `sla_breach:<zone>:<stage>:<IST hour>`; auto-clears via `ops_clear_alerts`.
- **Accounting export (§17.10).** Vouchers per IST day per zone (journal type), ledger names from `accounting_settings` (admin-editable, defaults in brackets):
  - *Sales* — Dr Customer collections – COD [`Customer Collections - COD`] / – Online [`Customer Collections - Online`] (customer paid by method); Dr Deligro-funded discounts [`Discount Expense`]; Cr Vendor payable [`Vendor Payable`] (food value incl. Deligro-funded discount), Cr Delivery fee income [`Delivery Fee Income`], Cr GST/taxes collected [`GST Payable`], Cr Rider tips payable [`Rider Tips Payable`].
  - *Commission* — Dr Vendor payable; Cr Commission income [`Commission Income`], Cr Output GST on commission [`Output GST on Commission`], Cr Other charges income [`Other Charges Income`].
  - *Refunds* — Dr Refunds [`Customer Refunds`]; Cr Customer collections – Online/COD by the order's method.
  - *Vendor payout* — per paid settlement (by `paid_at` IST day): Dr Vendor payable; Cr Bank [`Bank`]; narration carries the transaction reference.
  - *Rider salary* — per rider payout (by paid date): Dr Rider salary expense [`Rider Salary`]; Cr Bank.
  Amounts in rupees with 2 decimals; every voucher balances (Dr = Cr) or the export fails with `unbalanced` (never silently). Figures come from `ops_accounting_lines` (SQL mirror of Phase 2/6 definitions: unpaid online orders excluded, refunds once by refund id, cancelled orders excluded) — and the parity test proves the totals equal `getFinanceOverview` for the same range and scope. Tally XML: `ENVELOPE/HEADER/TALLYREQUEST = Import Data`, `BODY/IMPORTDATA/REQUESTDESC/REPORTNAME = Vouchers` (+ `SVCURRENTCOMPANY` from settings), one `TALLYMESSAGE/VOUCHER VCHTYPE="Journal" ACTION="Create"` per voucher with `DATE` (`YYYYMMDD`), `VOUCHERTYPENAME`, `VOUCHERNUMBER` (`DLG-<type>-<YYYYMMDD>-<zone slug>[-n]`), `NARRATION`, and `ALLLEDGERENTRIES.LIST` entries (`LEDGERNAME`, `ISDEEMEDPOSITIVE` `Yes` for debit / `No` for credit, `AMOUNT` negative for debit, positive for credit — Tally's sign convention); optional `includeMasters=1` prepends `LEDGER` masters under configured parent groups. XML-escaped text. Journal CSV columns: `date,voucher_no,voucher_type,ledger,debit,credit,narration,reference` (UTF-8 BOM, formula-injection guard from Phase 2). Range ≤ 366 days.

## API contract (pinned — both halves code to this)

JSON; errors `{ "error": "<code>", …extra }`; timestamps ISO-8601 UTC; ids uuid. Common query: `zone` (uuid) | `city` (uuid); `from`, `to` (`YYYY-MM-DD`, IST, inclusive; default last 28 days; ≤ 366 days else 400 `range_too_long`; `to` after today → 400 `range_in_future`). Common response part `Area`: `{ "type": "scope|city|zone", "id": "uuid|null", "name": "All my zones|<City>|<Zone>" }`. Errors: 400 `bad_request` (`field`), 403 `permission_denied`, 404 `not_found`, 409 per endpoint, 422 `reason_required`, 429 rate limited (reads 60/min per user; writes `managerWriteLimit`).

### Forecast and riders

- `GET /api/manager/insights/demand?zone|city` → `{ "generatedAt": "…", "area": Area, "insufficientHistory": false, "weeksOfHistory": 8,
  "trend": { "factor": 1.08, "last4Weeks": 412, "prior4Weeks": 381 },
  "forecast": [{ "hourStart": "…", "date": "YYYY-MM-DD", "weekday": 1, "hour": 19, "orders": 6.4, "low": 4.9, "high": 7.9 }],   // 168 rows, weekday 1 = Monday
  "daily": [{ "date": "YYYY-MM-DD", "orders": 88.2 }],                                                                      // 7 rows
  "peak": { "hourStart": "…", "orders": 9.1 },
  "backtest": { "days": 14, "hoursCompared": 196, "mape": 0.31, "wape": 0.22, "byDay": [{ "date": "YYYY-MM-DD", "forecast": 81.0, "actual": 77 }] } }`. `mape`/`wape` may be `null`.
- `GET /api/manager/insights/riders?zone|city` → `{ "generatedAt": "…", "area": Area,
  "productivity": { "deliveriesPerRiderHour": 2.4, "sampleHours": 132, "source": "zone|platform|default" },
  "hours": [{ "hourStart": "…", "forecastOrders": 6.4, "ridersNeeded": 3, "ridersUsuallyOnline": 2.0, "gap": 1 }],              // 168 rows
  "daily": [{ "date": "YYYY-MM-DD", "peakNeeded": 5, "peakUsual": 3.5, "shortHours": 6 }], "shortHours": 23 }`.

### Zones, vendors, SLA

- `GET /api/manager/insights/zones?from&to&zone|city` → `{ "generatedAt": "…", "range": { "from": "…", "to": "…" }, "area": Area, "cellKm": 1, "minCellDrops": 3,
  "zones": [{ "id": "uuid", "name": "…", "cityId": "uuid", "cityName": "…", "center": { "lat": 21.71, "lng": 81.53 }, "radiusKm": 6, "drops": 820,
              "avgDeliveryMinutes": 31.5, "medianDeliveryMinutes": 28, "avgDistanceKm": 2.9, "outsideRadiusShare": 0.12, "ordersPerDay": 29.3 }],
  "cities": [{ "id": "uuid", "name": "…", "drops": 820, "avgDeliveryMinutes": 31.5, "medianDeliveryMinutes": 28, "avgDistanceKm": 2.9, "outsideRadiusShare": 0.12, "ordersPerDay": 29.3 }],
  "cells": [{ "key": "2410:8790", "bounds": { "south": 21.70, "west": 81.52, "north": 21.709, "east": 81.529 }, "center": { "lat": 21.7045, "lng": 81.5245 },
              "drops": 41, "avgDeliveryMinutes": 27.0, "medianDeliveryMinutes": 25, "avgDistanceKm": 1.8, "nearestZoneId": "uuid|null", "distanceToZoneCenterKm": 1.2, "insideZone": true }],
  "suggestions": [{ "type": "new_zone|uncovered_demand|slow_area|resize_zone|merge_zone", "severity": "info|warning", "zoneId": "uuid|null",
                    "text": "12% of Bemetara drops are beyond its 6 km radius; consider a zone centred at 21.742, 81.561.", "center": { "lat": 21.742, "lng": 81.561 } /* or null */,
                    "metric": { "share": 0.12, "drops": 98 } }] }`.
- `GET /api/manager/insights/vendors?from&to&zone|city&vendor&page&pageSize` (pageSize ≤ 100, default 50; sorted by orders desc) → `{ "generatedAt": "…", "range": {…}, "area": Area, "minOrders": 5,
  "metrics": [{ "key": "prepMinutes|acceptMinutes|cancellationRate|rating|aov|repeatRate", "label": "Prep time", "unit": "minutes|ratio|stars|rupees", "better": "lower|higher" }],
  "zones": [{ "zoneId": "uuid", "name": "…", "vendorsCompared": 14, "medians": { "prepMinutes": 18, "acceptMinutes": 2.5, "cancellationRate": 0.06, "rating": 4.2, "aov": 312, "repeatRate": 0.38 } }],
  "cities": [{ "cityId": "uuid", "name": "…", "vendorsCompared": 14, "medians": { … } }],
  "vendors": [{ "id": "uuid", "name": "…", "zoneId": "uuid", "orders": 230,
                "values": { "prepMinutes": 22, "acceptMinutes": 1.5, "cancellationRate": 0.04, "rating": 4.5, "aov": 290, "repeatRate": 0.41 },   // any value may be null
                "verdicts": { "prepMinutes": "worse|better|in_line|not_enough_data", … }, "deltaPct": { "prepMinutes": 22.2, … } }],
  "page": 1, "pageSize": 50, "total": 31 }`.
- `GET /api/manager/insights/sla?from&to&zone|city` → `{ "generatedAt": "…", "range": {…}, "area": Area,
  "targets": [{ "zoneId": "uuid|null", "inherited": true, "acceptMinutes": 5, "prepMinutes": 20, "pickupMinutes": 10, "deliverMinutes": 45, "updatedBy": { "id", "name" } | null, "updatedAt": "…|null" }],
  "overall": { "accept": StageStat, "prep": StageStat, "pickup": StageStat, "deliver": StageStat },   // StageStat = { "orders": 812, "breaches": 61, "rate": 0.075, "medianMinutes": 3.2 }
  "byZone": [{ "zoneId": "uuid", "name": "…", "accept": StageStat, "prep": StageStat, "pickup": StageStat, "deliver": StageStat }],
  "byCity": [{ "cityId": "uuid", "name": "…", "accept": StageStat, … }],
  "byVendor": [{ "id": "uuid", "name": "…", "accept": StageStat, "prep": StageStat }],      // 20 worst by combined breach rate, ≥ 5 orders
  "byRider": [{ "id": "uuid", "name": "…", "code": "DR-0004|null", "pickup": StageStat, "deliver": StageStat }],   // 20 worst, ≥ 5 deliveries
  "daily": [{ "date": "YYYY-MM-DD", "accept": 0.05, "prep": 0.09, "pickup": 0.12, "deliver": 0.07 }] }`.
- `PUT /api/manager/insights/sla-targets` `{ "zoneId": "uuid|null", "acceptMinutes": 5, "prepMinutes": 20, "pickupMinutes": 10, "deliverMinutes": 45, "reason": "3–300", "clientActionId": "uuid" }` → 200 `{ "target": {…} }`; minutes bounds accept 1–60, prep 1–180, pickup 1–120, deliver 10–240 (400 `bad_threshold`); `zoneId null` admin-only. `DELETE /api/manager/insights/sla-targets?zone=<uuid>` → revert to inherited.

### Dispatch mode

- `GET /api/manager/insights/dispatch` → `{ "zones": [{ "zoneId": "uuid", "name": "…", "cityName": "…", "mode": "offer|auto_assign", "autoAssignMaxLoad": 0,
  "updatedBy": { "id", "name" } | null, "updatedAt": "…|null", "last24h": { "auto": 41, "offerAccepted": 12, "ops": 3, "fellBackToOffer": 5 } }], "canConfigure": false }`.
- `PUT /api/manager/insights/dispatch` `{ "zoneId": "uuid", "mode": "offer|auto_assign", "autoAssignMaxLoad": 0, "reason": "3–300", "clientActionId": "uuid" }` → 200 `{ "zone": {…} }`; `autoAssignMaxLoad` 0–3 (400 `bad_request`); 403 without `manager.dispatch.configure`.

### Fraud

- `GET /api/manager/insights/fraud?status=open|dismissed|resolved&rule&zone|city&cursor&limit` → `{ "items": [FraudCase], "nextCursor": "…|null", "counts": { "open": 3, "dismissed": 2, "resolved": 7 } }` where
  `FraudCase = { "alertId": "uuid", "rule": "customer_cancellations|code_sharing|refund_rate|rider_cash_gap|unusual_order_value", "severity": "warning|critical", "status": "open|acknowledged|resolved|dismissed",
  "zoneId": "uuid|null", "openedAt": "…", "subject": { "type": "customer|rider|order|code", "id": "string", "label": "Customer 3f2a9c10 · Ravi K." },
  "measure": { "value": 4, "threshold": 3, "unit": "count|ratio|rupees|multiple", "windowDays": 7 },
  "evidence": [{ "kind": "order|redemption|refund|cash_day", "id": "string", "at": "…", "text": "Cancelled by customer · ₹420" }],   // ≤ 20 rows, no phone, address or device data
  "dismissal": { "by": { "id", "name" }, "reason": "…", "until": "…" } /* or null */ }`.
- `POST /api/manager/insights/fraud/[alertId]/dismiss` `{ "reason": "3–300", "days": 30, "clientActionId": "uuid" }` → 200 `{ "case": FraudCase }`; 409 `already_resolved`; `days` 7–90.
- `GET /api/manager/insights/fraud-rules?zone=` → `{ "enabled": true, "rules": [{ "rule": "…", "zoneId": "uuid|null", "inherited": true, "enabled": true, "threshold": 3, "windowDays": 7, "unit": "count|ratio|rupees|multiple", "label": "Customer cancellations", "description": "…" }] }`.
- `PUT /api/manager/insights/fraud-rules` `{ "rule": "…", "zoneId": "uuid|null", "enabled": true, "threshold": 3, "windowDays": 7, "clientActionId": "uuid" }` → 200 `{ "rule": {…} }`; bounds count 1–50, ratio 0.05–1, rupees 100–100000, multiple 1.5–20; windowDays 1–90; `zoneId null` admin-only.

### Scheduled reports

- `GET /api/manager/report-schedules` → `{ "items": [Schedule], "kinds": [{ "kind": "sales", "label": "Sales report" }] }` (kinds the caller may schedule) where
  `Schedule = { "id": "uuid", "name": "Daily sales", "kind": "sales", "filters": { "vendor": "uuid|null", "rider": "uuid|null", "status": "…|null", "payment": "all|cod|online" },
  "frequency": "daily|weekly", "weekday": 1 /* or null */, "hourIst": 8, "rangePreset": "yesterday|last_7_days|last_week|month_to_date|last_month",
  "zoneIds": ["uuid"] /* or null */, "recipients": [{ "id": "uuid", "name": "…", "eligible": true }], "active": true, "owner": { "id", "name" },
  "nextRunAt": "…", "lastRun": { "id": "uuid", "status": "sent|partial|too_large|failed", "at": "…" } /* or null */ }`.
- `POST /api/manager/report-schedules` (body = Schedule fields without ids/derived, recipients as ids, plus `clientActionId`) → 201 `{ "schedule": Schedule }`; 409 `recipient_ineligible` (`{ "ids": [...] }`), 403 if the caller cannot run the kind.
- `PATCH /api/manager/report-schedules/[id]` (any editable field, `clientActionId`) → 200; `DELETE …/[id]` → 200 (owner or admin only, else 403).
- `GET /api/manager/report-schedules/[id]/runs?cursor` → `{ "items": [{ "id": "uuid", "periodFrom": "YYYY-MM-DD", "periodTo": "YYYY-MM-DD", "status": "sent|partial|too_large|failed", "rows": 120, "createdAt": "…", "recipientsSent": 3, "recipientsSkipped": [{ "id": "uuid", "name": "…", "reason": "permission|zone" }] }], "nextCursor": "…|null" }`.
- `POST /api/manager/report-schedules/[id]/run-now` `{ "clientActionId": "uuid" }` → 202 `{ "runId": "uuid" }` (period = the preset as of now; still unique per period).
- `GET /api/manager/report-runs/[id]` → `{ "run": {…as above…, "scheduleName": "…", "kind": "…"} }`; `GET /api/manager/report-runs/[id]/download` → `{ "url": "https://…", "expiresAt": "…" }` (5 min; 403 if the caller is not a delivered recipient with current permission and zones, nor an admin; 410 `expired` after retention).

### Accounting

- `GET /api/manager/insights/accounting?from&to&zone|city&format=summary` → `{ "generatedAt": "…", "range": {…}, "area": Area, "company": "Deligro",
  "vouchers": [{ "number": "DLG-SALES-20261020-bemetara", "type": "sales|commission|refunds|vendor_payout|rider_salary", "date": "YYYY-MM-DD", "narration": "…", "reference": "…|null",
                 "lines": [{ "ledger": "Vendor Payable", "debit": 0, "credit": 1234.00 }] }],
  "totals": { "debit": 99999.00, "credit": 99999.00 },
  "reconciliation": [{ "figure": "customerPaid|deliveryFees|platformCommission|refunds|vendorPaymentsCompleted|riderPayoutsCompleted", "export": 1234.00, "finance": 1234.00, "match": true }] }`.
- Same route with `format=tally[&includeMasters=1]` → `200 application/xml; charset=utf-8`, `Content-Disposition: attachment; filename="deligro-tally-<from>-<to>.xml"`; `format=journal` → `text/csv; charset=utf-8`, filename `deligro-journal-<from>-<to>.csv`. 409 `unbalanced` (`{ "voucher": "<number>" }`) — never a partial file. Requires `manager.accounting.export` + `manager.finance.view`.

### Area filter (multi-city) — applies to every existing manager route

Every route that accepts `zone` (dashboard, stats, orders, live, vendors, products, riders, finance, reports, tickets, alerts, audit, campaigns, offers, customers) also accepts `city`. Payloads that carry a per-zone list gain a sibling city list: stats `zones` → `cities` (Phase 2 fix may have added it — reuse), ticket metrics `recurring.zones` → `recurring.cities`, finance overview `byZone` (if present) → `byCity`, report rows grouped by zone → an extra city-subtotal row per city (`rowType: "city_subtotal"`), and the insight payloads above. `GET /api/manager/me` (Phase 1) is unchanged (already grouped by city).

## Requirement coverage

| Spec item | Task |
|---|---|
| §17.1 demand forecasting by city and time | S2 (`0170` rollup), S3 (forecast + backtest), A2 |
| §17.2 rider demand and availability forecasting | S2 (rider supply rollup), S3, A2 |
| §17.3 delivery zone optimisation | S4 (`ops_zone_grid`, suggestions), A3 (map overlay) |
| §17.4 automated rider assignment | S5 (`0172`, dispatch change), A4 |
| §17.5 vendor performance benchmarking | S4 (`ops_vendor_benchmarks`, verdicts), A3 |
| §17.6 fraud and unusual transaction alerts | S6 (`0173`, five rules → Phase 8 engine, dismissals, device hash), A4 |
| §17.7 automated operational reports | S7 (`0174` schedules/runs, server PDF, cron, delivery), A5 |
| §17.8 multiple-city management | S1 (area filter + `rollupByCity` everywhere), S7 (admin city filter), A1 (area picker everywhere) |
| §17.9 service-level agreement monitoring | S4 (targets, breaches), S6 (`sla_breach` evaluator), A3 |
| §17.10 integration with accounting systems | S8 (`ops_accounting_lines`, Tally XML, journal CSV, admin ledger names, parity), A5 |
| Design: heavy work in SQL, never unbounded Node reads | S1 structural QA, S2–S8 |
| Design: audit on configuration changes | S4 (SLA targets), S5 (dispatch mode), S6 (fraud rules, dismissals), S7 (schedules) |

## Review Focus

1. **Thin or broken history.** A zone created 10 days ago, a week with zero orders, a festival spike, all-zero backtest actuals → `insufficientHistory` true, no `NaN`/`Infinity` anywhere, `mape`/`wape` `null` rather than 0 or ∞, riders needed 0 for empty hours, and the app says "Not enough history yet" instead of drawing a confident line. (S3 QA fixtures; A2 widget test.)
2. **Auto-assign races.** Two dispatch runs for one order, a rider going offline between `chooseRider` and the RPC, a suspended or out-of-zone rider, a rider already at max load → never two `assigned` legs, never an ineligible rider, and a clean fall back to offers; a zone left on `offer` behaves exactly as before. (S5 PGlite concurrency + QA.)
3. **Scope leaks through filters and schedules.** A `city` containing zones the caller lacks, a schedule whose recipient lost `finance.view` or a zone since it was created, an old signed link, overlapping cron runs → narrowed-to-nothing payloads, skipped recipients listed on the run, 403 from download, one run per period. (S1, S7 QA.)
4. **Accounting that does not reconcile.** Paise rounding, a refund listed twice, an unpaid online checkout, a settlement paid on a different day than its orders, a day with only refunds → every voucher balances, totals equal Finance overview for the same range and area, `unbalanced` is a 409 not a file. (S8 parity + Tally XML schema test.)
5. **Fraud privacy and noise.** Evidence never carries phone, address or device data; device ids are only ever stored hashed with the pepper; a dismissed subject does not re-alert next sweep unless its measure doubles; rules do not fire on tiny samples (p95 needs ≥ 50 orders, refund rate ≥ 3 delivered). (S6 QA; S8-of-Phase-8 PII scanner extended to fraud payloads in S6.)

---

## Task P0: Merge siblings, reconcile, record what landed (main worktree)

**Files:** Modify: this plan (append `## P0 result`), whatever the merges touch.

- [ ] **Step 1:** In `F:\hub26\deligro-manager`: `git merge feat/vendor-app`, `git merge feat/rider-app`. Resolve conflicts keeping both sides' behaviour.
- [ ] **Step 2:** Record under `## P0 result`: whether `rider_shifts`, `delivery_exceptions` (with kind `customer_unreachable`), `rider_payouts` and `cash_deposits` exist on the branch (from the Rider merge or Phase 5's `0150`); whether `dispatchOrder`/`chooseRider` changed on the Rider branch since Phase 3 (the S5 edit point); whether the customer app already sends any install id header.
- [ ] **Step 3:** Diff every function re-declared across ≥ 2 migrations (at least `guard_order_update`, `ops_assign_rider`, `log_delivery_event`, `lock_restaurant_privileged_fields`) and make the latest definition on the branch carry every behaviour; run every `scripts/qa/sql/migration-*.mjs` and every offline `scripts/qa/manager-*.ts` — all pass.
- [ ] **Step 4:** Commit the merges, then `fix(db): reconcile re-declared functions after merging sibling work` (if any), then `docs(manager-app): phase 9 P0 result`. Create both worktrees from that commit.

---

# Part S — server (worktree `deligro-manager-p9s`)

### Task S1: Area filter (multi-city), city rollups, insight permissions

**Files:** Modify `src/lib/auth/manager-api.server.ts` (or wherever `narrowScope` lives), every `src/app/api/manager/**/route.ts` that reads `zone`, the Phase 2/6/8 payload builders with per-zone lists, `src/lib/features/catalog.ts`, `src/app/admin/page.tsx` + `src/app/admin/reports/*` (city filter); Create `src/lib/ops/area.ts`, `scripts/qa/manager-area.ts` (add `"test:manager-area"`).

**Interfaces — Produces:**
```ts
export type AreaQuery = { zone?: string | null; city?: string | null };
export function parseAreaQuery(sp: URLSearchParams): AreaQuery | { error: "bad_request"; field: "zone" | "city" };
export function narrowScope(scope: ManagerScope, area: AreaQuery, zoneCity: Map<string, string>): ManagerScope;   // existing signature extended; zone wins; never widens
export function areaLabel(scope: ManagerScope, area: AreaQuery, names: { zones: Map<string, string>; cities: Map<string, string> }): { type: "scope" | "city" | "zone"; id: string | null; name: string };
export function rollupByCity<R extends { zoneId: string }>(rows: R[], zoneCity: Map<string, { id: string; name: string }>, spec: { sum: (keyof R)[]; ratios?: { key: keyof R; num: keyof R; den: keyof R }[] }): ({ cityId: string; name: string } & Partial<R>)[];
export async function loadZoneCityMap(): Promise<Map<string, { id: string; name: string }>>;   // cached 60 s
```
Catalog: add `manager.insights.view` (on), `manager.dispatch.configure` (off), `manager.accounting.export` (off) — English labels and `offMeans`, no `labelHi`.

- [ ] **Step 1: Write `manager-area.ts`:** `parseAreaQuery` rejects a non-uuid zone/city (400 field); `narrowScope` with `city` = C (zones A1, A2) for a manager holding A1 and B1 → `{ all: false, zoneIds: [A1] }`; with a city the manager has no zone in → empty; `zone` + `city` → zone wins; admin + city → that city's zones; `rollupByCity` sums counts and recomputes `rate = num/den` (zones 1/10 and 9/30 → 10/40 = 0.25, not the 0.2 average of 0.1 and 0.3); structural: every `route.ts` under `src/app/api/manager/` that references `searchParams.get("zone")` also passes through `parseAreaQuery` (grep), and no file under `src/app/api/manager/insights/**` or `src/lib/ops/insights/**` imports `loadMetricOrders` or `readAll`; catalog: the three keys exist with the stated defaults and no `labelHi`; no Devanagari under `src/lib/ops/insights/**`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement;** extend each per-zone payload with its city list; admin dashboard and Reports get a city `SelectFilter` (console rules: tokens, container queries). **Step 4:** QA, `npx tsc --noEmit`, eslint, `npm run test:platform`, every earlier offline `test:manager-*` — PASS.
- [ ] **Step 5: Commit** `feat(api): city filter and city rollups across every manager area`.

### Task S2: Migration 0170 — hourly demand and rider supply rollups

**Files:** Create `supabase/migrations/0170_insight_rollups.sql`, `scripts/qa/sql/migration-0170.mjs`, `src/lib/ops/insights/rollups.ts`; Modify `src/lib/dispatch/sweep.ts` (throttled refresh), `docs/DATABASE.md`.

**Produces (database):**
- `ops_hourly_demand (zone_id uuid not null, hour_start timestamptz not null, orders int not null, delivered int not null, cancelled int not null, customer_paid bigint not null, primary key (zone_id, hour_start))` — orders by `ops_counts_as_order` (0144), `hour_start` = IST hour start.
- `ops_hourly_rider_supply (zone_id uuid not null, hour_start timestamptz not null, rider_minutes numeric(10,2) not null, delivered int not null, primary key (zone_id, hour_start))` — shifts clipped to the hour, a rider's minutes split `1/n` over their `staff_zones`; `delivered` = deliveries delivered in that hour for orders of the zone.
- `ops_refresh_insight_rollups(p_from timestamptz, p_to timestamptz) returns int` — recomputes and upserts every zone-hour in `[p_from, p_to)` (idempotent; deletes rows that became zero); `ops_backfill_insight_rollups() returns int` — 10 weeks, only when `ops_hourly_demand` is empty. Both service role only. RLS on, no policies; revoke all from anon/authenticated.
- `rollups.ts`: `refreshInsightRollups(now)` — claims `ops_alert_runs('insight_rollups', 900)`, backfills when empty, else refreshes `[now − 72 h, now)`; called from `sweepDispatch()`.

- [ ] **Step 1: Write `migration-0170.mjs`** (apply chain as earlier proofs): fixture orders across two zones, an unpaid online checkout, a cancelled order, an order at 23:50 IST and one at 00:10 IST → demand rows match `ops_counts_as_order` per IST hour (unpaid excluded, cancelled in `cancelled`); a shift 18:40–20:15 for a rider in two zones → 20/60/15 minutes split half to each zone per hour; refresh twice → same rows (idempotent); an order cancelled after the first refresh moves from `orders`… to `cancelled` on the second; backfill no-ops when rows exist; authenticated cannot select either table; parity: Σ `orders` over a day = `ops_dashboard_rollup` orders count for that day and zone.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration and `rollups.ts`. Step 4: All SQL proofs PASS; `npx tsc --noEmit`.**
- [ ] **Step 5: Commit** `feat(db): 0170 hourly demand and rider supply rollups`.

### Task S3: Forecast maths and the demand and riders routes

**Files:** Create `src/lib/ops/insights/forecast.ts`, `src/lib/ops/insights/insights-contract.ts`, `src/app/api/manager/insights/demand/route.ts`, `src/app/api/manager/insights/riders/route.ts`, `scripts/qa/manager-forecast.ts` (add `"test:manager-forecast"`).

**Produces:**
```ts
export const FORECAST = { weeks: 8, decay: 0.75, trendClamp: [0.75, 1.25], minWeeks: 2, horizonHours: 168, backtestDays: 14 } as const;
export const RIDERS = { productivityDays: 28, minSampleHours: 20, defaultProductivity: 2.0, usualWeeks: 4 } as const;
export type HourlyPoint = { hourStart: Date; orders: number };
export function forecastHours(history: HourlyPoint[], start: Date, hours: number): { points: { hourStart: Date; orders: number }[]; trend: { factor: number; last4Weeks: number; prior4Weeks: number }; insufficientHistory: boolean; weeksOfHistory: number };
export function backtest(history: HourlyPoint[], now: Date): { hoursCompared: number; mape: number | null; wape: number | null; byDay: { date: string; forecast: number; actual: number }[] };
export function productivity(supply: { hourStart: Date; riderMinutes: number; delivered: number }[], platformFallback: number | null): { value: number; sampleHours: number; source: "zone" | "platform" | "default" };
export function ridersPlan(forecast: { hourStart: Date; orders: number }[], supply: { hourStart: Date; riderMinutes: number }[], prod: number): { hourStart: Date; forecastOrders: number; ridersNeeded: number; ridersUsuallyOnline: number; gap: number }[];
export function demandPayload(...): DemandPayload; export function ridersPayload(...): RidersPayload;   // the pinned JSON
```
Routes: `managerApiContext("manager.insights.view")`, `parseAreaQuery` → `narrowScope`, read rollup rows for the scope's zones over the last 10 weeks (one query each, summed per hour across zones), compute, serialise; read rate limit 60/min.

- [ ] **Step 1: Write `manager-forecast.ts`:** constant history of 5 orders every Tuesday 19:00 for 8 weeks → forecast 5.0 for next Tuesday 19:00, trend 1.0; weights: weeks 1–8 values 8,0,…,0 → `8·1/Σ0.75^(k−1)` ≈ 1.92 (to 2 dp); trend: last 4 weeks 120, prior 80 → 1.25 (clamped from 1.5); prior 0 → 1.0; 10 days of history → `insufficientHistory` true, `weeksOfHistory` 1; backtest with all-zero actuals → `mape` null, `wape` null, `hoursCompared` 0-positive-actual hours; perfect history → `mape` 0; one hour f=4 a=2 and one f=2 a=2 → mape 0.5, wape 0.5; DST-free IST hour keys for 23:00–00:00 boundary; `productivity` with 25 sample hours of 2 riders delivering 5 → 2.5 `zone`, with 10 hours → platform fallback, none → 2.0 `default`; `ridersPlan` 6.4 orders at 2.5 → 3 needed, 0.3 orders → 0; usual = median of 4 weekday-hour samples; no NaN/Infinity in any payload field (JSON scan); route offline half: `?zone=bad` → 400; online half (skip when no server): QA manager without `insights.view` → 403.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: QA, tsc, eslint — PASS.**
- [ ] **Step 5: Commit** `feat(insights): demand forecast with backtest, and riders needed by hour`.

### Task S4: Migration 0171 — zone grid, vendor benchmarks, SLA

**Files:** Create `supabase/migrations/0171_insight_analytics.sql`, `scripts/qa/sql/migration-0171.mjs`, `src/lib/ops/insights/{zone-suggestions,benchmarks,sla}.ts`, routes `src/app/api/manager/insights/{zones,vendors,sla,sla-targets}/route.ts`, `scripts/qa/manager-insights-analytics.ts` (add `"test:manager-insights-analytics"`); Modify `docs/DATABASE.md`.

**Produces (database, all service role only):**
- `ops_zone_grid(p_zone_ids uuid[], p_all boolean, p_from timestamptz, p_to timestamptz, p_min_cell_drops int) returns jsonb` — `{ zones: [...], cells: [...] }` per *Claude's calls* (cells below the minimum omitted; zone totals include every drop; `outsideRadiusShare`, p95 distance from centre per zone for `resize_zone`).
- `ops_vendor_benchmarks(p_zone_ids uuid[], p_all boolean, p_from timestamptz, p_to timestamptz) returns table (restaurant_id uuid, zone_id uuid, orders int, prep_minutes numeric, accept_minutes numeric, cancellation_rate numeric, rating numeric, aov numeric, repeat_rate numeric)`.
- `ops_sla_targets (id bigint identity pk, zone_id uuid null → delivery_zones cascade, accept_minutes smallint not null, prep_minutes smallint not null, pickup_minutes smallint not null, deliver_minutes smallint not null, updated_by uuid, updated_at timestamptz default now(), unique nulls not distinct (zone_id))` seeded with the default row; select for managers (not sensitive), writes revoked.
- `ops_sla_breaches(p_zone_ids uuid[], p_all boolean, p_from timestamptz, p_to timestamptz) returns jsonb` — overall, by zone, by vendor, by rider (≥ 5), daily, per stage `{orders, breaches, rate, medianMinutes}`.
- `ops_set_sla_target(p_actor, p_zone, p_accept, p_prep, p_pickup, p_deliver, p_reason, p_client_action_id)`, `ops_reset_sla_target(p_actor, p_zone, p_reason, p_client_action_id)` — audited `sla_target.set` / `sla_target.reset` with before/after; null zone admin-only.

**Produces (TS):**
```ts
export const ZONE_RULES = { minCellDrops: 3, newZoneShare: 0.10, newZoneMinDrops: 30, uncoveredMinDrops: 20, slowCellMinDrops: 20, slowFactor: 1.5, resizeP95Share: 0.6, resizeMinDrops: 50, mergeOrdersPerDay: 1, mergeMinDays: 14 } as const;
export function zoneSuggestions(zones: ZoneStat[], cells: CellStat[], rangeDays: number): Suggestion[];   // English text, rounded figures
export const BENCH = { minOrders: 5, inLinePct: 10, inLineRating: 0.1, inLineRatePp: 0.02 } as const;
export function benchmark(rows: VendorBenchRow[]): { zones: ZoneMedians[]; vendors: VendorBench[] };      // medians over eligible vendors; verdict per metric
export function stageStat(durations: number[], target: number): { orders: number; breaches: number; rate: number; medianMinutes: number | null };   // used by QA parity with the SQL
```

- [ ] **Step 1: Write `migration-0171.mjs`:** drops placed in three cells (5, 2, 30 drops) → two cells returned, zone `drops` = 37; a drop outside the radius counts in `outsideRadiusShare`; vendor fixture → `prep_minutes` median of [10, 20, 40] = 20, `accept_minutes` median, cancellation 1/4, repeat 1 of 2 customers = 0.5, unpaid online checkout excluded; SLA: accept 6 min vs target 5 → breach, prep using the order's own `prep_minutes` 25 when set, pickup stage counted only for orders that reached `ready`; manager sets zone-A target ok + audit row, null zone → `forbidden`, bounds enforced, replay no-op; authenticated cannot execute the RPCs.
- [ ] **Step 2: Write `manager-insights-analytics.ts`:** each `zoneSuggestions` rule fires exactly at its threshold and not one unit below (e.g. 9.9 % outside → none, 10 % with 30 drops → `new_zone` with the outside centroid; 29 drops → none); `benchmark` verdicts (Δ 9 % → `in_line`, 11 % worse on prep → `worse`, rating 4.25 vs 4.2 → `in_line`); vendor with 4 orders → `not_enough_data` and excluded from the median; `stageStat` equals the SQL figures for the same fixture (parity); city rollup of SLA recomputes rates from counts; text has no Devanagari; routes: offline validation of ranges and bounds, online (skip) 403 without `insights.view`, PUT without `alerts.configure` → 403.
- [ ] **Step 3: Run both — FAIL. Step 4: Implement migration, modules, routes. Step 5: All SQL proofs + QA, tsc, eslint — PASS.**
- [ ] **Step 6: Commit** `feat(insights): zone grid and suggestions, vendor benchmarks, SLA targets and breaches`.

### Task S5: Migration 0172 — per-zone automatic assignment

**Files:** Create `supabase/migrations/0172_auto_assign.sql`, `scripts/qa/sql/migration-0172.mjs`, `src/app/api/manager/insights/dispatch/route.ts`, `scripts/qa/manager-auto-assign.ts` (add `"test:manager-auto-assign"`); Modify `src/lib/dispatch/rider-dispatch.ts` (`dispatchOrder`), `src/lib/ops/live-rules.ts` (export the max-load filter), admin Settings → Zones page (mode + max load per zone, same audited RPC), `docs/DATABASE.md`.

**Produces (database):**
- `delivery_zones.dispatch_mode text not null default 'offer' check in ('offer','auto_assign')`, `auto_assign_max_load smallint not null default 0 check between 0 and 3`, `dispatch_updated_by uuid`, `dispatch_updated_at timestamptz`.
- `deliveries.assignment_source text check in ('rider_accept','ops','auto')` (null on legacy rows); `grant select (assignment_source) on public.deliveries to authenticated`; set to `'ops'` by Phase 3's `ops_assign_rider`/`ops_reassign_delivery` (re-declared from their latest bodies with only this line added — diff in the proof) and to `'rider_accept'` by the rider accept path (default via trigger when a rider claims an offer).
- `rider_eligible_for_order(p_rider uuid, p_order uuid) returns text` — `null` when eligible, else `offline|on_break|stale_fix|suspended|out_of_zone` (the SQL half of Phase 3's rules; `ops_assign_rider` re-declared to call it so the two can never diverge).
- `ops_auto_assign_delivery(p_order uuid, p_rider uuid, p_max_load int) returns text` (service role only) — locks the delivery row; requires zone mode `auto_assign`, delivery absent or `unassigned`, `rider_eligible_for_order` null, rider's active deliveries ≤ `p_max_load`; assigns (`status='assigned'`, `assigned_at`, `assignment_source='auto'`, `driver_location_source='none'`); returns `null` on success or the refusal code (`already_assigned`, `mode_off`, `over_load`, eligibility code).
- `ops_set_zone_dispatch(p_actor, p_zone, p_mode, p_max_load, p_reason, p_client_action_id)` — audited `zone.dispatch_mode` (before/after), reason required; requires the actor to hold the zone.

**Produces (TS):** in `dispatchOrder(orderId, trigger)`: read the order's zone mode; when `auto_assign`: candidates from `chooseRider`'s ranking (refactor `chooseRider` to expose `rankDispatchCandidates(...)` returning the ordered list it already computes), filter with `riderEligibility` + load ≤ max, try `ops_auto_assign_delivery` for the first 3; on success `notifyDriverAssigned` + `notifyVendorRiderAssigned` (existing) and return `{ rider, offered: false, autoAssigned: true }`; otherwise continue to the unchanged offer path and count `fellBackToOffer` (an `obs` counter event). `GET/PUT /api/manager/insights/dispatch` per the contract (`last24h` from `deliveries.assignment_source` over `assigned_at` in the last 24 h; `fellBackToOffer` from the obs counter).

- [ ] **Step 1: Write `migration-0172.mjs`:** zone in `offer` → `mode_off`; zone in `auto_assign`: eligible idle rider → assigned, source `auto`; second concurrent call for the same order → `already_assigned` (two sessions, one wins); rider offline → `offline`; rider with 1 active delivery and max load 0 → `over_load`, max load 1 → assigned; rider out of zone → `out_of_zone`; `ops_assign_rider` still behaves exactly as its 0142 proof (re-run those assertions) and now stamps `ops`; `rider_eligible_for_order` agrees with the old inline checks on every fixture; mode change audited with reason, without reason → `reason_required`, zone not held → 42501.
- [ ] **Step 2: Write `manager-auto-assign.ts`:** with a stubbed RPC: first candidate refused (`stale_fix`), second accepted → that rider, 2 RPC calls; all three refused → offer path called once; zone `offer` → offer path, zero RPC calls; structural: `dispatchOrder` contains no direct `deliveries` update for the auto path (only the RPC).
- [ ] **Step 3: Run — FAIL. Step 4: Implement. Step 5: SQL proofs, QA, `test:manager-live`, `test:driver-app` (if present), tsc, eslint — PASS.**
- [ ] **Step 6: Commit** `feat(dispatch): per-zone automatic rider assignment with the same eligibility rules`.

### Task S6: Migration 0173 — fraud rules and SLA alerts in the engine

**Files:** Create `supabase/migrations/0173_fraud_and_sla_alerts.sql`, `scripts/qa/sql/migration-0173.mjs`, `src/lib/ops/alerts/fraud.ts`, `src/lib/ops/alerts/sla.ts`, routes `src/app/api/manager/insights/fraud/route.ts`, `…/fraud/[alertId]/dismiss/route.ts`, `…/fraud-rules/route.ts`, `scripts/qa/manager-fraud.ts` (add `"test:manager-fraud"`); Modify `src/lib/ops/alerts/catalog.ts` (`evaluated: "sweep"` for both kinds), `src/lib/ops/alerts/engine.ts` (load fraud/SLA facts via the RPCs), the order placement route(s) (`src/app/api/orders/route.ts` and the web checkout action) to record `order_client_meta`, `apps/customer/lib/core/api.dart` (send `x-device-id`; install UUID in prefs), Phase 8 PII scanner (`scripts/qa/manager-pii.ts`) to include fraud payloads, `.env.local.example`/docs (`DEVICE_HASH_PEPPER`), `docs/DATABASE.md`.

**Produces (database):**
- `ops_fraud_rules (id bigint identity pk, rule text not null check in ('customer_cancellations','code_sharing','refund_rate','rider_cash_gap','unusual_order_value'), zone_id uuid null, enabled boolean not null default true, threshold numeric not null, window_days int not null, updated_by uuid, updated_at timestamptz default now(), unique nulls not distinct (rule, zone_id))` seeded with the defaults; select for managers, writes revoked.
- `ops_fraud_dismissals (id bigint identity pk, rule text, subject_key text, zone_id uuid, measure_at_dismissal numeric, until timestamptz, alert_id uuid, dismissed_by uuid, reason text, created_at timestamptz default now())`, index `(rule, subject_key, until)`.
- `order_client_meta (order_id uuid pk → orders cascade, device_hash text null, created_at timestamptz default now())` — RLS on, no policies, all privileges revoked from anon/authenticated (service role only); never joined into any payload.
- `ops_fraud_candidates(p_now timestamptz) returns table (rule text, zone_id uuid, subject_type text, subject_id text, measure numeric, threshold numeric, window_days int, evidence jsonb)` — evaluates the five rules per *Claude's calls* with effective per-zone rules, excluding active dismissals unless `measure ≥ 2 × measure_at_dismissal`; evidence ≤ 20 rows of ids, times and English text only.
- `ops_sla_live(p_now timestamptz) returns table (zone_id uuid, stage text, orders int, breaches int, rate numeric)` — trailing 60 min, including unfinished stages past target.
- `ops_dismiss_fraud(p_actor, p_alert, p_reason, p_days, p_client_action_id)` — resolves the alert with note `false positive: <reason>`, records the dismissal; audited `fraud.dismiss`. `ops_set_fraud_rule(p_actor, p_rule, p_zone, p_enabled, p_threshold, p_window_days, p_client_action_id)` — audited `fraud_rule.set`; null zone admin-only; bounds per unit.
- `update ops_alert_rules set enabled = true where kind in ('fraud_suspected','sla_breach') and zone_id is null` (threshold for `sla_breach` = 25).

**Produces (TS):** `evaluateFraud(candidates, rules): DesiredAlert[]` and `evaluateSla(rows, rule): DesiredAlert[]` (pure; titles like "Possible coupon sharing: code DIWALI50 used by 4 accounts at one drop point", "Pickup SLA breached for 31% of orders in Bemetara in the last hour"); the engine calls both from `evaluate()` and clears with `ops_clear_alerts`. Fraud alerts' audience permission = `manager.customers.view` (rider cash gap: `manager.finance.view`). Routes per the contract; `fraud` list joins `ops_alerts` (kind `fraud_suspected`) with the latest candidate evidence stored in the alert body JSON (`ops_raise_alert` body carries a compact JSON tail — or a new `ops_alerts.details jsonb` column added here; choose the column, `select` granted to managers by the existing policy).

- [ ] **Step 1: Write `migration-0173.mjs`:** each rule fires at threshold and not below (3 customer cancellations in 7 days → candidate, 2 → none; 4th cancellation 8 days old not counted; COD `customer_unreachable` failure counts; code redeemed by 2 accounts at one drop point with `max_per_customer` 1 → candidate; refund rate 1/3 = 33 % → candidate, 1/2 → none (needs 3 delivered); cash gap ₹2,001 pending 49 h → candidate, open dispute → none; order ₹5,000 vs p95 ₹1,200 with 60 orders → candidate, with 40 orders → none); a dismissal suppresses the subject until `until` and stops suppressing when the measure doubles; `order_client_meta` unreadable by authenticated; dismiss/rule RPCs audited and bounded; SLA live: 2 of 5 pickups past target → rate 0.4.
- [ ] **Step 2: Write `manager-fraud.ts`:** `evaluateFraud`/`evaluateSla` produce stable dedupe keys within an IST week/hour; critical at 2 × threshold; English only; evidence and payload scan finds no phone/address/device fields (extend Phase 8's scanner); the order route stores a 64-hex hash when `x-device-id` + pepper are present, nothing when the pepper is missing, and rejects a non-uuid header silently (no hash); structural: no route selects `order_client_meta`.
- [ ] **Step 3: Run — FAIL. Step 4: Implement** (customer app: generate the install id once, send it on every API call; `flutter analyze`/`flutter test` in `apps/customer`). **Step 5: SQL proofs, QA, `test:manager-alerts`, tsc, eslint — PASS.**
- [ ] **Step 6: Commit** `feat(insights): fraud rules and SLA breach alerts in the alert engine, with dismissals`.

### Task S7: Migration 0174 — scheduled reports, server PDF, delivery; accounting settings

**Files:** Create `supabase/migrations/0174_report_schedules_accounting.sql`, `scripts/qa/sql/migration-0174.mjs`, `src/lib/reports/pdf/render.ts`, `src/lib/reports/pdf/fonts/{Roboto-Regular.ttf,Roboto-Bold.ttf,LICENSE.txt}`, `src/lib/ops/insights/schedules.ts`, routes `src/app/api/manager/report-schedules/route.ts`, `…/[id]/route.ts`, `…/[id]/runs/route.ts`, `…/[id]/run-now/route.ts`, `src/app/api/manager/report-runs/[id]/route.ts`, `…/[id]/download/route.ts`, `src/app/api/cron/reports/route.ts`, `scripts/qa/manager-schedules.ts` (add `"test:manager-schedules"`); Modify `next.config.ts` (`outputFileTracingIncludes` for the font directory on the cron and run-now routes), `package.json` (`pdf-lib`, `@pdf-lib/fontkit`), `src/lib/dispatch/sweep.ts` (throttled `runDueSchedules`), `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md`.

**Produces (database):**
- `report_schedules (id uuid pk, name text 3–80, kind text, filters jsonb not null default '{}', frequency text check in ('daily','weekly'), weekday smallint check 1–7 null, hour_ist smallint check 0–23, range_preset text check in (...), zone_ids uuid[] null, recipient_ids uuid[] not null, active boolean default true, owner_id uuid not null, next_run_at timestamptz not null, created_at, updated_at)`; `report_runs (id uuid pk, schedule_id uuid → cascade, period_from date, period_to date, status text check in ('running','sent','partial','too_large','failed'), file_path text, rows int, recipients_sent uuid[], recipients_skipped jsonb, error text, created_at, unique (schedule_id, period_from, period_to))`. RLS: managers select schedules they own or receive, runs of those; admins all; writes revoked (RPCs only).
- `ops_upsert_report_schedule(p_actor, p_id uuid null, p_fields jsonb, p_client_action_id)` (audited `report_schedule.create|update`), `ops_delete_report_schedule(p_actor, p_id, p_client_action_id)` (audited), `ops_claim_report_run(p_schedule, p_from date, p_to date) returns uuid` (insert-or-null on the unique key; service role), `ops_finish_report_run(...)`.
- Storage bucket `ops-reports` (private; no anon/authenticated policies; service role only).
- `accounting_settings` (single row, `id boolean pk default true check (id)`, `company_name text default 'Deligro'`, one `text` column per ledger name in *Claude's calls* with those defaults, `parent_groups jsonb`, `updated_by`, `updated_at`) — service role only; `ops_set_accounting_settings(p_actor, p_fields jsonb, p_client_action_id)` admin-only, audited `accounting_settings.set`.

**Produces (TS):**
```ts
export function presetPeriod(preset: RangePreset, nowIst: Date): { from: string; to: string };   // yesterday, last_7_days (ending yesterday), last_week (Mon–Sun), month_to_date (to yesterday; on the 1st = previous month), last_month
export function nextRunAt(s: { frequency: "daily" | "weekly"; weekday: number | null; hourIst: number }, after: Date): Date;
export function eligibleRecipient(p: { isAdmin: boolean; perms: Record<string, boolean>; zoneIds: string[] }, kind: ReportKindId, scheduleZones: string[] | null, ownerScopeZones: string[]): { ok: true } | { ok: false; reason: "permission" | "zone" };
export async function renderReportPdf(payload: ReportPayload, meta: { title: string; area: string; period: string; filters: string; generatedAt: Date; recipients: string[] }): Promise<Uint8Array>;
export async function runDueSchedules(now: Date): Promise<{ claimed: number; sent: number; skipped: number }>;   // lease 'report_schedules' 300 s
```
Cron route: `CRON_SECRET` bearer, fail closed (as dispatch-sweep); also called from `sweepDispatch` throttled. Retention: runs' files older than 90 days removed, `file_path` nulled (download → 410).

- [ ] **Step 1: Write `migration-0174.mjs`:** two `ops_claim_report_run` calls for one period → one uuid, one null; RLS: owner and recipients read the schedule, an unrelated manager reads nothing; schedule writes only via RPC, audited; `accounting_settings` unreadable by authenticated, admin-only setter.
- [ ] **Step 2: Write `manager-schedules.ts`:** `presetPeriod` for each preset on a Monday, on the 1st of a month, and at 00:30 IST; `nextRunAt` daily 08:00 at 07:59 → today 08:00, at 08:00 → tomorrow; weekly Monday; `eligibleRecipient` (lost finance permission for `commission` → `permission`; lost a zone → `zone`; admin ok); `renderReportPdf` produces a PDF (`%PDF-` header, page count ≥ 1, contains the text "Generated" and a ₹ amount when extracted with `pdf-lib`), 2,000-row payload renders multiple pages under 5 s; `runDueSchedules` with stubbed registry/storage/notifier: sends to eligible recipients, records skipped ones with reasons, owner inbox note on skips, `too_large` run on > 10,000 rows, second concurrent call claims nothing; download route: non-recipient → 403, recipient with current permission → signed URL (stub) with 300 s expiry, file pruned → 410; push text contains no URL with a token; English only.
- [ ] **Step 3: Run — FAIL. Step 4: Implement;** confirm `next build` traces the fonts (`.next/server` output contains the TTF) and the cron route runs in `next start` locally against a stubbed schedule. **Step 5: SQL proofs, QA, tsc, eslint, `next build` — PASS.**
- [ ] **Step 6: Commit** `feat(reports): scheduled reports — server PDF, private storage, permission-checked delivery`.

### Task S8: Accounting export — vouchers, Tally XML, journal CSV, admin ledger names

**Files:** Create `src/lib/ops/insights/accounting.ts`, `src/lib/ops/insights/tally.ts`, `src/app/api/manager/insights/accounting/route.ts`, `src/app/admin/settings/accounting/{page,accounting-form}.tsx` + server action, `scripts/qa/manager-accounting.ts` (add `"test:manager-accounting"`); Modify `supabase/migrations/0174_report_schedules_accounting.sql` (add `ops_accounting_lines`), `scripts/qa/sql/migration-0174.mjs`, admin Settings index (link), `docs/DATABASE.md`.

**Produces:**
- `ops_accounting_lines(p_zone_ids uuid[], p_all boolean, p_from date, p_to date) returns table (day date, zone_id uuid, figure text, method text, ref text, amount numeric(14,2))` (service role) — figures `customer_paid`, `deliveryFees`, `taxes`, `tips`, `food_value`, `platform_discount`, `commission`, `commission_gst`, `other_charges`, `refunds`, `vendor_payout` (per settlement, `ref` = transaction reference, day = `paid_at` IST), `rider_payout` (per payout) — the SQL mirror of `ops_order_breakdown` (0144) and Phase 6's definitions.
```ts
export type Voucher = { number: string; type: "sales" | "commission" | "refunds" | "vendor_payout" | "rider_salary"; date: string; narration: string; reference: string | null; lines: { ledger: string; debit: number; credit: number }[] };
export function buildVouchers(lines: AccountingLine[], settings: AccountingSettings, zones: Map<string, { slug: string; name: string }>): Voucher[];   // throws UnbalancedError(voucherNumber)
export function reconcile(vouchers: Voucher[], overview: FinanceOverview, settings: AccountingSettings): { figure: string; export: number; finance: number; match: boolean }[];
export function toTallyXml(vouchers: Voucher[], settings: AccountingSettings, opts: { includeMasters: boolean }): string;
export function toJournalCsv(vouchers: Voucher[]): string;   // BOM + formula guard (Phase 2 helper)
```

- [ ] **Step 1: Extend `migration-0174.mjs`:** `ops_accounting_lines` on the Phase 6 parity fixture (two IST days, 23:50 IST order, cancelled order, refund listed twice, vendor- and platform-funded discounts, a paid settlement on a later day, one rider payout, one unpaid online checkout) → figures equal `ops_order_breakdown`-based totals; refund once; unpaid online and cancelled excluded.
- [ ] **Step 2: Write `manager-accounting.ts`:** every voucher balances to the paisa; a deliberately broken line set → `UnbalancedError` naming the voucher; `reconcile` against `getFinanceOverview` computed from the same fixture → all `match: true` (customer paid, delivery fees, commission, refunds, vendor payments completed, rider payouts completed); Tally XML parses as XML, has one `VOUCHER` per voucher, debit `AMOUNT`s negative with `ISDEEMEDPOSITIVE` `Yes`, Σ amounts per voucher = 0, ledger names from settings, `&`/`<` escaped, `includeMasters` adds one `LEDGER` per distinct ledger; CSV header exact, BOM present, a ledger starting with `=` is guarded; voucher numbers unique and stable; route offline: range > 366 → 400, `format=bogus` → 400; online (skip): 403 without `accounting.export` or without `finance.view`; admin settings page saves through the audited RPC (`next dev` check, screenshot).
- [ ] **Step 3: Run — FAIL. Step 4: Implement. Step 5: SQL proofs, QA, `test:manager-reports` (parity still green), tsc, eslint, `npm run test:platform`, `next build` — PASS.**
- [ ] **Step 6: Commit** `feat(insights): accounting export — Tally XML vouchers and journal CSV that reconcile with Finance`.

---

# Part A — app (worktree `deligro-manager-p9a`, `apps/manager/` only)

### Task A1: Models, repositories, fixtures, and the area picker everywhere

**Files:** Create `lib/models/insights.dart`, `lib/data/insights_repository.dart` (`InsightsRepository` interface, `ApiInsightsRepository`, `FakeInsightsRepository`), `test/fixtures/api/insights/*.json` (one per endpoint, hand-written from the contract), `lib/widgets/area_picker.dart`, `lib/state/area.dart`; Modify every screen using the Phase 1/2 zone picker (Home, Statistics, Orders, Live, Finance, Reports, Vendors, Riders, Support, Alerts, Audit, Marketing, Offers, Customers) and their repositories (send `city` or `zone`).

**Produces:** `sealed class Area { const Area(); }` with `AreaScope()`, `AreaCity(id, name)`, `AreaZone(id, name, cityName)`; `Map<String,String> Area.toQuery()`; `areaProvider` (`Notifier<Area>`, shared across tabs, persisted per account, reset on sign-out); `AreaPicker` bottom sheet: "All my zones", then per city "All of <City>" followed by its zones (cities with one zone show only the zone); models for every pinned shape with nullable fields as pinned.

- [ ] **Step 1: Write `insights_models_test.dart` + `area_test.dart`:** every fixture parses; null `mape`/`wape`, null vendor values and `not_enough_data` verdicts parse; `AreaCity.toQuery()` → `{city: id}`, zone → `{zone: id}`, scope → `{}`; picker lists cities in name order with "All of" rows; selecting a city on Home then opening Orders carries it (provider shared); sign-out resets to scope; a 400 `range_too_long` maps to a typed error.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: `flutter analyze`, `flutter test` — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): insight models and a city-aware area picker on every screen`.

### Task A2: Insights hub, demand forecast, riders needed

**Files:** Create `lib/features/insights/insights_hub_screen.dart`, `demand_screen.dart`, `riders_needed_screen.dart`; Modify `lib/router.dart` (`/more/insights`, `/more/insights/demand`, `/more/insights/riders`), More menu (Insights row gated by `manager.insights.view`).

- Hub: tiles for Demand forecast, Riders needed, Zone map, Vendor benchmarks, SLA, Fraud (hidden without `customers.view`), Dispatch (always visible to read; edit gated), Scheduled reports, Accounting export (hidden without `accounting.export` + `finance.view`).
- Demand: area picker; 7-day bar chart of daily forecast; hour-by-hour line for a selected day with the low/high band; peak hour callout; trend chip ("+8% vs previous 4 weeks"); "Typical error" card with WAPE and MAPE as percentages and "compared over N hours in the last 14 days", or "Not enough history yet" when null/insufficient; insufficient-history banner. No polling.
- Riders needed: per-day strip with peak needed vs usually online; selected day's 24-hour bars (needed) with a line (usually online), short hours highlighted; productivity note with its source ("Based on 2.4 deliveries per rider-hour in this zone" / "platform average" / "a default of 2.0 until there is enough history").

- [ ] **Step 1: Write widget tests:** hub hides Fraud and Accounting tiles without their permissions; demand renders 7 bars and the band from the fixture; `insufficientHistory` shows the banner and keeps the chart labelled "Rough estimate"; null `wape` shows "Not enough history yet"; riders screen highlights exactly the fixture's short hours; productivity source text per value; strings English (no Devanagari scan of `lib/features/insights`).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: analyze, test — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): insights hub, demand forecast and riders needed`.

### Task A3: Zone map, vendor benchmarks, SLA

**Files:** Create `lib/features/insights/zone_map_screen.dart`, `vendor_benchmarks_screen.dart`, `sla_screen.dart`, `sla_targets_sheet.dart`; Modify `lib/router.dart`.

- Zone map: `flutter_map` (OSM tiles, as the customer app) with zone circles, grid cells as filled rectangles shaded by drops (sequential palette from the theme tokens) with a toggle to shade by median delivery minutes; tap a cell → bottom sheet with its figures; suggestions list below the map, each tapping to centre the map on its `center`; date range chips (7, 28, 90 days, custom); zone and city summary rows. Tablet: map and list side by side.
- Vendor benchmarks: zone medians header; vendor rows with six metrics, each showing value and a verdict mark (better/worse/in line/not enough data) in words, not colour alone; sort by any metric; tap → vendor detail (Phase 4 route); paging.
- SLA: four stage cards (rate, breaches/orders, median vs target); daily line chart per stage; worst vendors and riders tables; zone and city tables; "Edit targets" sheet (only with `alerts.configure`) with bounds validation and a required reason.

- [ ] **Step 1: Write widget tests:** map builds one rectangle per fixture cell and one circle per zone; tapping a suggestion moves the map centre (controller spy); shading toggle changes the legend; benchmarks show "Not enough data" for a 4-order vendor and sort by prep time; SLA edit sheet hidden without permission, rejects prep 0 and a 2-character reason, sends `clientActionId` reused on retry; English-only scan.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: analyze, test — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): zone map with suggestions, vendor benchmarks and SLA monitoring`.

### Task A4: Fraud cases and dispatch mode

**Files:** Create `lib/features/insights/fraud_screen.dart`, `fraud_case_screen.dart`, `fraud_rules_screen.dart`, `dispatch_screen.dart`; Modify `lib/router.dart`, the Phase 8 alert-to-screen link map (`fraud_suspected` → `/more/insights/fraud/<alertId>`, `sla_breach` → `/more/insights/sla?zone=<zoneId>`).

- Fraud: tabs Open / Dismissed / Resolved with counts; case cards (rule in words, subject label, measure vs threshold, window); case screen with evidence rows linking to the order/customer/rider screens of earlier phases; "Dismiss as false positive" (reason 3–300, days 7/30/90); rules screen (per zone, inherited marked, edit with `alerts.configure`, master switch shown read-only from Alerts thresholds).
- Dispatch: one row per zone — mode ("Offer to riders" / "Assign automatically"), max load, last 24 h counts; edit sheet only with `dispatch.configure`, with an explanation of each mode and a required reason; confirmation dialog when switching to automatic.

- [ ] **Step 1: Write widget tests:** fraud list counts and tab filtering from fixtures; dismiss requires reason and posts days; evidence rows contain no phone pattern; dispatch edit hidden without permission; switching to automatic shows the confirmation and sends `autoAssignMaxLoad`; alert link map routes the two kinds.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: analyze, test — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): fraud cases with dismissal, fraud rules, and per-zone dispatch mode`.

### Task A5: Scheduled reports and accounting export

**Files:** Create `lib/features/insights/schedules_screen.dart`, `schedule_form_screen.dart`, `schedule_runs_screen.dart`, `report_run_screen.dart`, `accounting_screen.dart`; Modify `lib/router.dart` (`/more/insights/reports`, `/more/insights/reports/:id`, `/more/insights/reports/runs/:runId`, `/more/insights/accounting`), push/inbox link map (report delivery → run screen).

- Schedules: list with next run and last run status; form (name, kind from the permitted list, filters per the kind's registry filters, frequency, weekday, hour, period preset, zones via the area picker, recipients from `/api/manager/tickets/assignees`-style staff list filtered to the zone — reuse Phase 8's assignees endpoint — showing ineligible ones disabled with the reason); pause/resume, delete (owner only); "Run now".
- Run screen: period, rows, status, recipients sent/skipped; "Open PDF" fetches the 5-minute URL, downloads to the cache directory and opens the share sheet (`share_plus`); 410 → "This file has been removed (kept for 90 days)".
- Accounting: date range (≤ 366 days), area picker, summary table of vouchers by type and the reconciliation list (match ticks; a mismatch shown in words); buttons "Download Tally XML" (option "Include ledger masters") and "Download journal CSV" → file saved and shared; 409 `unbalanced` → names the voucher and says nothing was exported.

- [ ] **Step 1: Write widget tests:** form only offers permitted kinds and disables ineligible recipients; weekly shows the weekday picker, daily hides it; run screen requests a fresh URL each tap; 410 message; accounting shows reconciliation rows and blocks download on `unbalanced`; file names match the contract.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: analyze, test — PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): scheduled reports and accounting export`.

### Task A6: Release check (app half)

- [ ] **Step 1:** `flutter analyze` clean; `flutter test` all pass; Devanagari scan of `apps/manager/lib` → none; `flutter build apk --release --dart-define-from-file=env/prod.json` (F:\dev env).
- [ ] **Step 2:** Install on `deligro_test`; cold start reaches login with no `E/flutter`/FATAL in logcat; golden/screenshot tests from fixtures for the Insights hub, Demand, Riders needed, Zone map (with cells and suggestions), Vendor benchmarks, SLA, Fraud list and case, Dispatch, Schedules, Run, Accounting — light and dark, phone and tablet for Zone map and Demand — saved under the scratchpad and listed in the commit body.
- [ ] **Step 3: Commit** `chore(manager-app): phase 9 release check`.

---

## Task I1: Merge, contract check, phase exit (main worktree)

- [ ] **Step 1:** In `F:\hub26\deligro-manager`: `git merge feat/manager-p9-server`, then `git merge feat/manager-p9-app`; resolve.
- [ ] **Step 2: Contract check.** Extend `scripts/qa/manager-contract-emit.ts` to run the S3–S8 serialisers on in-file fixtures (forecast with and without history, riders with each productivity source, zone grid with every suggestion type, vendor benchmarks with `not_enough_data`, SLA with inherited and overridden targets, dispatch both modes, fraud cases of all five rules incl. a dismissed one, schedules with skipped recipients, runs in every status, accounting summary) writing `apps/manager/test/fixtures/api/generated/insights_*.json`; extend `contract_test.dart` to parse each with the A1 models and assert every non-nullable field is present and typed; also re-emit one payload per earlier area with `city` set to prove the `cities` siblings parse. Run `npx tsx scripts/qa/manager-contract-emit.ts && cd apps/manager && flutter test test/contract_test.dart` — PASS. Commit the generated fixtures.
- [ ] **Step 3: Phase exit.** Every `scripts/qa/sql/migration-*.mjs`; `npm run test:manager-area`, `test:manager-forecast`, `test:manager-insights-analytics`, `test:manager-auto-assign`, `test:manager-fraud`, `test:manager-schedules`, `test:manager-accounting`, `test:manager-alerts`, `test:manager-pii`, `test:manager-reports`, `test:platform` and every earlier `test:manager-*`; `npx tsc --noEmit`; eslint on touched paths; `next build`; `flutter analyze` + `flutter test` in `apps/manager` and `apps/customer`; release APK cold start on the emulator. Walk `docs/SECURITY_AUDIT.md` (new tables: `ops_hourly_demand`, `ops_hourly_rider_supply`, `ops_sla_targets`, `ops_fraud_rules`, `ops_fraud_dismissals`, `order_client_meta`, `report_schedules`, `report_runs`, `accounting_settings`; new column `deliveries.assignment_source` grant; new bucket `ops-reports`; new env `DEVICE_HASH_PEPPER`; new cron route) and log it; walk `docs/DEPLOYMENT_AUDIT.md` for the new cron route and env var.
- [ ] **Step 4:** Remove both worktrees and branches. Commit `docs(manager-app): phase 9 exit — verification log`.

## Notes for other branches

- **Rider:** `dispatchOrder` gains an auto-assign branch and `chooseRider` exposes `rankDispatchCandidates`; `deliveries.assignment_source` is stamped by the rider accept path (default trigger). Rider phase work that edits dispatch should merge `feat/manager-app` first. An auto-assigned rider receives the existing "assigned" push, not an offer ring.
- **Customer app:** sends `x-device-id` (random install UUID) on API calls; the server stores only a peppered hash, service-role only.
- **Owner steps:** set `DEVICE_HASH_PEPPER` (random 32+ bytes) and schedule `/api/cron/reports` (or rely on the dispatch sweep's throttled call) when deploying; fill in ledger names and the Tally company name in Admin → Settings → Accounting before the first export.
