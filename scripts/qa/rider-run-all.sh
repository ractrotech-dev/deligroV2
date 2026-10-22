#!/usr/bin/env bash
# Rider app — full QA run (Phase 8 Task 3).
#
# Runs, in order, and exits non-zero if any step fails:
#   1. every rider-related QA script in package.json (listed explicitly below)
#   2. every PGlite migration proof, then the 0081→0087 sequence script
#   3. tsc --noEmit
#   4. lint
#   5. IDOR suite
#   6. platform separation
#   7. customer layout
#   8. apps/rider and apps/customer: flutter pub get, flutter analyze, flutter test
# and prints a summary table at the end.
#
# A QA script or PGlite proof that exits 0 must also report at least one
# passed check ("N passed", "PASS N checks", "(N groups)" or "ok" lines), or
# its step FAILS — an empty run is not a green one. The one exception is
# test:rider-api, whose every tier needs a running dev server; it shows
# "ran 0 checks".
#
# Usage (Git Bash on Windows, from anywhere):
#   bash scripts/qa/rider-run-all.sh
#
# Never touches a live service. The QA scripts run their data tiers against
# in-process fakes; their HTTP contract tiers only talk to a dev server on
# localhost and print SKIP when none is running. The IDOR suite provisions QA
# accounts and fixtures in whatever Supabase project it is pointed at, so it
# runs only when you opt in for a staging/local project (see RIDER_QA_IDOR).
#
# Environment (all optional):
#   RIDER_QA_TMP        temp folder for this run       (default F:/dev/tmp/run-all)
#   PUB_CACHE           Dart/Flutter package cache     (default F:/dev/pub-cache)
#   GRADLE_USER_HOME    Gradle home                    (default F:/dev/gradle-home)
#   npm_config_cache    npm cache                      (default F:/dev/npm-cache)
#   PGLITE_REGISTER     node --import hook for PGlite  (default F:/dev/tmp/pglite-p5/register.mjs)
#   PGLITE_NODE_PATH    NODE_PATH for PGlite proofs    (default F:/dev/tmp/pglite-p5/node_modules)
#   FLUTTER             flutter executable             (default: flutter on PATH)
#   MANAGER_REPO / MANAGER_REF  where the 0085/0086 convergence proofs read the
#                       Manager branch's committed 0150/0152 (default
#                       F:/hub26/deligro-manager, feat/manager-app); or set
#                       M0150 / MANAGER_0150 / M0152 to files directly
#   RIDER_QA_IDOR=1     run the IDOR suite (needs QA_PASSWORD + Supabase keys of a
#                       NON-production project; it creates accounts and fixtures there)
#   RIDER_QA_ALLOW_REMOTE=1  allow BASE / BASE_URL to point somewhere other than localhost
#   RIDER_QA_FAIL_FAST=1     stop at the first failing step
#   RIDER_QA_VERBOSE=1       stream every step's output (default: log file, tail on failure)
#   RIDER_QA_SKIP_FLUTTER=1  leave out the Flutter steps (e.g. a quick server-only run)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

# ── Environment ─────────────────────────────────────────────────────────────
RIDER_QA_TMP="${RIDER_QA_TMP:-F:/dev/tmp/run-all}"
mkdir -p "$RIDER_QA_TMP" || { echo "Cannot create $RIDER_QA_TMP" >&2; exit 2; }
export TEMP="$RIDER_QA_TMP" TMP="$RIDER_QA_TMP" TMPDIR="$RIDER_QA_TMP"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Djava.io.tmpdir=$RIDER_QA_TMP}"
export PUB_CACHE="${PUB_CACHE:-F:/dev/pub-cache}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-F:/dev/gradle-home}"
export npm_config_cache="${npm_config_cache:-F:/dev/npm-cache}"
PGLITE_REGISTER="${PGLITE_REGISTER:-F:/dev/tmp/pglite-p5/register.mjs}"
PGLITE_NODE_PATH="${PGLITE_NODE_PATH:-F:/dev/tmp/pglite-p5/node_modules}"
FLUTTER="${FLUTTER:-flutter}"

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$RIDER_QA_TMP/logs-$STAMP"
mkdir -p "$LOG_DIR" || exit 2

