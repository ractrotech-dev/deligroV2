# Rider App — Phase 5: Cash — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rider sees the cash they must collect, have collected, have deposited and still hold; declares deposits that a manager confirms or disputes; sees each day's reconciliation status; raises a dispute when an amount is wrong; and is reminded when cash has been held too long or grown too large.

**Architecture:** Migration `0085` adds `cash_deposits` and the reminder thresholds. A server module derives the rider's cash position from `deliveries.cod_collected_amount`, `cod_handovers` and `cash_deposits`. Rider routes under `/api/rider/cash/*`; the manager cash page gains a deposits queue that writes the existing `cod_handovers` row on confirmation (one ledger, as 0047 intended). The rider app gets a Cash screen under More.

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md` (*Cash (§10)*)

## Global Constraints

- Earlier phases' Global Constraints and rulings apply.
- Cash is whole rupees (`integer`, as `cod_handovers.amount` and `deliveries.cod_collected_amount` already are).
- Cash collected for Deligro is never added to, netted against, or shown inside the rider's earnings (§10 "distinguish").
- `cod_handovers` stays append-only and remains the single record of a handover; a confirmed deposit **is** a `cod_handovers` row (`rider_to_manager`, `from_user` = rider, `to_user` = confirming manager or the named manager, `recorded_by` = confirmer), linked back from the deposit.
- Day boundaries are IST.
- Reminder thresholds: `platform_settings.rider_cash_limit` (₹, default 5000) and `rider_cash_max_hours` (default 24); a reminder push at most every 6 hours per rider.

## Review Focus

1. **The rider declares a deposit, and the manager also records the same handover directly on /manager/cash** → the deposit queue shows the direct record for that rider and day, and confirming asks "Already recorded ₹X today — confirm anyway?"; nothing is silently double-counted (Task 2 test on the duplicate-warning helper).
2. **A deposit larger than the cash the rider holds** → refused with `exceeds_pending` showing the held amount (Task 2 test).
3. **An online-paid order** → never appears as cash to collect or collected; it is listed under "Paid online" (Task 2 test).
4. **A disputed deposit** → stays out of "deposited", the day reads *disputed*, and the rider sees the manager's note (Task 2 and Task 4 tests).
5. **A rider with no COD orders ever** → the Cash screen shows zeros and "No cash collected yet", not an error (Task 4 test).

---

### Task 1: Migration 0085 — cash deposits and thresholds

**Files:** `supabase/migrations/0085_rider_cash.sql`, `scripts/qa/sql/migration-0085.mjs`, `docs/DATABASE.md`

- `cash_deposits (id uuid pk, driver_id uuid not null, amount integer not null > 0, method text check in ('cash','upi'), manager_id uuid, reference text, photo_path text, note text, status text not null default 'submitted' check in ('submitted','confirmed','disputed','withdrawn'), handover_id uuid → cod_handovers, decided_by uuid, decided_at timestamptz, decision_note text, created_at)`; a `confirmed` row requires `handover_id`; a `disputed` row requires `decision_note`.
- `cash_disputes (id uuid pk, driver_id uuid not null, day date not null, claimed_amount integer, message text not null, status text default 'open' check in ('open','resolved'), resolution text, resolved_by uuid, resolved_at, created_at)` — Phase 7 links these into support tickets; until then they are listed on the manager cash page and admin cash ledger.
- `cash_reminders (driver_id uuid pk, last_sent_at timestamptz)`.
- `platform_settings.rider_cash_limit integer not null default 5000`, `rider_cash_max_hours integer not null default 24`.
- Storage: deposit receipt photos go in the private `delivery-proofs` bucket under `deposits/` (no new bucket).
- RLS: rider selects own deposits and disputes; managers and admins select all; writes service-role only.
- Proof: confirmed without handover raises; disputed without note raises; rider can't read others; settings defaults.
- Commit `feat(db): 0085 rider cash deposits, disputes and reminders`.

### Task 2: Server — cash position, deposits, decisions, disputes, reminders

**Files:** Create `src/lib/rider/cash-math.ts` (pure), `src/lib/data-access/rider-cash.ts`, routes `src/app/api/rider/cash/{summary,collections,deposits,disputes}/route.ts` and `src/app/api/rider/cash/deposits/[id]/route.ts` (DELETE = withdraw while submitted), `scripts/qa/rider-cash.ts`; Modify `src/app/manager/cash/{page,actions}.ts(x)` (deposits queue: confirm / dispute with note; disputes list: resolve), `src/app/admin/cash-ledger/page.tsx` (rider deposits and disputes visible), `src/lib/dispatch/sweep.ts` (reminder check, throttled), `src/lib/notifications/order-events.ts` (`notifyRiderCashReminder`, `notifyRiderDepositDecided`, `notifyOpsDepositSubmitted`)

**Interfaces:**
```ts
export interface RiderCashSummary { toCollect: number; collectedToday: number; depositedToday: number; collectedTotal: number; depositedTotal: number; pending: number;
  submittedAwaiting: number; oldestUndepositedAt: string | null; overLimit: boolean; overHours: boolean;
  days: { day: string; collected: number; deposited: number; status: "settled" | "pending" | "disputed" }[] }
