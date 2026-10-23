# Environment variables (SPEC.md section 12)

Verbatim from SPEC.md:1186-1217 (working tree 2026-10-23) with a `process`
column and a `kind` column added for the parser. Re-check the line numbers
before quoting; SPEC.md is edited concurrently.

## Validation rules (SPEC.md:1178-1184)

- Flags are not supported except `--help` (SPEC.md:1178).
- Each process validates its own variables at startup and exits 1 naming
  the first bad one (SPEC.md:1179-1180). The named checks:
  1. `KRUN_DB_DSN` empty while `KRUN_DB_MODE=postgres` (SPEC.md:1180).
  2. Scheduler with `KRUN_WEBHOOK_ALLOWED_HOSTS` set and
     `KRUN_WEBHOOK_SECRET` empty (SPEC.md:1180-1181). Gateway does not
     need the secret.
  3. `KRUN_MAX_INPUT_BYTES` or `KRUN_MAX_RESULT_BYTES` above `1048576`
     (SPEC.md:1182).
  4. A duration not matching `^\d+(ms|s|m|h)$` (SPEC.md:1182-1183; the
     same grammar as Function fields, SPEC.md:117-118).
  5. A CIDR that does not parse (SPEC.md:1183).
- An empty value is unset: the default applies and no validation runs on
  it (SPEC.md:1183-1184). P0.5 acceptance tests `KRUN_S3_PRESIGN_TTL=""`
  yielding the default (PLAN.md:163-166).
- P0.5 acceptance covers: defaults, one invalid duration, one invalid
  CIDR, DSN empty in postgres mode, webhook hosts without secret, a size
  above 1 MiB, and the empty-value case (PLAN.md:160-166).

`kind` legend: `enum`, `string`, `path`, `addr` (`host:port`, empty host =
all interfaces), `url`, `int` (non-negative integer, plain digits), `dur`
(duration grammar), `csv` (comma-separated strings), `cidrs`
(comma-separated CIDRs), `level` (pino level name).

## Table (SPEC.md:1186-1217)

| Variable | Default | Used by (SPEC text) | process | kind |
|---|---|---|---|---|
| `KRUN_DB_MODE` | `postgres` | both. `postgres` or `embedded` | both | enum |
| `KRUN_DB_DSN` | | both, postgres mode | both | string |
| `KRUN_DB_PATH` | `/data/krun.db` | both, embedded mode | both | path |
| `KRUN_API_KEYS_PATH` | `/etc/krun/keys.yaml` | gateway | gateway | path |
| `KRUN_LISTEN_ADDR` | `:8080` | gateway, public API | gateway | addr |
| `KRUN_INTERNAL_LISTEN_ADDR` | `:8081` | gateway, internal API | gateway | addr |
| `KRUN_ADMIN_LISTEN_ADDR` | `:9090` | both, probes and metrics; the chart sets `:9091` on the scheduler in embedded mode | both | addr |
| `KRUN_GATEWAY_INTERNAL_URL` | `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` | scheduler, injected into Jobs; the chart always sets it from the rendered internal Service name and port, the default serves non-chart deployments | scheduler | url |
| `KRUN_JOBS_NAMESPACE` | `krun-jobs` | scheduler | scheduler | string |
| `KRUN_NAMESPACE` | pod namespace, read from the ServiceAccount `namespace` file | both: Functions and Lease | both | string |
| `KRUN_MAX_RUNNING` | `100` | scheduler | scheduler | int |
| `KRUN_MAX_QUEUED` | `1000` | both, ceiling for `maxQueued` | both | int |
| `KRUN_MAX_INPUT_BYTES` | `262144` | gateway | gateway | int (≤ 1048576) |
| `KRUN_MAX_RESULT_BYTES` | `262144` | both | both | int (≤ 1048576) |
| `KRUN_MAX_WAIT` | `60s` | gateway | gateway | dur |
| `KRUN_SHUTDOWN_DELAY` | `5s` | gateway | gateway | dur |
| `KRUN_RATE_LIMIT_RPS` | `10` | gateway | gateway | int |
| `KRUN_RATE_LIMIT_BURST` | `50` | gateway | gateway | int |
| `KRUN_MAX_ACTIVE_DEADLINE` | `86400` | both, Function validation | both | int (seconds) |
| `KRUN_ALLOWED_SERVICE_ACCOUNTS` | `krun-job-default` | both, Function validation; comma-separated | both | csv |
| `KRUN_K8S_CONCURRENCY` | `8` | scheduler | scheduler | int |
| `KRUN_TTL_AFTER_FINISHED` | `86400` | scheduler | scheduler | int (seconds) |
| `KRUN_RETENTION` | `720h` | scheduler | scheduler | dur |
| `KRUN_ALLOWED_REGISTRIES` | empty, any | both | both | csv |
| `KRUN_S3_ENDPOINT`, `KRUN_S3_BUCKET`, `KRUN_S3_REGION`, `KRUN_S3_ACCESS_KEY`, `KRUN_S3_SECRET_KEY` | empty, disabled | both | both | string |
| `KRUN_S3_PRESIGN_TTL` | unset: the run's `activeDeadlineSeconds` | scheduler, PUT presign; a duration. The gateway's GET presign is fixed at 300 s | scheduler | dur |
| `KRUN_WEBHOOK_ALLOWED_HOSTS` | empty, webhooks disabled | both | both | csv |
| `KRUN_WEBHOOK_ALLOWED_CIDRS` | empty | both; comma-separated CIDRs that pass the address check | both | cidrs |
| `KRUN_WEBHOOK_SECRET` | | scheduler; comma-separated secrets, one signature each | scheduler | csv (secret) |
| `KRUN_LOG_LEVEL` | `info` | both | both | level |

`KRUN_API_URL`, `KRUN_API_KEY`, `KRUN_REGISTRY` are read by the CLI on a
developer machine only (SPEC.md:1219-1221); they are not process config.

## Notes for the parser

- `KRUN_MAX_ACTIVE_DEADLINE` and `KRUN_TTL_AFTER_FINISHED` are integer
  seconds (`86400`), not durations; `KRUN_MAX_WAIT`, `KRUN_SHUTDOWN_DELAY`,
  `KRUN_RETENTION` and `KRUN_S3_PRESIGN_TTL` are durations. Do not accept
  `24h` for the integer ones or `3600` for the duration ones.
- `KRUN_NAMESPACE` fallback file: the ServiceAccount `namespace` file
  (`/var/run/secrets/kubernetes.io/serviceaccount/namespace`). Outside a
  pod (P3.7 and P4.11 process tests with `test/fake-kube`) set
  `KRUN_NAMESPACE` explicitly; see the open gap in SKILL.md on what to do
  when neither exists.
- `KRUN_GATEWAY_INTERNAL_URL` default is computed after `KRUN_NAMESPACE`
  is resolved (SPEC.md:1195).
- `KRUN_WEBHOOK_SECRET` and `KRUN_S3_SECRET_KEY` / `KRUN_S3_ACCESS_KEY`
  and `KRUN_DB_DSN` are secrets: never log the config object; `dsn` is in
  the pino redact list (SPEC.md:1151-1153), the others must simply never
  be passed to a logger.
- The scheduler in embedded mode gets `KRUN_ADMIN_LISTEN_ADDR=:9091` from
  the chart because both processes share one pod (SPEC.md:1194).
- The chart renders section 12 tunables from `config.*` camelCase keys on
  both processes (SPEC.md:1240-1249); unknown variables to a process are
  ignored, not rejected.
