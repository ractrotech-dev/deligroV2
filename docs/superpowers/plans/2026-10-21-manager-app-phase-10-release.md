# Manager App — Phase 10: Release (§16, §18.10–18.11) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a release test build of the Manager app the client can approve: every numbered item of the 18-section spec shown to exist in code with a test, any gap closed in this phase, English throughout, finance and customer screens kept out of the recents thumbnail, the full migration chain proven in order, the security and deployment checklists walked, every QA suite green, the heavy endpoints inside their time budgets at 100k orders, a release APK smoke-tested on every screen, and handover documents for the owner and the client.

**Architecture:** One worktree, `F:\hub26\deligro-manager`, branch `feat/manager-app`, tasks run in order (no parallel halves — almost every task reads or touches the whole branch). Phases 1–9 have merged. Gap fixes found by the conformance audit (Task 3) and the review (Task 11) land here as their own commits with their own tests; nothing is deferred to a later phase because there is none.

**Tech Stack:** as Phases 1–9 — Supabase Postgres (PGlite proofs), Next.js route handlers, `tsx` QA scripts, Flutter 3.47 / Riverpod 3 / go_router, Android (Kotlin `MainActivity`), the F:\dev build environment and the `deligro_test` emulator.

**Spec:** `docs/superpowers/specs/2026-10-21-manager-app-design.md` (all sections; §16, §18, *Phases* row 10). Earlier plans: `docs/superpowers/plans/2026-10-21-manager-app-phase-{1..9}-*.md` — their coverage tables are the source for Task 3's conformance table.

## Global Constraints

- Phases 1–9 Global Constraints apply: AGENTS.md rules (role check + rate limit on every write route, `createAdminClient()` only under `managerApiContext` + `applyZoneScope`, column grants on `orders`, never `select("*")` on `orders`, fail closed); every audited write is one RPC that changes and logs together; migrations are **not applied** to any live database; never touch `F:\hub26\deligro`, `deligro-rider`, `deligro-vendor`; never bare `git stash`; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **English only on the manager side (owner rule, 2026-10-21).** This replaces the design's "Hindi pass". No `tr(...)`, no Hindi strings, no `labelHi` on any `manager.*` key, no Devanagari (`[\u0900-\u097F]`) anywhere under `apps/manager/lib`, `apps/manager/test`, `src/app/api/manager`, `src/app/manager`, `src/lib/ops`, staff push and inbox text, or report/export headers. The Rider and Partner apps and vendor/driver catalog keys keep their Hindi — do not touch them.
- **No new migration unless a gap needs one**; if one does, use the next free number in `0175`–`0199` with a PGlite proof and rollback block, house style.
- Version stays `2.0.0+2` unless a rebuild needs a bump; it must remain greater than the Capacitor Manager shell's `versionCode` 1 (`mobile/roles.json`).
- Flutter builds: `$env:GRADLE_USER_HOME='F:\dev\gradle-home'; $env:TEMP='F:\dev\tmp'; $env:TMP='F:\dev\tmp'; $env:JAVA_TOOL_OPTIONS='-Djava.io.tmpdir=F:\dev\tmp'`, toolchain under `F:\dev`. Emulator `deligro_test` with `ANDROID_USER_HOME=F:\dev\android-user`, `ANDROID_AVD_HOME=F:\dev\android-user\avd`; in Git Bash set `MSYS_NO_PATHCONV=1` for `adb shell` paths. Other sessions may use the emulator; never wipe it or uninstall other apps.
- Secrets never committed: `apps/manager/android/key.properties`, `apps/manager/env/*.json` except `example.json`, `.env.local`. Task 10 asserts it.
- Time budgets (server time, measured as in Task 6): dashboard < **800 ms**; any list page (orders, vendors, riders, products, customers, tickets, alerts, audit) < **400 ms**; live < **400 ms**; a report's first page < **1500 ms** (Claude's call — the directive pins only dashboard and lists).

## Review Focus

1. **The update path on managers' phones.** A release APK signed with a different key from the installed Capacitor Manager app (`com.ractrotech.deligro.manager`, release keystore alias `manager`) cannot install over it (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Expected: the build is signed with the `manager` alias, or it is a debug-signed test build, named and labelled as such, with signing listed as an owner step. Never a silently debug-signed "release". (Task 10 test.)
2. **Migrations applied out of order in production.** If a sibling migration (0061–0140) is applied after 0141–0174 (e.g. `--include-all` on a late sibling deploy), the re-declared `guard_order_update`, `lock_restaurant_privileged_fields` or rider read policies silently lose zone locking. Expected: the full-chain proof applies 0001→latest in order and asserts the final function bodies; DEPLOYMENT_AUDIT states the order and the check to run after any out-of-order apply. (Task 2 test.)
3. **A manager route the permission matrix doesn't know about.** A route added in Phases 3–9 that skips its permission check or zone narrowing. Expected: the matrix is generated from the filesystem (`src/app/api/manager/**/route.ts`), so an unmapped route fails the test instead of being skipped. (Task 4 test.)
4. **Secure screens entered sideways.** A finance or customer screen opened from a push, a deep link, the tablet side-by-side detail pane, or back-navigation must still set `FLAG_SECURE`, and leaving it must clear the flag. Expected: the flag follows the current top route, whatever way it got there. (Task 7 test.)
5. **Figures that agree on fixtures but drift on volume.** The dashboard, finance overview and reports agree on 20-row fixtures. On 100k orders a capped or paged read could truncate silently. Expected: the parity test is re-run on the 100k seed. Totals must match exactly, and no endpoint may return a 1000-row-truncated figure. (Task 6 test.)

---

### Task 1: English-only and copy pass

