---
title: Configuration
description: How krun is configured through environment variables and Helm values, grouped by task, with every default.
sidebar:
  order: 6
---

krun's gateway and scheduler are configured only through environment variables;
apart from `--help`, they accept no flags. When you install with Helm, the chart sets
those variables for you from its values. This page groups every setting by task and
shows the Helm value that controls it. The
[configuration reference](/krun/reference/configuration/) lists the same variables
in one table with their validation rules.

## How settings are read

- **An empty value means unset.** The default applies and no validation runs on it.
- **Startup validation is strict.** Each process validates its variables at start
  and exits 1, logging the name of the first invalid variable (never its value).
  Examples: `KRUN_DB_DSN` missing in Postgres mode, a duration that does not match
  `^\d+(ms|s|m|h)$`, a size above 1048576, or a CIDR that does not parse.
- **Each process reads only what it uses.** The gateway and scheduler read different
  subsets; `krun migrate` reads only the `KRUN_DB_*` variables.
- **Every `config.*` Helm value** renders on both processes as the matching
  upper-snake-case variable: `config.maxRunning` becomes `KRUN_MAX_RUNNING`,
  `config.k8sConcurrency` becomes `KRUN_K8S_CONCURRENCY`, and so on.

## Database

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_DB_MODE` | `postgres` | gateway, scheduler, migrate | `db.mode` |
| `KRUN_DB_DSN` | none; required in Postgres mode | gateway, scheduler, migrate | `db.postgres.existingSecret` (key `dsn`) |
| `KRUN_DB_PATH` | `/data/krun.db` | gateway, scheduler, migrate (embedded) | fixed at `/data/krun.db` by the chart |

`KRUN_DB_DSN` is a Postgres connection string. Postgres 16 or newer is required.

## Listeners and identity

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_LISTEN_ADDR` | `:8080` | gateway (public `/v1`) | not configurable |
| `KRUN_INTERNAL_LISTEN_ADDR` | `:8081` | gateway (internal `/internal/v1`) | not configurable |
| `KRUN_ADMIN_LISTEN_ADDR` | `:9090` | gateway, scheduler | set to `:9091` on the embedded scheduler |
| `KRUN_API_KEYS_PATH` | `/etc/krun/keys.yaml` | gateway | `apiKeys.existingSecret`, mounted at `/etc/krun` |
| `KRUN_NAMESPACE` | the pod's namespace, from the service-account namespace file | gateway, scheduler | the release namespace |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | scheduler | `jobsNamespace.name` |
| `KRUN_GATEWAY_INTERNAL_URL` | `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` | scheduler, injected into Jobs | rendered from the internal Service |
| `KRUN_POD_NAME` | none; required by the serving scheduler | scheduler (Lease identity) | downward API `metadata.name` |

Use a distinct admin address for each process when you colocate them outside the
chart. The scheduler's Lease identity must be its own pod name; never substitute a
shared constant.

