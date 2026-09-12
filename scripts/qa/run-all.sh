#!/usr/bin/env bash
# Full QA pack: payment signatures → app version gate → service-worker rules
# → telemetry redaction/grouping → platform separation → status-bar theme colour
# → switch affordance → delivery estimates → IDOR suite → E2E smoke →
# (optional) ZAP when ZAP_TARGET_URL is set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# First because they are the cheapest: pure functions, no network, no database.
echo "═══ 1/16 Payment signature verification ═══"
npx tsx scripts/qa/payments-signature.ts

echo ""
echo "═══ 2/16 App update gate ═══"
npx tsx scripts/qa/app-version.ts

echo ""
echo "═══ 3/16 Service-worker caching rules ═══"
npx tsx scripts/qa/sw-cache-rules.ts

echo ""
echo "═══ 4/16 Telemetry redaction, grouping, severity ═══"
npx tsx scripts/qa/obs-telemetry.ts

echo ""
echo "═══ 5/16 Admin web/mobile platform separation ═══"
npx tsx scripts/qa/platform-separation.ts

echo ""
echo "═══ 6/16 Status-bar theme colour ═══"
npx tsx scripts/qa/theme-color.ts

echo ""
echo "═══ 7/16 Switch click affordance ═══"
npx tsx scripts/qa/switch-affordance.ts

echo ""
echo "═══ 8/16 Overlay layering ═══"
npx tsx scripts/qa/overlay-layering.ts

echo ""
echo "═══ 9/16 Delivery estimates vs distance ═══"
npx tsx scripts/qa/eta-distance.ts

echo ""
echo "═══ 10/16 Delivery area fails closed ═══"
npx tsx scripts/qa/service-area.ts

echo ""
echo "═══ 11/16 Tracking origin not invented ═══"
npx tsx scripts/qa/tracking-origin.ts

echo ""
echo "═══ 12/16 Vendor pin required to go live ═══"
npx tsx scripts/qa/vendor-readiness.ts

echo ""
echo "═══ 13/16 Courier app ═══"
npx tsx scripts/qa/driver-app.ts

echo ""
echo "═══ 14/16 IDOR + cross-account ═══"
npx tsx scripts/qa/idor-suite.ts

echo ""
echo "═══ 15/16 E2E smoke ═══"
npx tsx scripts/qa/e2e-smoke.ts

if [[ -n "${ZAP_TARGET_URL:-${STAGING_URL:-}}" ]]; then
  echo ""
  echo "═══ 16/16 OWASP ZAP baseline ═══"
  bash scripts/qa/zap-baseline.sh
else
  echo ""
  echo "═══ 16/16 OWASP ZAP skipped (set ZAP_TARGET_URL to run) ═══"
fi

echo ""
echo "All requested QA steps finished."
