---
title: Operations
description: Monitor krun with health probes, Prometheus metrics, seven alerts and traces; rotate keys and secrets; back up and restore both database modes.
sidebar:
  order: 7
---

This page is the day-two overview for the platform team. The complete, normative
procedures live in the [operations guide](/krun/reference/generated/operations/),
mirrored from `docs/OPERATIONS.md`.

## Health and readiness

Both processes serve an admin listener (port 9090; 9091 for the embedded scheduler)
with no authentication. Never expose it outside the cluster.

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | The process is alive. Used by the liveness probe. |
| `GET /readyz` | The database answers within 2 seconds and the Function informer has synced; `503` from the start of shutdown. Used by the readiness probe. The scheduler reports its leader status here without failing readiness on standbys. |
| `GET /metrics` | Prometheus metrics. |

## Metrics

| Metric | Owner | Meaning |
|---|---|---|
| `krun_http_requests_total{route,code}` | both | Requests by route; `unmatched` for 404s. |
| `krun_http_request_seconds{route}` | both | Request latency. |
| `krun_admission_rejections_total{reason}` | gateway | `rate_limit`, `max_queued`, `input_size`, `schema`. |
| `krun_runs_transitions_total{function,to}` | scheduler leader | State transitions. |
| `krun_runs_current{function,state}` | scheduler leader | Non-terminal runs per function and state. |
| `krun_runs_failed_total{function,reason}` | scheduler leader | Failures by `failureReason`. |
| `krun_queue_wait_seconds{function}` | scheduler leader | Created to scheduled. |
| `krun_cold_start_seconds{function}` | scheduler leader | Scheduled to running. |
| `krun_run_duration_seconds{function,state}` | scheduler leader | Running to terminal. |
| `krun_terminal_detect_seconds{function}` | scheduler leader | Container exit to terminal state. |
| `krun_job_create_errors_total{function,code}` | scheduler leader | API status on Secret or Job create. |
| `krun_quota_rejections_total{function}` | scheduler leader | Job creation refused by quota. |
| `krun_scheduler_leader` | scheduler | 1 on the leader. |
| `krun_functions_synced` | both | 1 after the Function informer's initial list. |
| `krun_functions{ready}` | both | Function count by readiness. |
| `krun_deliveries_total{state}` | scheduler leader | Webhook delivery outcomes. |
| `krun_sweep_deleted_total` | scheduler leader | Runs deleted by retention. |

Enable `metrics.podMonitor.enabled` to render a PodMonitor for the admin ports, and
set `networkPolicy.metricsFrom` to your Prometheus namespace so only it can reach the
admin ports (the empty default allows every namespace).

## Alerts

`metrics.prometheusRule.enabled` renders exactly these seven rules. Four thresholds
are configurable under `metrics.prometheusRule.thresholds`.

| Alert | Fires when | First checks |
|---|---|---|
| `KrunNoLeader` | No scheduler holds the Lease, or none is scraped, for 2 minutes. Nothing is claimed. | The Lease holder, scheduler logs, API server reachability. |
| `KrunFunctionsNotSynced` | A process cannot list Functions for 2 minutes. | The CRD is installed and Established; RBAC for `functions.krun.io`. |
| `KrunJobLost` | More than `jobLostPerHour` (1) runs failed with `JOB_LOST` in an hour. | Scheduler downtime against `config.ttlAfterFinished`; someone deleting Jobs; node loss. |
| `KrunHeartbeatTimeouts` | More than `heartbeatTimeoutsPerHour` (5) heartbeat failures in an hour. | The run's `error` and `logTail`; whether `heartbeatTimeout` is too short. |
| `KrunDeliveriesDead` | A webhook delivery exhausted its six attempts. | Receiver availability, allowed hosts and CIDRs, DNS, signature checks. |
| `KrunQuotaRejections` | Quota rejections exceed `quotaRejectionsPerMinute` (1) for 10 minutes. | `kubectl describe quota -n krun-jobs`; function requests against `limitRange.max`. |
| `KrunQueueWaitHigh` | Queue-wait p95 exceeds `queueWaitP95Seconds` (60) for 10 minutes. | Free slots in `krun_runs_current`, `config.maxRunning`, cluster capacity, cold start. |

