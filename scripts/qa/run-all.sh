#!/usr/bin/env bash
# Full QA pack: payment signatures → app version gate → service-worker rules
# → telemetry redaction/grouping → platform separation → status-bar theme colour
# → IDOR suite → E2E smoke →
# (optional) ZAP when ZAP_TARGET_URL is set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# First because they are the cheapest: pure functions, no network, no database.
echo "═══ 1/9 Payment signature verification ═══"
npx tsx scripts/qa/payments-signature.ts

echo ""
echo "═══ 2/9 App update gate ═══"
npx tsx scripts/qa/app-version.ts

echo ""
echo "═══ 3/9 Service-worker caching rules ═══"
npx tsx scripts/qa/sw-cache-rules.ts

echo ""
echo "═══ 4/9 Telemetry redaction, grouping, severity ═══"
npx tsx scripts/qa/obs-telemetry.ts

echo ""
echo "═══ 5/9 Admin web/mobile platform separation ═══"
npx tsx scripts/qa/platform-separation.ts

echo ""
echo "═══ 6/9 Status-bar theme colour ═══"
npx tsx scripts/qa/theme-color.ts

echo ""
echo "═══ 7/9 IDOR + cross-account ═══"
npx tsx scripts/qa/idor-suite.ts

echo ""
echo "═══ 8/9 E2E smoke ═══"
npx tsx scripts/qa/e2e-smoke.ts

if [[ -n "${ZAP_TARGET_URL:-${STAGING_URL:-}}" ]]; then
  echo ""
  echo "═══ 9/9 OWASP ZAP baseline ═══"
  bash scripts/qa/zap-baseline.sh
else
  echo ""
  echo "═══ 9/9 OWASP ZAP skipped (set ZAP_TARGET_URL to run) ═══"
fi

echo ""
echo "All requested QA steps finished."
