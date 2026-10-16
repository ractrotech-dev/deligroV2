# SonarQube Cloud — Maintainability Audit

**Project:** `whiteslam_deligro26` · **Branch:** `master` · **Analysis:** commit `b05e8ad` (2026-10-16)
**Source of findings:** SonarCloud Web API (`api/issues/search`, open + confirmed, maintainability impact), all 1,838 issues fetched (no sampling). Nothing below is inferred.

## Baseline

| Metric | Value |
|---|---|
| Open maintainability issues | **1,838** |
| By severity | Blocker 5 · High 688 · Medium 396 · Low 749 |
| Estimated remediation effort (sum of issue efforts) | ~167 h |
| Technical-debt ratio / rating | 0.3 % · **A** |
| Distinct rules | 50 |
| Analysis scope | `.sonarcloud.properties`: `scripts/qa/**` and `mobile/scripts/*.test.mjs` are test code; `backups/**` excluded |

The rating is already A; the count is large mostly because of a few mechanical rules and one generated file.

## Where the issues are

| Area | Issues | Notes |
|---|---|---|
| `supabase/seed/legacy_catalog.sql` | 528 | **Generated** by `scripts/generate-legacy-seed-sql.ts` (header says so). All are `plsql:S1192`. |
| `src/app` (pages, server actions) | 469 | Mostly admin/developer screens. |
| `src/components` | 409 | |
| `scripts/` (non-test) | 185 | 129 of them are `S7778` in the two legacy SQL generators. |
| `src/lib` | 128 | Contains most protected logic (auth, orders, payments, dispatch). |
| `supabase/migrations` | 65 | Append-only history. |
| Root / `docs` HTML reports | 22 | Audit reports, not product code. |
| `src/app/api` | 18 | |
| other (`src/stores`, `public`, `src/hooks`) | 14 | |

## Rules by frequency

Risk: **L** = no runtime effect or purely syntactic · **M** = small runtime change, verifiable · **H** = touches protected logic or visible UI/behaviour.

| # | Rule | Name | Issues | Severity | Effort | Files | Risk | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `plsql:S1192` | String literals should not be duplicated | 593 | High | 40 h | 24 | — | 528 in the generated seed, 65 in applied migrations. See **Scope decisions**. |
| 2 | `typescript:S6759` | React props should be read-only | 382 | Low | 32 h | 214 | L | Type-only (`Readonly<…>`); 28 files are in protected areas. |
| 3 | `typescript:S3358` | Ternary operators should not be nested | 221 | Medium | 18 h | 105 | M–H | Concentrated in checkout-view (17), driver-board (16), tracking-view (12). |
| 4 | `typescript:S7778` | Combine consecutive `push()` calls | 131 | Low | 11 h | 4 | L | 129 in the two legacy SQL generators. |
| 5 | `typescript:S3776` | Cognitive complexity too high | 86 | High | 19 h | 78 | H | Spread thin (1–3 per file); includes OTP request route, checkout, refunds, settlements. |
| 6 | `typescript:S1874` | Deprecated APIs | 55 | Low | 14 h | 8 | M | All are our own `@deprecated` `StatTile`/`StatTiles`/`KpiItem` adapter in `console-ui.tsx`; migrating changes the look of 7 admin screens. |
| 7 | `typescript:S6478` | Components defined inside components | 53 | Medium | 4 h | 6 | M | Admin pages (cash-ledger 18, vendors 13, settlements 13). Nested definitions remount every render; moving them out is a real fix. |
| 8 | `typescript:S6551` | Object default stringification | 46 | Low | 4 h | 13 | M | `String(formData.get(k) ?? "")` where the value may be a `File`. Server actions in admin/developer. |
| 9 | `typescript:S9382` | `await` in a loop | 39 | Low | 3 h | 15 | M–H | Several are deliberately sequential (dispatch sweep, imports). Needs case-by-case judgement, not a blanket `Promise.all`. |
| 10 | `css:S9423` | `!important` | 38 | Medium | 3 h | 5 | H | 34 in `globals.css`; visual regressions likely. |
| 11 | `typescript:S4624` | Nested template literals | 24 | Medium | 4 h | 20 | L | |
| 12 | `typescript:S6582` (+ js) | Prefer optional chaining | 24 | Low | 2 h | 18 | L | 12 in protected files (driver-orders, checkout-view, sw-core). |
| 13 | `typescript:S6819` | Prefer native tag over ARIA role | 19 | Medium | 2 h | 19 | H | 14 ask for `<dialog>`: changes focus/top-layer behaviour of sheets. |
| 14 | `typescript:S7755` | Use `.at()` | 12 | Low | 1 h | 10 | L | |
| 15 | `typescript:S7741` | `typeof x === "undefined"` | 11 | Low | <1 h | 11 | L | |
| 16 | `typescript:S7776` | Arrays used only for lookups → `Set` | 11 | Medium | 1 h | 10 | L | |
| 17 | `css:S1874` | Deprecated CSS | 9 | Low | 2 h | 9 | — | All in HTML audit reports. |
| 18 | `plsql:OrderByExplicitAscCheck` | ORDER BY direction | 7 | Low | <1 h | 1 | — | Migrations/docs SQL. |
| 19 | `typescript:S6479` | Array index as `key` | 6 | Medium | <1 h | 5 | M | |
| 20 | `typescript:S128` | Switch case falls through | **5** | **Blocker** | <1 h | 1 | L | See below. |
| 21 | `typescript:S3735` | `void` operator | 5 | High | <1 h | 2 | L | |
| — | 29 other rules | | 51 | mixed | ~5 h | | L–M | Each ≤ 5 issues (unused assignments, merge imports, `export…from`, nullish coalescing, `RegExp.exec`, etc.). |