# Refuse to aim the HTTP tiers at a deployed site by accident.
for var in BASE BASE_URL; do
  val="${!var:-}"
  if [[ -n "$val" && "${RIDER_QA_ALLOW_REMOTE:-}" != "1" ]] &&
     ! [[ "$val" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]]; then
    echo "$var=$val is not localhost. This run never calls a deployed site." >&2
    echo "Unset it, or set RIDER_QA_ALLOW_REMOTE=1 for a staging target." >&2
    exit 2
  fi
done

# ── Step runner ─────────────────────────────────────────────────────────────
NAMES=(); RESULTS=(); TIMES=(); NOTES=()
FAILED=0
N=0

record() { # name result seconds note
  NAMES+=("$1"); RESULTS+=("$2"); TIMES+=("$3"); NOTES+=("$4")
}

# How many checks a QA script or PGlite proof says it passed: "N passed",
# "PASS N checks", "PASS … (N groups)", else the number of "ok" lines. 0 when
# it printed none of those.
checks_in() { # log
  local n
  n=$(grep -o -E '(^|[^0-9])[0-9]+ passed' "$1" 2>/dev/null | grep -o -E '[0-9]+' | tail -n 1)
  [[ -z "$n" ]] && n=$(grep -o -E 'PASS [0-9]+ checks' "$1" 2>/dev/null | grep -o -E '[0-9]+' | tail -n 1)
  [[ -z "$n" ]] && n=$(grep -o -E '^PASS .*\(([0-9]+) groups\)' "$1" 2>/dev/null | grep -o -E '[0-9]+ groups' | grep -o -E '[0-9]+' | tail -n 1)
  [[ -z "$n" ]] && n=$(grep -c -E '^[[:space:]]*ok[[:space:]]' "$1" 2>/dev/null || true)
  echo "${n:-0}"
}

# Steps run with COUNT=1 must report at least one passed check: a script that
# exits 0 having checked nothing (a tier that silently skipped, an empty
# proof) is a FAIL. COUNT=zero-ok allows 0 for a script documented to need a
# running server (test:rider-api); it is still shown as "ran 0 checks".
COUNT=0

# step <name> <command...>  — runs the command from the repo root
step() {
  local name="$1"; shift
  N=$((N + 1))
  local log; log="$LOG_DIR/$(printf '%02d' "$N")-${name//[^A-Za-z0-9._-]/_}.log"
  printf '── %02d %-44s ' "$N" "$name"
  local t0=$SECONDS rc
  if [[ "${RIDER_QA_VERBOSE:-}" == "1" ]]; then
    echo; "$@" 2>&1 | tee "$log"; rc=${PIPESTATUS[0]}
  else
    "$@" >"$log" 2>&1; rc=$?
  fi
  local dt=$((SECONDS - t0))
  # Inner SKIP lines (e.g. "dev server unreachable") are reported, not failed.
  local inner; inner=$(grep -c -E '(^|[^A-Za-z])(SKIP|skip)([^A-Za-z]|$)' "$log" 2>/dev/null || true)
  local note=""; [[ "${inner:-0}" -gt 0 ]] && note="$inner inner SKIP line(s)"
  # A script whose every tier skipped still exits 0; say so rather than hide it.
  if grep -q -E '(^|[^0-9])(PASS 0 checks|0 passed)' "$log" 2>/dev/null; then
    note="ran 0 checks${note:+; $note}"
  fi
  if [[ $rc -eq 0 && "$COUNT" != "0" ]]; then
    local checks; checks=$(checks_in "$log")
    if [[ "${checks:-0}" -gt 0 ]]; then
      note="$checks checks${note:+; $note}"
    elif [[ "$COUNT" != "zero-ok" ]]; then
      echo "FAIL (${dt}s, reported no passed checks) — $log"
      [[ "${RIDER_QA_VERBOSE:-}" == "1" ]] || tail -n 20 "$log" | sed 's/^/     │ /'
      record "$name" FAIL "$dt" "exit 0 but no 'N passed' line; log $log"
      FAILED=$((FAILED + 1))
      if [[ "${RIDER_QA_FAIL_FAST:-}" == "1" ]]; then summary; exit 1; fi
      return
    fi
  fi
  if [[ $rc -eq 0 ]]; then
    echo "PASS (${dt}s)"
    record "$name" PASS "$dt" "$note"
  else
    echo "FAIL (${dt}s, exit $rc) — $log"
    [[ "${RIDER_QA_VERBOSE:-}" == "1" ]] || tail -n 40 "$log" | sed 's/^/     │ /'
    record "$name" FAIL "$dt" "exit $rc; log $log"
    FAILED=$((FAILED + 1))
    if [[ "${RIDER_QA_FAIL_FAST:-}" == "1" ]]; then summary; exit 1; fi
  fi
}

