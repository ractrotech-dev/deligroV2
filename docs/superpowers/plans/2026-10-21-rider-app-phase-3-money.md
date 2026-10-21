# Rider App — Phase 3: Money — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every delivered delivery earns the rider an amount computed once, in the database, from an admin rate card; incentive targets award bonuses exactly once per period; admins record adjustments, deductions, salary and payouts; riders see every §8 figure and record field, their incentive progress, and a date-wise statement they can save as PDF or CSV.

**Architecture:** Migration `0083` holds the ledger and the rules, with triggers that write earnings and awards (so no app path can pay twice) and a `record_rider_payout` function that settles atomically. A pure TS mirror of the rate-card maths serves offer estimates only. Read routes under `/api/rider/earnings/*`; an admin **Riders** section (list + rider detail with a Money tab, incentive rules); the Flutter Earnings tab.

**Tech Stack:** as before, plus Flutter `pdf`, `printing`, `share_plus`, `path_provider`.

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md` (*Money — earnings, incentives, payouts*)

## Global Constraints

- Phase 1 and 2 Global Constraints and ledger rulings R1–R8 apply.
- Money is `numeric(10,2)` rupees in the database and shown with `formatINR` (web) / the customer app's `format.dart` rupee formatter (app). Figures in JetBrains Mono.
- IST (`Asia/Kolkata`) calendar for "today", weeks (Monday start) and months — in SQL (`at time zone 'Asia/Kolkata'`) and in TS (`src/lib/utils/ist-time.ts`).
- Rate card defaults are ₹0 everywhere: nothing is paid until an admin sets a rate.
- Earnings are separate from cash collected for Deligro (§10); no screen adds them together.
- Unique keys that make double payment impossible: `rider_earnings.delivery_id`, `rider_incentive_awards (rule_id, driver_id, period_start)`, and every earning/award/adjustment belongs to at most one payout.
- A COD tip is already in the rider's hand: shown on the record, never added to the payable amount. An online-paid tip is payable.
- The parked per-order commission code is deleted (`riderPayout`, `RiderPayoutConfig`, `RIDER_COMMISSION`, `RIDER_MIN_PAYOUT` in `src/lib/pricing.ts`; the "Rider commission" and "Rider minimum payout" fields in the admin settings form and their parsing). The `rider_commission`/`rider_min_payout` columns stay in the database, unread.

## Review Focus

1. **Admin changes the rate card mid-day** → deliveries already delivered keep their recorded amounts; only later deliveries use the new rates (Task 1 proof).
2. **Two deliveries complete at the same instant and both cross a daily target** → exactly one award (Task 1 proof with two concurrent inserts, or the unique key asserted).
3. **A payout is recorded twice by a double-click** → the second call finds nothing unattached and refuses with `nothing_to_pay`; no row is attached twice (Task 1 proof; Task 4 UI disables while pending).
4. **A deduction larger than everything pending** → `record_rider_payout` refuses `nothing_to_pay` (net ≤ 0) and the rider's pending figure shows the negative balance honestly (Task 2 summary test).
5. **The rider's statement for a range that spans a payout** → every row shows its own paid/pending status and settlement reference; totals reconcile: opening pending + earned − paid = closing pending (Task 2 statement test).

---

### Task 1: Migration 0083 — rate card, earnings ledger, incentives, adjustments, payouts

**Files:** Create `supabase/migrations/0083_rider_money.sql`, `scripts/qa/sql/migration-0083.mjs`; Modify `docs/DATABASE.md`

**Interfaces — Produces:**
- `platform_settings`: `rider_base_fee numeric(10,2) not null default 0`, `rider_km_included numeric(6,2) not null default 0`, `rider_per_km numeric(10,2) not null default 0`, `rider_min_per_delivery numeric(10,2) not null default 0` (all ≥ 0).
- `rider_earnings (id uuid pk, delivery_id uuid not null unique, order_id uuid not null, driver_id uuid not null, earned_at timestamptz not null, base_fee, distance_km numeric(6,2), billable_km numeric(6,2), distance_fee, min_topup, tip_amount numeric(10,2), tip_in_cash boolean not null, amount numeric(10,2) not null, payout_id uuid, created_at)`. `amount = greatest(base_fee + distance_fee, rider_min_per_delivery) + (tip_in_cash ? 0 : tip_amount)`; `billable_km = greatest(distance_km − km_included, 0)`; `distance_fee = round(billable_km × per_km, 2)`; `min_topup` = the part the minimum added.
- AFTER UPDATE trigger on `deliveries` (status becomes `delivered`, security definer): inserts the earning from the settings row at that moment, `distance_km` from `deliveries.distance_km` (Phase 2 stores it at accept; null → 0 and the record says "distance not recorded"), tip from `orders.tip`, `tip_in_cash` = `orders.payment_method = 'cod'` (or null method before 0025). `on conflict (delivery_id) do nothing`.
- `rider_incentive_rules (id uuid pk, name text not null, name_hi text, period text check in ('daily','weekly'), target_deliveries int > 0, bonus_amount numeric(10,2) > 0, window_start time, window_end time (both or neither; deliveries count only when earned inside the IST window), starts_on date not null, ends_on date, active boolean default true, created_by uuid, created_at, updated_at)`.
- `rider_incentive_awards (id uuid pk, rule_id, driver_id, period_start date, deliveries_count int, amount numeric(10,2), trigger_delivery_id uuid, awarded_at timestamptz default now(), notified_at timestamptz, payout_id uuid, unique (rule_id, driver_id, period_start))`.
- AFTER INSERT trigger on `rider_earnings`: for each active rule in force on the IST date of `earned_at`, count this rider's earnings in the rule's period (and window); when the count reaches `target_deliveries`, insert the award `on conflict do nothing`.
- `rider_adjustments (id uuid pk, driver_id, kind text check in ('bonus','adjustment','deduction','salary'), amount numeric(10,2) not null, reason text not null, order_id uuid, effective_on date not null, created_by uuid not null, created_at, payout_id uuid)`; `amount > 0` for bonus/salary/deduction (a deduction is subtracted), any non-zero for adjustment.
- `rider_payouts (id uuid pk, driver_id, period_end date not null, amount numeric(10,2) > 0, method text check in ('bank','upi','cash','other'), reference text, paid_on date not null, note text, created_by uuid not null, created_at)`.
- `record_rider_payout(p_driver uuid, p_period_end date, p_method text, p_reference text, p_paid_on date, p_note text) returns uuid` — security definer, admin only (`is_admin()` else raise `forbidden`), locks the rider's unattached rows (`for update`), sums earnings + awards + bonus/salary/adjustment − deduction dated ≤ `p_period_end` (IST date), raises `nothing_to_pay` when the net ≤ 0, inserts the payout and attaches every summed row in one statement set.
- RLS: rider selects own rows in earnings, awards, adjustments, payouts; drivers select active rules; admins select all; writes: rules and adjustments by admins (policies with `is_admin()`), everything else service role / the function. Rider never writes.

- [ ] **Step 1: PGlite proof** (apply 0081, 0082 stubs as needed). Cases: rate ₹20 base, 2 km included, ₹6/km, min ₹30 → 1.5 km = 30 (min_topup 10); 5 km = 38; 5 km with ₹15 online tip = 53; with ₹15 COD tip = 38 and `tip_in_cash`; a delivery marked delivered twice (correction path) → one earning; rate change after delivery doesn't change the stored row; failed/cancelled → no earning; daily rule target 3 bonus 100 → award on the third earning only, the fourth adds none; two rules both award; window rule counts only deliveries inside 12:00–15:00 IST; weekly period starts Monday IST (a Sunday 23:30 IST delivery belongs to the previous week); payout: attaches all ≤ period_end, a second call → `nothing_to_pay`; a deduction exceeding the rest → `nothing_to_pay`; rider can read own rows only and cannot insert; a non-admin calling `record_rider_payout` → `forbidden`.
- [ ] **Step 2: FAIL. Step 3: Migration. Step 4: PASS** (and 0081/0082 proofs still pass).
- [ ] **Step 5: Commit** `feat(db): 0083 rider money — rate card, earnings ledger, incentives, adjustments, payouts`.

### Task 2: Server — earnings maths mirror, summary, records, statement, incentive progress, pushes

**Files:** Create `src/lib/rider/earnings-math.ts` (pure), `src/lib/data-access/rider-earnings.ts`, routes `src/app/api/rider/earnings/{summary,records,payouts,incentives,statement}/route.ts`, `scripts/qa/rider-earnings.ts`; Modify `src/lib/data-access/rider-jobs.ts` (fill `estimatedEarning`), `src/lib/data-access/rider-delivery-actions.ts` (after `deliver`, call `notifyNewIncentiveAwards`), `src/lib/notifications/order-events.ts`, `src/lib/data-access/settings.ts` + `src/types/index.ts` + `src/lib/settings-defaults.ts` (`riderRateCard`), `src/lib/pricing.ts` and admin settings files (delete the parked commission code and fields), `src/app/admin/settings/settings-form.tsx` (rate-card fields in the Riders fieldset)

**Interfaces — Produces:**
```ts
export interface RateCard { baseFee: number; kmIncluded: number; perKm: number; minPerDelivery: number }
export function deliveryEarning(card: RateCard, d: { distanceKm: number | null; tip: number; tipInCash: boolean }): { baseFee: number; billableKm: number; distanceFee: number; minTopup: number; tipPayable: number; amount: number };
export interface EarningsSummary { today: number; week: number; month: number; total: number; perDeliveryAvg: number | null; deliveriesCounted: number;
  incentives: number; bonuses: number; adjustments: number; deductions: number; salary: number; paid: number; pending: number; lastPayout: { amount: number; paidOn: string; reference: string | null } | null }