## Limits and backpressure

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_MAX_RUNNING` | `100` | scheduler | `config.maxRunning` |
| `KRUN_MAX_QUEUED` | `1000` | gateway, scheduler | `config.maxQueued` |
| `KRUN_MAX_INPUT_BYTES` | `262144` (hard maximum 1048576) | gateway | `config.maxInputBytes` |
| `KRUN_MAX_RESULT_BYTES` | `262144` (hard maximum 1048576) | gateway, scheduler | `config.maxResultBytes` |
| `KRUN_MAX_WAIT` | `60s` | gateway | `config.maxWait` |
| `KRUN_RATE_LIMIT_RPS` | `10` | gateway | `config.rateLimitRps` |
| `KRUN_RATE_LIMIT_BURST` | `50` | gateway | `config.rateLimitBurst` |
| `KRUN_SHUTDOWN_DELAY` | `5s` | gateway | `config.shutdownDelay` |
| `KRUN_K8S_CONCURRENCY` | `8` | scheduler | `config.k8sConcurrency` |

- `KRUN_MAX_RUNNING` caps scheduled plus running runs across all functions. While the
  chart creates the jobs namespace, it must not exceed `jobsNamespace.quota.pods`.
- `KRUN_MAX_QUEUED` is the ceiling for any Function's `maxQueued`.
- The rate limit is a token bucket per API key **per gateway replica**.
- `KRUN_MAX_WAIT` caps `?wait=` on CreateRun and `timeout` on WaitRun. Keep it below
  your ingress timeout.
- On SIGTERM the gateway fails `/readyz` and keeps serving for `KRUN_SHUTDOWN_DELAY`
  so endpoints drain, then closes.
- `KRUN_K8S_CONCURRENCY` caps concurrent Kubernetes API calls from the scheduler; each
  call times out after 10 seconds.

## Function ceilings

These settings define what a `Function` may request. Both processes apply them, and
`krun validate` and `krun deploy` read the same five variables when you export them.

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | gateway, scheduler, CLI | `config.maxActiveDeadline` |
| `KRUN_MAX_QUEUED` | `1000` | gateway, scheduler, CLI | `config.maxQueued` |
| `KRUN_ALLOWED_REGISTRIES` | empty: any registry | gateway, scheduler, CLI | `config.allowedRegistries` |
| `KRUN_ALLOWED_SERVICE_ACCOUNTS` | `krun-job-default` | gateway, scheduler, CLI | `config.allowedServiceAccounts` |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty: webhooks disabled | gateway, scheduler, CLI | `webhooks.allowedHosts` |

`KRUN_ALLOWED_REGISTRIES` and `KRUN_ALLOWED_SERVICE_ACCOUNTS` are comma-separated.
Registries are prefixes: an image is allowed when it starts with one of them, so
include the trailing slash, for example `registry.example.com/team/`.

## Jobs and retention

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_TTL_AFTER_FINISHED` | `86400` | scheduler | `config.ttlAfterFinished` |
| `KRUN_RETENTION` | `720h` (30 days) | scheduler | `config.retention` |
| `KRUN_JOB_HOST_USERS` | `true` | scheduler | `jobsNamespace.userNamespaces: true` sets `false` |

- The scheduler deletes each Job and Secret itself once it records the terminal
  state; `ttlSecondsAfterFinished` is only a safety net. Keep scheduler downtime below
  it, or runs that finish during the outage become `JOB_LOST`.
- Finished runs older than `KRUN_RETENTION` are deleted in batches of 1000 every
  10 minutes.
- `KRUN_JOB_HOST_USERS=false` runs function pods with `hostUsers: false` (user
  namespaces). It needs Kubernetes 1.36, or 1.33 to 1.35 with the feature enabled,
  and a node runtime and kernel that support ID-mapped mounts.