skip_step() { # name reason
  N=$((N + 1))
  printf '── %02d %-44s SKIP — %s\n' "$N" "$1" "$2"
  record "$1" SKIP 0 "$2"
}

has_npm_script() {
  node -e "process.exit(require('./package.json').scripts?.[process.argv[1]] ? 0 : 1)" "$1"
}

npm_step() { # npm script name
  if has_npm_script "$1"; then
    step "npm run $1" npm run --silent "$1"
  else
    N=$((N + 1))
    printf '── %02d %-44s FAIL — no such npm script\n' "$N" "npm run $1"
    record "npm run $1" FAIL 0 "script missing from package.json"
    FAILED=$((FAILED + 1))
  fi
}

pglite() { # node <file> with the PGlite resolve hook
  NODE_OPTIONS="--import=file:///${PGLITE_REGISTER#/}" NODE_PATH="$PGLITE_NODE_PATH" "$@"
}

flutter_in() { # dir args...
  local dir="$1"; shift
  (cd "$ROOT/$dir" && "$FLUTTER" "$@")
}

summary() {
  echo
  echo "════════════════════════════════════════════════════════════════════════════════"
  echo " Rider QA run-all — summary ($STAMP)"
  echo "════════════════════════════════════════════════════════════════════════════════"
  printf ' %-3s %-46s %-5s %6s  %s\n' "#" "Step" "Result" "Time" "Note"
  printf ' %-3s %-46s %-5s %6s  %s\n' "---" "----------------------------------------------" "-----" "------" "----"
  local i pass=0 fail=0 skip=0
  for i in "${!NAMES[@]}"; do
    printf ' %-3s %-46s %-5s %5ss  %s\n' "$((i + 1))" "${NAMES[$i]}" "${RESULTS[$i]}" "${TIMES[$i]}" "${NOTES[$i]}"
    case "${RESULTS[$i]}" in PASS) pass=$((pass + 1));; FAIL) fail=$((fail + 1));; SKIP) skip=$((skip + 1));; esac
  done
  echo "────────────────────────────────────────────────────────────────────────────────"
  echo " $pass passed · $fail failed · $skip skipped   (logs: $LOG_DIR)"
}

cleanup_tmp() {
  # Flutter leaves flutter_tools.* folders in TEMP; they are ours to delete.
  rm -rf "$RIDER_QA_TMP"/flutter_tools.* "$RIDER_QA_TMP"/flutter_test_* 2>/dev/null || true
}
trap cleanup_tmp EXIT

echo "Rider QA run-all — $ROOT"
echo "  TEMP=$TEMP  PUB_CACHE=$PUB_CACHE  GRADLE_USER_HOME=$GRADLE_USER_HOME"
echo "  logs: $LOG_DIR"
echo

