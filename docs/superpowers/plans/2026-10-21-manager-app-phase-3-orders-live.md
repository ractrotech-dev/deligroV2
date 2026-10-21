# Manager App — Phase 3: Orders & live operations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every order across the manager's zones — searchable, filterable, paged, with its full timeline — and every intervention on it (advance, cancel, assign, reassign, escalate, correct, note) done atomically with its audit row; plus a live operations map of riders and active orders with delay, inactivity and failure signals (§3, §6).

**Architecture:** One migration (`0142`) adds the order short code, actor propagation into the 0061/0081 event triggers, an order notes table and one `security definer` RPC per intervention that changes and logs in the same transaction; a second (`0143`) brings support tickets (Rider 0087's exact shape, built here only if not merged yet) plus the manager extensions and the escalation RPC. Pure rules (`src/lib/ops/live-rules.ts`) decide delays, signals and rider eligibility; thin `/api/manager/*` routes serialise through one contract module. The Flutter Orders and Live tabs code against the JSON pinned below, tested with fake repositories.

**Tech Stack:** Supabase Postgres (RPCs, RLS, triggers), Next.js route handlers (read `node_modules/next/dist/docs/` first), Flutter 3.47 / Riverpod 3 / go_router, `flutter_map` 8 + `latlong2` (as `apps/customer`), `uuid`.

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (§3, §6, Audit log, Permissions). Earlier plans: phase 1 foundation, phase 2 dashboard. Neighbouring designs: `2026-10-21-rider-app-design.md`, rider plans phase 2 (exceptions, 0082) and phase 7 (tickets, 0087).

## Execution layout — two halves in parallel

| Half | Worktree | Branch | Touches |
|---|---|---|---|
| **Part S (server)** | `F:\hub26\deligro-manager-p3s` | `feat/manager-p3-server` | `supabase/`, `scripts/`, `src/`, `docs/DATABASE.md`, `docs/SECURITY_AUDIT.md` |
| **Part A (app)** | `F:\hub26\deligro-manager-p3a` | `feat/manager-p3-app` | `apps/manager/` only |

Both branch from `feat/manager-app` at the commit that closes Phase 2. They share no files. When both are done: merge S, then A, into `feat/manager-app`, then run **Task I1** there. Remove both worktrees afterwards (`git worktree remove`, `git branch -d`).

## Global Constraints

- Phase 1 and 2 Global Constraints apply unchanged (AGENTS.md rules, migrations 0141–0199, `tr(ref, en, hi)`, F:\dev build env, release-APK smoke test, commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`.
- **Every audited write is one RPC that changes and logs in the same transaction** (`_ops_log`, 0141). No `logOpsActionSafely` after the fact for anything in this phase.
- RPCs follow 0141's pattern: `security definer set search_path = public`, first statement an authorisation helper that requires the `service_role` JWT and checks the actor; `revoke execute … from public, anon, authenticated; grant execute … to service_role`.
- **Permissions per action** (`managerApiContext(key)` before anything else): read lists/detail/live → `manager.orders.view` (orders) / `manager.live.view` (live); `advance`, `cancel` → `manager.move_status`; `assign` → `manager.assign_rider`; `reassign` → `manager.reassign_rider`; `escalate` → `manager.orders.escalate`; `correct`, `note` → `manager.orders.correct`. Customer phone in any payload only with `manager.call_customer` (absent key otherwise, not null).
- **Zone scope** on every read (`applyZoneScope` on `orders.zone_id`; deliveries through their order; riders through `staff_zones`); an out-of-scope id answers **404 `not_found`**, indistinguishable from a missing one. RPCs re-check the zone in the database.
- **Completed money is never edited.** No route or RPC writes `total`, `discount`, `delivery_fee`, `tax`, `tip`, `payment_*` on an order. A delivered order that is in any settlement line or has `cod_collected_at` set is `financially_closed` for status corrections.
- Rider location appears in a payload only for riders who are online or hold an active delivery in scope (§6 privacy line); never a history trail.
- Polling: Orders list and Live every 10 s while the screen is visible and the app foregrounded; detail every 10 s while open. Paused in background (`AppLifecycleListener`).

## Claude's calls

- **Reason rules.** A forward one-step `advance` and an `assign` onto an order with no rider are routine pipeline work: reason optional (the status event already records actor and time). Everything else — `cancel`, `reassign`, `escalate`, `correct`, `note`, and any `advance` from the Live tab's "manual intervention" sheet — requires a reason of 3–300 characters (`reason_required`). This narrows the design's "status change" wording to what an operator would call an intervention; the web `/manager` board keeps its one-tap advance.
- **Reassignment after pickup** is allowed only with `afterPickup: true` (the app warns "The food is with <old rider>. They must hand it to <new rider>."); otherwise a `picked_up` delivery answers 409 `picked_up`. Delivered, failed and cancelled deliveries cannot be reassigned.
- **Rider eligibility** (one pure function, used by the picker and enforced again in the RPC): online, not on a break, fix younger than `RIDER_PRESENCE_MS` (5 min, `src/lib/rider/availability.ts`), not suspended (`profiles.account_status` when that column exists — Phase 5 adds it; until then nobody is suspended), shares a zone with the order (`staff_zones`; a rider with no zones is out of zone — fail closed, the admin assigns rider zones on Team), not the current rider. Load (active deliveries) and distance to the shop order the eligible list; a rider with 2+ active deliveries is still eligible but shown "busy (2)".
- **Delays** (constants in `live-rules.ts` now; Phase 8 makes them thresholds): `prep` — status `kitchen` and now > `accepted_at` + `prep_minutes` (0061; else `kitchenPrepMinutes`) + 5 min grace; `pickup` — status `ready`, no `picked_up_at` 10 min after `ready_at`; `delivery` — `computeOrderEta(...).late`; `unassigned` — status `kitchen`/`ready`/`on_the_way` with no rider on the delivery, and 5 min since `accepted_at` (or since `ready_at` for `ready`). One order carries at most one delay, priority `unassigned` > `delivery` > `pickup` > `prep`.
- **Signals for Phase 8** are computed, not stored: `liveSignals()` returns `rider_inactive` (active delivery, last fix older than 5 min), `delivery_failed` (delivery `failed` in the last 2 h), `delivery_delayed`, `order_unassigned`, `prep_delayed`. Phase 8's alert engine calls the same function; no table now.
- **Stale GPS** = last fix older than 120 s (`STALE_FIX_SECONDS`); the marker turns grey and reads "updated N min ago" (§6.12).
- **Order code search** uses a stored generated column `orders.short_code = upper(left(id::text, 8))` (the code every screen already shows, `orderCode()`); `q` matches a full uuid exactly or a code prefix (≥ 4 chars, hex, case-insensitive).
- **Support tickets**: if `feat/rider-app` has merged 0087 by the time Part S starts, 0143 contains only the manager extensions and the escalation RPC; otherwise 0143 creates `support_tickets` and `support_messages` with **0087's exact columns, checks and RLS** using `create table if not exists` / `drop policy if exists`, so either order of application converges. Status gains `escalated`. `user_notifications` and `announcements` stay with the Rider branch.
- **Delivery exceptions** (Rider 0082) are decided in Phase 5 (Riders), after that branch merges; Phase 3 shows only `failed` deliveries.
- `cancelOrderAsOps(orderId, { by: "admin" | "manager", reason, requestedBy })` is extracted from `cancelOrderAsAdmin` with exactly the Rider plan's name and signature (rider phase 2, Task 4), so the two branches converge on merge.

## API contract (pinned — both halves code to this)

All responses are JSON. Errors: `{ "error": "<code>", ...extra }`. Timestamps ISO-8601 UTC strings; money whole rupees (int); ids uuid strings.

### Shared shapes

```jsonc
// OrderListItem
{
  "id": "uuid", "code": "AB12CD34", "status": "placed|kitchen|ready|on_the_way|delivered|cancelled",
  "createdAt": "…", "zoneId": "uuid",
  "vendor": { "id": "uuid", "name": "Spice Hub" },
  "customerName": "Asha" ,                    // string|null
  "total": 420, "itemCount": 3,
  "payment": { "method": "cod|online|null", "status": "pending|paid|failed|refunded|null" },
  "rider": { "id": "uuid", "name": "Ravi", "code": "DR-0004" },   // or null; code null before 0081
  "deliveryStatus": "unassigned|assigned|picked_up|delivered|failed|cancelled|null",
  "byPhone": false,
  "eta": { "pickupAt": "…|null", "expectedAt": "…|null", "dueAt": "…|null", "late": false, "lateByMinutes": 0 },  // null when terminal
  "delay": { "kind": "unassigned|delivery|pickup|prep", "minutes": 12 },                                        // or null
  "cancellation": { "by": "customer|vendor|manager|admin|system|null", "reason": "…|null", "at": "…|null" }    // null unless cancelled
}
// TimelineEntry
{ "at": "…", "source": "order|delivery|ops", "kind": "status|preparing|offered|accepted|…|note|reassigned|corrected|escalated",
  "from": "…|null", "to": "…|null", "actor": { "id": "uuid", "name": "…", "role": "manager|admin|vendor|driver|customer|system" } /* or null */,
  "reason": "…|null", "method": "…|null" }
// RiderCandidate
{ "id": "uuid", "name": "Ravi", "code": "DR-0004|null", "phase": "online|break|stale|offline",
  "activeDeliveries": 1, "distanceKm": 2.4 /* null without fix */, "lastFixAgeSeconds": 45 /* null */,
  "eligible": true, "ineligibleReason": "offline|on_break|stale_fix|suspended|out_of_zone|current_rider|null" }
```

### `GET /api/manager/orders`

Query: `q`, `from`, `to` (ISO datetimes, inclusive/exclusive), `vendor` (uuid), `rider` (uuid), `status` (comma list of db statuses or aliases `pending` = placed,kitchen,ready,on_the_way · `completed` = delivered · `today` = IST today as `from`/`to`), `payment` (comma list of `cod`, `online`, `pending`, `paid`, `failed`, `refunded`), `zone` (uuid), `queue` (`delayed|unassigned|cancelled`), `cursor`, `limit` (default 50, max 100).
200: `{ "items": [OrderListItem], "nextCursor": "string|null", "counts": { "delayed": 2, "unassigned": 1 } }`. `queue=delayed|unassigned` return every matching active order (no cursor). Cursor = base64url of `<createdAt>|<id>`, keyset on `(created_at desc, id desc)`.
400 `bad_request` (`field` names the bad parameter): malformed uuid, `from > to`, unknown status/payment/queue, bad cursor, `limit` out of range.

### `GET /api/manager/orders/[id]`

200: `{ "order": OrderDetail }` where `OrderDetail` = `OrderListItem` plus
```jsonc
{
  "items": [{ "name": "Paneer Tikka", "qty": 2, "price": 180, "lineTotal": 360 }],
  "money": { "subtotal": 360, "discount": 0, "deliveryFee": 40, "tax": 20, "tip": 0, "total": 420 },
  "pickup": { "name": "Spice Hub", "address": "…", "lat": 21.7, "lng": 81.5, "phone": "…|null" },
  "drop": { "label": "Home", "address": "…", "landmark": "…|null", "lat": 21.71, "lng": 81.52 },
  "customer": { "name": "Asha", "phone": "+91…" },            // "phone" key absent without manager.call_customer
  "delivery": {                                                // null when no delivery row
    "id": "uuid", "status": "…", "rider": { "id": "uuid", "name": "Ravi", "code": "DR-0004|null", "phone": "…|null" } /* or null */,
    "offeredTo": { "id": "uuid", "name": "…" } /* or null */,
    "assignedAt": "…|null", "pickedUpAt": "…|null", "deliveredAt": "…|null", "failedAt": "…|null", "failureReason": "…|null",
    "lastFix": { "lat": 21.7, "lng": 81.5, "at": "…", "ageSeconds": 40 } /* or null */
  },
  "timeline": [TimelineEntry],                                 // oldest first
  "tickets": [{ "id": "uuid", "number": 17, "status": "escalated", "priority": "high" }],
  "allowed": { "advance": "kitchen|ready|on_the_way|delivered|null", "cancel": true, "assign": false,
               "reassign": true, "escalate": true, "correct": false, "note": false }
}
```
`allowed` reflects both the order's state and the caller's permissions. 404 `not_found`.

### `GET /api/manager/orders/[id]/riders`

200: `{ "riders": [RiderCandidate] }` — eligible first (by `distanceKm` then `activeDeliveries`), then ineligible. 404 `not_found`. Permission: `manager.assign_rider` or `manager.reassign_rider`.

### `POST /api/manager/orders/[id]/actions`

Body: `{ "action": "advance|cancel|assign|reassign|escalate|correct|note", "reason": "string|undefined", "clientActionId": "uuid", …per action }`
- `advance`: `{ "expected": "<current db status>" }`
- `assign` / `reassign`: `{ "riderId": "uuid", "afterPickup": false }`
- `escalate`: `{ "priority": "high|emergency" }` (default `high`)
- `correct`: `{ "kind": "status|delivery_status|item_unavailable", "toStatus": "…" /* status kinds */, "itemId": "uuid" /* item_unavailable: order_items.id */ }`
- `note`: `{ "note": "string 3–1000" }` (the `reason` field is not used for notes)

200: `{ "ok": true, "order": OrderDetail }` (and `"ticket": { "id", "number" }` for `escalate`). A replayed `clientActionId` returns 200 with the current order and changes nothing.
Errors: 400 `bad_request` | `reason_required`; 403 `permission_denied`; 404 `not_found`; 409 `stale` (status moved), `already_assigned`, `picked_up`, `rider_ineligible` (`{ "reasons": ["stale_fix"] }`), `financially_closed`, `terminal` (delivered/cancelled for cancel/advance), `invalid_transition`; 429 rate limited (`managerWriteLimit`, 60/min).

### `GET /api/manager/live?zone=`

200:
```jsonc
{
  "generatedAt": "…",
  "riders": [{ "id": "uuid", "name": "Ravi", "code": "DR-0004|null",
               "state": "available|on_delivery|break|stale",
               "lat": 21.7, "lng": 81.5, "lastFixAt": "…|null", "lastFixAgeSeconds": 40, "stale": false,
               "activeOrderIds": ["uuid"] }],
  "orders": [OrderListItem & { "pickupPoint": { "lat": 21.7, "lng": 81.5 }, "dropPoint": { "lat": 21.71, "lng": 81.52 } }],   // active only
  "lanes": { "placed": 1, "kitchen": 3, "ready": 1, "on_the_way": 4 },
  "unassigned": ["uuid"],
  "delayed": [{ "orderId": "uuid", "kind": "prep|pickup|delivery|unassigned", "minutes": 12 }],
  "signals": [{ "kind": "rider_inactive|delivery_failed|delivery_delayed|order_unassigned|prep_delayed",
                "orderId": "uuid|null", "riderId": "uuid|null", "minutes": 7, "at": "…" }],
  "thresholds": { "staleSeconds": 120, "inactiveMinutes": 5, "unassignedMinutes": 5, "prepGraceMinutes": 5, "pickupWaitMinutes": 10 }
}
```
Riders listed: online (any phase but offline) or holding an active delivery in scope. 403 `permission_denied` without `manager.live.view`.

## Requirement coverage

| Spec item | Task |
|---|---|
| §3.1 view all orders | S4, A2 |
| §3.2 search by Order ID | S1 (short_code), S4, A2 |
| §3.3 filter date & time | S4, A2 |
| §3.4 filter vendor · §3.5 rider · §3.6 status · §3.7 payment status | S4, A2 |
| §3.8 details & item breakdown | S4, A3 |
| §3.9 pickup & delivery addresses | S4, A3 |
| §3.10 order timeline | S1 (actor), S4, A3 |
| §3.11 track rider & progress | S4, A3 (mini-map), A4 |
| §3.12 delayed & unassigned | S3, S4 (queues), A2 |
| §3.13 cancelled + reasons | S4 (`queue=cancelled`), A2, A3 |
| §3.14 reassign to eligible rider | S1, S3, S5, A3 |
| §3.15 escalate | S2, S5, A3 |
| §3.16 authorised corrections with audit | S1, S5, A3 |
| §3 "no altering completed financial records" | S1 (`financially_closed`, no money writes), S5 |
| §6.1 live map of available & active riders | S6, A4 |
| §6.2 active orders by delivery status | S6 (lanes), A4 |
| §6.3 unassigned orders | S3, S6, A4 |
| §6.4 delayed orders | S3, S6, A4 |
| §6.5 estimated pickup & delivery times | S3 (`eta.pickupAt/expectedAt`), S4, S6, A2–A4 |
| §6.6 vendor preparation delays | S3 (`prep`), S6, A4 |
| §6.7 rider inactivity alerts | S3 (`rider_inactive`), S6, A4 |
| §6.8 delivery failure alerts | S3 (`delivery_failed`), S6, A4 |
| §6.9 reassignment | S5, A3, A4 |
| §6.10 manual intervention with reason | S1, S5, A3, A4 |
| §6.11 filter by zone | S4, S6, A2, A4 |
| §6.12 last location update time | S6, A4 |
| §6 privacy (disclosed tracking only) | S6 (rider filter), Global Constraints |

## Review Focus

1. **Two operators act on one order at once**: a manager reassigns while the rider taps "picked up", or two managers advance together → exactly one wins; the other gets 409 `stale`/`picked_up`, the app refreshes the order and says why; no double event, no double audit row. (S1 PGlite race via `expected` + row lock; S5 QA; A3 widget test for 409.)
2. **A manager in zone A opens, acts on, or reassigns-into an order or rider of zone B** by id (deep link, push, crafted request) → 404 / `rider_ineligible: out_of_zone`, never data; the RPC refuses even if the route check were skipped. (S1 PGlite, S5 QA.)
3. **The app replays an action** after a timeout (same `clientActionId`) → 200 with the current order, nothing applied twice. (S1 PGlite, A3 repository test.)
4. **Correcting a delivered order** that has a COD collection or a settlement line → 409 `financially_closed`; a correction never changes any money column. (S1 PGlite, S5 QA.)
5. **A rider whose phone died mid-delivery** → Live shows the marker grey with "updated 9 min ago" and a `rider_inactive` signal; the picker shows them `stale_fix`, ineligible. Offline riders without an active delivery never appear on the map. (S3 QA, S6 QA, A4 widget test.)

---

# Part S — server (worktree `deligro-manager-p3s`)

### Task S1: Migration 0142 — short code, actors, notes, intervention RPCs

**Files:**
- Create: `supabase/migrations/0142_manager_orders_live.sql`, `scripts/qa/sql/migration-0142.mjs`
- Modify: `docs/DATABASE.md`

**Interfaces — Produces (database):**
- `orders.short_code text generated always as (upper(left(id::text, 8))) stored`, index `orders_short_code_idx (short_code text_pattern_ops)`, `grant select (short_code) on public.orders to authenticated`. Indexes if absent: `orders (zone_id, created_at desc, id desc)`, `orders (zone_id, status)`, `deliveries (driver_id, status)`.
- `public._ops_set_actor(p_actor uuid)` (internal, revoked from everyone): `set_config('deligro.actor_id', p_actor::text, true)`. **Re-declare** `log_order_status_event()` (0061) and `log_delivery_event()` (0081) — first diff every later re-declaration on the branch and keep all behaviour — changing only the actor to `coalesce(auth.uid(), nullif(current_setting('deligro.actor_id', true), '')::uuid)`.
- `public.ops_require_staff(p_actor uuid, p_zone uuid) returns text` (returns the actor's role): service-role JWT required; actor `admin`, or `manager` with `p_zone` in their `staff_zones`; else `forbidden` (42501). Revoked from everyone but service_role.
- `public.order_ops_notes (id bigint identity pk, order_id uuid not null → orders on delete cascade, author_id uuid not null → profiles, body text not null check (char_length(body) between 3 and 1000), created_at timestamptz not null default now())`, index `(order_id, created_at)`. RLS on: select when `is_admin() or manager_can_see_order(order_id)`; no write policies; writes revoked from anon/authenticated.
- RPCs (all `returns jsonb` = `{ "order_id", "status", "delivery_status" }`, all take `p_client_action_id text` and return the current state unchanged if `_ops_log` already holds that id for this actor; all call `_ops_set_actor`, lock the order row `for update`, call `ops_require_staff` with the order's `zone_id`, and `_ops_log` with `before`/`after`):
  - `ops_advance_order(p_actor uuid, p_order uuid, p_expected order_status, p_reason text, p_client_action_id text)` — only the next step of `placed→kitchen→ready→on_the_way→delivered`; `stale` (40001) if status ≠ expected; `terminal` from delivered/cancelled. Action `order.advance`.
  - `ops_cancel_order(p_actor, p_order, p_reason, p_client_action_id)` — reason required (`reason_required`, 22023); from any non-terminal status; sets `status='cancelled'`, `cancelled_by=<actor role>`, `cancellation_reason`; cancels a non-terminal delivery row. Action `order.cancel`. (Refunds and pushes stay in TypeScript, S5.)
  - `ops_assign_rider(p_actor, p_order, p_rider uuid, p_reason text, p_client_action_id)` — delivery absent or `unassigned` (else `already_assigned`, 23505); rider eligibility re-checked in SQL: role `driver`, `rider_status.is_online`, not on break, `last_fix_at > now() - interval '5 minutes'`, shares a `staff_zones` zone with the order, `profiles.account_status` (if the column exists — use a dynamic check or a `to_regclass`-style guard on `information_schema.columns`) not `suspended`/`restricted`; else `rider_ineligible` (22023, `detail` = reason code). Inserts or updates the delivery to `assigned` with `assigned_at = now()`, `driver_location_source='none'`. Action `delivery.assign`.
  - `ops_reassign_delivery(p_actor, p_order, p_rider, p_reason, p_after_pickup boolean, p_client_action_id)` — reason required; delivery `assigned`, or `picked_up` with `p_after_pickup` (else `picked_up`, 22023); terminal → `terminal`; same rider → `rider_ineligible` `current_rider`; writes a `delivery_events` `reassigned` row naming the **old** rider with the reason, then sets `driver_id = p_rider`, `assigned_at = now()`; the 0081 trigger logs the rest. Action `delivery.reassign`, `before`/`after` carry both rider ids.
  - `ops_correct_order(p_actor, p_order, p_kind text, p_to_status text, p_item uuid, p_reason, p_client_action_id)` — reason required. `status`: any status to any other except into/out of `cancelled` (use cancel) — refused `financially_closed` when the order is `delivered` and (`deliveries.cod_collected_at` is set or a `vendor_settlement_orders` row exists for it); sets the status in the same statement as a session flag that `guard_order_update` honours as a correction (re-declare `guard_order_update` from its latest definition on the branch, keeping everything, adding: when `current_setting('deligro.ops_correction', true) = 'on'` the forward-only/terminal rules are skipped for `status` only — every other locked column stays locked). `delivery_status`: sets `deliveries.status` with `correction_reason = p_reason` (0081's correction path). `item_unavailable`: inserts a `refunds` row `pending` for that line's `qty × price`, origin `manager`, reason — never touches `orders.total`. Action `order.correct.<kind>`.
  - `ops_add_order_note(p_actor, p_order, p_note text, p_client_action_id)` — inserts `order_ops_notes`; action `order.note`.
- Rollback block in the header dropping everything 0142 adds and restoring the prior definitions of the three re-declared functions.

- [ ] **Step 1: Write `migration-0142.mjs`** (PGlite; apply 0001…0141 stubs as `migration-0141.mjs` does, then 0142). Assertions, each printed `ok`/`FAIL`, exit 1 on any FAIL:
  - `short_code` of a known uuid equals its first 8 chars upper-cased; authenticated can select it.
  - as service role with actor = manager M (zone A): `ops_advance_order(M, orderA, 'placed', null, 'c1')` → status `kitchen`; one `order_status_events` row whose `actor_id = M`; one `ops_audit_log` row `order.advance`.
  - replay with `'c1'` → same result, still one event and one audit row.
  - `ops_advance_order(M, orderA, 'placed', …, 'c2')` after it moved → error `stale`.
  - M on an order in zone B → `forbidden`; called by `authenticated` role directly → permission denied.
  - `ops_cancel_order` with reason `''` → `reason_required`; with a reason → `cancelled`, `cancelled_by='manager'`, delivery row `cancelled`.
  - `ops_assign_rider` with an offline rider → `rider_ineligible` detail `offline`; stale fix → `stale_fix`; rider with no shared zone → `out_of_zone`; eligible → delivery `assigned`; second assign → `already_assigned`.
  - `ops_reassign_delivery` on `assigned` → driver changed, a `reassigned` event naming the old rider with the reason, audit row with both ids; on `picked_up` without `p_after_pickup` → `picked_up`; with it → ok; on `delivered` → `terminal`.
  - `ops_correct_order(kind 'status')` `ready → kitchen` → ok and an event with actor M; a non-status column in the same flow stays locked (direct update of `total` as manager still raises); on a delivered order with `cod_collected_at` set → `financially_closed`; `item_unavailable` → one pending refund with the line value and `orders.total` unchanged.
  - `ops_add_order_note` → note row; manager in zone B selects no notes of that order; nobody can update/delete `ops_audit_log` (re-assert).
  - Re-run `migration-0061.mjs` and `migration-0081.mjs` logic paths that the re-declared triggers affect: vendor status change still logs with the vendor's `auth.uid()`.
- [ ] **Step 2: Run** `node scripts/qa/sql/migration-0142.mjs` — expect FAIL (file missing).
- [ ] **Step 3: Write the migration** (house-style header: purpose, STATUS: PENDING APPROVAL, rollback).
- [ ] **Step 4: Run the 0142 proof and every `scripts/qa/sql/migration-*.mjs` — all `ok`.**
- [ ] **Step 5: Update `docs/DATABASE.md`; commit** `feat(db): 0142 manager order interventions — short code, actors, notes, audited RPCs`.

### Task S2: Migration 0143 — support tickets and escalation

**Files:**
- Create: `supabase/migrations/0143_support_tickets_ops.sql`, `scripts/qa/sql/migration-0143.mjs`
- Modify: `docs/DATABASE.md`

**Interfaces — Produces (database):**
- First `git log --oneline feat/rider-app -- supabase/migrations/0087*` and `ls supabase/migrations`. If 0087 is present on the branch: skip the base section. Otherwise the base section, idempotent, copied **verbatim from the Rider phase 7 plan, Task 1**: `support_tickets`, `support_messages` (with `internal`), private bucket `support-attachments` (5 MB, jpeg/png), and its RLS (requester reads own tickets and non-internal messages; admins all; inserts through the service role). Header note: "Base tables are the Rider branch's 0087 shape, built here first; whichever is applied first creates them."
- Extensions (always): `support_tickets` gains `team text null`, `escalation_level smallint not null default 0 check between 0 and 3`, `first_response_at timestamptz`, `resolution text`, `zone_id uuid → delivery_zones` (stamped from the order's zone or the requester's first zone by trigger); status check re-created to include every 0087 status **plus `escalated`**; manager select policy: `manager_can_see_zone(zone_id)`.
- `ops_escalate_order(p_actor uuid, p_order uuid, p_reason text, p_priority text, p_client_action_id text) returns jsonb` (`{ ticket_id, number }`): `ops_require_staff` on the order's zone; reason required; priority `high|emergency`; creates a ticket (`requester_id = p_actor`, `requester_role` = actor role, `category = 'order_issue'`, `subject = 'Order ' || short_code`, `order_id`, `status = 'escalated'`, `escalation_level = 1`, `zone_id`) and its first message (body = reason, `internal = false`); an open ticket for the same order and category is escalated (+1 level, message appended) instead of duplicated; `_ops_log` action `order.escalate`. Replay-safe on `p_client_action_id`.

- [ ] **Step 1: Write `migration-0143.mjs`:** escalate creates ticket + message + audit row; a second escalate on the same order raises the level to 2 and adds a message, still one ticket; zone-B manager cannot escalate (`forbidden`) nor select the ticket; requester (as authenticated) never sees an `internal = true` message; status `escalated` accepted, `bogus` rejected; replay returns the same ticket.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration. Step 4: Run all SQL proofs — PASS.**
- [ ] **Step 5: Commit** `feat(db): 0143 support tickets for ops — escalation, levels, zones` (say in the body whether the base tables were built here).

### Task S3: Live rules (pure)

**Files:**
- Create: `src/lib/ops/live-rules.ts`, `scripts/qa/manager-live-rules.ts` (add `"test:manager-live"` to `package.json`)

**Interfaces — Produces:**
```ts
export const STALE_FIX_SECONDS = 120;
export const INACTIVE_MINUTES = 5;
export const UNASSIGNED_MINUTES = 5;
export const PREP_GRACE_MINUTES = 5;
export const PICKUP_WAIT_MINUTES = 10;
export type DelayKind = "unassigned" | "delivery" | "pickup" | "prep";
export interface LiveOrderFacts { status: OrderStatus; createdAt: string; acceptedAt: string | null; readyAt: string | null;
  prepMinutes: number | null; etaMin: number | null; etaMax: number | null; distanceKm: number | null;
  delivery: { status: string; driverId: string | null; pickedUpAt: string | null; failedAt: string | null } | null; }
export function orderEtaView(o: LiveOrderFacts, now: Date): { pickupAt: string | null; expectedAt: string | null; dueAt: string | null; late: boolean; lateByMinutes: number } | null;
export function delayFor(o: LiveOrderFacts, now: Date): { kind: DelayKind; minutes: number } | null;
export interface RiderFacts { id: string; isOnline: boolean; breakUntil: string | null; lastFixAt: string | null; lat: number | null; lng: number | null;
  zoneIds: string[]; suspended: boolean; activeDeliveries: number; }
export function riderMarkerState(r: RiderFacts, now: Date): "available" | "on_delivery" | "break" | "stale";
export function riderEligibility(r: RiderFacts, ctx: { orderZoneId: string; currentRiderId: string | null; shop: { lat: number; lng: number } | null }, now: Date):
  { eligible: boolean; ineligibleReason: "offline" | "on_break" | "stale_fix" | "suspended" | "out_of_zone" | "current_rider" | null; distanceKm: number | null };
export function rankCandidates<T extends { eligible: boolean; distanceKm: number | null; activeDeliveries: number }>(list: T[]): T[];
export type SignalKind = "rider_inactive" | "delivery_failed" | "delivery_delayed" | "order_unassigned" | "prep_delayed";
export function liveSignals(orders: (LiveOrderFacts & { id: string })[], riders: (RiderFacts & { activeOrderIds: string[] })[], now: Date):
  { kind: SignalKind; orderId: string | null; riderId: string | null; minutes: number; at: string }[];
```
`orderEtaView` wraps `computeOrderEta` (`src/lib/orders/eta.ts`); `pickupAt` = `readyAt` when ready, else `acceptedAt + (prepMinutes ?? kitchenPrepMinutes(...))`. Distance by haversine.

- [ ] **Step 1: Write `scripts/qa/manager-live-rules.ts`** (house style, `ok`/`FAIL`): `kitchen` accepted 30 min ago with `prepMinutes: 20` → `{prep, 5}`; with 24 min → null (inside grace); `ready` 12 min ago, not picked up, rider assigned → `{pickup, 2}`; `ready`, no rider, 6 min → `{unassigned, 1}` and outranks pickup; late ETA → `delivery` outranks pickup; terminal order → null; rider fix 121 s old → marker `stale`; on break → `break` even with a stale fix; online with active delivery → `on_delivery`; eligibility reasons in order offline → on_break → stale_fix → suspended → out_of_zone → current_rider; `rankCandidates` puts eligible first, nearer first, then lower load; `liveSignals` emits `rider_inactive` for a rider with an active order and a 6-min-old fix but not for an idle one; `delivery_failed` for a delivery failed 30 min ago and none for one failed 3 h ago.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; eslint on the file.**
- [ ] **Step 5: Commit** `feat(ops): live rules — delays, ETAs, rider states, eligibility, signals`.

### Task S4: Order list and detail — data layer, contract, routes

**Files:**
- Create: `src/lib/ops/order-contract.ts` (types for every pinned shape + serialisers), `src/lib/data-access/manager-ops-orders.ts`, `src/app/api/manager/orders/route.ts`, `src/app/api/manager/orders/[id]/route.ts`, `scripts/qa/manager-orders.ts` (add `"test:manager-orders"`)

**Interfaces — Produces:**
- `parseOrderQuery(params: URLSearchParams, now: Date): { ok: true; query: OrderQuery } | { ok: false; field: string }`.
- `encodeCursor(createdAt: string, id: string): string`, `decodeCursor(s: string): { createdAt: string; id: string } | null`.
- `listManagerOrders(scope: ManagerScope, q: OrderQuery, opts: { withPhone: false; now: Date }): Promise<{ items: OrderListItem[]; nextCursor: string | null; counts: { delayed: number; unassigned: number } }>`.
- `getManagerOrderDetail(scope: ManagerScope, id: string, ctx: { permissions: Record<string, boolean>; now: Date }): Promise<OrderDetail | null>` — null when missing or out of scope.
- `mergeTimeline(statusEvents, deliveryEvents, notes, tickets, actors): TimelineEntry[]` (pure, oldest first, stable by source order on equal timestamps).
- `allowedActions(detail facts, permissions): OrderDetail["allowed"]` (pure).
- Service-role reads only below `managerApiContext`, explicit column lists (never `select("*")` on `orders`), all scoped through `applyZoneScope`; actor names resolved in one batched `profiles` read.

- [ ] **Step 1: Write `scripts/qa/manager-orders.ts`:** pure — `parseOrderQuery` accepts the alias `pending` → 4 statuses, `today` → IST-day bounds, rejects `from > to`, bad uuid (`field: "vendor"`), `limit=101`, unknown `queue`; cursor round-trips and rejects garbage; `mergeTimeline` orders mixed sources by time and keeps reasons/methods; `allowedActions`: `ready` order without `manager.reassign_rider` → `reassign:false`; delivered → `advance:null, cancel:false`; `correct:true` only with `manager.orders.correct`; serialiser omits the `phone` key without `manager.call_customer`. Structural: both route files open with `managerApiContext("manager.orders.view")`; `manager-ops-orders.ts` contains no `select("*")` and every `from("orders")` chain applies the scope. Live (skipped with a notice when `BASE` is unreachable or `QA_MANAGER_*` absent): unauthenticated 401; out-of-zone id 404; list keyset pagination returns disjoint pages; `q=<first 6 chars of a known order>` finds it.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`.**
- [ ] **Step 5: Commit** `feat(api): manager orders — search, filters, queues, cursor paging, detail and timeline`.

### Task S5: Order actions, rider candidates, cancellation extraction, web portal on the same path

**Files:**
- Create: `src/lib/data-access/manager-ops-actions.ts`, `src/app/api/manager/orders/[id]/actions/route.ts`, `src/app/api/manager/orders/[id]/riders/route.ts`, `scripts/qa/manager-order-actions.ts` (add `"test:manager-actions"`)
- Modify: `src/lib/data-access/order-cancellation.ts` (add `cancelOrderAsOps`), `src/app/admin/orders/actions.ts` (`cancelOrderAsAdmin` → thin wrapper over `cancelOrderAsOps`), `src/app/manager/actions.ts` (`advanceOrder` → `opsAdvance`; `assignRider` → `opsAssign`; signatures unchanged), `src/lib/notifications/order-events.ts` (`notifyDriverReassignedAway(riderId, { orderId })`, `notifyVendorRiderChanged(orderId, riderName)`)

**Interfaces — Produces:**
```ts
export type OpsActor = { id: string; role: "manager" | "admin" };
export type OpsResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string; extra?: Record<string, unknown> };
export async function opsAdvance(actor: OpsActor, orderId: string, expected: OrderStatus, reason: string | null, clientActionId: string): Promise<OpsResult>;
export async function opsCancel(actor: OpsActor, orderId: string, reason: string, clientActionId: string): Promise<OpsResult>;
export async function opsAssign(actor: OpsActor, orderId: string, riderId: string, reason: string | null, clientActionId: string): Promise<OpsResult>;
export async function opsReassign(actor: OpsActor, orderId: string, riderId: string, reason: string, afterPickup: boolean, clientActionId: string): Promise<OpsResult>;
export async function opsEscalate(actor: OpsActor, orderId: string, reason: string, priority: "high" | "emergency", clientActionId: string): Promise<OpsResult & { ticket?: { id: string; number: number } }>;
export async function opsCorrect(actor: OpsActor, orderId: string, input: { kind: "status" | "delivery_status" | "item_unavailable"; toStatus?: string; itemId?: string }, reason: string, clientActionId: string): Promise<OpsResult>;
export async function opsNote(actor: OpsActor, orderId: string, note: string, clientActionId: string): Promise<OpsResult>;
export async function listRiderCandidates(scope: ManagerScope, orderId: string, now: Date): Promise<RiderCandidate[] | null>; // null = not found / out of scope
export function mapRpcError(e: { code?: string; message?: string; details?: string }): OpsResult; // pure
export async function cancelOrderAsOps(orderId: string, opts: { by: "admin" | "manager"; reason: string; requestedBy: string }): Promise<{ ok: true; refundQueued: boolean } | { ok: false; error: string }>;
```
- Each `ops*` calls its RPC with the service role, then runs side effects with `deferNotify` exactly as the web actions do today: advance → `vendorRingEnds`/`stopVendorRing`, `notifyOrderAccepted|Ready|OnTheWay|Delivered`, `recordCodForStaffDelivery` on delivered, `dispatchOrder` on `kitchen`/`ready`; cancel → the refund queue **before** the RPC (as `cancelOrderAsAdmin` does), then `cancelDeliveryForOrder`, `notifyOrderCancelled`, `notifyVendorOrderCancelled`; assign → `notifyDriverAssigned` + `notifyVendorRiderAssigned`; reassign → `notifyDriverAssigned` (new), `notifyDriverReassignedAway` (old), `notifyVendorRiderChanged`; correct `status` to `ready` re-runs `dispatchOrder(orderId, "ready")` when no rider.
- `mapRpcError`: 42501 → 404 `not_found`; `stale` → 409 `stale`; `reason_required` → 400; `rider_ineligible` → 409 with `extra.reasons = [detail]`; `already_assigned`, `picked_up`, `terminal`, `financially_closed`, `invalid_transition` → 409 with that code.
- Route: `managerApiContext(<key for the action>)`, `managerWriteLimit(ctx, "order-actions")`, body via `readJsonObject`, `clientActionId` must be a uuid (400), reason length 3–300 where required; success returns the fresh `getManagerOrderDetail`.
- The web `/manager` board keeps its buttons; its actions now go through the same RPCs (reason `null` for advance/assign, `clientActionId = crypto.randomUUID()`), so web changes are audited too.

- [ ] **Step 1: Write `scripts/qa/manager-order-actions.ts`:** pure — `mapRpcError` for each code above; body validation (missing `clientActionId` → 400; `cancel` without reason → `reason_required`; `reassign` with reason "ok" (2 chars) → `reason_required`; unknown action → 400); permission map: each action's required key matches the Global Constraints table (assert from an exported `ACTION_PERMISSION` constant). Structural: `cancelOrderAsAdmin` calls `cancelOrderAsOps` and contains no `cancelOrderRow`; `src/app/manager/actions.ts` calls `opsAdvance`/`opsAssign` and no longer updates `orders`/`deliveries` directly. Live (skip as S4): advance a QA order twice with the same `clientActionId` → second returns 200 and the order moved once; reassign to an offline QA rider → 409 `rider_ineligible`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `npm run test:idor`; `npm run test:platform`; walk `docs/SECURITY_AUDIT.md` (new RPCs, new routes) and add a log row.**
- [ ] **Step 5: Commit** `feat(api): audited manager order actions — advance, cancel, assign, reassign, escalate, correct, note`.

### Task S6: `GET /api/manager/live`

**Files:**
- Create: `src/lib/data-access/manager-live.ts`, `src/app/api/manager/live/route.ts`
- Modify: `scripts/qa/manager-live-rules.ts` (route section)

**Interfaces — Produces:**
- `getLiveSnapshot(scope: ManagerScope, now: Date): Promise<LiveSnapshot>` (the pinned shape): active orders in scope (non-terminal) with their pickup/drop points; riders = `rider_status` rows online **or** drivers holding an active delivery in scope, filtered to those sharing a zone with the scope (admins: all), position from `rider_status.last_*` falling back to `deliveries.driver_lat/lng/driver_location_at`; `lanes`, `unassigned`, `delayed`, `signals` from `live-rules.ts`; failed deliveries of the last 2 h feed `delivery_failed`.
- Route: `managerApiContext("manager.live.view")`, `zone` via `narrowScope`, 400 on a malformed zone.

- [ ] **Step 1: Extend the QA script:** `getLiveSnapshot` builder tested with injected rows (export a pure `buildLiveSnapshot(rows, now)` and test that): an offline rider without an active delivery is absent; an offline rider **with** an active delivery is present and `stale` when the fix is old; lanes count by status; `unassigned` and `delayed` agree with `delayFor`; `thresholds` echo the constants. Structural: route opens with `managerApiContext("manager.live.view")`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `npx tsc --noEmit`; `npm run lint`; `next build` (all new routes compile).**
- [ ] **Step 5: Commit** `feat(api): manager live snapshot — riders, lanes, queues, signals`.

---

# Part A — app (worktree `deligro-manager-p3a`)

Part A never calls a real server in tests: every screen gets its data through `OrdersRepository` / `LiveRepository`, overridden with fakes in tests.

### Task A1: Models, repositories, fixtures

**Files:**
- Create: `apps/manager/lib/models/orders.dart`, `apps/manager/lib/models/live.dart`, `apps/manager/lib/data/orders_repository.dart`, `apps/manager/test/fixtures/api/{orders_list,order_detail,order_riders,live}.json` (hand-written from the pinned contract, covering nulls and every enum value at least once), `apps/manager/test/orders_models_test.dart`, `apps/manager/test/fakes/fake_orders_repository.dart`
- Modify: `apps/manager/pubspec.yaml` (add `flutter_map: ^8.3.2`, `latlong2: ^0.10.1`, `uuid: ^4.5.1`), `apps/manager/lib/state/providers.dart` (repository providers)

**Interfaces — Produces:**
- Models with `fromJson`: `OrderListItem`, `OrderDetail`, `OrderLine`, `OrderMoney`, `Place`, `DeliveryInfo`, `TimelineEntry`, `TicketRef`, `AllowedActions`, `RiderCandidate`, `OrderPage { items, nextCursor, counts }`, `LiveSnapshot`, `LiveRider`, `LiveOrder`, `Signal`, `Delay`, `Eta`; enums parsed leniently (unknown → `.unknown`, never a throw).
- `OrderFilters` (immutable, `copyWith`, `toQuery()`, `fromUri(Uri)` understanding the dashboard's `status=today|pending|completed|cancelled` and `queue=…`).
- `abstract interface class OrdersRepository { Future<OrderPage> list(OrderFilters f, {String? cursor}); Future<OrderDetail> detail(String id); Future<List<RiderCandidate>> riders(String id); Future<ActionOutcome> act(String id, OrderAction a); }` and `LiveRepository { Future<LiveSnapshot> snapshot({String? zoneId}); }`; `ApiOrdersRepository` / `ApiLiveRepository` over `ApiClient`.
- `OrderAction` (sealed: `Advance(expected)`, `Cancel`, `Assign(riderId)`, `Reassign(riderId, afterPickup)`, `Escalate(priority)`, `Correct(kind, toStatus?, itemId?)`, `Note(text)`) each with `reason` and a `clientActionId` generated once per user intent (`Uuid().v4()`) and reused on retry.
- `ActionOutcome` (sealed: `ActionDone(OrderDetail, ticket?)`, `ActionRefused(code, reasons)`), mapping 409/400 codes from `ApiException`.

- [ ] **Step 1: Write `orders_models_test.dart`:** each fixture parses; a list item with `rider: null`, `eta: null`, `delay: null` parses; `customer` without `phone` → `phone == null`; unknown status string → `OrderStatus.unknown`; `OrderFilters.fromUri('/orders?status=today')` yields IST-day `from`/`to`; `fromUri('/orders?status=pending')` → 4 statuses; `toQuery()` round-trips; an `Advance` retried keeps the same `clientActionId`; `ApiOrdersRepository.act` maps a 409 `{"error":"rider_ineligible","reasons":["stale_fix"]}` to `ActionRefused('rider_ineligible', ['stale_fix'])` (mock `http.Client`).
- [ ] **Step 2: Run `flutter test test/orders_models_test.dart` — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze` clean.**
- [ ] **Step 5: Commit** `feat(manager-app): order and live models, repositories, contract fixtures`.

### Task A2: Orders tab — list, search, filters, queues, paging

**Files:**
- Create: `apps/manager/lib/state/orders.dart`, `apps/manager/lib/features/orders/orders_screen.dart`, `apps/manager/lib/features/orders/order_filters_sheet.dart`, `apps/manager/lib/features/orders/order_tile.dart`, `apps/manager/lib/widgets/polling.dart`, `apps/manager/test/orders_screen_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/orders` reads query params into `OrderFilters`; replaces the Phase 3 placeholder)

**Interfaces — Produces:**
- `orderFiltersProvider` (`Notifier<OrderFilters>`), `orderListProvider` (`AsyncNotifier<OrderListState>` with `loadMore()`, `refresh()`), `usePolling(ref, Duration(seconds: 10), callback)` helper in `polling.dart` (paused when the app is not resumed or the route is not visible).
- Screen: search field (debounced 400 ms; accepts a code or uuid), segmented queues **All · Delayed (n) · Unassigned (n) · Cancelled**, filter chips row showing active filters (each removable), "Filters" sheet with date & time range, vendor, rider, status (multi), payment (multi), zone (the Phase 1 zone picker); tile shows code, vendor, customer, time, total (JetBrains Mono, en-IN), status chip, payment chip, rider or "No rider", delay badge ("Kitchen 12 min late", "Waiting for pickup 4 min", "Late 9 min", "No rider 6 min"), cancellation reason line for cancelled; infinite scroll calls `loadMore()` at 80 % scroll; pull-to-refresh; skeleton on first load; filtered-empty → one dashed `Empty` line; error → message + Retry; ≥ 840 dp → list + detail side by side.

- [ ] **Step 1: Write `orders_screen_test.dart`** with `FakeOrdersRepository`: first page renders 50 tiles' worth of fixture rows and calls `list` with `cursor: null`; scrolling to the end calls `list` with the fixture's `nextCursor`, and stops when it is null; tapping "Delayed (2)" calls `list` with `queue=delayed`; typing "ab12" calls `list` with `q=ab12` once after the debounce; a filtered list returning no items shows the `Empty` line, not the full-screen state; a repository error shows "Retry" and retry re-calls; route `/orders?status=cancelled` opens with the Cancelled queue selected; a cancelled tile shows its reason; polling: with fake async, advancing 10 s re-fetches page one while visible and not after the screen is disposed.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): Orders tab — search, filters, queues, infinite scroll`.

### Task A3: Order detail — timeline, map, actions, reasons, rider picker

**Files:**
- Create: `apps/manager/lib/features/orders/order_detail_screen.dart`, `.../order_timeline.dart`, `.../order_mini_map.dart`, `.../reason_dialog.dart`, `.../rider_picker_sheet.dart`, `.../order_actions_bar.dart`, `apps/manager/test/order_detail_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/orders/:id`), `apps/manager/lib/core/push.dart` (order pushes → `/orders/<id>`)

**Interfaces — Produces:**
- `orderDetailProvider(id)` (`AsyncNotifierProvider.family`, 10 s polling while open, `act(OrderAction)` → updates state from `ActionDone`).
- `Future<String?> showReasonDialog(BuildContext, {required String title, required List<String> quickPicks, bool required = true})` — Submit disabled until ≥ 3 chars when required. Quick picks per action (English/Hindi pairs): cancel — "Customer asked to cancel", "Shop closed", "Item unavailable", "Duplicate order"; reassign — "Rider not responding", "Rider vehicle issue", "Rider too far", "Customer requested"; correct — "Wrong status tapped", "Confirmed by phone", "Rider/vendor mistake"; escalate — "Customer complaint", "Food quality", "Payment problem", "Safety concern"; manual intervention — "Confirmed with kitchen by phone", "Confirmed with rider by phone", "Customer confirmed delivery".
- Detail layout: header (code, status chip, total), customer block (Call only when `phone` present), pickup and drop with addresses and landmark, items with line totals and the money breakdown (read-only), delivery block (rider name, code, Call when phone present, "updated N min ago"), mini-map (`flutter_map`, OSM tiles, `userAgentPackageName: com.ractrotech.deligro.manager`; shop, drop and rider pins; rider pin grey when stale), timeline (oldest first: time, kind label, actor name and role, reason, method; ops notes and escalations included), tickets list, actions bar showing only `allowed` actions: Advance to <next>, Assign / Reassign rider (opens picker), Cancel, Escalate (priority choice), Correct (kind → target status / item → reason), Add note.
- Rider picker: eligible riders first with distance, load ("busy (2)") and fix age; ineligible greyed with the reason in words ("Offline", "On a break", "No recent location", "Suspended", "Not in this zone", "Current rider"), not tappable; after-pickup reassign shows the hand-over warning and sends `afterPickup: true` only after the manager confirms it.
- Outcome handling: `ActionRefused('stale'|'already_assigned'|'picked_up'|'terminal'|'financially_closed'|'rider_ineligible')` → a sentence each in a snackbar plus a detail refresh; network failure → "Couldn't reach Deligro — try again" and a retry that reuses the same `clientActionId`.

- [ ] **Step 1: Write `order_detail_test.dart`:** fixture detail renders items, money total, both addresses and a timeline in time order with the reason text; no Call button when `customer.phone` is absent; only the actions in `allowed` are shown (fixture with `reassign:false` → no Reassign); Cancel opens the reason dialog with Submit disabled until 3 chars, then calls `act(Cancel)` with that reason; the rider picker greys an ineligible rider and shows "No recent location", tapping it does nothing; reassigning a `picked_up` order shows the hand-over warning and sends `afterPickup: true`; an `ActionRefused('stale')` shows "Someone else moved this order" and re-fetches; a thrown network error then Retry calls `act` with the identical `clientActionId`; push link `/admin/orders/<uuid>` maps to `/orders/<uuid>`.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): order detail — timeline, mini-map, audited actions, rider picker`.

### Task A4: Live tab — map, lanes, queues, signals, zone filter

**Files:**
- Create: `apps/manager/lib/state/live.dart`, `apps/manager/lib/features/live/live_screen.dart`, `.../live_map.dart`, `.../live_panels.dart`, `.../intervention_sheet.dart`, `apps/manager/test/live_screen_test.dart`
- Modify: `apps/manager/lib/router.dart` (`/live` with `zone` and `focus` query params; replaces the placeholder)

**Interfaces — Produces:**
- `liveSnapshotProvider` (`AsyncNotifier<LiveSnapshot>`, 10 s polling while visible, zone from the shared zone picker state).
- Map (full-height on phone with a draggable bottom panel; side panel ≥ 840 dp): rider markers — available green, on delivery the accent orange, break blue-grey, stale grey with a small label "updated N min ago"; order pins at the shop (status-coloured) with a line to the drop for orders on the way; tapping a rider shows name, code, state, active orders, last update and Call; tapping an order opens `/orders/:id`. "Fit all" control.
- Panel tabs: **Lanes** (Placed · Kitchen · Ready · On the way counts, each tapping to that list), **Unassigned** (each with "Assign" → rider picker from A3), **Delayed** (kind + minutes + estimated pickup/delivery time), **Alerts** (signals in words: "Ravi hasn't sent a location for 7 min during a delivery", "Delivery failed: AB12CD34", …).
- Manual intervention sheet from any live order: Advance / Reassign / Cancel / Escalate / Note, each through `showReasonDialog` with `required: true` (advance included here — Claude's call).
- `focus=<orderId>` centres the map on that order (used by pushes and the dashboard's "Riders currently on delivery" tile).

- [ ] **Step 1: Write `live_screen_test.dart`** with a fake `LiveRepository`: a rider with `stale: true, lastFixAgeSeconds: 540` renders the grey marker and the text "updated 9 min ago"; an `available` rider's marker uses the green token; lanes show the fixture counts and tapping Kitchen navigates to `/orders?status=kitchen`; the Unassigned tab lists the fixture order with an Assign button that opens the picker; the Alerts tab shows a `rider_inactive` signal sentence with the rider's name; changing the zone re-fetches with that `zoneId`; advancing from the intervention sheet requires a reason; polling every 10 s while visible (fake async).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS; `flutter analyze`.**
- [ ] **Step 5: Commit** `feat(manager-app): Live tab — rider map, lanes, unassigned, delayed, signals`.

### Task A5: Release build check (app half)

- [ ] **Step 1:** `flutter analyze`, `flutter test` (all), release APK with the F:\dev env (`flutter build apk --release --dart-define-from-file=env/prod.json`).
- [ ] **Step 2:** Install on `deligro_test`; cold start reaches login without `E/flutter` or FATAL in logcat; golden/screenshot tests (`test_screens/`, the Partner app's approach, fixture data) for Orders list, Order detail and Live in light and dark, saved under the scratchpad and listed in the commit body.
- [ ] **Step 3: Commit** `test(manager-app): Phase 3 screens — release build and screenshots`.

---

# Integration (in `F:\hub26\deligro-manager`, after both halves)

### Task I1: Merge, contract check, phase exit

**Files:**
- Create: `scripts/qa/manager-contract-emit.ts`, `apps/manager/test/contract_test.dart`

- [ ] **Step 1: Merge** `feat/manager-p3-server`, then `feat/manager-p3-app` into `feat/manager-app` (no overlap expected; resolve `package.json` script additions if any).
- [ ] **Step 2: Contract check.** `manager-contract-emit.ts` runs the S4/S6 serialisers on in-file fixture rows (one order in each status, cancelled with reason, null rider, stale rider) and writes `apps/manager/test/fixtures/api/generated/{orders_list,order_detail,order_riders,live}.json`; `contract_test.dart` parses each generated file with the A1 models and asserts no field the app reads is missing or mistyped (every non-nullable model field present). Run `npx tsx scripts/qa/manager-contract-emit.ts && cd apps/manager && flutter test test/contract_test.dart` — PASS. Commit the generated fixtures.
- [ ] **Step 3: Phase exit:** every `scripts/qa/sql/migration-*.mjs` ok; `npm run test:manager-live`, `test:manager-orders`, `test:manager-actions`, `test:metrics`, `test:idor`, `test:platform`; `npx tsc --noEmit`; `npm run lint`; `next build`; `flutter analyze`; `flutter test`; release APK on `deligro_test` (Orders and Live reachable from the bar; signed-in flows need `QA_MANAGER_*` and the migrations applied — record if unavailable).
- [ ] **Step 4: Commit** `test(manager): Phase 3 contract check and phase exit`; remove both worktrees and branches.
