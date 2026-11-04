---
title: Configuration reference
description: Every krun environment variable with its default, the processes that read it and its validation rule, plus the built-in limits and defaults.
sidebar:
  order: 3
---

The source of truth is `packages/shared/src/config/index.ts`. Each process validates
its subset at startup and exits 1 naming the first invalid variable. An empty value
means unset: the default applies and no validation runs. For a task-oriented guide
with the matching Helm values, see [Configuration](/krun/guides/configuration/).

## Process variables

G = gateway, S = scheduler, M = `krun migrate`, C = `krun validate` and `krun deploy`.

| Variable | Default | Read by | Validation |
|---|---|---|---|
| `KRUN_DB_MODE` | `postgres` | G S M | `postgres` or `embedded` |
| `KRUN_DB_DSN` | none | G S M | string; required in Postgres mode |
| `KRUN_DB_PATH` | `/data/krun.db` | G S M | string; used in embedded mode |
| `KRUN_API_KEYS_PATH` | `/etc/krun/keys.yaml` | G | string |
| `KRUN_LISTEN_ADDR` | `:8080` | G | string |
| `KRUN_INTERNAL_LISTEN_ADDR` | `:8081` | G | string |
| `KRUN_ADMIN_LISTEN_ADDR` | `:9090` | G S | string |
| `KRUN_GATEWAY_INTERNAL_URL` | `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` | S | string |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | S | string |
| `KRUN_NAMESPACE` | the service-account namespace file | G S | string; startup fails if neither is available |
| `KRUN_POD_NAME` | none | S | DNS-1123 subdomain of at most 253 characters; required to serve |
| `KRUN_MAX_RUNNING` | `100` | S | non-negative integer |
| `KRUN_MAX_QUEUED` | `1000` | G S C | non-negative integer |
| `KRUN_MAX_INPUT_BYTES` | `262144` | G | non-negative integer, at most 1048576 |
| `KRUN_MAX_RESULT_BYTES` | `262144` | G S | non-negative integer, at most 1048576 |
| `KRUN_MAX_WAIT` | `60s` | G | duration |
| `KRUN_SHUTDOWN_DELAY` | `5s` | G | duration |
| `KRUN_RATE_LIMIT_RPS` | `10` | G | non-negative integer |
| `KRUN_RATE_LIMIT_BURST` | `50` | G | non-negative integer |
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | G S C | non-negative integer (seconds) |
| `KRUN_ALLOWED_SERVICE_ACCOUNTS` | `krun-job-default` | G S C | comma-separated list |
| `KRUN_K8S_CONCURRENCY` | `8` | S | non-negative integer |
| `KRUN_JOB_HOST_USERS` | `true` | S | `true` or `false` |
| `KRUN_TTL_AFTER_FINISHED` | `86400` | S | non-negative integer (seconds) |
| `KRUN_RETENTION` | `720h` | S | duration |
| `KRUN_ALLOWED_REGISTRIES` | empty (any) | G S C | comma-separated image prefixes |
| `KRUN_S3_ENDPOINT` | empty (disabled) | G S | string; see the S3 group rule |
| `KRUN_S3_BUCKET` | empty | G S | string; see the S3 group rule |
| `KRUN_S3_REGION` | empty | G S | string; no runtime default |
| `KRUN_S3_ACCESS_KEY` | empty | G S | string; see the S3 group rule |
| `KRUN_S3_SECRET_KEY` | empty | G S | string; see the S3 group rule |
| `KRUN_S3_PRESIGN_TTL` | unset: the run's `activeDeadlineSeconds` | S | duration from 1 second to 7 days |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty (webhooks disabled) | G S C | comma-separated host globs |
| `KRUN_WEBHOOK_ALLOWED_CIDRS` | empty | G S | comma-separated CIDRs; each must parse |
| `KRUN_WEBHOOK_SECRET` | none | S | comma-separated; required when hosts are set |
| `KRUN_LOG_LEVEL` | `info` | G S | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty (traces dropped) | G S | OTLP/HTTP endpoint |
| `OTEL_SERVICE_NAME` | `krun-gateway` / `krun-scheduler` | G S | string |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | G S | string |
| `OTEL_TRACES_SAMPLER_ARG` | `0.1` | G S | string, interpreted by OpenTelemetry |

### Rules that span variables

- **Durations** match `^\d+(ms|s|m|h)$`, for example `250ms`, `30s`, `5m` or `720h`.
- **Postgres mode** requires `KRUN_DB_DSN`.
- **The S3 group** is all or nothing: set `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`,
  `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY` and `KRUN_S3_SECRET_KEY` together, or none of
  them. Startup names the first missing one.