# ── 1. Rider-related QA scripts (package.json test:*) ──────────────────────
RIDER_QA_SCRIPTS=(
  # Phase 1 — availability, /api/rider/me|status|location|signout, dispatch roster
  test:rider-availability
  test:rider-status
  test:rider-eligibility
  test:rider-dispatch
  test:rider-api
  # Phase 2 — offers, board, delivery machine, exceptions, ring, instructions/POD
  test:rider-offers
  test:rider-jobs
  test:rider-delivery
  test:delivery-exceptions
  test:ring
  test:order-instructions
  test:eta
  test:tracking-origin
  test:rpc-fallback
  # Phase 3 — money ledger, admin Riders
  test:rider-earnings
  test:admin-riders
  # Phase 4 — dashboard, history, performance, ratings
  test:rider-insights
  test:rider-rating
  # Phase 5 — cash
  test:rider-cash
  # Phase 6 — profile, documents, admin verification
  test:rider-profile
  test:admin-rider-profile
  # Phase 7 — support, notifications, SOS, announcements, admin desk
  test:support
  test:admin-support
  # Shared rider surfaces — legacy courier screens, update gate, feature switches, OTP login
  test:driver-app
  test:app-version
  test:role-features
  test:role-manifest
  test:otp-limits
  test:otp-attempts
)
# Scripts whose every tier needs a running dev server and QA credentials, so
# they may honestly check nothing here (shown as "ran 0 checks").
ZERO_OK_SCRIPTS=" test:rider-api "
for s in "${RIDER_QA_SCRIPTS[@]}"; do
  if [[ "$ZERO_OK_SCRIPTS" == *" $s "* ]]; then COUNT=zero-ok; else COUNT=1; fi
  npm_step "$s"
done
COUNT=1

# ── 2. PGlite migration proofs + sequence ──────────────────────────────────
PGLITE_PROOFS=(
  scripts/qa/sql/migration-0055.mjs
  scripts/qa/sql/migration-0056.mjs
  scripts/qa/sql/migration-0057.mjs
  scripts/qa/sql/migration-0058.mjs
  scripts/qa/sql/migration-0081.mjs
  scripts/qa/sql/migration-0082.mjs
  scripts/qa/sql/migration-0083.mjs
  scripts/qa/sql/migration-0084.mjs
  scripts/qa/sql/migration-0085.mjs
  scripts/qa/sql/migration-0086.mjs
  scripts/qa/sql/migration-0087.mjs
)
# 0085 and 0086 prove convergence with the Manager branch's 0150 / 0152. Read
# them from that branch's COMMITTED state, never from its working tree: another
# session may be mid-edit there, which made these proofs fail at random.
# Override with M0150 / MANAGER_0150 / M0152, or MANAGER_REPO / MANAGER_REF.
MANAGER_REPO="${MANAGER_REPO:-F:/hub26/deligro-manager}"
MANAGER_REF="${MANAGER_REF:-feat/manager-app}"
if [[ -z "${M0150:-}${MANAGER_0150:-}${M0152:-}" && -d "$MANAGER_REPO" ]]; then
  MGR_DIR="$RIDER_QA_TMP/manager-$STAMP"
  mkdir -p "$MGR_DIR"
  if git -C "$MANAGER_REPO" rev-parse --verify -q "$MANAGER_REF" >/dev/null 2>&1 &&
     git -C "$MANAGER_REPO" show "$MANAGER_REF:supabase/migrations/0150_rider_tables_converge.sql" >"$MGR_DIR/0150.sql" 2>/dev/null &&
     git -C "$MANAGER_REPO" show "$MANAGER_REF:supabase/migrations/0152_payment_requests_cash_exceptions.sql" >"$MGR_DIR/0152.sql" 2>/dev/null; then
    export M0150="$MGR_DIR/0150.sql" MANAGER_0150="$MGR_DIR/0150.sql" M0152="$MGR_DIR/0152.sql"
    echo "  Manager 0150/0152 from $MANAGER_REF @ $(git -C "$MANAGER_REPO" rev-parse --short "$MANAGER_REF") (committed)"
  else
    # Never fall back to the Manager working tree (another session may be
    # mid-edit there). Point the proofs at files that do not exist, so they
    # cannot read it, and fail this step loudly.
    echo "  WARNING: $MANAGER_REPO exists but $MANAGER_REF:0150/0152 could not be read (bad ref or missing file)." >&2
    export M0150="$MGR_DIR/missing-0150.sql" MANAGER_0150="$MGR_DIR/missing-0150.sql" M0152="$MGR_DIR/missing-0152.sql"
    N=$((N + 1))
    printf '── %02d %-44s FAIL — %s
