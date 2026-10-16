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

## Results (all batches, 2026-10-16)

Every batch is its own local commit and passed `tsc`, `eslint`, `pnpm knip`, `pnpm build` and the QA suites covering its files. After the last batch, the whole tree passed `tsc`, `eslint` (0 errors, the same 3 pre-existing `<img>` warnings), `knip`, `pnpm build`, all 38 offline QA suites and the 21 `mobile` tests. Two independent read-only reviews checked batches 6 and 9 hunk by hunk and found no behaviour change; they covered every protected file those batches touched.

| Batch | Commit(s) | Rule(s) | Fixed | Left (see Accepted list) |
|---|---|---|---|---|
| Scope | `2ddb7f2` | generated seed + HTML reports out of analysis | — (540 leave the count) | — |
| 1 | `64c7279` | Blocker `S128` + mechanical idioms | 66 | 1 |
| 2 | `055cb56` | `S6759` read-only props (type-only, all files) | 382 | 0 |
| 3 | `4f44671` | `S7778` merged `push()` (AST-proven identical output) | 131 | 0 |
| 4 | `393e494` | `S6551` `formString` for FormData reads | 46 | 0 |
| 5 | `b76baf2` | `S6478` column definitions hoisted out of pages | 53 | 0 |
| 6 | `4a8dd40` `448881d` `89bca92` | `S3358` nested ternaries | 215 | 1 |
| 7 | `94fc955` `75c9135` | small rules (`S4624`, `S3735`, `S6479`, `S4666`, …) | 43 | 7 |
| 8 | `3bd1d7d` | `S1874` deprecated `StatTile`/`KpiStrip` adapters (+1 `S4624`) | 56 | 0 |
| 9 | `8dca3a8` `463f83d` `cfac6e4` | `S3776` cognitive complexity | 67 (+9 already resolved by earlier batches) | 8 |
| 10 | `70d9072` `53a9cff` | Batch 1 idioms inside protected files | 35 | 1 |
| Case-by-case | `b72f870` `d7bcd02` `451ce93` `ed427e5` | `S9382`, `css:S9423`, `S6819`, SQL `ORDER BY` | 1 + 1 + 3 + 9 | 38 + 34 + 17 + 1 |

**Totals:** about 1,120 issues fixed in code, 540 out of scope, about 175 to mark *Accepted*. The exact counts come from the next SonarCloud analysis.

**The two behaviour changes, both deliberate:**
- **Batch 4:** a `File` posted where a text field is expected now reads as `""` (or the stated fallback), not `"[object File]"`.
- **Batch 8:** the migrated admin screens now import the console kit directly. The adapter already rendered through those components, so they look the same.

**Protected-area rule as applied.** In auth/OTP, checkout submission, payments, order-state transitions, dispatch, refunds, settlement money logic, the service worker and webhooks, only these kinds of change were made:
- rewrites that are provably identical;
- pure helper extractions, with every check, throw and early return kept in its original order;
- presentation-only changes.

Anything that would restructure gates, state transitions or DB writes was left and is on the Accepted list.

## Accepted list — mark these in SonarCloud with the reason given

| Where | Rule | Count | Reason |
|---|---|---|---|
| `supabase/migrations/*` | `plsql:S1192`, `LiteralsNonPrintableCharactersCheck` | 66 | Applied migrations are an immutable history. |
| `docs/rls-verification.sql` | `plsql:S1192` | 1 | Each block is pasted and run on its own; a shared constant would break that. |
| `src/app/globals.css` | `css:S9423` | 34 | The reduced-motion reset and the print/PDF block must beat specific screen rules and an inline table `min-width`. |
| Sheets and modals (`confirm-dialog`, `item-sheet`, `search-sheets`, `address-picker-sheet`, checkout, `delivery-map-screen`, `tracking-view`, …) | `S6819` dialog | 15 | Custom sheets with their own focus and Escape handling. A native `<dialog>` changes top-layer stacking, focus, sizing and UA colours, and pulls them out of the phone frame. |
| `splash-screen.tsx`, `driver-board.tsx` "Delivery complete" | `S6819` status | 2 | `<output>` may only contain phrasing content; both contain block elements. |
| Dispatch sweep, slot writes, menu import, bulk upload, legacy import/seed scripts | `S9382` | 38 | Deliberately sequential: riders shared across orders, ordered non-atomic writes, last-write-wins, pagination, retry with backoff, worker pools, throttled imports. |
| `settlePayment`, `decideRefund`, `writeOffer`, `CheckoutView`, `placeOrder`, `writeSettlement`, `advanceDelivery`, `createOrder` | `S3776` | 8 | What remains is gates, state transitions and DB writes. Splitting them further would mean restructuring protected control flow. |
| `cod-rules.ts` `codRefusal` | `S3358` | 1 | A payment-domain value, not presentation. |
| OTP digit boxes, calendar spacer cells, fixed text lists, draft menu rows, stack-trace lines | `S6479` | 7 | Position is the identity, or no stable unique value exists. |
| `vendor-registration.ts` `base || "shop"` | `S7760` | 1 | A default parameter would not cover `""`. |
| `src/proxy.ts` matcher | `S7780` | 1 | Next reads `config.matcher` statically, so it must stay a plain string literal. |

## Batch 1 detail — applied 2026-10-16

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

**Checks run:** `tsc` (app) clean · `eslint src scripts` 0 errors, the same 3 pre-existing `<img>` warnings · `knip` clean · `pnpm build` passes · all 38 offline QA suites pass · `mobile` tests 21/21. The scripts typecheck still shows its pre-existing errors in `import-legacy-customers.ts`, `legacy-db.ts:140–145` and `set-vendor-phone.ts:156`; none of them are on lines this batch changed. `test:idor`, `test:e2e` and `test:zap` weren't run (they need credentials, a server or a ZAP target).

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
- 38 offline QA suites (`pnpm run test:*`), plus `mobile` `node --test` (21 tests)
- Can't run here: `test:idor` (needs `QA_PASSWORD` / Supabase), `test:e2e` (needs a running server), `test:zap` (needs a ZAP target)

## Log

| Date | Batch | Issues before → after | Notes |
|---|---|---|---|
| 2026-10-16 | Baseline (audit only) | 1,838 | No code changed. |
| 2026-10-16 | Scope: exclude generated seed + HTML reports | 1,838 → expected 1,298 | Config only (`.sonarcloud.properties`). Takes effect on the next analysis. |
| 2026-10-16 | Batch 1 | expected −66 → 1,232 | 45 files. |
| 2026-10-16 | Batches 2–10 + case-by-case | expected ≈ 1,232 → ≈ 175 open | All of them are on the Accepted list above; marking those leaves ≈ 0. Not yet pushed: confirm against the next SonarCloud analysis of `master` and record the real numbers here. |
