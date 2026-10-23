# Deligro Manager app — resume here

Last updated: 2026-10-23. Read this first if you are continuing the Manager app build
(human or Claude session). Everything below is committed; nothing needs the old PC
except the files listed in section 6.

## 1. Where things stand

The client asked for a native **Deligro Manager app** covering an 18-section spec
(dashboard, statistics, orders, vendors, riders, live operations, finance, marketing,
offers, customers, support, products, reports, alerts, profile, audit, future features,
developer requirements). Owner's rule: **every section complete, nothing partial**,
in our customer-app look. Flutter app in `apps/manager`, server in `src/` + `supabase/`.

| Phase | Subject | State |
|---|---|---|
| 1 | Foundation: zones, permissions, audit log, login, profile | done, reviewed, fixed |
| 2 | Dashboard (18 figures) + statistics | done, reviewed, fixed |
| 3 | Orders + live operations | done, reviewed, fixed |
| 4 | Vendors + products | done, reviewed, fixed |
| 5 | Riders | done, reviewed, fixed |
| 6 | Finance + 12 reports | done, reviewed, fixed |
| 7 | Marketing, offers, customers | done, reviewed, fixed (fixes merged) |
| 8 | Support, alerts, audit log | done, reviewed, fixed |
| 9 | Insights (spec section 17) | **app half done on its own branch; server half partly done; not merged** |
| 10 | Release: full spec audit, security, signed build, handover | **groundwork done (tasks 1, 2, 4, 6, 7); tasks 3, 5, 8–12 remain** |

Design: `docs/superpowers/specs/2026-10-21-manager-app-design.md`.
Plans (one per phase, with coverage tables, pinned JSON and execution notes):
`docs/superpowers/plans/2026-10-21-manager-app-phase-*.md`.

## 2. Branches to push

All in the one repository. None has a remote copy yet.

| Branch | Head when written | What it is |
|---|---|---|
| `feat/manager-app` | `6ae3029` (or later) | The main line. Phases 1–8 + Phase 10 groundwork. **Green**: `tsc` clean, `flutter analyze` clean, 627 Flutter tests, all 96 migrations apply in order, permission matrix 606 checks. |
| `feat/manager-p9-app` | `526a731` | Phase 9 app half (Insights screens, area picker). 747 tests pass. Based on `a91f371`. **Not merged.** |
| `feat/manager-p9-server` | `576d925` | Phase 9 server half, partly done (see section 3). Based on `a91f371`. **Not merged.** |
| `feat/vendor-app` | `7f53653` | Partner app. Already contained in `feat/manager-app`. |
| `feat/rider-app` | `31b6869` | Rider app. **82 commits are NOT yet in `feat/manager-app`** — see step 0 below. |

Push all five so nothing exists only on one PC, for example:

```bash
git push -u origin feat/manager-app feat/manager-p9-app feat/manager-p9-server feat/rider-app feat/vendor-app
```

(`origin` is `whiteslam/deligro26`; the repo also has a `deligroV2` remote — pick the one you use.)

## 3. What to do next, in order

**Step 0 — bring the Rider branch in again.** `git checkout feat/manager-app && git merge feat/rider-app`.
It has 82 new commits (its phases 2–8: jobs, money, dashboard, cash, documents, help, release).
Reconcile exactly as the earlier "P0" steps did (see the "P0 result" sections in the phase
plans): our migrations run last, so they must carry every guard a sibling migration added;
there must be **one** definition of the rider ledger (Rider `0083`), one rider-eligibility
rule (`riderIneligibility` / `eligibleCandidates`), one payment-approval rule, one copy of
tickets/inbox. Extend `scripts/qa/sql/migration-order.mjs`, run `npm run test:migrations`.

**Step 1 — finish the Phase 9 server half** in `feat/manager-p9-server`. Open
`docs/superpowers/plans/2026-10-21-manager-app-phase-9-insights.md`, section
**"Resume here (Part S)"**. Done: S1 city filter, S2 rollups (0170), S3 forecast, S4 zone grid /
vendor benchmarks / SLA (0171), S5 automatic assignment (0172), S6 fraud + SLA as standalone
modules (0173), migration 0174 (scheduled reports + accounting settings). **Not done:** the rest
of S7 (schedule logic, server PDF renderer, runner, routes, cron route, font tracing in
`next.config.ts`, QA script) and all of S8 (accounting export: `ops_accounting_lines`, Tally XML,
journal CSV, admin ledger names).

**Step 2 — Phase 9 integration (I1).** Merge `feat/manager-p9-server` then `feat/manager-p9-app`
into `feat/manager-app`. Wire the fraud and SLA alerts into the alert engine
(`src/lib/ops/alerts/engine.ts`, `facts.ts`, `evaluate.ts` — TODO list is in the plan). Reconcile
the app/server JSON (the app half lists 8 gaps in its execution notes; the server half lists its
deviations). Add Phase 9 routes to the audit-coverage check and PII scan, Phase 9 screens to the
FLAG_SECURE list, and Phase 9 insight endpoints to the performance runner. Extend the contract
check (`npm run test:manager-contract` + `apps/manager/test/contract_*_test.dart`).

