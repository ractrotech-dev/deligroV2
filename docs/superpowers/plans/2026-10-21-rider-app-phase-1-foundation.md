# Rider App — Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Riders have a real, server-side online/offline/break state that dispatch obeys, every delivery change is audited and guarded in the database, and a Flutter Rider app exists that a rider can sign in to, go online in, and share location from with the screen locked.

**Architecture:** One migration (`0081`) proven in PGlite; a pure availability module plus a server-only data layer behind thin `/api/rider/*` route handlers; dispatch filtered through the pure module; a new Flutter app `apps/rider` adapted from `apps/customer`.

**Tech Stack:** Supabase Postgres (migrations, RLS, triggers), Next.js route handlers (this repo's Next version — read `node_modules/next/dist/docs/` before writing a route), Flutter 3.47 / Riverpod 3 / go_router / supabase_flutter / geolocator 14 / onesignal_flutter.

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md`

## Global Constraints

- **Owner override (2026-10-21): the Rider app is ENGLISH ONLY — no Hindi anywhere on the rider side.** Ignore every mention below of Hindi, `tr(en, hi)`, `langProvider`, bilingual copy, `name_hi`/`nameHi`/`title_hi`, Devanagari or a language setting; write plain English strings and English-only tests. (The customer app and website keep their own language support untouched.)
- Work only in the worktree `F:\hub26\deligro-rider`, branch `feat/rider-app`. Never touch `F:\hub26\deligro` or `F:\hub26\deligro-vendor`.
- `AGENTS.md` rules apply: role check + rate limit on every write route; `createAdminClient()` only under an authorization check in the same path; never `select("*")` on `orders`; new `orders` columns need a per-column grant; fail closed.
- Migrations `0081`+ only. **Not applied** to any database. Each ships a PGlite proof in `scripts/qa/sql/` (pattern: `migration-0058.mjs`, `npm i --no-save @electric-sql/pglite@0.2.17`) and a rollback block in its header.
- The rider id always comes from the session, never from a request body or URL.
- App ID `com.ractrotech.deligro.rider`, display name `Deligro Rider`, version `2.0.0+3`.
- App look = `apps/customer/lib/theme/app_theme.dart` tokens (Inter, warm surfaces, orange accent, JetBrains Mono figures), light and dark. Splash/brand art PNG or JPEG, never WebP.
- Every user-facing app string is an English/Hindi pair through `tr(en, hi)`; English by default.
- Flutter builds on this PC: `GRADLE_USER_HOME=F:\dev\gradle-home`, `TEMP/TMP=F:\dev\tmp`, toolchain under `F:\dev`; C: is full. Copy `apps/customer/android/app/proguard-rules.pro` (shared_preferences JNI keep rules).
- Every screen is checked on the emulator `deligro_test` from the **release** APK before its task is done.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A rider still on the web `/driver` portal after dispatch goes online-only** → they must still be able to work: the web portal gets the same Online switch and idle heartbeat (Task 3 test: a rider with no `rider_status` row is not dispatchable; after the web action sets online and a fix arrives, they are).
2. **The app is killed or the phone dies while online** → the rider must stop receiving offers within minutes, not stay "online" forever: dispatchable requires a fix younger than `RIDER_PRESENCE_MS` = 5 min (Task 2 pure test).
3. **Go offline or take a break while carrying an order or holding an offer** → refused with `active_delivery`, and the app says why in both languages (Task 2 route test, Task 6 widget test).
4. **Sign out with no network** → the local sign-out still completes; the presence window takes the rider out of dispatch (Task 6 test: a failing `/api/rider/signout` does not block `signOut`).
5. **Location permission denied or turned off** → going online is refused in the app with a button to open settings, never a silent "online" rider with no position (Task 7 test).

---

### Task 1: Migration 0081 — rider foundation

**Files:**
- Create: `supabase/migrations/0081_rider_app_foundation.sql`
- Create: `scripts/qa/sql/migration-0081.mjs`
- Modify: `docs/DATABASE.md` (new tables, columns, triggers, policies)

**Interfaces — Produces:**
- `delivery_status` gains `'failed'` (the `alter type … add value if not exists` sits **before** `begin;` — a new enum value cannot be used in the transaction that adds it).
- `deliveries` columns: `arrived_pickup_at`, `departed_pickup_at`, `arrived_drop_at`, `failed_at timestamptz`; `failure_reason text`; `pickup_method text check in ('code','qr','vendor','manual','none')`; `delivery_method text check in ('code','photo','ops_approved','staff')`; `distance_km numeric(6,2)`; `last_action_id uuid`; `correction_reason text`.
- `rider_status (driver_id uuid pk → profiles, is_online bool not null default false, break_until timestamptz, online_since timestamptz, last_lat double precision, last_lng double precision, last_fix_at timestamptz, updated_at timestamptz not null default now())`.
- `rider_shifts (id bigint identity pk, driver_id uuid not null, started_at timestamptz not null, ended_at timestamptz, ended_by text check in ('rider','logout','ops','presence'))`, index `(driver_id, started_at desc)`; partial unique index: one open shift per rider (`where ended_at is null`).
- `rider_profiles (driver_id uuid pk → profiles on delete cascade, rider_code text unique not null default 'DR-' || lpad(nextval('public.rider_code_seq')::text, 4, '0'), created_at, updated_at)` — later phases add columns. Trigger `ensure_rider_profile` on `profiles` (after insert or update of `role`, when `role = 'driver'`) inserts the row `on conflict do nothing`; existing drivers backfilled in `created_at` order.
- `delivery_events (id bigint identity pk, delivery_id uuid not null, order_id uuid not null, driver_id uuid, kind text not null, method text, reason text, actor_id uuid, lat double precision, lng double precision, client_action_id uuid, created_at timestamptz not null default now())`; `kind in ('offered','rejected','lapsed','accepted','arrived_pickup','picked_up','departed','arrived_drop','delivered','failed','cancelled','reassigned','exception_requested','exception_decided','corrected')`; unique index on `client_action_id` where not null; index `(delivery_id, created_at)` and `(driver_id, created_at desc)`.
- AFTER trigger `log_delivery_event` on `deliveries` (insert, update): writes `offered` (offered_driver_id newly set), `accepted` (unassigned→assigned), `arrived_pickup` / `departed` / `arrived_drop` (stamp newly set), `picked_up` (method = `pickup_method`), `delivered` (method = `delivery_method`), `failed` (reason), `cancelled`, `reassigned` (driver_id A→B, both non-null), `corrected` (correction_reason changed). Each row carries `new.last_action_id` only when it changed in this update, so a replayed action id hits the unique index and the whole update fails with `23505`.
- BEFORE UPDATE trigger `guard_delivery_transition` on `deliveries`, applied to **every** role including service_role. A "correction" is an update where `correction_reason` is distinct from the old value; corrections bypass rules 1, 4 and 5. Rules: (1) to `delivered` requires `picked_up_at` (stamps `delivered_at := coalesce(new.delivered_at, now())`); (2) to `picked_up` requires old status `assigned` and a `driver_id` (stamps `picked_up_at := coalesce(…, now())`); (3) to `failed` requires `failure_reason` and old status `assigned` or `picked_up` (stamps `failed_at`); (4) `arrived_pickup_at`, `departed_pickup_at`, `arrived_drop_at`, `picked_up_at` cannot change once set; (5) nothing leaves `delivered`, `failed` or `cancelled`. Violations raise `invalid_delivery_transition` with errcode `check_violation`.
- `platform_settings` columns `privacy_policy_url text not null default ''`, `terms_url text not null default ''` (Deligro has no published policy or terms; nothing is invented — the app links them once an admin sets them). Admin → Settings gets the two fields (`src/app/admin/settings/settings-form.tsx`, `src/lib/settings.ts` `privacyPolicyUrl`/`termsUrl`, `https://` only).
- RLS: `rider_status`, `rider_shifts`, `rider_profiles`, `delivery_events` — rider selects own rows (`driver_id = auth.uid()`), admins and managers (`public.is_admin() or public.current_role() = 'manager'`) select all; insert/update/delete revoked from anon and authenticated; service_role full.

- [ ] **Step 1: Write `scripts/qa/sql/migration-0081.mjs`.** Copy 0058's preamble; stub `profiles(id, role, full_name)`, `orders(id, status)`, `delivery_status` enum without `failed`, `deliveries` with the 0001/0008/0042/0047 columns (`id, order_id, driver_id, status, assigned_at, picked_up_at, delivered_at, driver_lat, driver_lng, driver_location_at, offered_driver_id, offered_at, cod_collected_amount, cod_collected_at`), `is_admin()`, `current_role()`. Seed two drivers, one manager, one customer before running the migration. Assertions (`ok`/`FAIL`, exit 1 on any FAIL):
  - both pre-existing drivers have `rider_profiles` with codes `DR-0001`, `DR-0002`; inserting a third driver creates `DR-0003`; a customer gets no row; changing a customer's role to `driver` creates one.
  - `unassigned → assigned → picked_up → delivered` succeeds and writes events `accepted, picked_up, delivered` in order; `picked_up_at` and `delivered_at` are stamped.
  - `assigned → delivered` raises `invalid_delivery_transition`; the same with `correction_reason = 'staff_marked_delivered'` succeeds and writes `corrected`.
  - setting `arrived_pickup_at` twice raises; `delivered → assigned` raises.
  - `picked_up → failed` without `failure_reason` raises; with it succeeds and stamps `failed_at`.
  - two updates carrying the same `last_action_id` (different stamps) → the second raises SQLSTATE `23505` and leaves the row unchanged.
  - driver_id A→B writes `reassigned`.
  - as `authenticated` driver 1: sees own `rider_status`/`delivery_events` rows only; `insert into rider_status` is denied; as manager: sees all rows; as customer: sees none.
  - one open `rider_shifts` row per rider: a second open row raises.
- [ ] **Step 2: Run it — expect FAIL** (no migration): `node scripts/qa/sql/migration-0081.mjs`.
- [ ] **Step 3: Write the migration** in house style (header with purpose, `STATUS: PENDING APPROVAL`, security notes, rollback block dropping everything added; note that an enum value cannot be dropped, so rollback leaves `failed` in place and says so).
- [ ] **Step 4: Run the proof — every line `ok`.** Also run `node scripts/qa/sql/migration-0058.mjs` (unchanged, still passes).
- [ ] **Step 5: Check existing writers against the guard.** `advanceDelivery` (`src/lib/data-access/driver-orders.ts`) must reach `picked_up` from `assigned` only; `recordCodForStaffDelivery` moves `assigned|picked_up → delivered` and must now set `correction_reason: 'staff_marked_delivered'` and `delivery_method: 'staff'`; `advanceDelivery`'s delivered update sets `delivery_method: 'code'`, its pickup update sets `pickup_method` to `'code'` when a pickup code was checked else `'none'`. Make those edits (guarded with the existing `columnKnownMissing`/`isMissingColumn` probe pattern under a new key `"deliveries.pickup_method"` so a database without 0081 keeps working). `npm run typecheck`, `npm run lint`, `npx tsx scripts/qa/driver-app.ts` pass.
- [ ] **Step 6: Update `docs/DATABASE.md`; commit** `feat(db): 0081 rider foundation — availability, shifts, rider ID, delivery audit and transition guard`.

### Task 2: Rider availability — pure rules, data layer, `/api/rider/*`

**Files:**
- Create: `src/lib/rider/availability.ts` (pure, no `server-only`, importable by tsx)
- Create: `src/lib/data-access/rider-status.ts` (`server-only`)
- Create: `src/lib/auth/rider-api.ts`
- Create: `src/app/api/rider/me/route.ts`, `src/app/api/rider/status/route.ts`, `src/app/api/rider/location/route.ts`, `src/app/api/rider/signout/route.ts`
- Modify: `src/app/auth/signout/route.ts` (driver → `forceRiderOffline` before `signOut`)
- Create: `scripts/qa/rider-availability.ts`, `scripts/qa/rider-api.ts`; Modify: `package.json` scripts `test:rider-availability`, `test:rider-api`

**Interfaces — Produces:**
```ts
// src/lib/rider/availability.ts
export const RIDER_PRESENCE_MS = 5 * 60_000;
export const BREAK_MINUTES = [15, 30, 60] as const;
export type AvailabilityAction = "online" | "offline" | "break" | "resume";
export interface RiderAvailability { isOnline: boolean; breakUntil: string | null; onlineSince: string | null; lastFixAt: string | null; }
export type AvailabilityResult =
  | { ok: true; next: RiderAvailability; shift: "open" | "close" | "none" }
  | { ok: false; error: "active_delivery" | "invalid_minutes" | "not_online" };
export function nextAvailability(current: RiderAvailability, action: AvailabilityAction,
  ctx: { hasCommitment: boolean; now: Date; minutes?: number | null }): AvailabilityResult;
export function isDispatchable(s: RiderAvailability, now: Date): boolean;
export function riderPhase(s: RiderAvailability, now: Date): "offline" | "online" | "break" | "stale";

// src/lib/data-access/rider-status.ts
export async function getRiderAvailability(driverId: string): Promise<RiderAvailability>;
export async function hasRiderCommitment(driverId: string): Promise<boolean>; // assigned|picked_up delivery, or an unanswered offer inside its window
export async function setRiderAvailability(driverId: string, action: AvailabilityAction, minutes?: number | null): Promise<AvailabilityResult>;
export async function recordRiderFix(driverId: string, lat: number, lng: number): Promise<{ ok: true; online: boolean; active: boolean } | { ok: false; error: "invalid_position" }>;
export async function forceRiderOffline(driverId: string, endedBy: "logout" | "ops" | "presence"): Promise<void>;

// src/lib/auth/rider-api.ts
export async function requireRiderApi(): Promise<{ ok: true; profile: Profile } | { ok: false; response: NextResponse }>; // 503 not_configured, 401 unauthenticated, 403 not_rider
```
Rules for `nextAvailability`: `online` from offline → opens a shift, sets `onlineSince`, clears `breakUntil`; `online` when already online is a no-op `shift: "none"`; `offline` or `break` with `hasCommitment` → `active_delivery`; `break` needs `minutes ∈ BREAK_MINUTES` or `null` (= until resumed, stored as `9999-12-31`), else `invalid_minutes`; `break`/`resume` while offline → `not_online`; `offline` closes the shift. `isDispatchable` = online, not on a break that ends after `now`, and `lastFixAt` within `RIDER_PRESENCE_MS`. `recordRiderFix` validates exactly like `reportDriverLocation` (finite, in range, within `MAX_FIX_KM` of `PINNED_LOCATION`), writes `rider_status.last_*` **only when online** (no location kept for an offline rider), and calls `reportDriverLocation` when the rider has an active delivery (its `active` result passes through).

Route contracts (all JSON, rider id from session, `requireRiderApi()` first):
- `GET /api/rider/me` → `{ id, name, phone, avatarUrl, riderCode, availability: RiderAvailability, phase, activeDeliveryId: string | null, features: Record<"driver.history"|"driver.earnings"|"driver.call_customer"|"driver.navigation"|"driver.profile_edit", boolean>, legal: { privacyUrl: string | null, termsUrl: string | null } }` (empty settings → `null`).
- `POST /api/rider/status { action, minutes? }` → `{ availability, phase }`; 400 `invalid_action`/`invalid_minutes`, 409 `active_delivery`/`not_online`; rate limit `rider-status:<id>` 20/min.
- `POST /api/rider/location { lat, lng }` → `{ ok: true, online, active }`; 400 `invalid_position`; rate limit `rider-location:<id>` 30/min.
- `POST /api/rider/signout` → `{ ok: true }` after `forceRiderOffline(id, "logout")`; rate limit 10/min. Does not end the Supabase session (the app does that).

- [ ] **Step 1: Write `scripts/qa/rider-availability.ts`** (node `assert/strict`, prints `ok` lines): online from offline opens a shift; offline with `hasCommitment` → `active_delivery`; break 45 → `invalid_minutes`; break `null` → `breakUntil` year 9999; break while offline → `not_online`; `isDispatchable` false at fix age 5 min 1 s, true at 4 min 59 s; false while `breakUntil` is in the future, true once it has passed; `riderPhase` returns `stale` for online with a 6-minute-old fix.
- [ ] **Step 2: Run** `npx tsx scripts/qa/rider-availability.ts` — FAIL (module missing).
- [ ] **Step 3: Implement `availability.ts`; run — PASS.**
- [ ] **Step 4: Write `scripts/qa/rider-api.ts`** against a dev server (`BASE`, default `http://localhost:3005`; skip with a notice when unreachable; credentials from `QA_RIDER_EMAIL`/`QA_RIDER_PASSWORD` and `QA_CUSTOMER_*` via `_env.ts`): no cookie → 401 on all four routes; a customer → 403 `not_rider`; rider: `me` has `riderCode` matching `^DR-\d{4}$`; `status {action:"dance"}` → 400; `online` → `phase` `stale` until a location is posted, then `online`; `location` while offline → `online:false` and `me.availability.lastFixAt` unchanged; `break 15` → `phase: "break"`; `resume` → `online`; `signout` → `me.availability.isOnline === false`.
- [ ] **Step 5: Implement the data layer, helper and routes**; add the driver branch to `/auth/signout`. Run the QA script with `npm run dev` up (PASS, or the documented skip when no QA credentials), `npm run typecheck`, `npm run lint`, `npm run test:idor`. Walk `docs/SECURITY_AUDIT.md` for the new routes and log it.
- [ ] **Step 6: Commit** `feat(rider): server-side online, offline and breaks with /api/rider routes`.

### Task 3: Dispatch offers only to dispatchable riders; web portal gets the switch

**Files:**
- Modify: `src/lib/dispatch/rider-dispatch.ts` (`loadCandidates`)
- Modify: `src/app/driver/actions.ts` (`setAvailabilityAction`), `src/app/driver/page.tsx` + `src/lib/data-access/driver-orders.ts` (`DriverBoardData.availability`)
- Create: `src/components/driver/availability-switch.tsx`
- Modify: `src/components/driver/driver-board.tsx` (`useLocationReporting` posts to `/api/rider/location` while online, not only while a delivery is active)
- Create: `scripts/qa/rider-dispatch-eligibility.ts`

**Interfaces:**
- Consumes: `isDispatchable`, `RiderAvailability`, `setRiderAvailability` (Task 2).
- Produces: `export function eligibleCandidates<T extends { id: string }>(riders: T[], availability: Map<string, RiderAvailability>, now: Date): T[]` in `rider-dispatch.ts`'s new pure sibling `src/lib/dispatch/eligibility.ts`; a rider with no `rider_status` row is not eligible. `loadCandidates` reads `rider_status` for the driver ids and filters through it; when `rider_status.last_fix_at` is newer than the delivery-row fix, its position is used for distance.

- [ ] **Step 1: Write `scripts/qa/rider-dispatch-eligibility.ts`:** offline rider excluded; rider with no row excluded; online with fresh fix included; online on break excluded; online with a 6-minute-old fix excluded; order of the input preserved.
- [ ] **Step 2: Run — FAIL. Step 3: Implement** `eligibility.ts` and wire it into `loadCandidates` (a database without 0081 — `rider_status` missing — keeps today's behaviour via the schema-probe pattern under key `"rider_status"`, so dispatch never goes dark before the migration is applied). **Run — PASS.**
- [ ] **Step 4: Web portal.** `setAvailabilityAction(action, minutes?)` (`requireDriver()`, rate limit `driver-availability:<id>` 20/min, calls `setRiderAvailability`, `revalidatePath("/driver")`); `AvailabilitySwitch` in the board header shows Online / Offline / On break with the 15/30/60/until-resumed menu and the `active_delivery` message "Finish or hand back your current order first."; the location hook reports every 30 s while online and idle, every 10 s on an active delivery, and stops when offline.
- [ ] **Step 5: Verify:** `npx tsx scripts/qa/rider-dispatch-eligibility.ts`, `npx tsx scripts/qa/driver-app.ts`, `npm run typecheck`, `npm run lint`, `npm run test:platform`; on `npm run dev`, sign in as the QA rider in a phone-sized browser, go online, see `phase: online` from `/api/rider/me` after the first fix; screenshot the switch in light and dark.
- [ ] **Step 6: Commit** `feat(dispatch): offer pickups only to online riders; web rider portal gets the switch`.

### Task 4: Flutter scaffold — `apps/rider`

**Files:**
- Create: `apps/rider/` by copying `apps/customer/` minus `lib/features/*` (except `shell` as a starting point), `lib/data/*`, `lib/models/*`, `lib/state/cart.dart`, `lib/state/location.dart`, `lib/core/pricing.dart`, `lib/widgets/cart_widgets.dart`, `lib/widgets/restaurant_card.dart`, `test/*`, `build/`.
- Create: `apps/rider/lib/core/i18n.dart`, `apps/rider/tool/brand.mjs` (renders `Resources/3D Icons for Food Delivery App (Community)/Electric Cycle3DIcon 10.svg` to `assets/brand/rider.png`), `apps/rider/test/boot_test.dart`
- Modify (in the copy): `pubspec.yaml` (`name: deligro_rider`, `version: 2.0.0+3`, drop `razorpay_flutter`, keep the rest), `android/app/build.gradle*` (`applicationId com.ractrotech.deligro.rider`), Kotlin package `com.ractrotech.deligro.rider`, `AndroidManifest.xml` (label `Deligro Rider`; permissions `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `WAKE_LOCK`), `lib/config/env.dart` (`x-client` becomes `deligro-rider-flutter/<versionCode>`), `lib/widgets/splash.dart` (rider art, "Deligro Rider"), `lib/main.dart` (startup failure reads "Deligro Rider couldn't start").

**Interfaces — Produces:**
```dart
// lib/core/i18n.dart
final langProvider = NotifierProvider<LangNotifier, String>(LangNotifier.new); // 'en' | 'hi', persisted in prefs key 'lang'
String tr(WidgetRef ref, String en, String hi);
```
`ApiClient` is unchanged from the customer app except the `x-client` header.

- [ ] **Step 1: Write `boot_test.dart`:** `tr` returns Hindi when `langProvider` is `'hi'`, English otherwise, and the choice survives a new `ProviderContainer` with the same prefs; `ApiClient` sends `x-client: deligro-rider-flutter/3` (mock `http.Client`); the startup-failure widget shows "Deligro Rider couldn't start" and Retry.
- [ ] **Step 2: Run** `flutter test` — FAIL. **Step 3: Implement** the scaffold.
- [ ] **Step 4:** `flutter analyze` clean, `flutter test` PASS; `flutter build apk --release --dart-define-from-file=env/prod.json`; install on `deligro_test`; cold start shows the rider splash then the login route; logcat has no `FATAL`.
- [ ] **Step 5: Commit** `feat(rider-app): Flutter scaffold for the Rider app`.

### Task 5: Sign-in and the rider gate

**Files:**
- Create: `apps/rider/lib/data/auth_repository.dart`, `apps/rider/lib/data/rider_repository.dart`, `apps/rider/lib/models/rider_me.dart`, `apps/rider/lib/features/auth/login_screen.dart`, `apps/rider/lib/features/gate/not_rider_screen.dart`
- Modify: `apps/rider/lib/router.dart`, `apps/rider/lib/state/providers.dart`
- Test: `apps/rider/test/auth_test.dart`

**Interfaces:**
- Consumes: `GET /api/rider/me` (Task 2), `/api/auth/otp/request` + `/api/auth/otp/verify` (existing; copy the customer `requestOtp`/`verifyOtp`).
- Produces:
```dart
class AuthRepository { Future<({bool devMode, String? devCode})> requestOtp(String phone); Future<void> verifyOtp(String phone, String code); Future<void> signInWithEmail(String email, String password); Future<void> signOut({bool everywhere = false}); }
class RiderRepository { Future<RiderMe> me(); Future<RiderAvailabilityDto> setStatus(String action, {int? minutes}); Future<({bool online, bool active})> postLocation(double lat, double lng); Future<void> signoutOffline(); }
class RiderMe { String id; String? name; String? phone; String? avatarUrl; String riderCode; RiderAvailabilityDto availability; String phase; String? activeDeliveryId; Map<String, bool> features; }
final meProvider = FutureProvider<RiderMe>(...);
```
Login screen: two tabs, **Phone OTP** and **Email & password** (rider accounts are created with an email and a one-time password in Admin → Settings → Employees). Mobile + password is added when the Partner app's shared `/api/auth/password-login` lands (merge that commit; do not write a second copy). Router: no session → `/login`; session and `me()` 403 `not_rider` → `/not-rider` ("This account isn't a Deligro rider. Ask Deligro ops to enable rider access." + Sign out); 401 → sign out and `/login`; otherwise `/home`.

- [ ] **Step 1: Write `auth_test.dart`:** OTP request with an invalid phone shows the server's friendly error; email sign-in with `invalid_credentials` shows "Wrong email or password." / "ईमेल या पासवर्ड गलत है।"; `me()` 403 routes to `/not-rider` and Sign out is offered; `me()` 401 signs out and routes to `/login`; login renders both tabs in light, dark and 1.3× text without overflow.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** analyze, test, release build; on the emulator sign in with the QA rider (or confirm the error states against live with a customer account); screenshots of login, OTP entry and not-rider.
- [ ] **Step 5: Commit** `feat(rider-app): sign-in with OTP or email and password, rider gate`.

### Task 6: Shell, Home availability card, More and Settings

**Files:**
- Create: `apps/rider/lib/features/shell/rider_shell.dart`, `apps/rider/lib/features/home/home_screen.dart`, `apps/rider/lib/features/home/availability_card.dart`, `apps/rider/lib/features/more/more_screen.dart`, `apps/rider/lib/features/settings/settings_screen.dart`, `apps/rider/lib/core/update_check.dart`
- Test: `apps/rider/test/shell_test.dart`

**Interfaces:**
- Consumes: `RiderRepository`, `meProvider`, `langProvider`, `GET /api/app-version?app=rider&versionCode=3` (existing).
- Produces: `RiderShell` with a bottom bar whose tabs come from a list; Phase 1 registers **Home** and **More** (Jobs, Earnings, History are added by their phases; the list order is Home · Jobs · Earnings · History · More). `availabilityProvider` (Notifier over `RiderAvailabilityDto` with `goOnline()`, `goOffline()`, `takeBreak(int? minutes)`, `resume()`).

Home (Phase 1 content; Phase 4 completes the twelve figures): rider name and rider ID, the availability card — big Online/Offline switch, phase chip (Online · On break until 3:45 pm · Offline · "Waiting for location"), break menu (15/30/60 min, until I resume), time online today from `onlineSince`. `active_delivery` → snackbar "Finish or hand back your current order first." / "पहले अपना मौजूदा ऑर्डर पूरा करें या वापस करें।". More: Settings, plus disabled rows for nothing — later phases add their own rows. Settings: Language (English / हिन्दी), Location disclosure (re-opens Task 7's screen), App version (`2.0.0 (3)` and "Check for updates" → update sheet with notes and a download link; `forceUpdate` blocks the app with that sheet), **Privacy & data** (an in-app screen in the style of the customer `/profile/privacy` page: a factual list of what the Rider app holds — phone, name and photo, location only while online, delivery records, earnings and cash records, documents — who can see each, and how long; then **Privacy policy** and **Terms** rows that open `me.legal.privacyUrl` / `termsUrl`, shown only when set), **Sign out** (confirm if `activeDeliveryId != null`: "You're carrying an order. Sign out anyway?"), **Sign out of all devices**. Both sign-outs call `signoutOffline()` first and proceed even if it fails.

- [ ] **Step 1: Write `shell_test.dart`:** tabs Home/More (Hindi labels when `'hi'`); toggling online calls `setStatus('online')` and shows the phase chip; a 409 `active_delivery` shows the bilingual snackbar and leaves the switch on; break 30 shows "On break until"; sign out with a throwing `signoutOffline` still calls `signOut`; sign out with an active delivery shows the confirm dialog; `forceUpdate: true` shows a blocking sheet; Privacy & data hides the policy/terms rows when `legal` URLs are null and shows them when set; every screen renders in light, dark and 1.3× text without exceptions.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** analyze, full test suite, release build; emulator walk: go online/offline/break, switch to Hindi and back, check for updates, sign out; logcat clean; screenshots.
- [ ] **Step 5: Commit** `feat(rider-app): shell, availability card, More and Settings`.

### Task 7: Location disclosure and the foreground location service

**Files:**
- Create: `apps/rider/lib/core/location_service.dart`, `apps/rider/lib/features/onboarding/location_disclosure_screen.dart`
- Modify: `apps/rider/lib/features/home/availability_card.dart` (going online requires the service to start)
- Test: `apps/rider/test/location_test.dart`

**Interfaces:**
- Consumes: `RiderRepository.postLocation`, `availabilityProvider`.
- Produces:
```dart
enum LocationGate { ok, needsDisclosure, denied, deniedForever, serviceOff }
class LocationService {
  Future<LocationGate> check();                 // disclosure accepted (prefs 'loc_disclosure_v1') + permission + service
  Future<void> start({required bool activeDelivery}); // geolocator stream with AndroidSettings(foregroundNotificationConfig: ...)
  Future<void> setActiveDelivery(bool active);  // 30 s idle cadence ↔ 10 s active
  Future<void> stop();
}
```
Cadence: post at most one fix per 30 s while idle, per 10 s on an active delivery, plus a heartbeat `getCurrentPosition` when the stream has been silent that long. Foreground notification: title "Deligro Rider is online" / "Deligro Rider ऑनलाइन है", text "Sharing your location with Deligro dispatch while you're online." / "ऑनलाइन रहने तक आपकी लोकेशन Deligro डिस्पैच के साथ साझा हो रही है।". The disclosure screen states what is collected (precise location), when (only while online), why (offers near you, live tracking for your customer), who sees it (Deligro dispatch; the customer only while you carry their order), and how to stop (go offline); buttons Continue / Not now. A `postLocation` answer of `online: false` stops the service (the server says the rider is offline — e.g. signed out elsewhere).

- [ ] **Step 1: Write `location_test.dart`** with a fake geolocator platform: `check()` is `needsDisclosure` before the screen is accepted; denied → going online shows "Deligro needs your location to send you orders." with **Open settings**, and `setStatus('online')` is never called; `serviceOff` → "Turn on location" prompt; with permission, `start()` posts the first fix immediately and then no more than one per 30 s for a burst of 10 readings over 20 s; `setActiveDelivery(true)` allows one per 10 s; `online: false` from the server stops the stream.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4:** analyze, tests, release build; on the emulator: accept the disclosure, go online, lock the screen, push mock locations (`adb emu geo fix 81.53 21.71` then `81.54 21.72` after 40 s) and confirm two fixes reached the server (`/api/rider/me` → `lastFixAt` advanced, or the server log); the foreground notification is visible; go offline and the notification disappears.
- [ ] **Step 5: Commit** `feat(rider-app): location disclosure and foreground location while online`.

---

## Phase exit

- All QA scripts above pass; `npm run typecheck`, `npm run lint`, `npm run test:idor`, `npm run test:platform` pass; `flutter analyze` clean and `flutter test` pass in `apps/rider`.
- Release APK installed on `deligro_test` (2 GB RAM profile): sign in, go online, share location with the screen locked, take a break, go offline, switch language, sign out.
- Short report to the owner: what shipped, screenshots, the migration awaiting their apply, and anything deferred with its phase.