`node scripts/check-operations-alerts.ts` compares the documented alert table with
the PrometheusRule actually rendered in both database modes.

## Traces and logs

- Set `observability.otlpEndpoint` to export traces over OTLP/HTTP; sampling is
  parent-based at 10 percent by default. Every span about a run carries
  `krun.run_id`, which correlates the CreateRun request, the scheduler iteration and
  the pod's internal API calls across processes. Log lines inside a span carry
  `traceId` and `spanId`.
- Logs are JSON lines. Every `/v1` request writes one audit line with the key name
  (never the key), client IP, user agent, route, status code and run id. Input,
  results, runtime status, error details, tokens, keys and DSNs are redacted.

## Logs of a run

`kubectl logs -f -n krun-jobs job/krun-<id>` works only while the run is `SCHEDULED`
or `RUNNING`, because the scheduler deletes the Job at the terminal transition. For a
finished run, GetRun returns `logTail` on failures only (the last 100 lines, at most
16 KB). Successful runs leave no logs in krun; use your cluster's log aggregation.
Function authors bound to `krun-job-viewer` can read in-flight logs.

## Rotation

- **API keys**: add the new value to the principal's `key` list in the Secret, wait
  one 30-second reload, switch clients, then remove the old value. No restart.
- **Webhook signing secrets**: set the Secret's `secret` key to `new,old`, restart the
  scheduler (`deployment/<release>-scheduler` in Postgres mode, `statefulset/<release>`
  in embedded mode), let receivers accept either signature, then drop `old` and
  restart again.
- **Object storage and database credentials** reach the pods as environment
  variables, so restart the workloads after editing those Secrets.

## Backup and restore

- **Postgres mode**: backups belong to your managed database service. The `runs`
  table is the only state; `run_events` and `deliveries` cascade from it.
- **Embedded mode with Litestream**: the native sidecar streams the SQLite WAL to
  object storage continuously. On start, the restore init container pulls the latest
  replica when `krun.db` is absent, then `krun migrate` runs.
- **Embedded mode without Litestream**: the PVC is the only copy. Snapshot it with
  your storage class, or enable Litestream.

Run a restore drill before you rely on it. In the local embedded e2e run on
2026-11-04, with real MinIO and Litestream 0.3.13, the measured restore-to-Ready
downtime was **56.040 seconds**, and a run created before the drill was readable
afterwards. That is a local measurement of database-file loss on a retained PVC, not a
production recovery-time guarantee; repeat the drill with your own storage, image and
backup policy. The [operations guide](/krun/reference/generated/operations/#backup-and-restore)
has the step-by-step procedure.

## Upgrades

- `helm upgrade` runs `krun migrate` as a `pre-upgrade` hook in Postgres mode.
  Migrations are forward-only and expand/contract, so the previous version keeps
  working during the rollout. A database newer than the binary is tolerated:
  `krun migrate` warns and exits 0.
- Embedded mode has one replica: expect a brief downtime while the StatefulSet
  restarts.
- `helm rollback` by one minor version is supported.
- Keep scheduler downtime below `config.ttlAfterFinished`.

## Runbook snippets

```sh title="Terminal"
# Runs stuck in QUEUED for one function
kubectl get kfn <name> -n krun -o jsonpath='{.status.conditions}'
curl -sG -H "Authorization: Bearer $KRUN_API_KEY" \
  "$KRUN_API_URL/v1/functions/<name>/runs" \
  --data-urlencode 'filter=state = QUEUED' --data-urlencode pageSize=5

# A failed run
curl -s -H "Authorization: Bearer $KRUN_API_KEY" \
  "$KRUN_API_URL/v1/functions/-/runs/<id>" | jq '.failureReason, .error, .logTail'

# A run still in flight
kubectl logs -f -n krun-jobs job/krun-<id>

# The current scheduler leader
kubectl get lease krun-scheduler -n krun -o jsonpath='{.spec.holderIdentity}'
```
