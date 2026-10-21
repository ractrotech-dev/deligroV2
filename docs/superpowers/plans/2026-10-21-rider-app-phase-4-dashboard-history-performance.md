# Rider App — Phase 4: Dashboard, History, Performance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home shows exactly the client's twelve figures, refreshing on its own; History lists every delivery in every outcome with filters and full detail; Performance shows targets, times, rates, ratings and month-by-month reports; customers can rate their rider.

**Architecture:** Migration `0084` adds rider ratings and default targets. One server module computes the dashboard, history and performance from `deliveries`, `delivery_events`, `rider_shifts`, `rider_earnings` and `rider_ratings`, behind `/api/rider/{dashboard,history,performance,ratings}`. Customer rating UI on the website and in the customer Flutter app. Rider app Home, History and Performance screens.

**Tech Stack:** as before (`fl_chart` for the monthly bars in Performance).

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md` (*Performance and ratings*, *History*, requirement map §1, §9.5–9.10, §14)

## Global Constraints

- **Owner override (2026-10-21): the Rider app is ENGLISH ONLY — no Hindi anywhere on the rider side.** Ignore every mention below of Hindi, `tr(en, hi)`, `langProvider`, bilingual copy, `name_hi`/`nameHi`/`title_hi`, Devanagari or a language setting; write plain English strings and English-only tests. (The customer app and website keep their own language support untouched.)
- Earlier phases' Global Constraints and ledger rulings apply.
- Figure definitions (one module, used by Home, History and Performance alike so they never disagree; IST days):
  1. **Today's deliveries** — deliveries this rider accepted today, any outcome.
  2. **Pending** — offers waiting for this rider now (held for them, plus upcoming pickups offered to them).
  3. **Accepted** — accepted, not yet picked up (`assigned`).
  4. **Picked up** — `picked_up`, not yet delivered.
  5. **Completed** — delivered today.
  6. **Cancelled** — today's deliveries of this rider that ended `cancelled`, `failed`, or were reassigned away; subtitle shows the failed count.
  7. **Today's earnings** — `EarningsSummary.today`.
  8. **Total earnings** — `EarningsSummary.total`.
  9. **Pending payments** — `EarningsSummary.pending`.
  10. **Online / Offline** — the Phase 1 availability card (switch included).
  11. **Current delivery status** — the active delivery's `RiderDeliveryStatus` with order code and next step, tapping to Jobs; "No active delivery" otherwise.
  12. **Incentives earned** — awards this week, with the nearest target's progress.
- Home refreshes every 15 s while visible, on resume, and after any action; the last-updated time is shown.
- Rates: acceptance = accepted ÷ (accepted + rejected + lapsed) offers; failed rate = failed ÷ (delivered + failed); average delivery time = accepted → delivered and picked up → delivered, delivered deliveries only. A rate with a zero denominator shows "—", never 0 % or 100 %.
- Customers' names never reach the rider through ratings; comments are shown without attribution.

## Review Focus

1. **A brand-new rider with no history** → every tile shows 0 or "—" and an explanation, no errors or NaN (Task 2 test with an empty fixture).
2. **A delivery accepted at 23:58 IST and delivered at 00:10** → counted in yesterday's "Today's deliveries" and today's "Completed", consistently in Home and History (Task 2 pure test).
3. **A customer rates twice or rates an order someone else delivered** → one rating per order, only by that order's customer, only after delivery (Task 1 proof, Task 3 contract).
4. **History filtered to a status with thousands of rows** → keyset paging, 20 a page, no repeats when a new delivery lands at the top (Task 2 test).
5. **Earnings switch (`driver.earnings`) off** → the money tiles (7, 8, 9, 12) are hidden on Home and earnings are absent from History rows (Task 4 test).

---

### Task 1: Migration 0084 — rider ratings and default targets

**Files:** Create `supabase/migrations/0084_rider_ratings_targets.sql`, `scripts/qa/sql/migration-0084.mjs`; Modify `docs/DATABASE.md`

- `rider_ratings (id uuid pk, order_id uuid not null unique, driver_id uuid not null, customer_id uuid not null, rating smallint not null check 1–5, comment text check ≤ 300 chars, created_at)`. Insert policy: `customer_id = auth.uid()` and the order is the customer's, `delivered`, and the delivery's `driver_id = driver_id`; no update/delete for anyone but admins. Select: the rider sees rows with `driver_id = auth.uid()` **through a view `my_rider_ratings` without `customer_id`** (the table select for riders is revoked); the customer sees their own; admins all.
- `platform_settings`: `rider_daily_target int not null default 0`, `rider_weekly_target int not null default 0` (0 = no target shown).
- Proof: customer rates own delivered order once (second → 23505); undelivered → denied; someone else's order → denied; rider can read `my_rider_ratings` but not `rider_ratings.customer_id`; comment 301 chars → raises.
- Commit `feat(db): 0084 rider ratings and default targets`.

### Task 2: Server — dashboard, history, performance

**Files:** Create `src/lib/rider/figures.ts` (pure), `src/lib/data-access/rider-insights.ts`, routes `src/app/api/rider/{dashboard,history,history/[orderId],performance,ratings}/route.ts`, `scripts/qa/rider-insights.ts`; Modify `src/lib/data-access/settings.ts` group for the two targets, admin settings Riders fieldset.

**Interfaces:**
```ts
export interface RiderDashboard { today: { deliveries: number; pending: number; accepted: number; pickedUp: number; completed: number; cancelled: number; failed: number };
  money: { today: number; total: number; pending: number; incentivesThisWeek: number } | null; // null when driver.earnings is off
  availability: RiderAvailability; phase: string; current: { orderId: string; code: string; status: RiderDeliveryStatus; next: string } | null;
  nearestTarget: { name: string; done: number; target: number; bonus: number } | null; updatedAt: string }