Top files: `legacy_catalog.sql` 528 · `generate-legacy-seed-sql.ts` 81 · `generate-legacy-customers-sql.ts` 49 · `globals.css` 38 · `checkout-view.tsx` 27 · `registration-wizard.tsx` 25 · `driver-board.tsx` 24 · `admin/cash-ledger/page.tsx` 21 · `admin/settlements/page.tsx` 20 · `obs-ui.tsx` 19.

### The five Blocker issues

`src/app/developer/observability/layout.tsx:74–82`. The `switch` in the search server action calls `redirect()` in every case without `return`. `redirect()` returns `never` (it throws), so nothing actually falls through, but Sonar can't know that. Fix: `return redirect(…)`. Same behaviour, and the intent is visible to readers too. The `requireRole("developer")` check above it is untouched.

## Scope decisions (approved 2026-10-16)

These are about *what Sonar should analyse*, not about disabling rules. Each has a written reason.

1. **`supabase/seed/legacy_catalog.sql` (528 issues). Applied.** Generated output with literal data rows; "define a constant" is meaningless for an INSERT list. The fix belongs in the generator, which is still analysed. `supabase/seed/**` is now in `sonar.exclusions`.
2. **`supabase/migrations/*.sql` (65 issues). To do in the SonarCloud UI.** These are applied, append-only history. Editing them would change the record of what ran, and this work may not touch the schema. They stay in analysis; mark each one *Accepted* with the reason "applied migration — immutable". New migrations stay fully checked.
3. **Root and `docs/` `*.html` audit reports (12 issues). Applied.** Static reports, not shipped. `*.html,docs/**/*.html` are now in `sonar.exclusions`. `public/offline.html` ships, so it stays in. (The audit first said 22; the other 10 are `docs/rls-verification.sql`, which stays in analysis.)

Together these take 605 issues out of the count *without changing any code*: 540 by scope, 65 by acceptance. They're counted separately so the remediation batches aren't credited with them.

## Remediation plan (batches)

Each batch is one isolated commit, and each must pass `tsc`, `eslint`, `pnpm knip`, `pnpm build` and the QA scripts relevant to the files touched.

| Batch | Scope | Issues | Risk | Verification |
|---|---|---|---|---|
| **1** ✅ | Blocker `S128` + mechanical syntax rules **outside protected areas** (see below) | 66 | L | tsc, lint, build, all offline QA suites |
| 2 | `S6759` read-only props, non-protected components first | ~330 | L | tsc (type-only change) |
| 3 | `S7778` in the two legacy SQL generators | 129 | L | The generator output must be byte-identical. The real source JSON isn't in the repo, so this needs a fixture run (or your export). |
| 4 | `S6551` — one `formString(fd, key)` helper for server-action form reads | 46 | M | Behaviour note: a `File` would read as `""` instead of `"[object File]"`. |
| 5 | `S6478` nested components in admin pages | 53 | M | Visual check of 6 admin screens |
| 6 | `S3358` nested ternaries, non-protected files | ~150 | M | tsc, lint, build, visual spot-check |
| 7 | `S4624`, `S7776`, `S6479`, `S3735`, remaining small rules | ~60 | L–M | |
| 8 | `S1874`: migrate the 7 admin screens off the deprecated `StatTile` adapter, then delete it | 55 | M | Visual review. It's a deliberate design change, so it needs your sign-off. |
| 9 | `S3776` complexity, one function at a time, non-protected first | 86 | H | Per-function tests or QA coverage before refactoring |
| Later / case-by-case | `S9382`, `S6819`, `css:S9423`, and anything in protected areas | ~95 | H | Individual review. Where the current code is deliberate, mark it *Accepted* with a reason rather than change it. |

**Protected areas** (auth, RLS/migrations, checkout, payments, order transitions, dispatch, webhooks, service worker, notifications, generated types) are deferred to the last batches. They're only touched with targeted tests, and never just to lower the count.

## Batch 1 — applied 2026-10-16 (local commit, not pushed)

**Result:** 66 issues fixed in 45 files, all 5 Blockers included. No runtime behaviour change.

