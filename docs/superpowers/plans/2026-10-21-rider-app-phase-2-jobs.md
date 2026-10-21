# Rider App — Phase 2: Jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rider receives offers with a live countdown, accepts or rejects them with a reason, and works every delivery status from arrival at the shop to delivered or failed — with pickup by code, QR, vendor confirmation or ops-approved manual check; delivery by code and photo; exceptions decided by managers and admins; navigation, calls, an in-app route map; native ringing; and an offline action queue that can never double-apply.

**Architecture:** Migration `0082` adds exceptions, instructions, photo proof and dispatch settings. New server modules (`rider-jobs.ts`, `rider-delivery-actions.ts`, `delivery-exceptions.ts`) sit behind `/api/rider/*`; the web `/driver` actions and the existing `advanceDelivery` delegate to them so there is one implementation. Ops decide exceptions on the manager board and the admin live board. The Flutter app gets the Jobs tab, the active-delivery screen and a persisted action queue.

**Tech Stack:** as Phase 1, plus `mobile_scanner`, `image_picker`, `uuid`, `vibration` (Flutter); `qrcode@1.5.4` (web, vendor board).

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md` (sections *Offers and dispatch*, *Pickup and delivery verification*, *Navigation*)

## Global Constraints

- **Owner override (2026-10-21): the Rider app is ENGLISH ONLY — no Hindi anywhere on the rider side.** Ignore every mention below of Hindi, `tr(en, hi)`, `langProvider`, bilingual copy, `name_hi`/`nameHi`/`title_hi`, Devanagari or a language setting; write plain English strings and English-only tests. (The customer app and website keep their own language support untouched.)
- Everything in Phase 1's Global Constraints applies (worktree, AGENTS.md rules, migrations not applied, PGlite proofs, rider id from the session, `tr(en, hi)`, release-APK checks, commit trailer). Phase 1 ledger rulings R1–R6 apply: `npx tsc --noEmit` for typecheck; route QA asserts the contract and skips schema-dependent checks without the schema; missing tables → 503 `migration_pending`; app screenshots of server-dependent flows via the debug-only fixture backend.
- Statuses and their database mapping are exactly the spec's *Delivery statuses (§4)* table.
- Offer window = `platform_settings.rider_offer_window_seconds` (default 180, allowed 60–600); `EXCLUSIVE_OFFER_MS` becomes the fallback when the setting is missing.
- Geofence for arrival suggestions = 150 m. Customer "arriving" push stays at 500 m (`ARRIVAL_RADIUS_M`); "arrived" is the rider's explicit arrival at the drop.
- POD photo rule = `platform_settings.pod_photo_rule ∈ {never, cod, always, exceptions}` (default `never`). Photos: private bucket `delivery-proofs`, JPEG/PNG, ≤ 5 MB, magic-byte checked, signed URLs valid 10 minutes, deleted after 90 days by the cron.
- `customer_unreachable` may be raised only after a logged call to the customer and `platform_settings.unreachable_wait_minutes` (default 10, 3–30) since `arrived_drop_at`.
- The customer's phone and the shop's phone reach the app only for the rider's own active delivery, and only when `driver.call_customer` is on.
- Every rider action carries a client `actionId` (UUID v4). A repeat of an applied action id answers `{ ok: true, duplicate: true }` and changes nothing.
- Copy for every rider-facing error code lives in the app in English and Hindi; the server returns codes, not sentences.

## Review Focus

1. **A rider taps Delivered twice, or the queue replays after a reconnect** → exactly one `delivered` event, one COD record, one earning (Phase 3); the second answer is `duplicate: true` (Task 3 test with the same `actionId`; Task 5 queue test).
2. **The offer window ends while the rider is reading the card** → Accept answers `offer_expired` or succeeds if the order is still open to everyone; the card never accepts an order another rider already holds (Task 2 test on `reserved` vs expired-open).
3. **The vendor cancels while the rider is at the shop or on the way** → the next action answers `order_not_active`, the app clears the job, the cancellation push stops the ring, and the queued actions for that order are dropped with a notice (Task 3 and Task 5 tests).
4. **No signal at the customer's door** → the delivery code is accepted offline into the queue, the screen shows "Saved — will send when you're back online", and the server verifies the code on replay; a wrong code on replay re-opens the code entry (Task 5 test).
5. **Ops approve "complete without code" on an order the rider has meanwhile delivered with the code** → the decision answers `already_resolved`, nothing is changed twice (Task 4 test).

---

### Task 1: Migration 0082 — exceptions, instructions, proof photos, dispatch settings

**Files:**
- Create: `supabase/migrations/0082_rider_jobs.sql`, `scripts/qa/sql/migration-0082.mjs`
- Modify: `docs/DATABASE.md`

**Interfaces — Produces:**
- `delivery_exceptions (id uuid pk default gen_random_uuid(), delivery_id uuid not null → deliveries on delete cascade, order_id uuid not null, driver_id uuid not null, kind text not null, reason text not null, notes text, photo_path text, lat double precision, lng double precision, status text not null default 'pending', decided_by uuid, decided_at timestamptz, decision_note text, created_at timestamptz not null default now())`.
  - `kind ∈ ('customer_unreachable','wrong_address','complete_without_code','failed_delivery','manual_pickup','go_offline','return_to_shop','missing_items','wrong_package','vendor_delay','other_issue')`; the last four plus `return_to_shop` are **reports** (`status ∈ pending → acknowledged`), the rest are **requests** (`pending → approved | rejected`). A check constraint enforces which terminal status each kind may reach.
  - Partial unique index: one `pending` row per `(delivery_id, kind)`.
  - RLS: rider selects own (`driver_id = auth.uid()`), admin/manager select all; writes service-role only.
- `delivery_events.kind` check gains `'contact_attempt'` (method `customer` | `vendor`) — drop and re-create the constraint by name.
- `deliveries.pod_photo_path text`.
- `orders.delivery_instructions text` (≤ 300 chars, check), `grant select (delivery_instructions) on public.orders to authenticated`, and added to `guard_order_update`'s locked list (the API writes it with the service role).
- `guard_delivery_transition` extended (re-declare the 0081 function, keeping every 0081 rule) — and tightened per the Phase 1 review: a non-correction move to `delivered` also requires `old.status = 'picked_up'` (not only a `picked_up_at` value). `log_delivery_event` re-declared so a reassignment writes the `reassigned` row for the rider who lost the job **and** an `accepted` row for the rider who took it. To `failed` additionally requires an `approved` exception of kind `failed_delivery`, `customer_unreachable` or `wrong_address` for this delivery; `delivery_method = 'ops_approved'` requires an approved `complete_without_code`; `pickup_method = 'manual'` requires an approved `manual_pickup`. Corrections still bypass.
- `platform_settings`: `rider_offer_window_seconds int not null default 180 check 60–600`, `pod_photo_rule text not null default 'never' check in (…)`, `unreachable_wait_minutes int not null default 10 check 3–30`, `routing_base_url text not null default 'https://router.project-osrm.org'`.
- Storage bucket `delivery-proofs`: private, 5 MB, `image/jpeg`, `image/png`; no policies for anon/authenticated (service-role only).

- [ ] **Step 1: Write the PGlite proof** (stub `storage.buckets` as a plain table; reuse 0081's stubs and apply 0081 first). Assert: `picked_up → failed` with a reason but no approved exception raises; after an `approved` `customer_unreachable` it succeeds; `delivery_method='ops_approved'` without approval raises, with it succeeds; `pickup_method='manual'` likewise; a report kind cannot be set `approved`; a request kind cannot be set `acknowledged`; a second pending `wrong_address` for the same delivery raises `23505`; rider reads own exceptions only, cannot insert; `contact_attempt` events insert; `orders.delivery_instructions` of 301 chars raises; a vendor (owns_restaurant) updating `delivery_instructions` raises via `guard_order_update`; settings defaults and range checks; the bucket row exists and is not public. Also re-run the 0081 assertions file to confirm the re-declared guard kept 0081's rules.
- [ ] **Step 2: Run — FAIL. Step 3: Write the migration** (house style, rollback). **Step 4: Run — PASS.**
- [ ] **Step 5: Settings plumbing.** Add an `OPTIONAL_GROUPS` entry for the four settings (`src/lib/data-access/settings.ts`), `PlatformSettings` fields `riderOfferWindowSeconds`, `podPhotoRule`, `unreachableWaitMinutes`, `routingBaseUrl`, defaults in `src/lib/settings-defaults.ts`, a **Riders** fieldset in `src/app/admin/settings/settings-form.tsx` and parsing in `saveSettingsAction` (`routingBaseUrl` must be `https://`). `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 6: Commit** `feat(db): 0082 rider jobs — exceptions, instructions, proof photos, dispatch settings`.