**Files:**
- Create: `scripts/qa/manager-english-only.ts`, `docs/manager-app-terminology.md`
- Modify: `package.json` (`"test:manager-english": "tsx scripts/qa/manager-english-only.ts"`), any manager string that fails the check or the terminology table
- Test: `scripts/qa/manager-english-only.ts`, `apps/manager/test/english_only_test.dart` (exists from the Phase 2 English-only refactor; extend if missing)

**Interfaces:**
- Produces: `npm run test:manager-english` (exit 1 on any finding), used again in Task 5's full run.

- [ ] **Step 1: Write `scripts/qa/manager-english-only.ts`.** It walks `apps/manager/lib`, `apps/manager/test`, `src/app/api/manager`, `src/app/manager`, `src/lib/ops`, `src/lib/auth/manager-*`, `src/lib/notifications/ops-*` and `src/lib/reports`, and reports:
  - (a) any Devanagari `[\u0900-\u097F]`;
  - (b) any `tr(` call or `langProvider`/`labelHi` reference under `apps/manager` or in the `manager.*` entries of `src/lib/features/catalog.ts`;
  - (c) every terminology-table "avoid" word found in a user-facing string literal (Dart `'…'`/`"…"`, TS strings in `src/lib/ops/**/labels*`, alert catalogs, report column labels).

  Each finding is printed as `file:line  rule  text`.
- [ ] **Step 2: Write `docs/manager-app-terminology.md`.** It's a two-column table: the spec's term, and the words to avoid for the same thing. Rows:
  - Order ID (avoid: "order code" in labels; the short code is shown *as* the Order ID)
  - Vendor (avoid: shop, restaurant in manager UI; keep "store" only in §4.6 "store information" and §4.7 "store opening hours")
  - Rider (avoid: driver, courier)
  - Platform Commission
  - Vendor Payments Due
  - Rider Payments Due
  - Settlement
  - Marketing Request
  - Support Ticket
  - Delivery Zone
  - Cancelled Orders
  - Net Sales
  - Gross Sales
  - Deligro-funded / Vendor-funded discount (avoid: platform-funded in UI)

  The dashboard's 18 labels and the 12 report names are copied verbatim from the client spec.
- [ ] **Step 3: Run** `npx tsx scripts/qa/manager-english-only.ts`. Expect findings (at least the "driver"/"shop" wording that earlier phases used). Record the count.
- [ ] **Step 4: Fix every finding.** Change user-facing strings only: identifiers, API field names and database names stay as they are. Dashboard tile labels and report names must equal the spec text exactly; `apps/manager/test/dashboard_labels_test.dart` asserts the 18 labels in spec order and `report_names_test.dart` asserts the 12 names.
- [ ] **Step 5: Run the check, `flutter test`, `flutter analyze` and `npx tsc --noEmit`.** All clean, findings 0. Commit `chore(manager-app): English-only and copy pass — spec terminology throughout`.

### Task 2: The whole migration chain, in order

**Files:**
- Create: `scripts/qa/sql/all-migrations.mjs`
- Modify: `docs/DATABASE.md` (section "Apply order"), `docs/DEPLOYMENT_AUDIT.md` §2 (order + post-apply check), `package.json` (`"test:migrations": "node scripts/qa/sql/all-migrations.mjs"`)

**Interfaces:**
- Produces: `npm run test:migrations`, used in Task 5 and quoted in the handover.

- [ ] **Step 1: Write `all-migrations.mjs`.**
  - It boots one PGlite instance with the shared preamble (`auth` schema, `auth.uid()`/`auth.role()` stubs, `storage` stubs, roles `anon`/`authenticated`/`service_role`). It must **not** grant `all on all tables` beyond what Supabase grants by default; the Phase 2 review found that preamble hiding missing column grants.
  - It applies every file in `supabase/migrations/` sorted by numeric prefix (0001→latest). The two `0033_*` files go in filename order. Each file runs in its own statement batch, and a failure names the file and the statement.
  - It then asserts:
    - `guard_order_update` locks include `zone_id`, `preparing_at` and the 0055/0058 columns;
    - `lock_restaurant_privileged_fields` covers `zone_id` and the 0145 status columns;
    - every 0081 rider table's manager policy calls `manager_can_see_rider`;
    - `ops_audit_log` refuses update/delete for `service_role`;
    - the 0052 feature-key check accepts `manager.finance.view`;
    - the `manager_apk_*` and `vendor_apk_*` columns are granted to `anon`.
  - Then it **runs every `scripts/qa/sql/migration-*.mjs` proof** as a child process and fails if any fails.
  - Reverse-order check: on a fresh instance it applies the chain, then re-applies `0061` and `0081` as a late sibling deploy would. It asserts the zone lock **is** lost, which documents why order matters, and then that re-applying 0141→latest restores it. The test prints both outcomes.
- [ ] **Step 2: Run it — expect FAIL** on the first assertion that the chain does not yet satisfy, or on an apply error. Fix the cause in the newest migration that owns the object. Never edit an earlier migration that a sibling branch or live database may already have.
- [ ] **Step 3: Document the apply order** in `docs/DATABASE.md` and `DEPLOYMENT_AUDIT.md` §2:
  - 0001–0060 (main);
  - 0061–0080 (Partner app);
  - 0081–0140 (Rider app);
  - 0141–0199 (Manager app), strictly ascending.
  - **After any out-of-order apply, re-run 0141→latest** (idempotent), then run the post-apply SQL check (the Step 1 assertions as a `select` script, `scripts/qa/sql/post-apply-check.sql`, which returns one row per check with `ok`).
