#!/usr/bin/env bash
# OWASP ZAP baseline scan against a *staging* (or local) target.
#
# Never point this at production with real customer data.
#
# Usage:
#   ZAP_TARGET_URL=https://staging.example.com npm run test:zap
#   ZAP_TARGET_URL=http://localhost:3003 npm run test:zap
#
# Optional:
#   ZAP_REPORT_DIR=./zap-report
#   ZAP_FAIL_ON=High              (High|Medium|Low|Informational — default High)
#   ZAP_IMAGE=ghcr.io/zaproxy/zaproxy:stable
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${ZAP_TARGET_URL:-${STAGING_URL:-}}"
REPORT_DIR="${ZAP_REPORT_DIR:-$ROOT/zap-report}"
FAIL_ON="${ZAP_FAIL_ON:-High}"
PRIMARY_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"
FALLBACK_IMAGE="${ZAP_FALLBACK_IMAGE:-zaproxy/zap-stable}"

if [[ -z "$TARGET" ]]; then
  echo "Set ZAP_TARGET_URL (or STAGING_URL) to the staging base URL."
  echo "  ZAP_TARGET_URL=https://your-staging.vercel.app npm run test:zap"
  exit 1
fi

if [[ "${ZAP_ALLOW_PROD:-}" != "1" ]]; then
  case "$TARGET" in
    *deligro.com*|*\.prod.*|*production*)
      echo "Refusing to scan what looks like production: $TARGET"
      echo "Set ZAP_ALLOW_PROD=1 only if you are sure (and the env has no real PII)."
      exit 1
      ;;
    *)
      # Not production-shaped: scan it.
      ;;
  esac
fi

mkdir -p "$REPORT_DIR"

pick_image() {
  local img="$1"
  if docker image inspect "$img" >/dev/null 2>&1; then
    echo "$img"
    return 0
  fi
  echo "Pulling $img …" >&2
  if docker pull "$img"; then
    echo "$img"
    return 0
  fi
  return 1
}

IMAGE=""
if IMAGE="$(pick_image "$PRIMARY_IMAGE")"; then
  :
elif [[ "$PRIMARY_IMAGE" != "$FALLBACK_IMAGE" ]] && IMAGE="$(pick_image "$FALLBACK_IMAGE")"; then
  echo "Using fallback image: $IMAGE"
else
  echo "Could not pull ZAP image ($PRIMARY_IMAGE or $FALLBACK_IMAGE)."
  echo "Check Docker network access, then retry: npm run test:zap"
  exit 1
fi

echo "OWASP ZAP baseline → $TARGET"
echo "  report dir: $REPORT_DIR"
echo "  fail on:    $FAIL_ON+"
echo "  image:      $IMAGE"

DOCKER_EXTRA=()
if [[ "$TARGET" == *"localhost"* ]] || [[ "$TARGET" == *"127.0.0.1"* ]]; then
  TARGET="${TARGET//localhost/host.docker.internal}"
  TARGET="${TARGET//127.0.0.1/host.docker.internal}"
  DOCKER_EXTRA+=(--add-host=host.docker.internal:host-gateway)
  echo "  rewritten:  $TARGET (Docker → host)"
fi

set +e
docker run --rm \
  "${DOCKER_EXTRA[@]}" \
  -v "$REPORT_DIR:/zap/wrk:rw" \
  -t "$IMAGE" \
  zap-baseline.py \
  -t "$TARGET" \
  -r zap-report.html \
  -w zap-report.md \
  -J zap-report.json \
  -x zap-report.xml \
  -I
STATUS=$?
set -e

echo ""
echo "ZAP finished with exit code $STATUS"
echo "  HTML: $REPORT_DIR/zap-report.html"
echo "  MD:   $REPORT_DIR/zap-report.md"
echo "  JSON: $REPORT_DIR/zap-report.json"

if [[ "$STATUS" -ge 125 ]]; then
  echo "Docker/ZAP failed to run (exit $STATUS) — not a finding report."
  exit 1
fi

if [[ "$STATUS" -ge 2 ]]; then
  echo "ZAP reported High/Critical findings — see report."
  exit 1
fi

if [[ "$STATUS" -eq 1 ]]; then
  echo "ZAP reported warnings (Low/Medium). Review $REPORT_DIR/zap-report.md"
  if [[ "$FAIL_ON" == "Medium" || "$FAIL_ON" == "Low" || "$FAIL_ON" == "Informational" ]]; then
    exit 1
  fi
fi

echo "ZAP baseline OK (no High/Critical)."
exit 0
