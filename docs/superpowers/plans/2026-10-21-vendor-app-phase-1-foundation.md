# Vendor App — Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The database, server and app groundwork every later phase builds on: the Preparing step and status history in the database, vendor read access to their own money, a vendor release track, a vendor API base, and a Flutter Partner app a vendor can sign in to and move around.

**Architecture:** One migration (`0061`) validated in PGlite; thin Next.js route handlers over shared server-only helpers; a new Flutter app `apps/vendor` adapted from `apps/customer` (same cookie bridge, theme, startup guard, release fixes).

**Tech Stack:** Supabase Postgres (migrations, RLS), Next.js route handlers (this repo's Next version — read `node_modules/next/dist/docs/` before writing a route), Flutter 3.47 / Riverpod 3 / go_router / supabase_flutter / onesignal_flutter (vendored copy).

**Spec:** `docs/superpowers/specs/2026-10-21-vendor-app-design.md`

## Global Constraints

- Work only in the worktree `F:\hub26\deligro-vendor`, branch `feat/vendor-app`. Never touch `F:\hub26\deligro` (another session's uncommitted work).
- Repo rules in `AGENTS.md` apply: role check + rate limit on every write route; `createAdminClient()` only under an authorization check; new `orders` columns need `grant select (col) on public.orders to authenticated`; never `select("*")` on `orders`; fail closed.
- Migrations are **not applied** to any live database. Each ships a PGlite proof in `scripts/qa/sql/` (pattern: `migration-0058.mjs`) and a rollback block in its header.
- App ID `com.ractrotech.deligro.partner`, version `2.0.0+3`, display name `Deligro Partner`.
- App look = `apps/customer/lib/theme/app_theme.dart` tokens (Inter, warm surfaces, orange accent, JetBrains Mono figures), light and dark. Bottom bar: **Home · Orders · Reports · Payments · More**.
- Every user-facing string in the app is an English/Hindi pair through `tr(en, hi)`; English by default.
- Flutter builds on this PC: env from memory note — `GRADLE_USER_HOME=F:\dev\gradle-home`, `TEMP/TMP=F:\dev\tmp`, toolchain under `F:\dev`. Release R8 keep rules for `shared_preferences` JNI (copy `apps/customer/android/app/proguard-rules.pro`). Splash/brand art as PNG/JPEG, never WebP.
- Every screen added is checked on the emulator (`deligro_test`) from the **release** APK before the task is done.

## Review Focus

1. A signed-in customer (no shop) opens the Partner app → told plainly this account doesn't run a shop, offered sign-out; never a blank or broken shell. (Task 5 test.)
2. The session expires while the app is in the background → the next API call that answers 401 sends the vendor to login, not into an error loop. (Task 5 test.)
3. A multi-shop owner whose saved shop no longer belongs to them → the server falls back to an owned shop and the app adopts the server's `activeSlug`. (Task 3 and Task 6 tests.)
4. Mobile + password for an account with no email → the route returns `no_email` and the app shows "Sign in with OTP, or ask Deligro to add an email" rather than "wrong password". (Task 3 and Task 5 tests.)
5. No network or a server outage at launch → the app shows the startup-failure screen with Retry (as the customer app does), never an endless splash. (Task 4 test.)

---

### Task 1: Migration 0061 — vendor foundation

**Files:**
- Create: `supabase/migrations/0061_vendor_app_foundation.sql`
- Create: `scripts/qa/sql/migration-0061.mjs`
- Modify: `docs/DATABASE.md` (new columns, table, policies)

**Interfaces:**
- Produces (database):
  - `orders.preparing_at timestamptz null`, `orders.prep_minutes smallint null check (prep_minutes between 1 and 180)`, both granted `select` to `authenticated`.
  - `guard_order_update()` re-created with `'preparing_at'` added to `locked`.
  - Trigger `guard_order_prep_minutes` (before update): a non-admin may change `prep_minutes` only while `old.status in ('placed','kitchen')`; else raise `prep_minutes_locked`.
  - `public.start_preparing(p_order uuid) returns timestamptz`, security definer, `grant execute … to authenticated`: requires `owns_restaurant(restaurant_id)`, `status = 'kitchen'`, `preparing_at is null`; sets `preparing_at = now()`, logs a `preparing` event, returns it; otherwise raises `invalid_transition`.
  - Table `public.order_status_events(id bigint identity pk, order_id uuid not null → orders on delete cascade, restaurant_id uuid not null, kind text not null check (kind in ('status','preparing')), from_status order_status null, to_status order_status null, actor_id uuid null, reason text null, created_at timestamptz not null default now())`, index `(order_id, created_at)`. RLS: select when `owns_restaurant(restaurant_id)` or the order's `customer_id = auth.uid()` or `is_admin()`; no write policies; `revoke insert, update, delete … from anon, authenticated`.
  - Trigger `log_order_status_event` (security definer, after insert or update of `status` on `orders`): one `status` row per change; `actor_id = auth.uid()`; `reason = new.cancellation_reason` when `to_status = 'cancelled'`.
  - Policies: `"vendor_settlements — vendor read"` (`owns_restaurant(restaurant_id) and status <> 'draft'`); `"vendor_settlement_orders — vendor read"` (its settlement is non-draft and owned); `"settlement_corrections — vendor read"` (`owns_restaurant(restaurant_id)`); `"refunds — vendor read"` (the refund's order is owned). Selects are already granted (0028, 0048, 0001); comment that vendors now see settlement `notes`.
  - `platform_settings`: `vendor_apk_version_code integer not null default 1`, `vendor_apk_min_version_code integer not null default 1`, `vendor_apk_url text not null default ''`, `vendor_apk_notes text not null default ''`, constraint `platform_settings_vendor_apk_versions` (min ≤ latest), same as the customer track in 0045.

- [ ] **Step 1: Write `scripts/qa/sql/migration-0061.mjs`** — PGlite with stubbed `auth.uid()`/roles (copy 0058's preamble, add the minimal `refunds`, `vendor_settlements`, `vendor_settlement_orders`, `settlement_corrections`, `platform_settings` tables and the `order_status` enum). Assertions, each printed `ok`/`FAIL`, exit 1 on any failure:
  - vendor A sees A's `paid` settlement and its lines; not A's `draft`; not shop B's.
  - vendor A reads refunds on A's orders (count 1), none on B's (count 0).
  - vendor A `update orders set preparing_at = now()` → error containing `only order status may be changed`.
  - `start_preparing` on A's `kitchen` order → non-null timestamp and one `preparing` event; second call → `invalid_transition`; on a `placed` order → `invalid_transition`; as vendor B on A's order → `invalid_transition`.
  - status `placed → kitchen → cancelled` with `cancellation_reason = 'Out of stock'` → two `status` events, the second with reason `Out of stock`.
  - `prep_minutes` set to 25 while `kitchen` → ok; after `ready` → `prep_minutes_locked`.
  - customer of the order reads its events; an unrelated user reads none.
  - inserting `vendor_apk_min_version_code = 5, vendor_apk_version_code = 3` → constraint error.
- [ ] **Step 2: Run it — expect FAIL** (migration file missing): `npm i --no-save @electric-sql/pglite@0.2.17 && node scripts/qa/sql/migration-0061.mjs`.
- [ ] **Step 3: Write the migration** with the objects above, a header in the house style (purpose, STATUS: PENDING APPROVAL, rollback block dropping everything it adds and restoring 0055's `guard_order_update`).
- [ ] **Step 4: Run the proof — expect every line `ok`.**
- [ ] **Step 5: Update `docs/DATABASE.md`; commit** `feat(db): 0061 vendor app foundation — preparing step, status events, vendor money read access`.

### Task 2: Vendor release track

**Files:**
- Modify: `src/lib/releases/app-version.ts` (`RELEASE_APPS = ["rider", "customer", "vendor"]`, settings lookup for vendor)
- Modify: `src/types/index.ts`, `src/lib/settings-defaults.ts`, `src/lib/data-access/settings.ts` (map `vendor_apk_*` ↔ `vendorApkVersionCode`, `vendorApkMinVersionCode`, `vendorApkUrl`, `vendorApkNotes`, mirroring the customer fields)
- Modify: `src/app/admin/settings/settings-form.tsx`, `src/app/admin/settings/actions.ts` (a "Partner app" block identical to the customer one, `safeApkUrl` on write)
- Modify: `src/app/api/app-version/route.ts` doc comment (`app=rider|customer|vendor`)
- Test: `scripts/qa/app-version.ts`

**Interfaces:**
- Produces: `GET /api/app-version?app=vendor&versionCode=<int>` → `AppVersionAnswer` from the vendor fields.

- [ ] **Step 1: Add cases to `scripts/qa/app-version.ts`:** `parseReleaseApp("vendor") === "vendor"`; `appVersionAnswer(settings{vendorApkVersionCode:4, vendorApkMinVersionCode:3, vendorApkUrl:"https://x/p.apk"}, "vendor", 2)` → `{updateAvailable:true, forceUpdate:true, latestVersionCode:4}`; with versionCode 4 → both false; the vendor answer never reads the customer fields (customer 9 / vendor 4 → latest 4).
- [ ] **Step 2: Run** `npx tsx scripts/qa/app-version.ts` — expect FAIL on the new cases.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run the QA script (PASS), `npm run typecheck`, `npm run lint`.**
- [ ] **Step 5: Commit** `feat(releases): vendor (Partner) app release track`.

### Task 3: Vendor API base — `/api/vendor/me` and password login

**Files:**
- Create: `src/lib/auth/vendor-api.server.ts`
- Create: `src/lib/auth/password-login.server.ts`
- Modify: `src/app/(portal-auth)/actions.ts` (`signInWithMobileAction` uses the shared helper; behaviour unchanged)
- Create: `src/app/api/vendor/me/route.ts`
- Create: `src/app/api/auth/password-login/route.ts`
- Test: `scripts/qa/vendor-api.ts`

**Interfaces:**
- Produces:
  - `vendorApiContext(): Promise<{ profile: Profile; restaurant: OwnedRestaurant; shops: OwnedRestaurant[] } | Response>` — 503 `not_configured`, 401 `unauthenticated` (no session), 403 `forbidden` (`hasVendorAccess` false), 404 `no_restaurant`. Later vendor routes start with it.
  - `resolvePasswordLoginEmail(e164: string): Promise<{ ok: true; email: string } | { ok: false; error: "bad_credentials" | "no_email" }>` (service role; the lookup `signInWithMobileAction` does today).
  - `GET /api/vendor/me` → `{ profile: { id, fullName, phone, role }, shops: [{ id, slug, name, isOpen }], activeSlug: string, features: Record<FeatureKey, boolean> }` — features are the `vendor` entries of `featuresFor("vendor")` resolved with `vendorFeatureOn`.
  - `POST /api/auth/password-login` body `{ mobile: string, password: string }` → 200 `{ accessToken, refreshToken }`; 400 `bad_request`; 401 `bad_credentials`; 409 `no_email`; 429 via `tooManyRequests`. Buckets `pw-login-ip:${clientIp}` and `pw-login-phone:${e164}`, same limits and window as the action. Signs in with a non-persisting `@supabase/supabase-js` client so no cookie is set.
- Consumes: `hasVendorAccess`, `resolveVendorRestaurant`, `listOwnedRestaurants`, `rateLimit`, `clientIp`, `tooManyRequests`, `toE164`.

- [ ] **Step 1: Write `scripts/qa/vendor-api.ts`** against a running dev server (`BASE` env, default `http://localhost:3005`), skipping with a notice when unreachable: `GET /api/vendor/me` without a cookie → 401 `unauthenticated`; `POST /api/auth/password-login {}` → 400 `bad_request`; `{mobile:"9999900000",password:"x"}` → 401 `bad_credentials` (no such account); 11 rapid bad attempts on one number → a 429. With `QA_VENDOR_*` credentials present: login → tokens; `GET /api/vendor/me` with the rebuilt cookie → `shops.length ≥ 1` and `activeSlug ∈ shops`; with cookie `vendor_restaurant_slug=not-mine` → `activeSlug` is still an owned shop.
- [ ] **Step 2: Run** `npx tsx scripts/qa/vendor-api.ts` with `npm run dev` up — expect FAIL (404s).
- [ ] **Step 3: Implement** the helpers and routes; refactor the action onto `resolvePasswordLoginEmail` and delete its inline copy.
- [ ] **Step 4: Run the QA script (PASS), `npm run typecheck`, `npm run lint`; walk `docs/SECURITY_AUDIT.md` for an auth-path change and log it.**
- [ ] **Step 5: Commit** `feat(api): vendor API base and password login for native apps`.

### Task 4: Flutter app scaffold — `apps/vendor`

**Files:**
- Create: `apps/vendor/` via `flutter create --org com.ractrotech.deligro --project-name deligro_partner --platforms android,ios apps/vendor`, then set `applicationId`/`namespace` `com.ractrotech.deligro.partner` and Kotlin package to match.
- Copy and adapt from `apps/customer`: `lib/core/{api,errors,format,session_cookie}.dart`, `lib/theme/app_theme.dart`, `lib/widgets/splash.dart`, `assets/brand/*`, `android/app/proguard-rules.pro`, `android/app/build.gradle.kts` (signing via `key.properties`), `android/gradle.properties`, `env/example.json`, `.gitignore`, `README.md`.
- Create: `lib/config/env.dart` (`versionCode = 3`, `releaseApp = 'vendor'`), `lib/core/i18n.dart`, `lib/main.dart`, `lib/app.dart`
- Modify: `pubspec.yaml` (deps as customer minus maps/razorpay; `onesignal_flutter` override `path: ../customer/third_party/onesignal_flutter`; add `flutter_localizations`)
- Test: `apps/vendor/test/boot_test.dart`

**Interfaces:**
- Produces:
  - `ApiClient(GoTrueClient auth, {http.Client? client, String? Function()? shopSlug})` — when `shopSlug()` is non-null, appends `vendor_restaurant_slug=<slug>` to the cookie header; `x-client: deligro-partner-flutter/<versionCode>`. Otherwise identical to the customer's.
  - `String tr(WidgetRef ref, String en, String hi)` and `langProvider` (`Notifier<String>`, `'en' | 'hi'`, persisted in prefs key `partner-lang`, default `'en'`).
  - `main()` with the customer's startup guard (`_StartupFailed` + Retry) and the website splash overlay.
- [ ] **Step 1: Write `boot_test.dart`:** `tr` returns the Hindi string when `langProvider` is `'hi'`, English otherwise; `ApiClient` with `shopSlug: () => 'spice-hub'` sends a cookie header containing `vendor_restaurant_slug=spice-hub` (mock `http.Client` capturing headers); the startup-failure widget shows "Deligro Partner couldn't start" and a Retry button.
- [ ] **Step 2: Run** `flutter test` — FAIL.
- [ ] **Step 3: Implement** the scaffold.
- [ ] **Step 4: `flutter analyze` clean, `flutter test` PASS; `flutter build apk --release --dart-define-from-file=env/prod.json`; install on the emulator; cold start shows the splash then the login route without errors in logcat.**
- [ ] **Step 5: Commit** `feat(partner-app): Flutter scaffold for the vendor app`.

### Task 5: Sign-in and the vendor gate

**Files:**
- Create: `lib/data/auth_repository.dart`, `lib/data/vendor_repository.dart`, `lib/models/vendor_me.dart`, `lib/state/providers.dart`, `lib/state/session.dart`, `lib/features/auth/login_screen.dart`, `lib/features/auth/no_shop_screen.dart`, `lib/router.dart`
- Test: `test/auth_test.dart`, `test/login_screen_test.dart`

**Interfaces:**
- Consumes: `ApiClient` (Task 4); `POST /api/auth/otp/request`, `POST /api/auth/otp/verify`, `POST /api/auth/password-login`, `GET /api/vendor/me` (Task 3).
- Produces:
  - `AuthRepository`: `requestOtp(String phone)`, `verifyOtp(String phone, String code)` (→ `auth.verifyOtp(tokenHash:…, type: OtpType.email)`), `passwordLogin(String mobile, String password)` (→ `auth.setSession(refreshToken)`), `emailLogin(String email, String password)`, `signOut()`.
  - `VendorMe { profile, List<Shop> shops, String activeSlug, Map<String,bool> features }`, `Shop { id, slug, name, isOpen }`; `VendorRepository.me()`.
  - `vendorMeProvider` (`AsyncNotifier<VendorMe?>`), `activeShopSlugProvider` (persisted, key `partner-shop`).
  - Router: unauthenticated → `/login`; authenticated and `me` 403/404 → `/no-shop`; else `/`. Any `ApiException.unauthorized` from a provider → sign out → `/login`.
- [ ] **Step 1: Write tests:** `passwordLogin` maps 409 `no_email` to the message "This account has no email, so it can't use a password. Sign in with OTP, or ask Deligro to add one."; 401 → "Wrong mobile number or password."; `me()` 403 routes to `/no-shop` and that screen offers "Sign out"; a 401 from `me()` signs out and routes to `/login`; the login screen renders the OTP tab and the password tab in light, dark and 1.3× text without overflow.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: analyze, test, release build; on the emulator sign in with a test vendor (or confirm the error states against live with a non-vendor) — screenshots of login, OTP entry and no-shop.**
- [ ] **Step 5: Commit** `feat(partner-app): sign-in with OTP or password, vendor gate`.

### Task 6: Shell, shop picker, More, settings and update check

**Files:**
- Create: `lib/features/shell/shell.dart`, `lib/features/shell/shop_switcher.dart`, `lib/features/more/more_screen.dart`, `lib/features/more/settings_screen.dart`, `lib/features/shell/section_placeholder.dart`, `lib/core/update_check.dart`, `lib/core/push.dart`
- Test: `test/shell_test.dart`

**Interfaces:**
- Consumes: `vendorMeProvider`, `activeShopSlugProvider`, `tr`, `/api/app-version?app=vendor`.
- Produces:
  - Routes `/` (Home), `/orders`, `/reports`, `/payments`, `/more`, `/more/settings`; a `StatefulShellRoute` with the five-tab bar.
  - `ShopSwitcher` in the Home app bar when `shops.length > 1`; choosing a shop sets `activeShopSlugProvider` and refreshes `vendorMeProvider`; if `me.activeSlug` differs from the saved slug, the saved slug is replaced by `me.activeSlug`.
  - More lists, in this order: Store, Products & inventory, Offers, Marketing requests, Customer reviews, Invoices & receipts, Help & support, Notifications, Settings. Entries whose phase hasn't landed open `SectionPlaceholder` naming the section (removed as each phase lands).
  - Settings: language (English / हिन्दी), theme (system / light / dark), app version, sign out.
  - `PushService.start()` — OneSignal `login(uid)` and `POST /api/notifications/register`, as the customer app (ring handling arrives in Phase 2).
- [ ] **Step 1: Write `shell_test.dart`:** five tabs with labels Home/Orders/Reports/Payments/More (and हिन्दी labels when `'hi'`); a two-shop `me` shows the switcher and selecting the second updates the provider; a saved slug not in `shops` is replaced by `activeSlug`; More lists the nine entries in order; every tab renders in light, dark and 1.3× text without exceptions.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: analyze, full test suite, release build; emulator walk through every tab, More, Settings (switch to Hindi and back); logcat clean.**
- [ ] **Step 5: Commit** `feat(partner-app): shell, shop switcher, More and settings`.

---

**Phase exit:** all six tasks committed; `npm run typecheck`, `npm run lint`, QA scripts, PGlite proof and Flutter tests green; a release APK at `apps/vendor/build/app/outputs/flutter-apk/app-release.apk`; a short report to the owner listing what to apply (migration 0061) before Phase 2 can be tested against live data.
