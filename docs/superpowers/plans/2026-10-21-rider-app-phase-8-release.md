# Rider App — Phase 8: Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Rider app is ready to hand to the client as a test build: every screen in clear English with no Hindi left anywhere, the security and deployment checklists walked and logged for everything this project added, the full QA suite green on a low-end device profile, a release APK built and smoke-tested, and handover notes that tell the owner exactly what to apply, configure and sign.

**Spec:** `docs/superpowers/specs/2026-10-21-rider-app-design.md` (*Testing and release (§18)*, *Owner steps outside this repo*, requirement map)

## Global Constraints

- **Owner override (2026-10-21): the Rider app is ENGLISH ONLY — no Hindi anywhere on the rider side.** Ignore every mention below of Hindi, `tr(en, hi)`, `langProvider`, bilingual copy, `name_hi`/`nameHi`/`title_hi`, Devanagari or a language setting; write plain English strings and English-only tests. (The customer app and website keep their own language support untouched.)
- Earlier phases' Global Constraints and rulings apply.
- Nothing is applied to the live database and nothing is pushed or published: the owner applies migrations, deploys and signs.
- Low-end profile: AVD `deligro_low` (Android 10, 2 GB RAM, 720×1440, x86_64) created under `F:\dev\android-user\avd`.

## Review Focus

1. **A long English string (button, error, address)** → no overflow at 1.3× text on 720 px width (Task 1 golden-free overflow test over every screen).
2. **A requirement in the client's document with no working screen** → caught by the requirement-coverage check (Task 3).
3. **The migrations applied in order 0081 → 0087 on a database at 0060** → every proof passes when run in sequence on one PGlite instance (Task 2).
4. **Cold start on the low-end AVD** → splash to login < 4 s, Jobs polling does not grow memory over 10 minutes (Task 4).
5. **App left online overnight** → the foreground service and polling do not drain more than the measured budget; the rider is marked stale by the presence window when the phone sleeps the service (Task 4 observation logged).

---

### Task 1: English-only sweep and text-scale pass

**Files:** `apps/rider/lib/**`, `apps/rider/test/**`; Create `apps/rider/test/no_hindi_test.dart`.
- [ ] `no_hindi_test.dart` scans every file under `apps/rider/lib/` and `apps/rider/test/` and fails on any Devanagari character (U+0900–U+097F) or any remaining `langProvider`/language-setting reference. Every user-facing string reviewed for short, plain English a rider reads at a glance. A widget test pumps every route at 1.3× text on a 360×720 logical surface and fails on any overflow. Fix all. analyze, test. Commit `fix(rider-app): English-only copy and text-scale pass`.

### Task 2: Migrations in sequence, security and deployment checklists

**Files:** Create `scripts/qa/sql/rider-migrations-sequence.mjs`; Modify `docs/SECURITY_AUDIT.md` log, `docs/DEPLOYMENT_AUDIT.md` log, `docs/DATABASE.md`.
- [ ] The sequence script loads the stubs once, applies 0081–0087 in order on one PGlite instance and runs every proof's assertions against it; then re-applies every migration (idempotency) and asserts nothing changes. Walk `docs/SECURITY_AUDIT.md` for every new table, policy, grant, bucket, function and route of phases 1–7 and log each line; walk `docs/DEPLOYMENT_AUDIT.md` for the website changes. Fix any finding (each fix its own commit). Commit `docs(release): rider app security and deployment checklists`.

### Task 3: Requirement coverage check and QA run

**Files:** Create `docs/rider-app-requirements-coverage.md`, `scripts/qa/rider-run-all.sh`.
- [ ] For every numbered line of the client's document (the spec's requirement map), record the screen or server behaviour that delivers it and the test that proves it; any line without both is a defect fixed here. `rider-run-all.sh` runs every rider-related QA script, every PGlite proof, tsc, lint, idor, platform, customer-layout, and both Flutter apps' analyze/test; it exits non-zero on any failure. Run it; all green. Commit `test(rider-app): requirement coverage and full QA run`.

### Task 4: Release build, low-end device run, handover

**Files:** Modify `apps/rider/pubspec.yaml` (final version `2.0.0+3`), `mobile/roles.json` (rider entry points to the Flutter build), Create `apps/rider/README.md`, `docs/rider-app-handover.md`.
- [ ] Build the release APK with R8 (`flutter build apk --release --dart-define-from-file=env/prod.json`), install on `deligro_low`, cold-start timing, a 10-minute online session with location and Jobs polling (memory via `adb shell dumpsys meminfo`), screenshots of every screen in English and Hindi, light and dark (fixture build for server-dependent screens). Handover doc: what shipped (per phase, per requirement), the deploy order (website → migrations 0081…0087 in order → restart app instances → set rate card, incentive rules, POD rule, unreachable wait, cash limits, targets, demand thresholds, support numbers, privacy/terms URLs → sign APK with the rider alias → raise `rider_apk_version_code`/`min_version_code` and URL), staging checks (including the order/delivery disagreement check from Phase 1's deferred minor), known limitations, and the list of Claude's rulings. Commit `chore(rider-app): release build, handover notes`.

---

## Phase exit

`scripts/qa/rider-run-all.sh` green; release APK on the low-end AVD; handover doc complete; final whole-branch review.