export interface HistoryItem { orderId: string; code: string; shop: string; dropArea: string | null; outcome: "delivered" | "failed" | "cancelled" | "reassigned";
  acceptedAt: string | null; pickedUpAt: string | null; deliveredAt: string | null; endedAt: string; distanceKm: number | null; earning: number | null;
  reason: string | null; cancelledBy: string | null; proof: "code" | "photo" | "ops_approved" | "staff" | "vendor" | null; itemCount: number; orderValue: number }
export async function getRiderDashboard(driverId: string, now?: Date): Promise<RiderDashboard>;
export async function getRiderHistory(driverId: string, q: { from?: string; to?: string; outcome?: HistoryItem["outcome"]; cursor?: string | null }): Promise<{ items: HistoryItem[]; nextCursor: string | null }>;
export async function getRiderHistoryDetail(driverId: string, orderId: string): Promise<(HistoryItem & { timeline: RiderEvent[]; proofPhotoUrl: string | null; items: { name: string; qty: number }[] }) | null>;
export interface RiderPerformance { daily: { target: number; done: number }; weekly: { target: number; done: number }; avgAcceptToDeliverMin: number | null; avgPickupToDeliverMin: number | null;
  acceptanceRate: number | null; failedRate: number | null; onlineHoursThisWeek: number; rating: { average: number | null; count: number; recent: { rating: number; comment: string | null; at: string }[] };
  months: { month: string; delivered: number; failed: number; cancelled: number; acceptanceRate: number | null; avgDeliverMin: number | null; earnings: number | null; onlineHours: number }[] }
