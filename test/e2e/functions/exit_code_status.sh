#!/bin/sh
. /common.sh
# Keep the first state until the external observer has positively witnessed it.
ack=/tmp/krun-e2e-first-status-ack
mkfifo "$ack"
trap 'rm -f "$ack"' EXIT
status '{"message":"first","progress":0.25}'
read -r witness < "$ack"
[ "$witness" = first-observed ]
# Respect the normative one-second accepted-status rate limit.
sleep 1
status '{"message":"second","progress":0.75}'
printf '%s\n' 'krun-e2e-exit-three'
exit 3