## Object storage

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_S3_ENDPOINT` | empty: disabled | gateway, scheduler | `objectStorage.endpoint` |
| `KRUN_S3_BUCKET` | empty | gateway, scheduler | `objectStorage.bucket` |
| `KRUN_S3_REGION` | empty; no runtime default | gateway, scheduler | `objectStorage.region` |
| `KRUN_S3_ACCESS_KEY` | empty | gateway, scheduler | `objectStorage.existingSecret` (key `accessKey`) |
| `KRUN_S3_SECRET_KEY` | empty | gateway, scheduler | `objectStorage.existingSecret` (key `secretKey`) |
| `KRUN_S3_PRESIGN_TTL` | unset: the run's `activeDeadlineSeconds` | scheduler | `config.s3PresignTtl` |

Set all five `KRUN_S3_*` connection variables or none: a partial group fails startup
and names the first missing one. The scheduler presigns each run's upload URL for
`KRUN_S3_PRESIGN_TTL`, which must be between 1 second and 7 days; when it is unset,
`KRUN_MAX_ACTIVE_DEADLINE` must not exceed 7 days (604800 seconds). The gateway's
download URLs are always valid for 300 seconds. With the chart, enabling
`objectStorage.enabled` also opens function egress to the peers in
`objectStorage.egress` when the chart creates the jobs namespace
(`jobsNamespace.create: true`); otherwise you supply that egress.

## Webhooks

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty: webhooks disabled | gateway, scheduler | `webhooks.allowedHosts` |
| `KRUN_WEBHOOK_ALLOWED_CIDRS` | empty | gateway, scheduler | `webhooks.allowedCIDRs` |
| `KRUN_WEBHOOK_SECRET` | none; required when hosts are set | scheduler | `webhooks.existingSecret` (key `secret`) |

Hosts are comma-separated glob patterns. A callback address must be public unicast
(loopback, link-local, RFC 1918, carrier-grade NAT and similar ranges are rejected)
unless it falls inside one of the comma-separated `KRUN_WEBHOOK_ALLOWED_CIDRS`; list
your Pod or Service CIDR there for in-cluster receivers. `KRUN_WEBHOOK_SECRET` is a
comma-separated list: every delivery carries one signature per secret, which lets you
rotate without downtime.

## Logging and telemetry

| Variable | Default | Read by | Helm value |
|---|---|---|---|
| `KRUN_LOG_LEVEL` | `info` | gateway, scheduler | `config.logLevel` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty: traces dropped | gateway, scheduler | `observability.otlpEndpoint` |
| `OTEL_SERVICE_NAME` | `krun-gateway` or `krun-scheduler` | gateway, scheduler | set by the chart only when `observability.otlpEndpoint` is non-empty |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | gateway, scheduler | set by the chart only when `observability.otlpEndpoint` is non-empty |
| `OTEL_TRACES_SAMPLER_ARG` | `0.1` | gateway, scheduler | `observability.tracesSampleRatio` |

`KRUN_LOG_LEVEL` accepts `fatal`, `error`, `warn`, `info`, `debug`, `trace` and
`silent`. Logs are JSON lines and never include input, results, tokens or keys.
Traces are exported over OTLP/HTTP only when an endpoint is set. Prometheus metrics are
always served on the admin listener's `/metrics`.

## Command-line tools

The `krun` CLI runs on a developer machine or in CI and reads these variables:

| Variable | Default | Used by |
|---|---|---|
| `KRUN_REGISTRY` | none; required | `krun deploy` (overridden by `--registry`) |
| `KRUN_NAMESPACE` | `krun` | `krun deploy` (overridden by `--namespace`) |
| `KRUN_API_URL` | none | `krun deploy` printed commands (overridden by `--api-url`) |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | `krun deploy` printed logs command |
| `KRUN_API_KEY` | none | referenced literally in the printed `curl` commands; never read |
| `NO_COLOR` | unset | `krun deploy` plain progress output |

`krun validate` and `krun deploy` also read the five Function ceilings above.

## Inside function containers

The scheduler sets these for every Job; you never configure them yourself:
`KRUN_RUN_ID`, `KRUN_FUNCTION`, `KRUN_GATEWAY_URL`, `KRUN_TOKEN`,
`KRUN_MAX_RESULT_BYTES`, `KRUN_RESULT_UPLOAD_URL` (with object storage only) and
`KRUN_HEARTBEAT_TIMEOUT` (with `heartbeatTimeout` only). See
[Writing a function](/krun/guides/writing-a-function/#environment).

## Helm-only values

Some chart values have no environment variable because they shape Kubernetes
resources rather than process behavior: replicas and resources, `priorityClassName`,
`terminationGracePeriodSeconds`, the jobs namespace quota, LimitRange, DNS egress and
extra egress CIDRs, `networkPolicy.metricsFrom`, the HTTPRoute, the PodMonitor and
PrometheusRule, CRD installation, and embedded storage with Litestream. See the
generated [Helm chart reference](/krun/reference/generated/helm-chart/) for every
value and default.