' "$N" "manager 0150/0152 snapshot" "cannot read $MANAGER_REF in $MANAGER_REPO"
    record "manager 0150/0152 snapshot" FAIL 0 "cannot read $MANAGER_REF:0150/0152 in $MANAGER_REPO; set MANAGER_REF or M0150/M0152"
    FAILED=$((FAILED + 1))
  fi
fi

if [[ ! -f "$PGLITE_REGISTER" || ! -d "$PGLITE_NODE_PATH/@electric-sql/pglite" ]]; then
  for f in "${PGLITE_PROOFS[@]}"; do
    N=$((N + 1))
    printf '── %02d %-44s FAIL — PGlite not found\n' "$N" "pglite $(basename "$f")"
    record "pglite $(basename "$f")" FAIL 0 "PGlite missing: set PGLITE_REGISTER / PGLITE_NODE_PATH (@electric-sql/pglite@0.2.17)"
    FAILED=$((FAILED + 1))
  done
else
  for f in "${PGLITE_PROOFS[@]}"; do COUNT=1 step "pglite $(basename "$f")" pglite node "$f"; done
fi

if has_npm_script test:rider-migrations; then
  step "npm run test:rider-migrations (sequence)" pglite npm run --silent test:rider-migrations
else
  skip_step "npm run test:rider-migrations (sequence)" \
    "script absent — arrives when rider/p8-server merges"
fi

# ── 3–4. Types and lint ────────────────────────────────────────────────────
COUNT=0
step "tsc --noEmit" node node_modules/typescript/bin/tsc --noEmit
npm_step lint

# ── 5. IDOR ────────────────────────────────────────────────────────────────
if [[ "${RIDER_QA_IDOR:-}" == "1" ]]; then
  npm_step test:idor
else
  skip_step "npm run test:idor" \
    "not opted in — it writes QA accounts/fixtures to the configured Supabase; set RIDER_QA_IDOR=1 + QA_PASSWORD for a staging project"
fi

# ── 6–7. Platform separation, customer layout ──────────────────────────────
COUNT=1
npm_step test:platform
npm_step test:customer-layout
COUNT=0

# ── 8. Flutter apps ────────────────────────────────────────────────────────
if [[ "${RIDER_QA_SKIP_FLUTTER:-}" == "1" ]]; then
  skip_step "flutter (rider + customer)" "RIDER_QA_SKIP_FLUTTER=1"
elif ! command -v "$FLUTTER" >/dev/null 2>&1; then
  N=$((N + 1)); echo "── flutter not found"; record "flutter" FAIL 0 "flutter not on PATH (set FLUTTER)"; FAILED=$((FAILED + 1))
else
  for app in apps/rider apps/customer; do
    step "$app: flutter pub get" flutter_in "$app" pub get
    step "$app: flutter analyze" flutter_in "$app" analyze
    step "$app: flutter test" flutter_in "$app" test
  done
fi

summary
if [[ $FAILED -gt 0 ]]; then exit 1; fi
exit 0