export async function getRiderCashSummary(driverId: string, now?: Date): Promise<RiderCashSummary>;
export async function listRiderCollections(driverId: string, q: { from?: string; to?: string; cursor?: string | null }): Promise<{ items: { orderId: string; code: string; at: string; amount: number; method: "cod" | "online"; status: string }[]; nextCursor: string | null }>;
export async function submitDeposit(driverId: string, input: { amount: number; method: "cash" | "upi"; managerId?: string; reference?: string; photo?: File; note?: string }): Promise<{ ok: true; id: string } | { ok: false; error: "exceeds_pending" | "invalid_amount" | "reference_required" | "bad_photo" }>;
export async function decideDeposit(actor: { id: string; role: "manager" | "admin" }, id: string, decision: "confirm" | "dispute", note?: string): Promise<{ ok: true } | { ok: false; error: "not_found" | "already_decided" | "note_required" }>;
export async function raiseCashDispute(driverId: string, input: { day: string; claimedAmount?: number; message: string }): Promise<{ ok: true; id: string } | { ok: false; error: "invalid_day" | "message_required" }>;
export async function sendCashReminders(now?: Date): Promise<number>;
```
- `pending` = collected (all time) − deposited (confirmed handovers from the rider, all time); `submittedAwaiting` is shown but not subtracted until confirmed. Per-day status: `disputed` if any deposit that day is disputed or a dispute is open for the day; `settled` when cumulative deposited ≥ cumulative collected at the end of that day; else `pending`.
- UPI deposits require `reference`. `toCollect` = COD totals of the rider's assigned and picked-up deliveries.
- Manager queue: oldest first, rider name and rider ID, amount, method, reference, receipt thumbnail (signed URL), "Already recorded today" warning from a pure `sameDayHandoverTotal`; Confirm writes the `cod_handovers` row through `recordCodHandover` and links it; Dispute requires a note.
- [ ] Steps: tests for `cash-math.ts` (Review Focus 1–4 cases, day statuses across three days with a late deposit) and route contracts → FAIL → implement → script, tsc, lint, idor, platform; dev screenshots of the manager queue (phone and console) → commit `feat(cash): rider cash position, deposits with manager confirmation, disputes, reminders`.

### Task 3: Admin/ops copy and settings

**Files:** Modify admin settings Riders fieldset (`rider_cash_limit`, `rider_cash_max_hours`), settings data group; `scripts/qa/rider-cash.ts` parser cases.
- [ ] Steps: parser test (negative and > 100000 refused) → FAIL → implement → tsc, lint → commit `feat(admin): rider cash limits`.

### Task 4: App — Cash screen

**Files:** Create `apps/rider/lib/models/cash.dart`, `apps/rider/lib/data/cash_repository.dart`, `apps/rider/lib/features/cash/{cash_screen,deposit_sheet,collections_screen,dispute_sheet}.dart`; Modify More (Cash row with the pending amount as a badge), Home (a "Cash in hand ₹X" strip under the money row when > 0; it is not one of the twelve tiles and is labelled "Not your earnings"), fixtures.
- Screen: cash to collect now, collected today, deposited today, pending deposit (large; red when over limit or over hours, with the reason), awaiting confirmation, day-by-day list with status chips (Settled / Pending / Disputed) and per-day dispute button; order-wise collections (cash vs paid online, filterable by date); **Deposit cash** sheet (amount prefilled with pending, method Cash/UPI, manager picker from `listRiders`-equivalent managers list, UPI reference, receipt photo, note); deposits list with status and manager note; withdraw a submitted deposit.
- [ ] Steps: widget tests (all figures; over-limit styling; UPI without reference blocks submit; disputed day shows the note; empty rider; Hindi; light/dark/1.3×) → FAIL → implement → analyze, test, release build, emulator screenshots → commit `feat(rider-app): Cash screen with deposits, reconciliation and disputes`.

---

## Phase exit

Proofs and QA pass; tsc, lint, idor, platform; Flutter analyze/test; release walkthrough; report.