- [ ] **Step 4: Run** `npm run test:migrations` — PASS. Commit `test(db): prove the whole migration chain in order; document apply order and post-apply check`.

### Task 3: Spec conformance audit and gap fixes

**Files:**
- Create: `docs/manager-app-conformance.md`, `scripts/qa/manager-conformance.ts`
- Modify: whatever a gap needs (each gap its own commit)

**Interfaces:**
- Produces: `docs/manager-app-conformance.md`, the table quoted by the handover (Task 12). `npm run test:manager-conformance` checks the table's integrity:
  - every row has a non-empty *Shipped* and *Verified by*;
  - every file path in those columns exists;
  - every test named in *Verified by* exists (grep for the test name);
  - no row says `TODO`, `partial`, `deferred` or `mostly`.

- [ ] **Step 1: Write `scripts/qa/manager-conformance.ts`**, which parses the Markdown table under `## Conformance` in `docs/manager-app-conformance.md`. Run it against the skeleton below — expect FAIL (empty columns).
- [ ] **Step 2: Fill the table by reading the code, not the plans.** For each row, open the owning route, screen and test, and confirm the behaviour exists end to end: server → payload → screen → test. Then fill in:
  - *Shipped*: route file, screen file, RPC, as `path` or `path#symbol`;
  - *Verified by*: the QA script, assertion name or Flutter test name.

  A row whose behaviour is missing, stubbed, a placeholder screen, "—" with a note, or reachable only on admin web is a **gap**. Gap rows are listed under `## Gaps found` with the reason.
- [ ] **Step 3: Close each gap.**
  - Write a failing test (QA assertion or Flutter test), implement, and pass.
  - Commit `fix(manager-app): close conformance gap §N.M — <what>`.
  - Fill the row; move the gap to `## Gaps closed` with the commit hash.
  - Known candidates to check first:
    - dashboard tiles that still show "—" (Rider Payments Due, Pending Marketing Requests, Pending Support Tickets: their tables exist from Phases 5/7/8 and must now count);
    - tile tap-throughs to placeholder routes from Phase 2;
    - Active Riders excluding suspended riders (Phase 2 finding 12, enabled by Phase 5 `rider_can_work()`);
    - §2.11 per-city subtotal;
    - §15.6 per-device sign-out (Phase 1 open item: 501 when `auth.sessions` delete is not permitted — the app must state it plainly; this row is satisfied by "sign out everywhere" working plus the honest 501 message, and the row says so).
- [ ] **Step 4: Run `npm run test:manager-conformance`** — PASS, with gaps open = 0. Commit `docs(manager-app): conformance table — every spec item mapped to code and test`.

**The skeleton** goes into `docs/manager-app-conformance.md` under `## Conformance`.
- Columns: `| ID | Requirement (spec words) | Owner (phase · task) | Shipped | Verified by |`.
- *Owner* comes from the phase coverage tables; the last two columns are filled in Step 2.
- Phase task names: P1 = Phase 1 Task n; P2 = Phase 2 Task n; P3–P9 use their S/A task ids.

