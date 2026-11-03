#!/bin/sh
. /common.sh
call "$BASE/input" -o /tmp/input.json
ack=/tmp/krun-e2e-backpressure-release
mkfifo "$ack"
trap 'rm -f "$ack"' EXIT
status '{"message":"holding"}'
read -r witness < "$ack"
[ "$witness" = release ]
call -H 'Content-Type: application/json' -X PUT "$BASE/result" --data-binary @/tmp/input.json -o /tmp/result-response
