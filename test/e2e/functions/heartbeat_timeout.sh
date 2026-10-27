#!/bin/sh
. /common.sh
status '{"message":"alive"}'
printf '%s\n' 'krun-e2e-heartbeat-silent'
# This workload deliberately stops reporting; it must be killed by the scheduler.
sleep 120