| ID | Requirement | Owner |
|---|---|---|
| §1.1 | Today's Total Sales | P2 T3, T5 |
| §1.2 | Total Sales | P2 T3, T5 |
| §1.3 | Today's Orders | P2 T3, T5 |
| §1.4 | Total Orders | P2 T3, T5 |
| §1.5 | Pending Orders | P2 T3, T5 |
| §1.6 | Completed Orders | P2 T3, T5 |
| §1.7 | Cancelled Orders | P2 T3, T5 |
| §1.8 | Active Vendors | P2 T3, T5 |
| §1.9 | Online Vendors | P2 T3, T5 |
| §1.10 | Active Riders | P2 T3, T5; P5 S2 (suspension) |
| §1.11 | Online Riders | P2 T3, T5 |
| §1.12 | Riders Currently on Delivery | P2 T3, T5 |
| §1.13 | Total Delivery Fees | P2 T3, T5 |
| §1.14 | Total Platform Commission | P2 T3, T5 |
| §1.15 | Vendor Payments Due | P2 T3, T5 |
| §1.16 | Rider Payments Due | P2 T3; P5 S5; P6 S4 |
| §1.17 | Pending Marketing Requests | P2 T3; P7 S1 |
| §1.18 | Pending Support Tickets | P2 T3; P3 S2; P8 S1 |
| §1 auto | All figures update automatically from the backend | P2 T5 (30 s, visible only) |
| §2.1 | Day-by-day sales statistics | P2 T4, T6 |
| §2.2 | Daily, weekly, monthly, yearly filters | P2 T4, T6 |
| §2.3 | Custom date-range filtering | P2 T4, T6 |
| §2.4 | Sales growth vs previous period | P2 T4, T6 |
| §2.5 | Order growth statistics | P2 T4, T6 |
| §2.6 | Completed versus cancelled analysis | P2 T4, T6 |
| §2.7 | Average order value | P2 T4, T6 |
| §2.8 | Peak ordering hours | P2 T4, T6 |
| §2.9 | Best-performing vendors | P2 T4, T6 |
| §2.10 | Best-performing product categories | P2 T4, T6 |
| §2.11 | City-wise and area-wise performance | P2 T4, T6; P9 S1 |
| §2.12 | Downloadable performance reports | P2 T7; P6 A6 |
| §3.1–§3.16 | (one row each, spec words) | P3 coverage table rows |
| §3 rule | No altering completed financial records without authorization | P3 S1, S5 |
| §4.1–§4.15 | (one row each) | P4 coverage table rows |
| §5.1–§5.15 | (one row each) | P5 coverage table rows |
| §6.1–§6.12 | (one row each) | P3 coverage table rows |
| §6 rule | Tracking follows disclosed policies and privacy | P3 S6; P5 S3 |
| §7 S1–S9 | Gross sales · Net sales · Platform commission · Vendor- and Deligro-funded discounts · Refunds and adjustments · Delivery fees collected · Rider delivery earnings · Vendor earnings payable · Rider earnings payable (one row each) | P6 coverage table rows |
| §7 T1–T9 | Vendor payments due · completed · Rider payouts due · completed · Failed or delayed transactions · Settlement history · Transaction reference numbers · Date-wise financial reports · Reconciliation (one row each) | P6 coverage table rows |
| §7 rule | Initiate/approve only with permissions; RBAC on payment execution and adjustments | P5 S2; P6 S2, S5 |
| §8.1–§8.12 | (one row each) | P7 coverage table rows |
| §8 statuses | Pending, Approved, Rejected, In Progress, Completed | P7 S1, S5, A2 |
| §9.1–§9.10 | (one row each) | P7 coverage table rows |
| §10.1–§10.9 | (one row each) | P7 coverage table rows |
| §11.1–§11.11 | (one row each) | P8 coverage table rows |
| §11 statuses | Open, In Progress, Escalated, Resolved, Closed | P8 S1, A2 |
| §12.1–§12.10 | (one row each) | P4 coverage table rows |
| §12 rule | Inventory stays with the vendor unless permitted | P4 S5, S7, A6 |
| §13.R1–R12 | Sales · Order · Vendor Performance · Rider Performance · Commission · Vendor Settlement · Rider Payout · Cancellation · Refund and Adjustment · Marketing Campaign · Support Ticket · Cash Reconciliation Report (one row each) | P6 S7 registry, A6 |
| §13.F1 | Filter by date range (From / To) | P6 S7, A6 |
| §13.F2 | Filter by vendor, rider, status, delivery zone where applicable | P6 S7, A6 |
| §13.F3 | Export to Excel/CSV and PDF | P6 A6 |
| §13.F4 | Display report generation date | P6 S7, A6 |
| §13.F5 | Consistent calculations across dashboards and reports | P6 S7, I1 |
| §13.F6 | Keep cancelled orders separate from net sales | P6 S3, S7 |
| §13.F7 | Prevent duplicate counting of refunds and adjustments | P6 S3, S7 |
| §14.1–§14.13 | (one row each, alert kind) | P8 S4 |
| §14 thresholds | Configurable thresholds for selected alerts | P8 S2, S6, A4 |
| §15.1 | Manager profile | P1 T8 |
| §15.2 | Secure login and logout | P1 T4, T7 |
| §15.3 | Assigned city or delivery zones | P1 T1, T5, T8 |
| §15.4 | Role and permission display | P1 T8 |
| §15.5 | Password or OTP-based authentication | P1 T7 |
| §15.6 | Session management | P1 T4, T8 |
| §15.7 | Notification preferences | P1 T8; P8 S3, A3 |
| §15.8 | Activity history | P1 T4, T8 |
| §15.9 | Access to authorized reports only | P6 S7 (`permittedKinds`), A6 |
| §15 rule | Only permitted cities, vendors, riders, financial data | P1 T1, T4; every phase's scope |
| §16.1–§16.10 | (one row each) | P8 coverage table rows |
| §16 rule | Audit records not editable by ordinary managers | P1 T1 (0141 trigger); P8 S2 |
| §17.1–§17.10 | (one row each) | P9 coverage table rows |
| §18.1 | Integrate with the existing Deligro backend | all phases (`/api/manager/*`, Supabase) |
| §18.2 | Reuse existing APIs wherever possible | P2 T2 (admin split), P3 S5 (`cancelOrderAsOps`), P6 S7 (registry) |
| §18.3 | Synchronize order status across customer, vendor, rider, manager | P3 S1, S5 (status events, pushes) |
| §18.4 | Dashboard figures match financial reports | P2 T3; P6 S7; Task 6 here |
| §18.5 | Role-based access control | P1 T2, T4; Task 4 here |
| §18.6 | Pagination and efficient filters | P3–P8 list routes; Task 6 here |
| §18.7 | Loading, empty, and error states | every A task; Task 3 here checks each screen |
| §18.8 | Real-time updates where available | P2 T5, P3 A2/A4 polling, P8 pushes |
| §18.9 | Audit trails for sensitive actions | P8 S7 |
| §18.10 | Test allocation, reconciliation, reports, permissions | Task 5 here |
| §18.11 | Test build for approval before production | Task 10 here |
| Final | Centralized view; permissions respected; figures accurate, traceable, consistent | Tasks 3–6, 11 here |

Expand every "(one row each)" line into one row per numbered item, using the spec's own words. That gives about 230 rows. The script fails if any spec ID from the list `§1.1…§18.11` is missing, and that list is hard-coded in the script from the spec's counts:
- §1 18, §2 12, §3 16, §4 15, §5 15, §6 12, §7 9 + 9, §8 12, §9 10, §10 9, §11 11, §12 10;
- §13 12 reports and 7 features, §14 13, §15 9, §16 10, §17 10, §18 11;
- plus the rule and status rows above.

§18.7 checks every screen for loading, empty and error states. *Verified by* names the screen's widget test that asserts all three. Screens without such a test are gaps, and the gap fix adds the test.

### Task 4: Permission matrix — every manager route × permission × zone

