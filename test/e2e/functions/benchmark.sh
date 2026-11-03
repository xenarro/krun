#!/bin/sh
. /common.sh
call "$BASE/input" -o /tmp/input.json
# This is the measured workload, not a harness wait or a scheduler timeout.
sleep 10
if grep -q '"fail":true' /tmp/input.json; then
  exit 1
fi
call -X PUT "$BASE/result" -H 'Content-Type: application/json' --data-binary '{}'