- **Presigned uploads** last at most 7 days: when `KRUN_S3_PRESIGN_TTL` is unset and
  object storage is configured, the scheduler requires `KRUN_MAX_ACTIVE_DEADLINE` of
  at most 604800 seconds.
- **Webhooks**: the scheduler requires `KRUN_WEBHOOK_SECRET` when
  `KRUN_WEBHOOK_ALLOWED_HOSTS` is set.

## CLI variables

| Variable | Default | Used by |
|---|---|---|
| `KRUN_REGISTRY` | none; required | `krun deploy`, overridden by `--registry` |
| `KRUN_NAMESPACE` | `krun` | `krun deploy`, overridden by `--namespace` |
| `KRUN_API_URL` | none | `krun deploy` printed commands, overridden by `--api-url` |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | `krun deploy` printed logs command |
| `NO_COLOR` | unset | `krun deploy` progress style |

`$KRUN_API_KEY` appears literally in the commands `krun deploy` prints; the CLI never
reads it. The CLI never reads `KRUN_GATEWAY_URL`.

## Function container variables

Set by the scheduler on every Job; see
[the internal API reference](/krun/reference/generated/internal-api/#1-where-it-lives-and-who-may-call-it).

| Variable | Present | Meaning |
|---|---|---|
| `KRUN_RUN_ID` | always | Lowercase UUIDv7 of the run. |
| `KRUN_FUNCTION` | always | Function name. |
| `KRUN_GATEWAY_URL` | always | Internal API base URL (`KRUN_GATEWAY_INTERNAL_URL`). |
| `KRUN_TOKEN` | always | Per-run bearer token from the Secret `krun-<run id>`. |
| `KRUN_MAX_RESULT_BYTES` | always | Inline result cap in bytes. |
| `KRUN_RESULT_UPLOAD_URL` | with object storage | Presigned PUT for a larger result. |
| `KRUN_HEARTBEAT_TIMEOUT` | with `heartbeatTimeout` | Heartbeat window in seconds. |
| `HOME` | always | `/tmp`. |

## Built-in limits and defaults

| Setting | Default | Notes |
|---|---|---|
| Rate limit per API key | 10 requests/s, burst 50 | Per gateway replica. |
| Function `maxQueued` | 1000 | 429 `QUEUE_FULL` beyond; ceiling `KRUN_MAX_QUEUED`. |
| Key `maxQueued` | unset | Queued runs per function for that key; 429 `QUEUE_FULL` beyond. |
| Run `priority` | 0 | 0 to 9; above 0 needs `runs:priority`. |
| Input size | 262144 bytes | Hard ceiling 1 MiB. |
| Inline result size | 262144 bytes | Hard ceiling 1 MiB; larger results need object storage. |
| Function `maxConcurrency` | 10 | Scheduled plus running runs per function. |
| `KRUN_MAX_RUNNING` | 100 | Global; must not exceed the jobs namespace pod quota. |
| Function `queueTimeout` | `1h` | Fails with `QUEUE_TIMEOUT`; also used for deleted Functions. |
| Function `heartbeatTimeout` | unset | Minimum 30 s; stale runs fail with `HEARTBEAT_TIMEOUT`. |
| Function `activeDeadlineSeconds` | 3600 | Ceiling `KRUN_MAX_ACTIVE_DEADLINE`, default 86400. |
| Job `backoffLimit` | 0 | No automatic retries. |
| Job `ttlSecondsAfterFinished` | 86400 | Safety net; the scheduler deletes Jobs itself. |
| Status reports | 1 per second per run | Per gateway replica; 429 beyond. |
| Status body / message / data | 16384 / 1024 / 4096 bytes | Internal API. |
| Error body / message / type / details | 32768 / 4096 / 128 / 8192 bytes | Internal API. |
| Log tail | last 100 lines, 16 KB | Failed runs whose container ran. |
| Input schema | 64 KiB serialized | Per Function. |
| `KRUN_MAX_WAIT` | `60s` | Keep below your ingress timeout. |
| Webhook attempts | 6 over about 15 hours | At least once, 10 s timeout each. |
| `KRUN_RETENTION` | `720h` | Sweep every 10 minutes, batch 1000. |
| LimitRange `max` | cpu 4, memory 8Gi, ephemeral-storage 20Gi | Per container in the jobs namespace. |
| Scheduler claim lease | 30 s | |
| Lost-Job grace | 2 minutes | Then `JOB_LOST`. |
| Presigned result download | 300 s | Gateway `GetRunResult` redirect. |
