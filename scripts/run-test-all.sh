#!/bin/zsh
# Runs every suite in `npm run test:all` while bypassing the tsx CLI wrapper.
#
# `npx tsx <file>` spawns an IPC server on a unix socket, which this sandbox
# denies with `listen EPERM`. Importing the tsx loader directly into node skips
# that wrapper entirely and executes the identical TypeScript.
#
# Usage: ./scripts/run-test-all.sh
set -u

suites=(
  "off-window:scripts/test-off-window.ts"
  "retry-exhaustion:scripts/test-retry-exhaustion.ts"
  "idempotency:scripts/test-webhook-idempotency.ts"
  "conflict-guard:scripts/test-webhook-conflict-guard.ts"
  "demo-isolation:scripts/test-demo-baseline-isolation.ts"
  "advisory-unavailable:scripts/test-advisory-unavailable.ts"
  "webhook-processing-failure:scripts/test-webhook-processing-failure.ts"
  "provider-attribution:scripts/test-provider-attribution.ts"
  "webhook-events:scripts/test-webhook-event-coverage.ts"
  "p2p-watchdog:scripts/test-p2p-watchdog.ts"
  "smart-router:scripts/test-smart-router.ts"
)

logdir="${TMPDIR:-/tmp}/recoverai-testall"
mkdir -p "$logdir"

failed=()
for pair in "${suites[@]}"; do
  name="${pair%%:*}"
  file="${pair#*:}"
  log="$logdir/$name.log"
  printf '%-30s' "$name"
  TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx "$file" > "$log" 2>&1
  code=$?
  if [[ $code -eq 0 ]]; then
    print "PASS (exit 0)  -> $log"
  else
    print "FAIL (exit $code)  -> $log"
    failed+=("$name")
  fi
done

print ""
if (( ${#failed[@]} == 0 )); then
  print "✅ ALL ${#suites[@]} SUITES PASSED (0 failures)"
else
  print "❌ ${#failed[@]} of ${#suites[@]} SUITES FAILED: ${failed[*]}"
  exit 1
fi