### Task 2: Offers — board API, accept, reject, smarter re-offer

**Files:**
- Create: `src/lib/rider/offer-window.ts` (pure), `src/lib/data-access/rider-jobs.ts`, `src/app/api/rider/board/route.ts`, `src/app/api/rider/offers/[orderId]/accept/route.ts`, `src/app/api/rider/offers/[orderId]/reject/route.ts`, `scripts/qa/rider-offers.ts`
- Modify: `src/lib/dispatch/rider-dispatch.ts` (window from settings; `excludeRiderIds` from history), `src/lib/dispatch/sweep.ts` (re-offer excludes every prior rejecter/lapser, writes `lapsed` events), `src/lib/data-access/driver-orders.ts` (`acceptDelivery` stores `distance_km`, writes nothing else new)

**Interfaces — Produces:**
```ts
// offer-window.ts
export function offerDeadline(offeredAt: string | null, windowSeconds: number): string | null;
export function offerState(driverId: string, offer: { offeredDriverId: string | null; offeredAt: string | null }, windowSeconds: number, now: Date): "open" | "mine" | "held";
export const REJECT_REASONS = ["too_far", "vehicle_issue", "on_break", "low_battery", "other"] as const;
export function roadKmFallback(straightKm: number): number; // × 1.3, 2 dp

// rider-jobs.ts
export interface RiderStop { name: string; line: string | null; point: { lat: number; lng: number } | null; phone: string | null }
export interface RiderOffer { orderId: string; code: string; shop: RiderStop; drop: RiderStop; instructions: string | null; itemCount: number;
  shopToDropKm: number | null; riderToShopKm: number | null; etaMinutes: number | null; offerExpiresAt: string | null; reservedForYou: boolean;
  payment: { instruction: "collect" | "prepaid" | "unconfirmed"; collectAmount: number }; estimatedEarning: number | null }
export interface RiderUpcoming { offer: RiderOffer; readyInMinutes: number | null }
export interface RiderActive { orderId: string; deliveryId: string; code: string; status: RiderDeliveryStatus; shop: RiderStop; drop: RiderStop & { customerName: string | null };
  instructions: string | null; items: { name: string; qty: number }[]; payment: RiderOffer["payment"]; pickupCodeRequired: boolean;
  distanceKm: number | null; etaMinutes: number | null; podPhotoRequired: boolean; timeline: RiderEvent[]; exceptions: RiderException[];
  arrivedDropAt: string | null; unreachableWaitMinutes: number }
export type RiderDeliveryStatus = "accepted" | "arrived_pickup" | "picked_up" | "on_the_way" | "arrived_drop" | "delivered" | "failed" | "cancelled";
export interface RiderEvent { kind: string; method: string | null; reason: string | null; at: string }
export interface RiderException { id: string; kind: string; status: string; reason: string; decisionNote: string | null; createdAt: string }
export async function getRiderBoard(driverId: string): Promise<{ offers: RiderOffer[]; upcoming: RiderUpcoming[]; active: RiderActive | null; offerWindowSeconds: number }>;
export async function acceptOffer(driverId: string, orderId: string): Promise<{ ok: true } | { ok: false; error: "reserved" | "offer_expired" | "already_taken" | "not_ready" | "not_online" }>;
export async function rejectOffer(driverId: string, orderId: string, reason: (typeof REJECT_REASONS)[number], note?: string): Promise<{ ok: true } | { ok: false; error: "not_offered" | "invalid_reason" }>;
```
- `RiderDeliveryStatus` is derived from `deliveries.status` + stamps per the spec table (`picked_up` without `departed_pickup_at` → `picked_up`; with → `on_the_way`; with `arrived_drop_at` → `arrived_drop`).
- Shop phone: `restaurants.phone` (or the owner's `profiles.phone` when the shop has none), only in `active`. Customer phone only in `active`, and both are null when `driver.call_customer` is off.
- `etaMinutes` uses `computeOrderEta` / `roadMinutesFor` (no new ETA model). `riderToShopKm` from `rider_status.last_lat/lng`. `estimatedEarning` is `null` until Phase 3.
- Accept requires the rider to be online (`not_online`), refuses `reserved` (held for someone else) and answers `offer_expired` when the rider's own window passed **and** someone else has since been offered it; if it fell open to everyone, accepting succeeds.
- Reject: only the current offeree (`not_offered` otherwise); writes a `rejected` event with the reason, clears `offered_driver_id/offered_at`, stops the ring, and calls `dispatchOrder(orderId, stage, { excludeRiderIds })` where `excludeRiderIds` = every rider with a `rejected` or `lapsed` event on this order.
- Routes: `GET /api/rider/board` (rate limit 40/min), `POST …/accept` (30/min, same key as the web action), `POST …/reject { reason, note? }` (30/min). On accept success: `notifyVendorRiderAssigned`, `stopRiderRing`, as the web action does.
- The web `/driver` page and its `acceptDeliveryAction` keep working; `acceptDelivery` gains the online check and `distance_km`.
- Never-offered orders (Phase 1 review F1): the sweep also re-dispatches `ready` orders whose delivery is `unassigned` with `offered_driver_id` null, and a successful `online`/`resume` (app route and web action) triggers a throttled dispatch pass (`maybeSweepDispatch`). Add a pure selector test for "which rows the sweep re-dispatches".
- `dispatchOrder` currently swallows errors silently; when it stands down because `rider_status` could not be read (not missing — unreadable), log it through the observability helper the repo uses (`src/lib/obs` — find the existing logger) so a broken grant doesn't look like "no riders online".
- Presence sweep (Phase 1 final review): the sweep force-offlines riders who are online with no fix for 20 minutes and no active delivery (`forceRiderOffline(id, "presence")`, shift closed at `last_fix_at`, or `online_since` when there was never a fix). Pure selector `presenceExpired(rows, now)` with tests (19:59 stays, 20:01 goes, active delivery never goes).
- `hasRiderCommitment` uses the new `rider_offer_window_seconds` setting (not `EXCLUSIVE_OFFER_MS`), the same window dispatch uses.
- Every rider action writes the rider's current position on the delivery row in the same update, so `delivery_events.lat/lng` is where the action happened.
- Any write this task touches that names a 0081/0082 column uses `writeWithColumnFallback` / `isMissingColumnOnWrite` from `src/lib/data-access/column-fallback.ts` (PGRST204 as well as 42703) — including `reportDriverLocation`'s `driver_location_source` write.

- [ ] **Step 1: Write `scripts/qa/rider-offers.ts`** for the pure module: deadline = offeredAt + window; `offerState` mine/held/open at window − 1 s / + 1 s; `roadKmFallback(10) === 13`; reject reasons list. Plus contract checks against the dev server (401/403/400 `invalid_reason`; schema-dependent checks skip per R2).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** run the script, `npx tsx scripts/qa/driver-app.ts`, `npx tsx scripts/qa/ring-protocol.ts`, `npx tsc --noEmit`, `npm run lint`, `npm run test:idor`.
- [ ] **Step 5: Commit** `feat(rider): offers board API with countdown, accept and reject with reason`.

### Task 3: Delivery actions — arrival, pickup methods, trip, delivery, proof photo, vendor handover

**Files:**
- Create: `src/lib/rider/delivery-machine.ts` (pure), `src/lib/data-access/rider-delivery-actions.ts`, `src/app/api/rider/deliveries/[orderId]/action/route.ts`, `src/app/api/rider/deliveries/[orderId]/proof/route.ts`, `src/app/api/rider/deliveries/[orderId]/contact/route.ts`, `src/app/api/vendor/orders/[id]/handover/route.ts`, `scripts/qa/rider-delivery-machine.ts`
- Modify: `src/lib/data-access/driver-orders.ts` (`advanceDelivery` delegates to `performDeliveryAction`; delete the logic it replaces), `src/lib/notifications/order-events.ts` (`notifyRiderArrived(orderId, riderName)` to the customer; `notifyRiderHandedOver(driverId, orderId)`), `src/components/vendor/vendor-orders-board.tsx` (QR of the pickup code beside "Read to the rider", and a **Handed to rider** button while the rider has arrived or is assigned), `src/app/(customer)/orders/[id]` tracking copy and `src/lib/utils/order-status.ts` ("Your rider has arrived"), `package.json` (`qrcode@1.5.4`, `@types/qrcode`)

**Interfaces — Produces:**
```ts
// delivery-machine.ts (pure)
export type RiderAction = "arrive_pickup" | "pickup" | "start_trip" | "arrive_drop" | "deliver";
export type PickupMethod = "code" | "qr" | "manual"; export type DeliverMethod = "code" | "photo" | "ops_approved";
export interface MachineState { status: "assigned" | "picked_up" | "delivered" | "failed" | "cancelled"; arrivedPickupAt: string | null; departedPickupAt: string | null; arrivedDropAt: string | null; orderStatus: string }
export function checkAction(s: MachineState, action: RiderAction): { ok: true } | { ok: false; error: "bad_state" | "order_not_active" | "already_done" };
export function podPhotoRequired(rule: "never" | "cod" | "always" | "exceptions", ctx: { isCod: boolean; viaException: boolean }): boolean;
// rider-delivery-actions.ts
export async function performDeliveryAction(driverId: string, orderId: string, input: { action: RiderAction; actionId: string; code?: string; method?: PickupMethod | DeliverMethod; photoPath?: string; lat?: number; lng?: number }):
  Promise<{ ok: true; duplicate?: boolean } | { ok: false; error: "bad_state" | "order_not_active" | "bad_pickup_otp" | "bad_otp" | "photo_required" | "manual_not_approved" | "not_yours" }>;
export async function uploadDeliveryProof(driverId: string, orderId: string, file: File): Promise<{ ok: true; path: string } | { ok: false; error: "bad_type" | "too_large" | "not_yours" | "bad_state" }>;
export async function logContactAttempt(driverId: string, orderId: string, target: "customer" | "vendor"): Promise<void>;
export async function vendorConfirmHandover(ownerId: string, orderId: string): Promise<{ ok: true } | { ok: false; error: "not_yours" | "no_rider" | "bad_state" }>;
```
- Order of actions: `arrive_pickup` (assigned, not yet arrived) → `pickup` (assigned; method `code`/`qr` checks `pickup_otp` exactly as today; `manual` needs an approved `manual_pickup`; sets order `on_the_way`, `pickup_method`) → `start_trip` (picked_up, sets `departed_pickup_at`) → `arrive_drop` (picked_up; also stamps `departed_pickup_at` if missing; pushes the customer "arrived") → `deliver` (picked_up; method `code` checks `delivery_otp`; photo required per rule → `photo_required` unless `photoPath` was uploaded for this delivery; records COD exactly as `recordCodCollection` does; order `delivered`).
- `actionId` is written to `deliveries.last_action_id` in the same update; a `23505` on it → `{ ok: true, duplicate: true }`. Per the Phase 1 review, a replay does not always surface as 23505: an exact replay of a stamp action is refused by guard rule 4 (`23514`), an exact replay of `deliver` on an already-delivered row is a no-op. So: before applying, re-read the row; if the requested action's target state already holds (stamp already set, status already reached) answer `{ ok: true, duplicate: true }` without writing; treat a `23514` whose re-read shows the target state as duplicate success too.
- The COD record moves into `performDeliveryAction` and its write uses `writeWithColumnFallback` (the old one checked 42703 only and silently skipped on PGRST204).
- `lat/lng` recorded on the event when given.
- Rate limit `driver-advance:<id>` 10/min stays for code-carrying actions (the existing OTP-guess guard); other actions 30/min.
- Proof upload: multipart `file`, JPEG/PNG, ≤ 5 MB, `assertRealType`, path `<deliveryId>/<uuid>.<ext>`, sets `deliveries.pod_photo_path`; only while the rider holds the delivery at `picked_up`.
- Contact: `POST …/contact { target }` writes a `contact_attempt` event (rate limit 20/min). The app calls it when the rider taps Call.
- Vendor handover: `POST /api/vendor/orders/[id]/handover` (vendor access + owns the order's shop, 30/min) → delivery `picked_up` with `pickup_method = 'vendor'`, order `on_the_way`, `notifyOnTheWay`, `notifyRiderHandedOver`.

- [ ] **Step 1: Write `scripts/qa/rider-delivery-machine.ts`:** every legal transition passes; `deliver` from `assigned` → `bad_state`; any action on a cancelled order → `order_not_active`; `arrive_pickup` twice → `already_done`; `podPhotoRequired` truth table for all four rules × cod/prepaid × exception. Contract checks for the four routes (401/403/400; schema-dependent skip per R2), including a vendor who does not own the order → 403 on handover.
- [ ] **Step 2: Run — FAIL. Step 3: Implement**; `advanceDelivery` keeps its signature and error codes for the web board but calls `performDeliveryAction` with a generated `actionId`. **Step 4:** the script, `driver-app.ts`, `ring-protocol.ts`, `npx tsc --noEmit`, `npm run lint`, `npm run test:idor`, `npm run test:platform`; dev server: vendor board shows the QR and the button (screenshot, light and dark).
- [ ] **Step 5: Commit** `feat(rider): full delivery flow — arrival, pickup methods, trip, proof photo, vendor handover`.

### Task 4: Exceptions — rider requests, ops decisions, manager and admin screens

**Files:**
- Create: `src/lib/data-access/delivery-exceptions.ts`, `src/app/api/rider/exceptions/route.ts`, `src/components/ops/exception-queue.tsx` (shared by manager and admin, console tokens only), `scripts/qa/delivery-exceptions.ts`
- Modify: `src/lib/data-access/order-cancellation.ts` (export `cancelOrderAsOps(orderId, { by: "admin" | "manager", reason, requestedBy })` extracted from `cancelOrderAsAdmin` — the admin action then calls it; one implementation), `src/app/admin/orders/actions.ts`, `src/app/manager/actions.ts` (`decideExceptionAction`), `src/app/manager/page.tsx` + `src/components/manager/manager-order-board.tsx` (queue on top with an alert sound; rider call button while a delivery is active, gated by `manager.call`-equivalent existing flag), `src/app/admin/page.tsx` (queue on the live board), `src/lib/notifications/order-events.ts` (`notifyOpsExceptionRequested`, `notifyDriverExceptionDecided`)

**Interfaces — Produces:**
```ts
export type ExceptionKind = "customer_unreachable" | "wrong_address" | "complete_without_code" | "failed_delivery" | "manual_pickup" | "go_offline" | "return_to_shop" | "missing_items" | "wrong_package" | "vendor_delay" | "other_issue";
export async function raiseException(driverId: string, input: { orderId: string; kind: ExceptionKind; reason: string; notes?: string; photoPath?: string; lat?: number; lng?: number }):
  Promise<{ ok: true; id: string } | { ok: false; error: "not_yours" | "duplicate_pending" | "call_first" | "wait_longer" | "bad_state" | "invalid_kind" }>;
export async function listPendingExceptions(): Promise<OpsException[]>; // with order code, rider name/phone, shop, customer area, minutes waiting
export async function decideException(actor: { id: string; role: "admin" | "manager" }, id: string, decision: "approve" | "reject" | "acknowledge", note?: string):
  Promise<{ ok: true } | { ok: false; error: "not_found" | "already_resolved" | "invalid_decision" }>;
```
- `call_first`: `customer_unreachable` without a `contact_attempt` to the customer after `arrived_drop_at`; `wait_longer`: fewer than `unreachable_wait_minutes` since `arrived_drop_at` (the error body carries `minutesLeft`). `manual_pickup` only at `assigned`; `complete_without_code`/`failed_delivery`/`customer_unreachable`/`wrong_address` only at `picked_up`; `go_offline` only with an active delivery or offer.
- Effects of approval (each re-checks the delivery's current state; a delivery already delivered/failed/cancelled → `already_resolved`): `failed_delivery` / `customer_unreachable` / `wrong_address` → delivery `failed` (`failure_reason` = kind + reason) and `cancelOrderAsOps(…, reason: "delivery_failed: <kind>")` (refund rules unchanged; the rider is told to return the food to the shop); `complete_without_code` → `performDeliveryAction`-equivalent completion with `delivery_method = 'ops_approved'` and COD record; `manual_pickup` → leaves the delivery for the rider to confirm with method `manual`; `go_offline` → the delivery is released (`driver_id` null, status `unassigned`, a `reassigned` event), `dispatchOrder(orderId, "ready", { excludeRiderIds: [rider] })`, then `forceRiderOffline(rider, "ops")`. Reports → `acknowledge` only.
- Ops alert: request → `notifyOpsExceptionRequested` (push to managers and admins, rings with the vendor ring protocol id `ops:<exceptionId>`); decision → `notifyDriverExceptionDecided`.
- Manager board: "Needs a decision" panel listing pending exceptions oldest first with Approve / Reject (note) / Acknowledge, photo thumbnail via a signed URL, the rider's phone with a call link while active. Admin home live board: same component.

- [ ] **Step 1: Write `scripts/qa/delivery-exceptions.ts`:** pure rule checks extracted as `exceptionAllowed(kind, state, ctx)` in `src/lib/rider/exception-rules.ts` (call_first, wait_longer with `minutesLeft`, state gates, report vs request decisions); contract checks for `POST /api/rider/exceptions` (401/403/400 `invalid_kind`; schema-dependent skip).
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** script, `npx tsc --noEmit`, `npm run lint`, `npm run test:idor`, `npm run test:platform`; dev server screenshots of the queue on manager (phone and console shells) and admin, light and dark.
- [ ] **Step 5: Commit** `feat(ops): delivery exceptions — rider requests, manager and admin decisions`.

### Task 5: App data layer — repositories, action queue, cached delivery, fixtures

**Files:**
- Create: `apps/rider/lib/models/jobs.dart`, `apps/rider/lib/data/jobs_repository.dart`, `apps/rider/lib/core/action_queue.dart`, `apps/rider/lib/core/active_cache.dart`, `apps/rider/lib/data/fixtures/fixture_backend.dart`
- Test: `apps/rider/test/action_queue_test.dart`, `apps/rider/test/jobs_models_test.dart`

**Interfaces — Produces:**
```dart
class JobsRepository {
  Future<RiderBoard> board();
  Future<void> accept(String orderId);
  Future<void> reject(String orderId, String reason, {String? note});
  Future<ActionOutcome> act(QueuedAction a);              // POST …/action
  Future<String> uploadProof(String orderId, File photo);  // returns path
  Future<void> logContact(String orderId, String target);
  Future<String> raiseException({required String orderId, required String kind, required String reason, String? notes, String? photoPath, double? lat, double? lng});
}
class QueuedAction { final String actionId; final String orderId; final String action; final String? code; final String? method; final String? photoPath; final double? lat; final double? lng; final DateTime queuedAt; }
class ActionQueue { // persisted in prefs 'action_queue_v1', FIFO per order
  Future<ActionOutcome> submit(QueuedAction a); // online → send; network error → keep queued, return ActionOutcome.queued
  Future<List<ActionOutcome>> flush();          // on connectivity regained and every board refresh
  Stream<List<QueuedAction>> pending;
}
enum ActionOutcomeKind { applied, duplicate, queued, rejected, orderGone }
class ActiveDeliveryCache { Future<void> save(RiderActive a); RiderActive? load(); Future<void> clear(); }
```
- Model parsing mirrors Task 2's JSON exactly (camelCase keys). `rejected` carries the server error code; `orderGone` = `order_not_active` → drop every queued action for that order and clear the cache.
- Fixture backend: implements the same repository interfaces from JSON fixtures in `fixtures/`; selected only when `const bool.fromEnvironment('FIXTURES')` **and** `!kReleaseMode` (assert + runtime check), so it cannot reach a release build.

- [ ] **Step 1: Write tests:** a network failure queues and `pending` emits one item; `flush()` sends in order and empties; a `duplicate` answer counts as applied; `bad_otp` on replay surfaces `rejected('bad_otp')` and removes only that action; `order_not_active` drops all actions for the order and clears the cache; the queue survives a new `SharedPreferences` instance; model round-trip for a full board fixture; fixtures refuse to load when `kReleaseMode` is simulated true.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** `flutter analyze`, `flutter test`.
- [ ] **Step 5: Commit** `feat(rider-app): jobs data layer with offline action queue`.

### Task 6: Jobs tab — offers, countdown, accept and reject, ringing

**Files:**
- Create: `apps/rider/lib/features/jobs/jobs_screen.dart`, `offer_card.dart`, `countdown_ring.dart`, `reject_sheet.dart`, `apps/rider/android/app/src/main/kotlin/com/ractrotech/deligro/rider/RingService.kt`, `RingNotificationExtension.kt`, `apps/rider/lib/core/ring.dart`
- Modify: `apps/rider/lib/features/shell/rider_shell.dart` (Jobs tab, second), `apps/rider/lib/core/push.dart` (tap → `/jobs`), `AndroidManifest.xml` (service, `com.onesignal.NotificationServiceExtension` meta-data, `USE_FULL_SCREEN_INTENT`), `apps/rider/android/app/src/main/res/raw/deligro_ring.ogg` (from the website's default rider alert sound)
- Test: `apps/rider/test/jobs_screen_test.dart`

Behaviour: the Jobs tab polls `board()` every 5 s while visible and on resume; with an active delivery it shows the active-delivery screen (Task 7). Offers: the first is a large card (shop, pickup line, drop line, instructions, item count, shop→drop km, rider→shop km, ETA, cash to collect or "Prepaid", estimated earning row hidden while null, **Held for you** + countdown ring to `offerExpiresAt`), the rest compact rows; **Accept** and **Reject** (reason sheet: too far, vehicle issue, on a break, low battery, other + note). Countdown reaching zero greys the card to "Open to everyone" (or removes it if the next poll no longer lists it). Upcoming pickups listed with "ready in ~N min". Offline rider: an empty state "You're offline — go online to get orders" with the switch. Ring: port of `RingService.java` (channel `deligro_ring`, `USAGE_ALARM`, looping, vibration, timeout → `deligro_missed` notification, stop memory in prefs `deligro_ring_stopped`) driven by the OneSignal notification-service extension reading `{ring, ringId, timeoutSec, sentAt}`; accepting, rejecting or the server's stop push ends it. Settings sound/vibration switches (Task 8) gate it, except while the offer is held for this rider.

- [ ] **Step 1: Write `jobs_screen_test.dart`** (fixture repo, fake clock): countdown shows 2:59 then 0:00 → "Open to everyone"; Accept calls `accept` and switches to the active screen on the next board; `reserved` → bilingual "Another rider is holding this order"; reject without a reason keeps Send disabled; reject sends the reason; offline → offline empty state; renders in light/dark/1.3×. Ring protocol parsing unit test in `ring_test.dart`: start/stop payloads, stale start after stop ignored.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** analyze, test, release build; emulator: send a test push with ring data from the OneSignal REST API using the QA rider's external id (or `adb shell am startservice` with the start intent when no push key is available) — the phone rings with the screen off and stops on Accept; fixture-build screenshots of the offer card, countdown and reject sheet.
- [ ] **Step 5: Commit** `feat(rider-app): Jobs tab with offer countdown, accept, reject and native ringing`.

### Task 7: Active delivery — steps, map, navigation, calls, codes, QR, photo, exceptions, timeline

**Files:**
- Create: `apps/rider/lib/features/delivery/active_delivery_screen.dart`, `step_tracker.dart`, `route_map.dart`, `code_entry.dart`, `qr_scan_screen.dart`, `proof_photo.dart`, `issue_sheets.dart`, `timeline.dart`, `apps/rider/lib/core/routing.dart`, `apps/rider/lib/core/navigation_launcher.dart`
- Modify: `apps/rider/lib/core/location_service.dart` (`setActiveDelivery` on start/end; exposes the latest fix to the screen), `pubspec.yaml` (`mobile_scanner`, `image_picker`, `uuid`)
- Test: `apps/rider/test/active_delivery_test.dart`, `apps/rider/test/routing_test.dart`

Behaviour:
- Step tracker shows all nine statuses (Assigned, Accepted, Arrived at pickup, Picked up, On the way, Arrived at customer, Delivered; Failed / Cancelled as terminal states) with the current one highlighted.
- Card: order code, shop name + address + **Call shop**, customer name + drop address + instructions + **Call customer** (each call logs a contact attempt first), item list (name × qty), cash notice, distance and ETA.
- Map (`flutter_map`, OSM tiles): rider, shop, drop; route polyline + ETA from `${routingBaseUrl}/route/v1/driving/<lng,lat;lng,lat>?overview=simplified&geometries=geojson` (base URL from the board), recomputed when the rider is > 150 m off the line or every 2 min; on failure a straight line and haversine ETA labelled "approx." / "अनुमानित".
- **Navigate** opens the rider's chosen app: Google Maps `google.navigation:q=<lat>,<lng>&mode=d` (falls back to `https://www.google.com/maps/dir/?api=1&destination=…` if not installed) or "Other app" via `geo:<lat>,<lng>?q=<lat>,<lng>`; address-only stops use the address text.
- Primary button follows the status: **I've arrived at the shop** → pickup panel (**Enter pickup code**, **Scan QR**, "Ask the shop to tap *Handed to rider*" with a spinner that resolves on the next board, **Request manual check**) → **Start trip** → **I've arrived** → delivery panel (**Enter delivery code**; photo step first when `podPhotoRequired`; **Can't deliver?** opens the exception sheet). Inside 150 m of the stop the arrival button pulses and a one-time banner suggests it.
- Exception sheets: customer unreachable (disabled with a countdown until `unreachableWaitMinutes` after arrival and until a call was logged — the sheet says which), wrong address, complete without code, failed delivery, go offline / hand back, and at the shop: missing items, wrong package, vendor delay, other — each with reason, notes and optional photo; pending/decided state shown on the card.
- Every action goes through `ActionQueue.submit` with a fresh UUID and the latest fix; queued actions show "Saved — will send when you're back online".
- Timeline sheet from `active.timeline`.
- Cached delivery shown when the board can't load; a banner says "Offline — showing saved details".
- Location service (Phase 1 final review, ruling R17): `setActiveDelivery` is driven by the board's active delivery; while a delivery is active the service shares at 10 s whatever the server says about `online`, and stops only when the rider is neither online nor carrying an order. A suspended location gate is cleared when the rider goes offline with no active delivery. The `/me`-driven silent resume gets a backoff (no more than once a minute) so a server that disagrees with itself can't loop it.

- [ ] **Step 1: Write tests:** each status renders its primary button (fixtures for all statuses); pickup code wrong → bilingual error and the boxes clear; QR scan result fills the code and submits with method `qr`; photo-required delivery blocks the code button until a photo is attached; unreachable sheet disabled before the wait and before a call, enabled after both; navigate builds the Google URI and the `geo:` URI per preference; `routing_test.dart`: parses an OSRM response, falls back to haversine on error, off-route detection at 151 m vs 149 m; cached delivery renders offline. All in light/dark/1.3×.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** analyze, test, release build; emulator with fixtures: walk every status, scan a QR rendered on the host screen (`adb emu` camera is unavailable → verify scanner screen opens and manual entry path), take a proof photo with the emulator camera; screenshots.
- [ ] **Step 5: Commit** `feat(rider-app): active delivery with every status, map, navigation, codes, QR, proof photo and exceptions`.

### Task 8: Settings — navigation app, sound and vibration

**Files:** Modify `apps/rider/lib/features/settings/settings_screen.dart`, `apps/rider/lib/state/prefs.dart`, `apps/rider/lib/core/ring.dart`; Test `apps/rider/test/settings_test.dart`

Also in this task (carried from the Task 6 review, ruling P2-R12): (1) server — `GET /api/rider/board` returns `serverNow` (ISO); the app keeps `serverOffset = serverNow − deviceNowAtReceipt` per fetch and every countdown/held/board-ring computation uses `now + offset` (test: a phone clock 3 min fast still shows 2:59 for a fresh offer); (2) server — `riderRing` sends `held: true` only for the offer held for this rider and `held: false` for heads-up rings, and the ring TTL follows `rider_offer_window_seconds` (update `src/lib/alerts/ring.ts`, `order-events.ts`, `scripts/qa/ring-protocol.ts`); (3) `RingService.kt` releases the MediaPlayer when prepare/start throws (no leak on retries).

Navigation app (Google Maps / Other app — the system chooser), Alert sound on/off, Vibration on/off, **Test the alert** button (rings for 3 s), and a link to the system's notification-channel settings for `deligro_ring`. Stored locally (prefs keys `nav_app`, `ring_sound`, `ring_vibrate`).

- [ ] **Step 1: Test:** preferences persist; Test the alert calls the ring with a 3 s timeout; with sound off, ring plays vibration only; Hindi labels. **Step 2: FAIL. Step 3: Implement. Step 4:** analyze, test, release build, emulator check. **Step 5: Commit** `feat(rider-app): navigation app, sound and vibration settings`.

### Task 9: Customer side — delivery instructions and the rider's arrival

**Files:**
- Modify: `src/lib/data-access/orders.ts` (`CreateOrderInput.instructions?: string`, trimmed, ≤ 300, written to `orders.delivery_instructions` via the probe pattern), the web checkout (instructions field, bilingual, optional), `src/lib/data-access/manager-phone-orders.ts` (the manager's note goes to `delivery_instructions` instead of being folded into `line`), `apps/customer/lib/features/checkout/checkout_screen.dart` + `apps/customer/lib/data/order_repository.dart` (send the existing "Delivery instructions" text as `instructions` rather than appending it to `line`), customer tracking screens (web `tracking-view.tsx`, Flutter `tracking_screen.dart`): "Your rider has arrived" step when `arrived_drop_at` is set, and a "Proof of delivery" photo link (signed URL from a new `GET /api/orders/[id]/proof`, customer of that order only) when a photo exists.
- Test: `scripts/qa/order-instructions.ts`; `apps/customer/test/checkout_instructions_test.dart`

- [ ] **Step 1: Tests:** 301-char instructions rejected with `instructions_too_long`; empty → null; the Flutter checkout sends `instructions` and leaves `line` as the address only; `/api/orders/[id]/proof` → 403 for another customer, 404 without a photo. **Step 2: FAIL. Step 3: Implement. Step 4:** `npx tsc --noEmit`, lint, `npm run test:idor`, `npm run test:customer-layout`; customer app `flutter analyze`, `flutter test`. **Step 5: Commit** `feat(orders): delivery instructions and rider arrival for customers`.

---

## Phase exit

All QA scripts pass; tsc, lint, idor, platform pass; `flutter analyze` + `flutter test` in `apps/rider` and `apps/customer`; release APK on `deligro_test`; fixture-build walkthrough of offers → delivered, and → failed via an approved exception; short report.