**Files:**
- Create: `scripts/qa/manager-permission-matrix.ts`, `src/lib/auth/manager-route-permissions.ts` (only if Phase 8 S7's route → permission map does not already exist under another name — reuse it if it does; one map, not two)
- Test: the script itself

**Interfaces:**
- Consumes: `managerApiContext(permission?)`, `narrowScope`, the Phase 8 S7 route → permission map, `catalog.ts` `defaultOn`.
- Produces: `npm run test:manager-permissions`.

- [ ] **Step 1: Write the matrix script.**
  - It enumerates every `src/app/api/manager/**/route.ts` and every exported HTTP method from the filesystem.
  - It looks each (route, method) up in the map. An **unmapped route fails the run**.
  - For each one it runs the handler in-process with the test seam the Phase 1 QA (`manager-scope.ts`) uses to inject a profile, permissions and zones. If that seam does not cover route handlers, add `withManagerTestContext(ctx, fn)` to `manager-api.server.ts`, exported only when `process.env.QA_SEAM === "1"`; a build-time check fails `next build` if it is reachable in production.
  - Cases per route:
    - (a) no session → 401;
    - (b) role customer → 403 `forbidden`;
    - (c) manager with the route's permission off → 403 `permission_denied`, and for default-off keys also with the switch never set;
    - (d) permission on, `zone=<zone not held>` → empty payload or 404/403, never another zone's rows;
    - (e) permission on, own zone → 2xx, or the route's documented 4xx for missing body fields;
    - (f) admin → 2xx.
  - Data comes from a stub data layer, or from a dev server with `QA_MANAGER_*` credentials when available. The structural cases (a)–(c) never need a database.
- [ ] **Step 2: Run** — expect FAIL on any unmapped route or wrong status. Fix each route, not the test.
- [ ] **Step 3: RPC-level zone matrix in PGlite** (`scripts/qa/sql/manager-zone-matrix.mjs`): for every `ops_*` security-definer RPC that takes an entity id, call it as a manager whose zones exclude the entity's zone. Expect `forbidden` / `not_in_scope` and no row written to the target table or to `ops_audit_log`. RPC names come from `pg_proc` where `proname like 'ops\_%'`, so new ones can't be missed; an RPC without an entity argument is listed as exempt with a reason.
- [ ] **Step 4: Both PASS.** Commit `test(manager): permission and zone matrix over every route and ops RPC`.

### Task 5: §18.10 test suites by name and the full QA run

**Files:**
- Create: `scripts/qa/manager-all.ts` (runner), `docs/manager-app-test-suites.md`
- Modify: `package.json` (`"test:manager-all": "tsx scripts/qa/manager-all.ts"`)

**Interfaces:**
- Produces: `npm run test:manager-all`, which runs the named suites in order, prints a table (`suite · checks · passed · failed · seconds`) and exits 1 on any failure. The handover quotes its output.

- [ ] **Step 1: Write `docs/manager-app-test-suites.md`.** Under the four §18.10 headings it lists every suite by exact script or test name, read from the repo (not from the plans):
  - **Order allocation:** Phase 3 `manager-live-rules.ts` (eligibility, ranking), reassign / assign RPC proofs in `migration-0142.mjs`, Phase 9 auto-assign proof (`migration-0172.mjs`), suspended-rider exclusion (Phase 5 proof).
  - **Financial reconciliation:** `metrics.ts`, `admin-metrics-parity.ts`, Phase 6 finance-rules and reconciliation tests, `migration-0144.mjs` SQL/TS parity, Phase 9 accounting parity.
  - **Reports:** Phase 6 registry and parity tests, the export tests (CSV injection guard, BOM, generated-at), Phase 9 scheduled-report tests.
  - **Permissions:** `manager-scope.ts`, `role-features.ts`, Task 4's two matrices, Phase 8 S7 audit coverage, Phase 8 S8 PII scan.
- [ ] **Step 2: Write `manager-all.ts`.** It runs:
  - `npm run test:migrations`;
  - every `scripts/qa/manager-*.ts` and `ops-*` / `metrics` / `admin-metrics-parity` script;
  - the existing `npm run test:*` scripts that touch shared code (`test:app-version`, `test:platform`, `test:idor`, `test:payments`, plus every other `test:*` in `package.json` — a script skips only when it states it needs a live server and none is up, and the skip is listed);
  - `npx tsc --noEmit`, `npm run lint`, `next build`;
  - and in `apps/manager`: `flutter analyze`, `flutter test`.
- [ ] **Step 3: Run `npm run test:manager-all`.** Fix every failure at its cause (a failing pre-existing script that this branch broke is this branch's bug; one that fails identically on `feat/vendor-app`'s tip is recorded as pre-existing with evidence and left alone). Re-run until green.
- [ ] **Step 4: Commit** `test(manager): named §18.10 suites and one runner for the full QA`.

### Task 6: Performance at 100k orders

**Files:**
- Create: `scripts/perf/seed-manager-100k.mjs`, `scripts/perf/manager-budgets.mjs`, `docs/manager-app-performance.md`
- Modify: offending queries/RPCs/indexes (new migration only if an index or RPC is needed — next free number)

**Interfaces:**
- Produces: `node scripts/perf/manager-budgets.mjs`, which prints per-endpoint timings against the budgets in Global Constraints and exits 1 on a breach.

- [ ] **Step 1: Write the seed.** In PGlite, after the full chain from Task 2, seed deterministically (seed 42):
  - 3 zones in 2 cities, 120 vendors, 2,000 menu items, 80 riders, 30,000 customers;
  - **100,000 orders** over 400 days, with realistic status mix (85 % delivered, 8 % cancelled with `cancelled_by` spread, 2 % unpaid online, rest in flight), items 1–5 each, refunds on 1.5 %, settlements covering delivered orders older than 14 days, deliveries + `delivery_events`, tickets 2,000, alerts 500, audit rows 20,000.
  - Run `ANALYZE` after seeding.
- [ ] **Step 2: Write the budget runner.**
  - For each endpoint, it executes the exact SQL or RPC the data layer issues; it imports the data-access functions with a PGlite-backed Supabase shim for `rpc`/`from().select()` if one exists from earlier phases, else it reproduces the RPC calls directly. It then times the Node post-processing on the returned rows. Each one runs 5 times, and the median counts.
  - Endpoints:
    - dashboard (all zones and one zone);
    - stats (month, year);
    - orders list first page and a filtered page;
    - order detail;
    - live;
    - vendors, riders, products, customers, tickets, alerts and audit first pages;
    - finance overview;
    - reports `sales`, `orders` (first page) and `cash-reconciliation`;
    - insights demand and zone grid.
  - It records `EXPLAIN (ANALYZE, BUFFERS)` for any query over budget.
  - PGlite is slower than hosted Postgres, so a pass here is conservative. The doc states that.
- [ ] **Step 3: Volume parity.** On the seed, assert:
  - dashboard Total Sales = `sales` report total `customerPaid` = finance overview, all for "all time";
  - Total Orders = the orders list `total`;
  - Vendor Payments Due = the sum of vendor-dues rows;
  - no endpoint's figure equals a multiple of 1000 caused by a capped read (cross-check each count with a `count(*)` query).
- [ ] **Step 4: Run** — expect some over budget. Fix each with an index, an RPC, keyset paging or a rollup. Never by narrowing what the screen shows. Re-run until every endpoint is within budget and parity holds.
- [ ] **Step 5: Write `docs/manager-app-performance.md`** (table of medians before → after, fixes made, method and caveats). Commit `perf(manager): 100k-order seed, budgets met, volume parity`.

### Task 7: FLAG_SECURE on finance and customer screens

**Files:**
- Modify: `apps/manager/android/app/src/main/kotlin/com/ractrotech/deligro/manager/MainActivity.kt` (method channel `deligro/secure`: `setSecure(bool)` adds/clears `WindowManager.LayoutParams.FLAG_SECURE` on the UI thread)
- Create: `apps/manager/lib/core/secure_screens.dart`, `apps/manager/test/secure_screens_test.dart`
- Modify: `apps/manager/lib/router.dart` (observer / `routerDelegate` listener)

**Interfaces:**
- Produces: `bool isSecureLocation(String location)` and `SecureScreenController` (listens to `GoRouter.routerDelegate`, computes the **top** location including the tablet detail pane's location, and calls the channel only on change).
- Secure prefixes (Claude's call, matching the design's "finance and customer screens"):
  - `/finance` (all);
  - `/more/customers` (all);
  - `/more/riders/:id/money`;
  - `/more/vendors/:id/finance`;
  - `/more/approvals`;
  - `/more/reports` (the report preview shows money or customers);
  - `/more/insights/accounting`;
  - `/more/insights/fraud`;
  - `/more/insights/reports/runs`.

  The actual paths are read from `router.dart`, and the test fails if a listed prefix matches no route.

- [ ] **Step 1: Write `secure_screens_test.dart`.**
  - `isSecureLocation` is true for every secure prefix and its children, and false for `/`, `/orders`, `/live` and `/more/vendors/:id` (overview).
  - Every prefix matches at least one route in the app's route table.
  - With a fake channel: navigate `/` → `/finance` gives `[true]`; then `/finance` → `/orders` gives `[true, false]`; a push deep link straight into `/more/customers/<id>` from cold start gives `[true]` as the first call; going back from a customer to `/orders` clears the flag; on tablet, a list on `/orders` with a detail pane showing a customer gives `true`.
- [ ] **Step 2: Run** `flutter test test/secure_screens_test.dart` — FAIL.
- [ ] **Step 3: Implement** the channel, controller and wiring.
- [ ] **Step 4: Emulator check (release APK from Task 10, or a profile build now).**
  - Open Finance and run `adb shell dumpsys window windows | grep -i "FLAG_SECURE\|fl=.*SECURE"`; expect the flag. `adb exec-out screencap -p` gives a black image, which is saved as evidence.
  - Open recents: the thumbnail is blank. Save the screenshot.
  - Go to Orders: the flag is cleared and screencap shows content.
  - Save the evidence to `docs/manager-app-release/secure-*.png`.
- [ ] **Step 5: `flutter analyze`, `flutter test` PASS.** Commit `feat(manager-app): finance and customer screens kept out of screenshots and recents (FLAG_SECURE)`.

### Task 8: Security and deployment checklists walked

**Files:**
- Create: `scripts/qa/manager-object-inventory.ts`
- Modify: `docs/SECURITY_AUDIT.md` (log rows), `docs/DEPLOYMENT_AUDIT.md` (env vars, crons, buckets, apply order, smoke tests, log rows)

**Interfaces:**
- Produces: `npx tsx scripts/qa/manager-object-inventory.ts`. It parses migrations 0141–latest, plus every sibling-range migration this branch added (0143, 0150, 0160, 0167 if built here), and lists every:
  - table;
  - column added to an existing table;
  - policy;
  - `grant` / `revoke`;
  - security-definer function;
  - trigger;
  - storage bucket and storage policy.

  It also parses `src/app/api/manager/**` for routes, upload handlers (multipart) and cron routes, and prints a checklist in Markdown.

- [ ] **Step 1: Write and run the inventory** to get the checklist.
- [ ] **Step 2: Walk `docs/SECURITY_AUDIT.md` item by item for every object** and record in the log one row per object group, with evidence (proof assertion or QA test name):
  - RLS on with explicit policies;
  - no anon/authenticated privilege beyond intended;
  - column grants on `orders`/`restaurants`/`platform_settings`;
  - `security definer` with `set search_path`;
  - `revoke execute from public, anon, authenticated` where server-only;
  - buckets private, with signed-URL lifetimes ≤ 5 min;
  - uploads checked for type and size;
  - rate limits on writes;
  - no `select("*")` on `orders`;
  - no service-role read without scope;
  - credentials never stored reproducibly;
  - the `DEVICE_HASH_PEPPER` and `CRON_SECRET` behaviour when absent (fail closed).

  Any failure is fixed here, with a test.
- [ ] **Step 3: Walk `docs/DEPLOYMENT_AUDIT.md`.**
  - §1: add the new env vars (`DEVICE_HASH_PEPPER`, any report-PDF font path, OneSignal manager app keys if separate) with the behaviour when missing.
  - §2: the apply order from Task 2.
  - §4: `pnpm install --frozen-lockfile` (the npm lockfile is stale; record it).
  - §5: smoke tests for `/api/app-version?app=manager`, `/api/manager/me` (401 unauthenticated), the cron routes (dispatch sweep, alert engine, campaign scheduler, report schedules, rollup refresh, retention cleanup) with `CRON_SECRET`, and the admin Zones / Feature access / Alerts / Audit pages.
  - §6: rollback, meaning the per-migration rollback blocks in reverse order.

  Log a dated row.
- [ ] **Step 4: Commit** `docs(security): manager objects 0141+ walked through SECURITY_AUDIT and DEPLOYMENT_AUDIT`.

### Task 9: Capacitor shell retired, release track instructions

**Files:**
- Modify: `mobile/roles.json` (manager entry: `"shell": "flutter"`, `"flutterApp": "apps/manager"`, `"versionCode": 2`, `"versionName": "2.0.0"`), `mobile/scripts/build-apk.mjs` (a role with `"shell": "flutter"` is refused with "Built from apps/manager with Flutter — see apps/manager/README.md"; `all` skips it with that note), `mobile/README.md` (Manager row), `apps/manager/README.md` (build, sign, release steps), `src/app/admin/settings/settings-form.tsx` (Manager release block help text, if not already present)
- Test: `scripts/qa/role-manifest.ts` / `native-bridge.ts` (whichever reads `roles.json`; extend) — `build-apk.mjs manager` exits non-zero with the message; `all` builds the other three only (dry-run flag `--dry-run` if the script lacks one: add it, printing the roles it would build).

- [ ] **Step 1: Write the test assertions** above; run — FAIL.
- [ ] **Step 2: Implement.** In the `apps/manager/README.md` release steps, the release track instructions are:
  1. bump `version` in `pubspec.yaml`;
  2. build signed (Task 10's command);
  3. upload the APK where the website serves files;
  4. in Admin → Settings → Manager app, set the latest version code and URL, and set the minimum version code only to force an update;
  5. check `/api/app-version?app=manager&versionCode=<old>`.
- [ ] **Step 3: PASS; commit** `chore(mobile): Manager is a Flutter app now; Capacitor build refuses it; release track instructions`.

### Task 10: Release build and full-screen smoke test

**Files:**
- Create: `apps/manager/test/route_inventory_test.dart`, `docs/manager-app-release/README.md` (screen checklist with results), screenshots `docs/manager-app-release/<route-slug>-<light|dark>.png`
- Modify: `apps/manager/android/app/build.gradle.kts` only if signing config needs it; `.gitignore` if any secret path is not ignored

**Interfaces:**
- Produces: `apps/manager/build/app/outputs/flutter-apk/app-release.apk`, copied to `mobile/dist/deligro-manager-2.0.0.apk` + `.sha256` (both gitignored if `mobile/dist` is; otherwise not committed — the APK is an artefact, not source).

- [ ] **Step 1: Write `route_inventory_test.dart`.** It walks the app's `GoRouter` configuration and writes `build/route_inventory.txt`, one location pattern per line with its permission. The test asserts the list is non-empty and that every route has a screen title. The smoke checklist in Step 5 is generated from this file, so no screen can be forgotten.
- [ ] **Step 2: Secrets check.** Run `git ls-files | grep -E "key.properties|env/(?!example)|\.env\.local|\.jks"` and expect nothing. Add a QA line to `manager-all.ts`.
- [ ] **Step 3: Signing.**
  - If `%USERPROFILE%\deligro-keys\deligro-release.jks` exists **and** `DELIGRO_KEYSTORE_PASSWORD` / `DELIGRO_KEY_PASSWORD` are set: write `apps/manager/android/key.properties` (gitignored) with `keyAlias=manager`, and build.
  - Otherwise build with the debug key. Name the file `deligro-manager-2.0.0-TEST-debug-signed.apk`, put "Test build — debug-signed, will not install over the Capacitor Manager app; sign with the `manager` alias for release" in `docs/manager-app-release/README.md` and the handover, and list signing as an owner step.
  - In both cases record `apksigner verify --print-certs` output (SHA-256 of the signing cert) in the README.
- [ ] **Step 4: Build.**
  - Command: `flutter build apk --release --dart-define-from-file=env/prod.json` with the F:\dev env.
  - Confirm `aapt dump badging` shows `package: name='com.ractrotech.deligro.manager' versionCode='2' versionName='2.0.0'`, the app label is Deligro Manager, and the icon is present.
  - Confirm the R8 keep rules are applied: `shared_preferences` loads at start (the customer app's splash-hang pitfall).
- [ ] **Step 5: Smoke every screen** on `deligro_test` from the release APK:
  - Cold start → splash → login, with no `FATAL`/`E/flutter` in logcat. Captured.
  - With `QA_MANAGER_MOBILE`/`QA_PASSWORD` against a staging database that has the chain applied: sign in, then visit **every** route in `route_inventory.txt` (parameterised routes with a real id from the list screen). For each, take a light screenshot (and dark for the five tab roots), check logcat for errors, and record `ok`/`issue` in the README table.
  - Without credentials or staging: smoke login, OTP tab, the not-a-manager screen (any non-manager test account if available), and Settings. Render every other screen from the Flutter widget tests' fixtures as golden screenshots (`flutter test --update-goldens` into `docs/manager-app-release/golden/`), mark the README rows `fixture-rendered — live smoke is an owner step`, and list that step in the handover.
  - Never claim a live smoke that didn't run.
- [ ] **Step 6: Upgrade test.**
  - If `mobile/dist/deligro-manager-1.0.0.apk` (or any Capacitor manager APK) exists: install it, then run `adb install -r` on the new APK.
  - Release-signed → expect `Success`, and the app opens to login (the cookie session from the WebView is not carried over; expected and noted).
  - Debug-signed → expect `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; record it as the proof that signing is required.
  - If no old APK exists, record "not testable here".
- [ ] **Step 7: Commit** the README, screenshots, goldens and test: `test(manager-app): release build and screen-by-screen smoke results`.

### Task 11: Final whole-branch review and fix round

**Files:**
- Create: `docs/manager-app-final-review.md`
- Modify: whatever the review finds

- [ ] **Step 1: Dispatch a fresh reviewer.** Use a general-purpose subagent on the most capable model, read-only, with no prior context.
  - Inputs: the design, all ten plans, `docs/manager-app-conformance.md`, AGENTS.md, SECURITY_AUDIT, `git diff 2af2ad5..HEAD` (the branch since its Partner-app base, excluding merged sibling commits — review the merges for lost behaviour only).
  - Instructions:
    - rank findings critical → low;
    - cover security (scope, permissions, PII, audit atomicity, uploads, crons), money correctness and parity, data loss in merges, concurrency (double taps, two managers, cron overlap), app state (sign-out leaks, polling while hidden, 401 handling), English-only, and spec conformance spot checks of 20 random conformance rows against the code;
    - each finding gives file:line, failure scenario and fix.
- [ ] **Step 2: Record findings in `docs/manager-app-final-review.md`.** Fix every critical, high and medium finding, each with a failing test first, as `fix(manager-app): final review — <finding>`. Low findings are fixed too unless the fix is riskier than the defect; those are recorded with the reason.
- [ ] **Step 3: Re-run** `npm run test:manager-all`, `node scripts/perf/manager-budgets.mjs` and `npm run test:manager-conformance`, all PASS. If any app code changed after Task 10, rebuild the release APK and re-smoke the screens touched by fixes, updating the README rows.
- [ ] **Step 4: Commit** the review record: `docs(manager-app): final review findings and resolutions`.

### Task 12: Handover and client summary

**Files:**
- Create: `docs/manager-app-handover.md`, `docs/manager-app-summary-2026-10-21.html`

- [ ] **Step 1: Write `docs/manager-app-handover.md`** (for the owner):
  1. **What was built**, per spec section, with a one-paragraph summary each and the screen names. It links the conformance table rather than repeating it.
  2. **Owner steps, in order:**
     - apply migrations to staging in the documented order;
     - run `scripts/qa/sql/post-apply-check.sql`;
     - deploy the website;
     - smoke `/api/app-version?app=manager`;
     - promote to production the same way;
     - assign each manager's zones (Admin → Settings → Team);
     - switch on sensitive permissions per person (Admin → Settings → Feature access; list the ten default-off keys plus `manager.dispatch.configure` and `manager.accounting.export`);
     - set alert thresholds per zone;
     - set the accounting ledger names and Tally company;
     - create report schedules;
     - set `DEVICE_HASH_PEPPER`, `CRON_SECRET` and the cron schedules (list each route and its frequency);
     - check the OneSignal app ID for the manager app;
     - sign the APK with the `manager` alias (Task 10 command) if this build is debug-signed;
     - publish on the manager release track;
     - run the live smoke with a real manager account if it ran on fixtures here.
  3. **Known limits**, stated plainly:
     - per-device sign-out depends on `auth.sessions` delete permission on hosted Supabase;
     - no calling-provider number masking;
     - PGlite-measured performance;
     - the Rider and Partner tables this branch built first, in case those branches are merged later;
     - anything the final review left at low with its reason.
  4. **How to test the build**, from install to the five things to try first.
  5. **Test evidence**: the `test:manager-all` table, budgets, and the screenshot folder.
- [ ] **Step 2: Write the client-facing HTML summary** in the house style of the existing reports:
  - Read `vendor-app-audit-2026-10-21.html` and `docs/audit-2026-10-03.html` for structure, typography and tokens, and reuse their inline CSS approach (self-contained, light/dark, no external scripts).
  - Sections:
    - what the Manager app does;
    - the 18 sections each with status "Complete" and the key screens;
    - screenshots (embedded from `docs/manager-app-release/`, compressed, keeping the file under 5 MB);
    - permissions and data protection in plain language;
    - what the client needs to do to approve the test build;
    - next steps to production.
  - English only, the spec's terminology, no internal jargon (no RPC, RLS or migration numbers; say "database update").
- [ ] **Step 3: Check the HTML** renders in a browser (open the file with the Playwright tools, take light and dark screenshots, and check there is no horizontal scroll at 390 px).
- [ ] **Step 4: Commit** `docs(manager-app): handover notes and client summary`.
- [ ] **Step 5: Final run.** Run `npm run test:manager-all` one last time on the final commit, and paste its table into the handover's evidence section (amend only that doc in a new commit `docs(manager-app): final QA evidence`). `git status` is clean.