**Step 3 — Phase 9 review, then fix round.** Read-only reviewer on a `git archive` copy of the
merged head; fix every finding (they have found real money/security bugs every phase).

**Step 4 — Phase 10 remaining tasks** (`docs/superpowers/plans/2026-10-21-manager-app-phase-10-release.md`):
3 spec conformance audit (~230 rows, fails on any gap), 5 named test suites and full QA run,
8 SECURITY_AUDIT / DEPLOYMENT_AUDIT walk, 9 retire the Capacitor Manager shell, 10 release
build and smoke test of every screen, 11 whole-branch review and fix round, 12 handover +
client summary. Re-run tasks 1, 2, 4, 6, 7 (already built, re-runnable): `npm run test:migrations`,
`npm run test:manager-permissions`, the English-only check, the 100k-order timing runner.

## 4. How the work has been done (keep doing it this way)

Per phase: **P0** merge the sibling branches and reconcile → **Part S** (server) and **Part A**
(app) built in parallel in separate git worktrees (`git worktree add -b feat/manager-pN-server ../deligro-manager-pNs <base>`),
the app half coding against the plan's pinned JSON with fake repositories → **I1** merge both,
contract-check app against real server output → read-only **review** → **fix round** → next phase.
Every task: write the failing test first, see it fail, then implement. Commit per task. Agents
stop at 200 turns; just resume them from the plan's "execution notes".

## 5. Rules that must not be broken

- **English only** on the manager side — no Hindi anywhere (no `tr()`, no `labelHi` on `manager.*`
  keys, no Hindi in manager payloads or pushes). The Partner app is English-only too. A test fails on
  any Devanagari under `apps/manager`.
- **Every audited write is one security-definer database function** that changes and logs
  atomically (`ops_require_staff` pattern, zone-checked in the database, revoked from
  `anon`/`authenticated`, safe to replay). Managers have **no direct write policies** on any table.
- **Zone scope** on every read and write; a manager with no zone sees nothing; `city=` only narrows.
- **No payment by one person.** Payments go through `payment_requests` (maker–checker). The only
  exception is the admin-only setting `allow_single_admin_payments` (off by default), which needs a
  reason and is flagged in the audit log. Completed financial records are never edited — corrections
  are new rows. Approved refunds can never add up to more than the order total.
- **Riders are salaried** (paid outside the app); the rider ledger records salary and payouts, with
  no per-order pay formula.
- **Money figures** come from one place (`src/lib/metrics` and the SQL rollups it is tested against);
  unpaid online checkouts are not orders in any figure.
- **Personal data:** customer phones masked unless `manager.customers.contact` (each reveal audited
  with a reason); bank/ID/licence numbers never leave the server.
- Migrations for this build are **0141–0199**; the Partner app owns 0061–0080, the Rider app 0081–0140.
  This build so far uses 0141–0146, 0150–0158, 0160–0168 on the main line and 0170–0174 on the Phase 9
  server branch. Apply order: 0061 → 0063/0064 → 0081–0087 → 0141 onward.
- Keep wrap-up messages to the owner short and plain.
- Commit messages end with the attribution line your session is told to use.

## 6. Setting up on another computer

1. Clone, `git fetch --all`, check out `feat/manager-app`.
2. `pnpm install --frozen-lockfile` (the npm lockfile is stale). Typecheck needs
   `NODE_OPTIONS=--max-old-space-size=8192`. The SQL proofs need the PGlite package:
   `npm i --no-save @electric-sql/pglite@0.2.17` (pnpm install removes it).
3. **Files that are NOT in git — bring or recreate them:**
   - `.env.local` — Supabase URL/keys etc., see `.env.example`. Also holds the owner's manager test
     login as `QA_MANAGER_EMAIL` / `QA_MANAGER_PASSWORD` (ask the owner; never commit it).
   - `apps/manager/env/prod.json` — copy `env/example.json` and fill the same values the website uses.
   - `apps/manager/android/key.properties` + keystore (alias `manager`) — **does not exist yet**; without
     it, release builds are debug-signed.
4. Flutter: version 3.47.6, JDK 21, Android SDK. On the old PC these lived in `F:\dev` with the Gradle
   cache and temp folder moved there only because drive C: was full — not needed elsewhere.
   Build: `cd apps/manager && flutter build apk --release --dart-define-from-file=env/prod.json`.
   Check: `flutter analyze` and `flutter test --concurrency=2` (a higher concurrency crashed the Dart VM
   when the PC was busy). Always smoke-test the **release** APK on an emulator (cold start must reach the
   English login; a debug build hid a release-only hang once).
5. Useful checks: `npm run test:migrations` (all migrations in order), `npm run test:manager-permissions`,
   `npm run test:manager-contract`, `npx tsx scripts/qa/<script>.ts`.

## 7. APKs built on the old PC

