#!/bin/sh
. /common.sh
status '{"message":"first","progress":0.25}'
# Respect the normative one-second accepted-status rate limit.
sleep 1
status '{"message":"second","progress":0.75}'
printf '%s\n' 'krun-e2e-exit-three'
exit 3
