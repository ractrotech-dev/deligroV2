#!/usr/bin/env bash
# Full QA pack: payment signatures → order ring protocol → app version gate → service-worker rules
# → telemetry redaction/grouping → platform separation → status-bar theme colour
# → switch affordance → delivery estimates → IDOR suite → E2E smoke →
# (optional) ZAP when ZAP_TARGET_URL is set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# The project's own tsx (a devDependency), by path. Not `npx tsx`: when the
# local copy is missing, npx quietly downloads one from the registry and runs
# its install scripts.
TSX="$ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "tsx not found at $TSX. Install dependencies first (pnpm install)." >&2
  exit 1
fi

# First because they are the cheapest: pure functions, no network, no database.
echo "═══ 1/17 Payment signature verification ═══"
"$TSX" scripts/qa/payments-signature.ts

echo ""
echo "═══ 2/17 Order ring protocol (server ↔ Android apps) ═══"
"$TSX" scripts/qa/ring-protocol.ts

echo ""
echo "═══ 3/17 App update gate ═══"
"$TSX" scripts/qa/app-version.ts

echo ""
echo "═══ 4/17 Service-worker caching rules ═══"
"$TSX" scripts/qa/sw-cache-rules.ts

echo ""
echo "═══ 5/17 Telemetry redaction, grouping, severity ═══"
"$TSX" scripts/qa/obs-telemetry.ts

echo ""
echo "═══ 6/17 Admin web/mobile platform separation ═══"
"$TSX" scripts/qa/platform-separation.ts

echo ""
echo "═══ 7/17 Status-bar theme colour ═══"
"$TSX" scripts/qa/theme-color.ts

echo ""
echo "═══ 8/17 Switch click affordance ═══"
"$TSX" scripts/qa/switch-affordance.ts

echo ""
echo "═══ 9/17 Overlay layering ═══"
"$TSX" scripts/qa/overlay-layering.ts

echo ""
echo "═══ 10/17 Delivery estimates vs distance ═══"
"$TSX" scripts/qa/eta-distance.ts

echo ""
echo "═══ 9b/16 OTP send limits ═══"
"$TSX" scripts/qa/otp-limits.ts

echo ""
echo "═══ 11/17 Delivery area fails closed ═══"
"$TSX" scripts/qa/service-area.ts

echo ""
echo "═══ 10b Role feature switches resolve ═══"
"$TSX" scripts/qa/role-features.ts

echo ""
echo "═══ 12/17 Tracking origin not invented ═══"
"$TSX" scripts/qa/tracking-origin.ts

echo ""
echo "═══ 13/17 Vendor pin required to go live ═══"
"$TSX" scripts/qa/vendor-readiness.ts

echo ""
echo "═══ 14/17 Courier app ═══"
"$TSX" scripts/qa/driver-app.ts

echo ""
echo "═══ 15/17 IDOR + cross-account ═══"
"$TSX" scripts/qa/idor-suite.ts

echo ""
echo "═══ 16/17 E2E smoke ═══"
"$TSX" scripts/qa/e2e-smoke.ts

if [[ -n "${ZAP_TARGET_URL:-${STAGING_URL:-}}" ]]; then
  echo ""
  echo "═══ 17/17 OWASP ZAP baseline ═══"
  bash scripts/qa/zap-baseline.sh
else
  echo ""
  echo "═══ 17/17 OWASP ZAP skipped (set ZAP_TARGET_URL to run) ═══"
fi

echo ""
echo "All requested QA steps finished."
