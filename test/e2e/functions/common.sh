#!/bin/sh
set -eu
BASE="$KRUN_GATEWAY_URL/internal/v1/runs/$KRUN_RUN_ID"
call() {
  curl -sS --fail-with-body --max-time 10 --retry 3 --retry-connrefused     -H "Authorization: Bearer $KRUN_TOKEN" "$@"
}
status() {
  curl -sS --fail-with-body --max-time 3     -H "Authorization: Bearer $KRUN_TOKEN" -H 'Content-Type: application/json'     -X POST "$BASE/status" --data-binary "$1" -o /tmp/status-response
}