export async function getRiderPerformance(driverId: string, now?: Date): Promise<RiderPerformance>;
```
- `figures.ts` holds the pure counting and rate functions over plain rows (IST bucketing, rate denominators, outcome derivation including "reassigned away" from `reassigned` events naming this rider).
- History pages by `endedAt` keyset (20); detail includes the proof photo as a 10-minute signed URL when present; the rider id is the session's.
- Targets: `rider_daily_target` / `rider_weekly_target` when > 0, else the largest active incentive rule target for that period, else hidden.
- `/driver/history` on the web keeps its own query (the web portal is not extended), unchanged.

- [ ] Steps: tests for `figures.ts` (all Review Focus 1, 2 cases; zero denominators; reassigned-away outcome; month bucketing across a year boundary) and route contracts → FAIL → implement → script, tsc, lint, idor → commit `feat(rider): dashboard, history and performance API`.

### Task 3: Customers rate their rider

**Files:** Create `src/app/api/orders/[id]/rider-rating/route.ts` (POST, customer of the order, rate limit 10/min), `scripts/qa/rider-rating.ts`; Modify web `src/components/orders/tracking-view.tsx` (after delivery: "Rate <rider first name>" 1–5 stars + optional comment, next to the restaurant review), Flutter customer `apps/customer/lib/features/orders/tracking_screen.dart` + `apps/customer/lib/data/order_repository.dart` (same), admin rider detail Overview (average, count, recent comments with order codes).
- Errors: `not_delivered`, `already_rated`, `not_yours`, `invalid_rating`, `comment_too_long`; bilingual copy on both customer surfaces.
- [ ] Steps: contract tests + customer app widget test (stars submit, already rated shows the given rating) → FAIL → implement → tsc, lint, idor, customer-layout, customer `flutter analyze`/`flutter test` → commit `feat(orders): customers rate their rider`.

### Task 4: App — Home dashboard

**Files:** Create `apps/rider/lib/models/dashboard.dart`, `apps/rider/lib/data/insights_repository.dart`, `apps/rider/lib/features/home/dashboard_grid.dart`, `current_delivery_card.dart`; Modify `home_screen.dart` (Phase 1 availability card stays at the top), fixtures.

Layout (customer-app tokens): header with name and rider ID; the availability card (figure 10); the current-delivery card (11); a 2-column grid of tiles 1–6 (count tiles, tinted per state: pending orange, accepted blue, picked up purple-free — use existing tokens `accent`, `blue`, `green`, `deal`), then a money row 7–9 and the incentives card 12 with a progress bar; "Updated 12:04" line; pull to refresh. Each count tile taps through to History pre-filtered (or Jobs for pending/accepted/picked up).
- [ ] Steps: widget tests (fixture dashboard: all 12 present with the right values; earnings off hides 7, 8, 9, 12; empty rider shows zeros and "—"; auto-refresh fires at 15 s with a fake timer; Hindi; light/dark/1.3×) → FAIL → implement → analyze, test, release build, emulator screenshots → commit `feat(rider-app): Home dashboard with the twelve figures`.

### Task 5: App — History and Performance

**Files:** Create `apps/rider/lib/features/history/{history_screen,history_detail_screen,history_filters}.dart`, `apps/rider/lib/features/performance/performance_screen.dart`; Modify the shell (History tab, fourth), More (Performance row), `pubspec.yaml` (`fl_chart`).
- History: date range (Today, Yesterday, This week, This month, Custom) and outcome chips (All, Delivered, Failed, Cancelled, Reassigned); rows with order code, shop, drop area, outcome chip, times, distance, earning; infinite scroll; detail with timestamps (accepted, picked up, delivered/ended), distance, earning, reason and who cancelled, proof (code / photo with viewer / ops-approved / vendor handover), item list, timeline.
- Performance: today and this week vs target (rings), average delivery times, acceptance rate, failed rate, online hours, rating (stars, count, recent comments), monthly report (table + bar chart of delivered per month for 12 months).
- [ ] Steps: widget tests (filters build the right query; empty state per filter; detail shows proof photo from the signed URL; rates with null show "—"; chart renders 12 bars; Hindi; light/dark/1.3×) → FAIL → implement → analyze, test, release build, emulator screenshots → commit `feat(rider-app): History and Performance`.

---

## Phase exit

Proofs and QA pass; tsc, lint, idor, platform, customer-layout; both Flutter apps analyze and test clean; release APK walkthrough; report.
