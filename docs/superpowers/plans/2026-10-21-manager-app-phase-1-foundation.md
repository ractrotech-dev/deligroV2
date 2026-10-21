# Manager App — Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The groundwork every later phase stands on: cities, zones and zone-scoped manager access in the database; an append-only ops audit log; manager permissions with safe defaults; a manager release track; the manager API base; admin screens to set zones; and a Flutter Deligro Manager app a manager can sign in to, move around, and see their profile, permissions, activity and sessions in.

**Architecture:** One migration (`0141`) proven in PGlite; pure TypeScript helpers for scope and feature resolution (tested offline); thin Next.js route handlers under `/api/manager/*` opening with `managerApiContext()`; admin console screens in the existing kit; a new Flutter app `apps/manager` adapted from `apps/customer`.

**Tech Stack:** Supabase Postgres (RLS, security-definer functions), Next.js route handlers (this repo's Next — read `node_modules/next/dist/docs/` first), Flutter 3.47 / Riverpod 3 / go_router / supabase_flutter / onesignal_flutter (vendored copy from `apps/customer/third_party`).

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md`

## Global Constraints

- Work only in `F:\hub26\deligro-manager`, branch `feat/manager-app`. Never touch `F:\hub26\deligro`, `F:\hub26\deligro-rider`, `F:\hub26\deligro-vendor` (reading their files to copy config is fine). Dependencies install with `pnpm install --frozen-lockfile` (npm's lock is stale).
- `AGENTS.md` rules: role check + rate limit on every write route; `createAdminClient()` only under an authorization check; new `orders`/`restaurants` columns need per-column `grant select`; never `select("*")` on `orders`; fail closed.
- Migrations in this branch: `0141`–`0199`. **Not applied** anywhere; each ships `scripts/qa/sql/migration-NNNN.mjs` (pattern `migration-0061.mjs`) and a rollback block.
- App ID `com.ractrotech.deligro.manager`, version `2.0.0+2`, display name `Deligro Manager`, `x-client: deligro-manager-flutter/2`.
- App look = `apps/customer/lib/theme/app_theme.dart` tokens, light and dark. Bottom bar **Home · Orders · Live · Finance · More**.
- English only — no Hindi (owner). Every user-facing string is plain English: no `tr()`, no language setting, no `manager-lang` key (superseded 2026-10-21; the app removes the old key at start-up).
- Flutter builds: `GRADLE_USER_HOME=F:\dev\gradle-home`, `TEMP/TMP=F:\dev\tmp`, `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=F:\dev\tmp`, toolchain `F:\dev\flutter`. Copy `proguard-rules.pro` (shared_preferences JNI keep rules). Brand art PNG/JPEG only, never WebP. Smoke-test the **release** APK on AVD `deligro_test`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A manager with **no zones** assigned → every scoped read returns nothing and `/api/manager/me` says `zones: []`; the app shows "No zones assigned — ask an admin" on Home, never all of the city. (Task 1 PGlite + Task 4 QA.)
2. The `role_feature_flags` read fails (table missing / network) → default-off powers (`manager.finance.approve_payment` …) read **off**, default-on read on. Never all-on. (Task 2 QA.)
3. Someone tries to edit or delete an audit row — as a manager, as an admin, as service role → refused every time; a replayed `client_action_id` returns the original row rather than a duplicate. (Task 1 PGlite.)
4. A customer or rider signs in to the Manager app (password, OTP or email) → told this account isn't a manager, offered sign-out; never a broken shell. A 401 from any call → back to login. (Task 7 tests.)
5. Signing out "this other device" ends only that session; "sign out everywhere" also ends this one and lands on login. (Task 1 PGlite for the RPC, Task 8 test for the app flow.)

---

### Task 1: Migration 0141 — zones, scope, audit, sessions, manager track

**Files:**
- Create: `supabase/migrations/0141_manager_foundation.sql`, `scripts/qa/sql/migration-0141.mjs`
- Modify: `docs/DATABASE.md`

**Interfaces — Produces (database):**
- `cities(id uuid pk, name text not null, slug text unique not null, is_active bool default true, created_at)`; `delivery_zones(id uuid pk, city_id → cities, name, slug, center_lat/center_lng double, radius_km numeric(5,1), polygon jsonb null, is_active bool default true, is_default bool default false, created_at, unique(city_id, slug))`, partial unique index on `is_default where is_default`. Seed city `Bemetara`/`bemetara`, zone `Bemetara`/`bemetara`, centre `21.7157, 81.5335` (`src/lib/location/pinned.ts`), radius from `platform_settings.delivery_radius_km` (fallback 8), `is_default = true`.
- `public.default_zone_id() returns uuid` (stable).
- `staff_zones(user_id → profiles on delete cascade, zone_id → delivery_zones on delete cascade, assigned_by uuid, created_at, pk(user_id, zone_id))`; seeded with every `profiles.role = 'manager'` × Bemetara.
- `restaurants.zone_id uuid not null references delivery_zones` (backfilled to default; `before insert` trigger fills null with `default_zone_id()`); `grant select (zone_id) on restaurants to authenticated`.
- `orders.zone_id uuid references delivery_zones`, backfilled from the restaurant; `before insert` trigger `stamp_order_zone` always sets it from the restaurant (falls back to default zone); `zone_id` added to `guard_order_update()`'s locked list (re-created from 0061's body); `grant select (zone_id) on orders to authenticated`; index `(zone_id, created_at desc)`.
- `cod_handovers.zone_id`, `operational_expenses.zone_id` (backfilled default; insert trigger: given value, else the recorder's only zone, else default).
- `public.manager_can_see_zone(zid uuid) returns boolean` — security definer: `is_admin()` or (caller role `manager` and a `staff_zones` row for (auth.uid(), zid)). `public.manager_can_see_order(oid uuid)` — same via the order's `zone_id`.
- 0023 policies replaced: `"orders — manager read"`/`"orders — manager update"` use `manager_can_see_zone(zone_id)`; `"order_items — manager read"` and `"deliveries — manager read"`/`"deliveries — manager manage"` use `manager_can_see_order(order_id)`; `"cod_handovers — staff read"` and `"operational_expenses — staff read"` become `is_admin() or manager_can_see_zone(zone_id)`. Profiles manager read unchanged (*Claude's call*: managers need rider and customer names across zones until Phase 7 narrows customer data).
- RLS: `cities`, `delivery_zones` select for admins and managers; `staff_zones` select own rows or admin; no write policies; `revoke insert, update, delete … from anon, authenticated`.
- `ops_audit_log(id bigint identity pk, actor_id uuid not null, actor_role text not null, action text not null, entity_type text not null, entity_id text, zone_id uuid, reason text, before jsonb, after jsonb, client_action_id text unique, created_at timestamptz default now())`, indexes `(actor_id, created_at desc)`, `(zone_id, created_at desc)`, `(entity_type, entity_id)`. Trigger `ops_audit_log_immutable` (before update or delete, row; and before truncate, statement) raises `ops_audit_log is append-only` for every role. RLS select: `is_admin() or actor_id = auth.uid()`; all writes revoked from anon/authenticated.
- `public.log_ops_action(p_actor uuid, p_action text, p_entity_type text, p_entity_id text, p_zone uuid, p_reason text, p_before jsonb, p_after jsonb, p_client_action_id text) returns bigint` — security definer. Service role: trusts `p_actor` (must exist in profiles). Authenticated: `p_actor` must equal `auth.uid()` and the caller must be manager or admin, else `forbidden`. `actor_role` read from profiles. Existing `client_action_id` → returns that row's id. Execute granted to authenticated, service_role only.
- `notification_preferences(user_id → profiles cascade, kind text, push bool not null default true, updated_at, pk(user_id, kind))`, RLS select own, writes service role only.
- `public.my_sessions() returns table(id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, ip text, is_current boolean)` and `public.revoke_my_session(p_id uuid) returns boolean` — security definer over `auth.sessions` filtered to `auth.uid()`; `is_current` = `id = (auth.jwt() ->> 'session_id')::uuid`; revoking the current session is refused (`use_sign_out`). Execute: authenticated only.
- `platform_settings.manager_apk_version_code int default 1`, `manager_apk_min_version_code int default 1`, `manager_apk_url text default ''`, `manager_apk_notes text default ''`, constraint `platform_settings_manager_apk_versions`.

- [ ] **Step 1: Write `migration-0141.mjs`** — preamble from 0061 (stubbed auth, roles), plus `restaurants`, `orders` with 0061's guard, `order_items`, `deliveries`, `cod_handovers`, `operational_expenses`, `platform_settings(delivery_radius_km)`, `auth.sessions`, 0023's policies. Assertions:
  - seeded: one default zone `bemetara` with radius = settings value; existing manager M1 in `staff_zones`; existing restaurant and order have `zone_id`.
  - a second zone Z2 with restaurant R2 and order O2: manager M1 (Bemetara only) reads O1 not O2, items/deliveries likewise; manager M3 with **no zones** reads no orders, no deliveries, no cash rows; admin reads both.
  - M1 cannot update O2's status (0 rows); can update O1's status.
  - a customer inserting an order with `zone_id = Z2` for a Bemetara restaurant → stored zone is Bemetara; vendor/manager updating `zone_id` → `only order status may be changed`.
  - new restaurant inserted without zone → default zone.
  - `log_ops_action` as M1 for itself → id; as M1 claiming another actor → `forbidden`; as a customer → `forbidden`; same `client_action_id` twice → same id, one row; update / delete as admin and as service_role → `append-only`; M1 reads own rows only; admin reads all; anon cannot execute.
  - `my_sessions()` as user U returns U's two sessions with exactly one `is_current`; `revoke_my_session(other)` → true and the row is gone; on the current → `use_sign_out`; on another user's session → false, row intact.
  - manager apk constraint (min 5, latest 3) refused.
  - migration applies twice; policies still hold.
- [ ] **Step 2: Run** `node scripts/qa/sql/migration-0141.mjs` — FAIL (file missing).
- [ ] **Step 3: Write the migration** in house style (header: purpose, STATUS: PENDING APPROVAL, security changes, rollback block).
- [ ] **Step 4: Run the proof — every line `ok`.**
- [ ] **Step 5: Update `docs/DATABASE.md`; commit** `feat(db): 0141 manager foundation — zones, zone-scoped access, ops audit log, sessions`.

### Task 2: Manager permissions with safe defaults

**Files:**
- Modify: `src/lib/features/catalog.ts`, `src/lib/features/resolve.ts`, `src/lib/features/flags.server.ts`, `src/app/developer/features/feature-access-panel.tsx`, `scripts/qa/role-features.ts`

**Interfaces — Produces:**
- `FeatureDef.defaultOn?: boolean` (absent = true). Manager keys exactly as the design's permission table, existing five kept; key format `role.name` or `role.area.name`.
- `defaults(): FeatureMap` (each feature's `defaultOn ?? true`); `allOn()` kept for admins.
- `resolveFeatures` starts from `defaults()`; no deciding row → default.
- `getFeatures`: no rows / read error / table missing → `defaults()` (so default-off powers fail closed).
- `managerFeaturesFor(profile): Promise<FeatureMap>` — admin → `allOn()`.
- The developer panel shows "Default: off" on default-off features and treats "inherit" as the default, not ON.

- [ ] **Step 1: Extend `role-features.ts`:** key format allows two dots; every design key exists; `manager.finance.approve_payment` off with no rows; on with a per-person ON row; `manager.orders.view` on with no rows; role-wide ON beats default-off; per-person OFF beats role-wide ON; existing assertions still hold (vendor/driver unaffected).
- [ ] **Step 2: Run** `npx tsx scripts/qa/role-features.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: QA PASS, `npm run typecheck`, `npm run lint`.**
- [ ] **Step 5: Commit** `feat(features): manager permissions with default-off sensitive powers`.

### Task 3: Manager release track

**Files:** as vendor commit `0c545c7`: `src/lib/releases/app-version.ts` (`RELEASE_APPS` += `"manager"`, `trackFor` case), `src/types/index.ts`, `src/lib/settings-defaults.ts`, `src/lib/data-access/settings.ts` (`manager_apk_*` ↔ `managerApk*`), `src/app/admin/settings/settings-form.tsx`, `src/app/admin/settings/actions.ts`, `src/app/api/app-version/route.ts` comment; Test: `scripts/qa/app-version.ts`.

- [ ] **Step 1: QA cases:** `parseReleaseApp("manager")`; manager track 4/3 → versionCode 2 force-updates, 4 doesn't; manager answer never reads vendor fields.
- [ ] **Step 2: Run** `npx tsx scripts/qa/app-version.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: QA PASS, typecheck, lint.**
- [ ] **Step 5: Commit** `feat(releases): Manager app release track`.

### Task 4: Manager API base

**Files:**
- Create: `src/lib/auth/manager-scope.ts` (pure), `src/lib/auth/manager-api.server.ts`, `src/lib/data-access/zones.ts`, `src/lib/data-access/ops-audit.ts`, `src/lib/ops-alerts/kinds.ts`
- Create routes: `src/app/api/manager/me/route.ts`, `…/activity/route.ts`, `…/sessions/route.ts`, `…/password/route.ts`, `…/notification-prefs/route.ts`
- Test: `scripts/qa/manager-scope.ts` (pure), `scripts/qa/manager-api.ts` (server; skips when unreachable)

**Interfaces — Produces:**
- `type ManagerScope = { all: true } | { all: false; zoneIds: string[] }`; `scopeAllows(scope, zoneId: string | null): boolean` (null zone → only `all`); `applyZoneScope<Q extends { in(col: string, v: string[]): Q }>(q: Q, scope, column = "zone_id"): Q` — `all` → unchanged; empty zoneIds → `in(column, ["00000000-0000-0000-0000-000000000000"])` (matches nothing).
- `managerApiContext(permission?: FeatureKey): Promise<{ profile: Profile; scope: ManagerScope; permissions: FeatureMap } | Response>` — 503 `not_configured`, 401 `unauthenticated`, 403 `forbidden`, 403 `permission_denied` `{permission}`. Zones read from `staff_zones` with the service role; a read error → `zoneIds: []` (fail closed).
- `listManagerZones(userId)`, `listAllZones()` → `{ cities: [{ id, name, zones: [{ id, name, slug, isDefault }] }] }`.
- `logOpsAction(input: { actorId; action; entityType; entityId?; zoneId?; reason?; before?; after?; clientActionId? }): Promise<number>` (service role RPC); `listActivity(actorId, { page, pageSize })`.
- `OPS_ALERT_KINDS` (the design's 16 kinds) with en/hi labels.
- Routes:
  - `GET /api/manager/me` → `{ profile: { id, fullName, phone, email, role }, zones: { all: bool, cities: [...] }, permissions: Record<key, bool> }`.
  - `GET /api/manager/activity?page=1&pageSize=50` → `{ items: [{ id, action, entityType, entityId, reason, createdAt }], page, hasMore }`.
  - `GET /api/manager/sessions` → `{ sessions: [{ id, createdAt, lastSeenAt, userAgent, ip, current }] }`; `DELETE /api/manager/sessions` `{ id }` → `revoke_my_session`; `{ all: true }` → `auth.signOut({ scope: "global" })` with the cookie client. Rate-limited, audited (`session.revoke`, `session.revoke_all`).
  - `POST /api/manager/password` `{ current, next }` → verifies `current` with a non-persisting client, sets `next` (min 8 chars) via admin API; 400 `weak_password`, 401 `bad_credentials`; rate-limited `mgr-pw:${id}`; audited `password.change`.
  - `GET /api/manager/notification-prefs` → `{ prefs: { [kind]: boolean } }` (missing = true); `PUT` `{ kind, push }` with kind ∈ `OPS_ALERT_KINDS`; rate-limited.

- [ ] **Step 1: Write `manager-scope.ts` QA** (scope rules above incl. empty-zone sentinel) and `manager-api.ts` (no cookie → 401 on all five routes; garbage body → 400 on password; with `QA_MANAGER_MOBILE/QA_PASSWORD`: me has `permissions` with every manager key; non-manager `QA_VENDOR_*` → 403 `forbidden`).
- [ ] **Step 2: Run both** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: QA PASS (server half against `npm run dev`; record skip if no credentials), typecheck, lint; walk `docs/SECURITY_AUDIT.md` (auth path) and log it.**
- [ ] **Step 5: Commit** `feat(api): manager API base — scope, me, activity, sessions, password, notification prefs`.

### Task 5: Admin — zones and manager zone assignment

**Files:**
- Create: `src/app/admin/settings/zones/page.tsx`, `…/zones/zones-manager.tsx`, `…/zones/actions.ts`
- Modify: `src/components/admin/admin-nav.ts` (Zones under System), `src/app/admin/settings/page.tsx` (`MENU_DESC`), `src/app/admin/settings/employees/{page.tsx,employees-manager.tsx,actions.ts}`, `src/lib/data-access/employees.ts` (zones per manager; fix the "full admin access" copy → "scoped to their zones and permissions")
- Test: `npm run test:platform`, `scripts/qa/manager-scope.ts` (validation helpers)

**Interfaces — Produces:** server actions (each `requireRole("admin")`, rate-limited, audited): `createCityAction({ name })`, `createZoneAction({ cityId, name, centerLat, centerLng, radiusKm })`, `updateZoneAction({ id, name?, centerLat?, centerLng?, radiusKm?, isActive? })`, `setManagerZonesAction({ managerId, zoneIds })` (replaces the set; refuses a non-manager). Pure `validateZoneInput(input) → { ok } | { ok: false, error }` (lat −90..90, lng −180..180, radius 0.5–50, name 2–60 chars).

- [ ] **Step 1: Add `validateZoneInput` cases to `manager-scope.ts` QA** — FAIL.
- [ ] **Step 2: Implement** page (console kit: `PageHeader`, `Section`, `DataTable`, tokens only, `@container` sizes), actions, team zone picker.
- [ ] **Step 3: QA PASS, `npm run test:platform`, typecheck, lint.**
- [ ] **Step 4: Commit** `feat(admin): cities, zones and manager zone assignment`.

### Task 6: Flutter scaffold — `apps/manager`

**Files:**
- Create via `flutter create --org com.ractrotech.deligro --project-name deligro_manager --platforms android apps/manager`; set `applicationId`/`namespace` `com.ractrotech.deligro.manager`, label `Deligro Manager`.
- Copy/adapt from `apps/customer`: `lib/core/{api,errors,format,session_cookie}.dart`, `lib/theme/app_theme.dart`, `lib/widgets/{splash,common}.dart` (only what is used), `assets/brand/*` (PNG/JPEG), `android/app/proguard-rules.pro`, `android/app/build.gradle.kts`, `android/gradle.properties`, `env/example.json`, `.gitignore`, `analysis_options.yaml`, `third_party` path override → `../customer/third_party/onesignal_flutter`.
- Create: `lib/config/env.dart` (`versionCode = 2`, `releaseApp = 'manager'`), `lib/core/i18n.dart`, `lib/state/prefs.dart` (theme, lang), `lib/main.dart`, `lib/app.dart`, `README.md`
- Test: `apps/manager/test/boot_test.dart`

**Interfaces — Produces:** `tr(WidgetRef ref, String en, String hi)`, `langProvider` (`'en'|'hi'`, key `manager-lang`); `ApiClient` identical to the customer's except `x-client: deligro-manager-flutter/<versionCode>`; startup guard titled "Deligro Manager couldn't start".

- [ ] **Step 1: `boot_test.dart`:** `tr` switches with `langProvider`; `ApiClient` sends `x-client: deligro-manager-flutter/2` (mock client); startup-failure widget shows its title and Retry.
- [ ] **Step 2: `flutter test` FAIL. Step 3: implement. Step 4: `flutter analyze` clean, tests PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): Flutter scaffold for the Manager app`.

### Task 7: Sign-in and the manager gate

**Files:** `lib/data/auth_repository.dart`, `lib/data/manager_repository.dart`, `lib/models/manager_me.dart`, `lib/state/providers.dart`, `lib/features/auth/login_screen.dart`, `lib/features/auth/not_manager_screen.dart`, `lib/router.dart`; Test: `test/auth_test.dart`, `test/login_screen_test.dart`

**Interfaces — Produces:**
- `AuthRepository`: `requestOtp`, `verifyOtp`, `passwordLogin(mobile, password)` (→ `auth.setSession(refreshToken)`), `emailLogin(email, password)`, `signOut()`.
- `ManagerMe { profile(id, fullName, phone, email, role), ZoneSet zones(all, cities[zones]), Map<String,bool> permissions; bool can(String key) }`; `ManagerRepository.me()`.
- `managerMeProvider` (`AsyncNotifier<ManagerMe?>`). Router: signed-out → `/login`; `me` 403 `forbidden` → `/not-manager`; else shell. Any `ApiException.unauthorized` → sign out → `/login`.
- Login: tabs **Mobile & password** (default), **OTP**, **Email**; errors via `friendlyError` (`bad_credentials` → "Wrong mobile number or password.").

- [ ] **Step 1: Tests:** `ManagerMe.fromJson` parses the route's shape and `can()`; `can` is false for unknown keys; login screen shows three tabs and validates a 10-digit mobile before calling the repo (fake repo); 403 `forbidden` routes to the not-manager screen with a Sign out button; 401 sends to login.
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: analyze clean, tests PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): sign-in and manager gate`.

### Task 8: Shell, More, Profile & permissions, Settings, updates, push

**Files:** `lib/features/shell/manager_shell.dart` (bottom bar), `lib/features/shell/phase_placeholder.dart`, `lib/features/more/more_screen.dart`, `lib/features/profile/{profile_screen,permissions_screen,activity_screen,sessions_screen,password_screen,notification_prefs_screen}.dart`, `lib/features/settings/settings_screen.dart`, `lib/core/push.dart`, `lib/core/updates.dart`, `lib/data/manager_repository.dart` (activity, sessions, password, prefs, appVersion, registerPush); Test: `test/shell_test.dart`, `test/profile_test.dart`

**Interfaces — Produces:**
- Tabs: Home (Phase 2 placeholder, but shows the zone picker header and "No zones assigned — ask an admin" when `zones` is empty and not `all`), Orders (Phase 3), Live (Phase 3), Finance (Phase 6; hidden entirely without `manager.finance.view`).
- `MoreItem { key, en, hi, icon, route, permission?, phase }`; `moreItemsFor(ManagerMe)` filters by permission. Rows whose phase is not built yet open the labelled placeholder.
- Profile: name, phone, email, role, zones by city, link rows to Permissions (every manager key with on/off and the catalog's English label), Activity (paged, pull to refresh), Sessions (list, "This device" marked, sign out one, sign out everywhere → login), Change password, Notifications (one switch per alert kind).
- Settings: language, theme (system/light/dark), version + "Check for updates" (`/api/app-version?app=manager`), Sign out.
- Push: OneSignal `external_id = profile id`, register with `/api/notifications/register`; taps open only in-app paths starting with `/`.

- [ ] **Step 1: Tests:** finance tab absent without `manager.finance.view`; `moreItemsFor` hides gated rows; placeholder names its phase; sessions screen marks current and calls revoke with the other id; "sign out everywhere" ends on login; permissions screen lists every key from `me.permissions`; no-zones banner shows.
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: analyze clean, tests PASS.**
- [ ] **Step 5: Commit** `feat(manager-app): shell, More, profile & permissions, sessions, settings`.

### Task 9: Release build and emulator check

**Files:** `apps/manager/README.md`, `mobile/roles.json` (manager entry note: the Flutter app supersedes the Capacitor shell from versionCode 2), `apps/manager/env/prod.json` (gitignored; from the Partner app's env).

- [ ] **Step 1:** `flutter build apk --release --dart-define-from-file=env/prod.json` with the F:\dev env.
- [ ] **Step 2:** install on `deligro_test`; cold start → splash → login; switch tabs on the login screen; `adb logcat` shows no `FATAL`/`E/flutter`; screenshot saved under the scratchpad.
- [ ] **Step 3: Commit** `docs(manager-app): build and release notes for Phase 1`.