Not in git (they are build outputs). Copies and checksums are in `F:\hub26\apk-handoff\` on the old PC —
copy that folder, or upload the files as release assets. All were built on that PC **without** the
release keystore, so they are **test builds signed with the debug key**.

| File | App | Version | Built from | SHA-256 (first 16) |
|---|---|---|---|---|
| `deligro-manager-2.0.0+2-main-phases1-8.apk` | Manager (`com.ractrotech.deligro.manager`) | 2.0.0+2 | `feat/manager-app` at Phases 1–8 + fixes (just before the Phase 10 groundwork merge) | `dcf5011156b8981e` |
| `deligro-manager-2.0.0+2-phase9-app-preview.apk` | Manager | 2.0.0+2 | `feat/manager-p9-app` `526a731` — adds the Insights screens | `d4c75ad71b9e6da0` |
| `deligro-rider-2.0.0+3.apk` | Rider (`com.ractrotech.deligro.rider`) | 2.0.0+3 | `feat/rider-app` `31b6869` | `3ff7ed12e4daae3d` |
| `deligro-partner-2.0.0+3.apk` | Partner / vendor (`com.ractrotech.deligro.partner`) | 2.0.0+3 | `feat/vendor-app` (build of 2026-10-21) | `2dbb361b01f4820e` |
| `deligro-customer-2.0.0+2.apk` | Customer (`com.ractrotech.deligro`) | 2.0.0+2 | customer app build of 2026-10-21 | `3bb2e3ea9be0b8fa` |

Full hashes: `SHA256SUMS.txt` in the same folder. Install notes:
- Same app IDs as the old Capacitor apps. A debug-signed APK **cannot update** an install signed with a
  different key — uninstall the old app first, or build with the production keystore.
- The Manager APK shows the login screen and the unauthenticated flow. Signed-in screens need the
  migrations applied to the database the app points at (section 8) and a real manager account.
- The Phase 9 preview APK has Insights screens that talk to server routes that are not merged or deployed yet.

## 8. Owner steps (nothing has been applied anywhere)

1. Apply the migrations to staging, then production, in the order in `docs/DATABASE.md`
   (`0061 → 0063/0064 → 0081–0087 → 0141…`), then run `scripts/qa/sql/post-apply-check.sql`.
   Deploy the website **after** `0145` and `0146` are applied (the code reads their columns).
2. Create or fix the manager test account in the live database (the test login is currently refused:
   the account is missing there or has a different password). Then the signed-in QA checks can run.
3. In Admin: assign each manager's zones; switch on the sensitive permissions per person (they default off);
   configure alert thresholds; decide whether to turn on `allow_single_admin_payments`.
4. Create the release keystore (alias `manager`) and `key.properties`; rebuild signed APKs.
5. Remove the demo logins listed in plain text in `docs/HANDOFF.md` and `docs/DATABASE.md` (old commits).
6. Delete leftover folders on the old PC (git no longer tracks them): `deligro-manager-p7s`, `-p7f`, `-p10`
   (and any other `deligro-manager-p*` that `git worktree list` doesn't show).
7. Tell the Rider/Partner sessions: a customer reply on a closed support ticket now returns `409 ticket_closed`
   (their apps show a generic error until handled); the Rider branch's `0082` rebuilds `guard_order_update`
   from `0055`, so applying it after `0061`/`0063` drops their locks until `0141` is re-run — apply in order.

## 9. Known open items and decisions

- **Speed at 100,000 orders** (measured on a slow in-memory database): dashboard 0.8–1.5 s, finance overview
  1.5 s, a year of statistics 2.3 s vs a 0.8 s budget. The fix is a daily rollup table — deliberately not built
  (changes how every figure is produced). Options and the first step (measure on the real database) are in
  `docs/manager-app-performance.md`.
- Approving a rider's delivery exception fails the delivery in a retried follow-up step, not inside one
  database transaction (every change is logged and a retry finishes it). Making it atomic was judged too risky.
- 88 places say "shop" where the client's table says "Vendor" — `docs/manager-app-terminology.md`; the
  `--strict-terms` option of the English-only check gates them for the final pass.
- Password sign-in tells a banned customer they are suspended (rate-limited); OTP sign-in reveals nothing.
- Per-device sign-out depends on Supabase letting a database function delete from `auth.sessions` — unconfirmed
  on the real project.
- The Partner app (`apps/vendor`) does not yet show why a dish is pending/hidden, and handles `ticket_closed`
  generically.
- Signed-in checks (idor, e2e, ZAP) have never run — they need the migrations applied and the test login.

## 10. Paste this to start the next session

> Continue the Deligro Manager app build. Read `docs/manager-app-resume.md` first, then follow section 3
> in order (step 0: merge `feat/rider-app` into `feat/manager-app` and reconcile; then finish the Phase 9
> server half; Phase 9 integration; review and fixes; Phase 10 remaining tasks). English only on the manager
> side. Keep going until all ten phases are finished; keep reports short and plain.