| Rule | Fixed |
|---|---|
| `S128` switch fall-through (Blocker) | 5 |
| `S7741` `typeof … === "undefined"` | 10 |
| `S6582` optional chaining | 9 |
| `S7755` `.at()` | 9 |
| `S7776` lookup-only array → `Set` | 8 |
| `S6594` `match` → `exec` | 4 |
| `S7763` `export … from` | 4 |
| `S6606` `??` / `??=` | 3 |
| `S3863`, `S4323`, `S6571`, `S6535`, `S6644` | 2 each |
| `S7780`, `S7749`, `S7747`, `S6557` | 1 each |

**Semantics notes.**
- `.at()` is typed `T | undefined`. Where the old code already guaranteed an element, the fallback added (`?? 0` in `route-path.ts`, `?? ""` in `format.ts`) can't be reached; it only satisfies the type checker.
- Each `Set` replaced an array that was only ever used for `.includes()`.
- `??=` is only used where the value can't be falsy without also being null.
- `a.startsWith(b[0])` in `semantic.ts` is guarded by `if (!a || !b) return false`.

**Deferred from Batch 1 (8):**
- **Seven sit in protected files**, under the protected-areas rule: the order-transition guards (`admin/orders/actions.ts`, `order-intervention.tsx`), rider and manager workflows (`driver/actions.ts`, `driver-board.tsx`, `manager/actions.ts`), and cart pricing (`utils/cart.ts`, `stores/cart-store.ts`).
- **One isn't fixable as Sonar suggests:** `S7760` in `vendor-registration.ts`, `base || "shop"`. A default parameter only replaces `undefined`, while `||` also replaces `""`, so following the rule would change behaviour for an empty shop name. It stays as is; mark it *Accepted* in SonarCloud with that reason.

**Checks run:** `tsc` (app) clean · `eslint src scripts` 0 errors, the same 3 pre-existing `<img>` warnings · `knip` clean · `pnpm build` passes · all 52 offline QA suites pass · `mobile` tests 21/21. The scripts typecheck still shows its pre-existing errors in `import-legacy-customers.ts`, `legacy-db.ts:140–145` and `set-vendor-phone.ts:156`; none of them are on lines this batch changed. `test:idor`, `test:e2e` and `test:zap` weren't run (they need credentials, a server or a ZAP target).

### Original Batch 1 proposal

**Goal:** remove the 5 Blockers and clear low-risk syntactic smells with no behaviour change. Protected files are excluded even when the rule is trivial.

| Rule | What changes | Issues in batch | Left for later (protected files) |
|---|---|---|---|
| `S128` | `return redirect(…)` in `developer/observability/layout.tsx` | 5 | 0 |
| `S6582` | `a && a.b` → `a?.b` | 12 | 12 (driver-orders, checkout-view, sw-core) |
| `S7755` | `arr[arr.length - 1]` → `arr.at(-1)` | 9 | 3 (otp-limits, driver-orders, admin-settlements) |
| `S7741` | `typeof x === "undefined"` → `x === undefined` (only where `x` is a declared binding) | 10 | 1 |
| `S7776` | lookup-only arrays → `Set` | 10 | 1 |
| `S6594` | `str.match(re)` → `re.exec(str)` (non-global regex only) | 4 | 0 |
| `S7763` | `import`+`export` → `export … from` | 4 | 0 |
| `S3863` | merge duplicate imports | 2 | 2 |
| `S6606` | `a !== null && a !== undefined ? a : b` → `a ?? b` | 3 | 0 |
| `S6644`, `S6535`, `S6571`, `S6557`, `S7749`, `S7754`, `S7760`, `S7747`, `S4323`, `S7780`, `S6598` | one-line idiom fixes | 14 | 6 |
| `S1854` / `S4165` | unused or redundant assignments | 1 | 5 (driver-orders, orders, cod-rules) |

**Expected:** 74 fewer issues, 0 Blockers, no runtime behaviour change. Each changed line is reviewed for semantics; for example, `.at(-1)` and `?.` are only applied where the original expression has the same value for every input, and `match`→`exec` only for non-global regexes.

## Checks available in this repo

- `npx tsc --noEmit -p .` (the project tsconfig excludes `scripts/`, so they get a separate typecheck)
- `pnpm lint` (eslint-config-next core-web-vitals + typescript)
- `pnpm knip`
- `pnpm build`
- 52 offline QA scripts (`pnpm run test:*`), plus `mobile` `node --test`
- Can't run here: `test:idor` (needs `QA_PASSWORD` / Supabase), `test:e2e` (needs a running server), `test:zap` (needs a ZAP target)

## Log

| Date | Batch | Issues before → after | Notes |
|---|---|---|---|
| 2026-10-16 | Baseline (audit only) | 1,838 | No code changed. |
| 2026-10-16 | Scope: exclude generated seed + HTML reports | 1,838 → expected 1,298 | Config only (`.sonarcloud.properties`). Takes effect on the next analysis. |
| 2026-10-16 | Batch 1 | expected −66 → 1,232 | 45 files. Confirm against the next SonarCloud analysis of `master`. |