export interface EarningRecord { kind: "delivery" | "incentive" | "bonus" | "adjustment" | "deduction" | "salary"; id: string; orderId: string | null; orderCode: string | null; date: string;
  baseFee: number | null; distanceKm: number | null; distanceFee: number | null; minTopup: number | null; tip: number | null; tipInCash: boolean | null;
  incentive: number | null; deduction: number | null; amount: number; status: "paid" | "pending"; settledOn: string | null; reference: string | null; note: string | null }
export async function getEarningsSummary(driverId: string, now?: Date): Promise<EarningsSummary>;
export async function listEarningRecords(driverId: string, q: { from?: string; to?: string; cursor?: string | null; limit?: number }): Promise<{ items: EarningRecord[]; nextCursor: string | null }>;
export async function listPayouts(driverId: string): Promise<{ id: string; amount: number; method: string; reference: string | null; paidOn: string; periodEnd: string; items: number }[]>;
export async function getIncentiveProgress(driverId: string, now?: Date): Promise<{ ruleId: string; name: string; nameHi: string | null; period: "daily" | "weekly"; target: number; done: number; bonus: number; window: string | null; endsOn: string | null; earned: boolean }[]>;
export async function getStatement(driverId: string, from: string, to: string): Promise<{ riderCode: string | null; name: string | null; from: string; to: string; openingPending: number; earned: number; paid: number; closingPending: number; rows: EarningRecord[] }>;
export async function notifyNewIncentiveAwards(driverId: string): Promise<void>; // pushes awards with notified_at null, then stamps them
```
- `deliveryEarning` mirrors the SQL exactly; it is used **only** for `RiderOffer.estimatedEarning` (labelled "est." in the app). The proof's cases are repeated in `scripts/qa/rider-earnings.ts` so the two cannot drift silently.
- An award is listed as a record of kind `incentive` and, on the delivery record that triggered it, `incentive` carries its amount. A deduction with an `order_id` shows on that order's record as `deduction`.
- Routes: all GET, rider only, rate limit 60/min; `records` and `statement` validate `YYYY-MM-DD` dates and a range ≤ 366 days (`invalid_range`); feature switch `driver.earnings` off → `featureOffResponse`.
- Pushes: `notifyRiderIncentiveEarned(driverId, { name, amount })`, `notifyRiderPayoutRecorded(driverId, { amount, reference })`.

- [ ] **Step 1: Test** the mirror against the proof's cases; statement reconciliation (opening + earned − paid = closing) on a fixture set via a pure `reconcile(rows, payouts)` helper; summary pending can be negative; date validation; contract checks for the five routes (schema-dependent skip per R2).
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4:** script, tsc, lint, idor; `grep -rn "riderPayout\|RIDER_COMMISSION\|riderCommission" src` returns nothing outside settings data mapping of the old columns (which is removed too).
- [ ] **Step 5: Commit** `feat(rider): earnings, incentives and statements API; parked commission code removed`.

### Task 3: Admin — Riders section, Money tab, incentive rules

**Files:** Create `src/app/admin/riders/page.tsx`, `src/app/admin/riders/[id]/page.tsx` (tabs; this task adds **Overview** and **Money**; Phase 6 adds Profile and Documents), `src/app/admin/riders/[id]/money-actions.ts`, `src/app/admin/riders/incentives/page.tsx` + `actions.ts`, `src/lib/data-access/admin-riders.ts`; Modify `src/components/admin/admin-nav.ts` (Riders entry), `scripts/qa/platform-separation.ts` expectations if it enumerates admin routes

**Interfaces:**
```ts
export async function listRidersForAdmin(): Promise<{ id: string; name: string | null; phone: string | null; riderCode: string | null; phase: "offline" | "online" | "break" | "stale"; activeOrderCode: string | null; deliveredToday: number; pending: number }[]>;
export async function getRiderMoney(driverId: string): Promise<{ summary: EarningsSummary; records: EarningRecord[]; payouts: …; preview: (periodEnd: string) => Promise<number> }>;
// actions (requireRole("admin"), rate-limited, revalidate):
export async function addAdjustmentAction(prev, form): Promise<ActionResult>; // kind, amount, reason, orderCode?, effectiveOn
export async function recordPayoutAction(prev, form): Promise<ActionResult>;   // periodEnd, method, reference, paidOn, note → record_rider_payout via the cookie client (the function checks is_admin itself)
export async function saveIncentiveRuleAction(prev, form): Promise<ActionResult>; export async function toggleIncentiveRuleAction(id: string, active: boolean): Promise<ActionResult>;
```
- Console-only layout rules from AGENTS.md (two shells, tokens only, container queries, no `dark:`). Riders list: search, phase chip, pending payout. Money tab: summary tiles, records table (`DataTable`), adjustments with an Add form, payouts with a Record payout form showing "This will settle ₹X (N items up to <date>)" before submit. Incentive rules: list, create/edit (English + Hindi name, period, target, bonus, optional window, dates), activate/deactivate (rules are never deleted once any award exists).

- [ ] **Step 1: Test** `scripts/qa/admin-riders.ts`: action input validation as pure parsers (`parseAdjustment`, `parsePayout`, `parseIncentiveRule`) — negative deduction refused, adjustment 0 refused, window with only a start refused, end before start refused; non-admin calling each action → `forbidden` (contract via the dev server, skip per R2).
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4:** script, tsc, lint, `npm run test:platform`; dev server screenshots (console light and dark, phone shell).
- [ ] **Step 5: Commit** `feat(admin): Riders section with Money tab and incentive rules`.

### Task 4: App — Earnings tab, records, payouts, incentives, statement PDF/CSV

**Files:** Create `apps/rider/lib/models/earnings.dart`, `apps/rider/lib/data/earnings_repository.dart`, `apps/rider/lib/features/earnings/{earnings_screen,record_detail_screen,payouts_screen,incentives_screen,statement_screen}.dart`, `apps/rider/lib/core/statement_export.dart`; Modify the shell (Earnings tab, third), offer card (show `estimatedEarning` as "≈ ₹X est."), fixtures
- Test: `apps/rider/test/earnings_test.dart`, `apps/rider/test/statement_export_test.dart`

Screens: Earnings — period switch Today / Week / Month / Total, tiles for every `EarningsSummary` figure (§8.1–8.11), last payout, entry rows to Records, Payouts (§8.12), Incentives & targets, Statement. Records — date-range filter, rows with order code, date, amount, paid/pending chip; detail shows every §8 record field (order ID, date, base fee, distance and distance fee, minimum top-up, tip and whether it was cash, incentive/bonus, deduction, final, payment status, settlement date and reference). Incentives — each rule with its Hindi name when Hindi, target, progress bar, window, end date, earned badge; plain-language rule text ("Complete 10 deliveries today → ₹100 bonus"). Statement — pick a range → on-screen statement (opening, earned, paid, closing, rows) → **Save PDF** (`pdf` + `printing`'s share) and **Share CSV** (`share_plus`), both with the rider name, rider ID and range in the header; Hindi labels when Hindi (the PDF embeds a Devanagari-capable font from `google_fonts`' Noto Sans Devanagari asset bundled in `assets/fonts/`).

- [ ] **Step 1: Tests:** every tile renders with fixture values and `₹` formatting; pending negative shows "−₹120" in the deal colour; record detail shows all fields and hides tip rows when tip is 0; incentives progress 7/10; CSV header and row count; PDF bytes start with `%PDF` and the text layer contains the rider ID; Hindi labels; light/dark/1.3×; `driver.earnings` off → the tab is hidden.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4:** analyze, test, release build; emulator fixture walkthrough; save a PDF and open it on the emulator; screenshots.
- [ ] **Step 5: Commit** `feat(rider-app): Earnings tab with records, payouts, incentives and statements`.

---

## Phase exit

All proofs and QA scripts pass; tsc, lint, idor, platform; `flutter analyze` + `flutter test`; release APK walkthrough; report.
