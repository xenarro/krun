#!/bin/sh
. /common.sh
call "$BASE/input" -o /tmp/input.json
status '{"message":"round-trip","progress":1}'
call -X PUT "$BASE/result" -H 'Content-Type: application/json' --data-binary @/tmp/input.json
