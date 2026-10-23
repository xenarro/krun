# Metrics (SPEC.md section 11)

Table verbatim from SPEC.md:1161-1179 (working tree 2026-10-23) plus
`type` and `PLAN task` columns. Type follows the name: `_total` → Counter,
`_seconds` → Histogram, the rest → Gauge. Re-check line numbers before
quoting.

"Metrics are Effect `Metric`s exported by the OpenTelemetry Prometheus
exporter on the admin listener's `/metrics`; the exposed names are exactly
those in the table below" (SPEC.md:1143-1147). "Metrics on the admin
listener of each process" (SPEC.md:1159).

| Metric | Owner | Meaning (SPEC text) | type | PLAN task |
|---|---|---|---|---|
| `krun_http_requests_total{route,code}` | both | `route` is `request.routeOptions.url`, `unmatched` for 404 | Counter | P3.1b (PLAN.md:385-388); registered on every listener incl. the scheduler admin listener in P4.11 |
| `krun_http_request_seconds{route}` | both | | Histogram | P3.1b |
| `krun_admission_rejections_total{reason}` | gateway | `rate_limit`, `max_queued`, `input_size`, `schema` | Counter | P3.3 (PLAN.md:411) |
| `krun_runs_transitions_total{function,to}` | scheduler leader | | Counter | P4.6 (PLAN.md:558-562) |
| `krun_runs_current{function,state}` | scheduler leader | from `countByState` each loop | Gauge | P4.6 |
| `krun_runs_failed_total{function,reason}` | scheduler leader | `failureReason` values | Counter | P4.8 (PLAN.md:572-585) |
| `krun_queue_wait_seconds{function}` | scheduler leader | created to scheduled | Histogram | P4.6 |
| `krun_cold_start_seconds{function}` | scheduler leader | scheduled to running | Histogram | P4.6 |
| `krun_run_duration_seconds{function,state}` | scheduler leader | running to terminal | Histogram | P4.6 |
| `krun_terminal_detect_seconds{function}` | scheduler leader | container exit to terminal state | Histogram | P4.8 |
| `krun_job_create_errors_total{function,code}` | scheduler leader | API status on Secret or Job create | Counter | P4.3a (PLAN.md:503) |
| `krun_quota_rejections_total{function}` | scheduler leader | | Counter | P4.3a |
| `krun_scheduler_leader` | scheduler | 1 on the leader | Gauge | P4.2 (PLAN.md:494) |
| `krun_functions_synced` | both | 1 after the Function informer's initial list | Gauge | P2.3 (PLAN.md:342-351) |
| `krun_functions{ready}` | both | Function count by readiness | Gauge | P2.3 |
| `krun_deliveries_total{state}` | scheduler leader | | Counter | P5.3 (PLAN.md:648) |
| `krun_sweep_deleted_total` | scheduler leader | | Counter | P4.10 (PLAN.md:598) |

## Label values

- `route`: Fastify route template `request.routeOptions.url`
  (`/v1/functions/:function/runs/:run`), never the raw URL; `unmatched`
  for 404 (SPEC.md:1163). P3.1b asserts a 404 counts under `unmatched`
  (PLAN.md:387-388).
- `code`: HTTP status as a string (`"404"`).
- `function`: Function name; bounded by the Function objects in
  `KRUN_NAMESPACE`.
- `to` / `state`: run state values from SPEC section 5. `reason`:
  `failureReason` values (`oom_killed deadline_exceeded evicted disrupted
  exit_code job_lost heartbeat_timeout queue_timeout job_create_failed
  ...`; precedence SPEC.md:379-381, full list in SPEC section 4) for
  `krun_runs_failed_total`, and the four admission reasons for
  `krun_admission_rejections_total`.
- `ready`: `true` / `false`.
- `krun_deliveries_total{state}`: `deliveries.state` values
  `pending delivered dead` (SPEC.md:459), counted by the deliveries loop
  (P5.3). Alert `KrunDeliveriesDead` reads `state="dead"` (SPEC.md:1454).

Never a label: run id, request id, key name, client IP, raw path, error
message. One high-cardinality label turns `/metrics` into a memory leak
(KEDA made per-trigger histogram labels opt-in for this,
`keda pkg/metricscollector/prommetrics.go:35-178`).

## Consumers that pin the names

Alert rules in SPEC.md:1446-1456 query `krun_scheduler_leader`,
`krun_functions_synced`, `krun_runs_failed_total{reason}`,
`krun_deliveries_total{state="dead"}`, `krun_quota_rejections_total` and
`krun_queue_wait_seconds_bucket`. Renaming a metric or label breaks the
chart's PrometheusRule and `promtool` in `make helm-lint`: a Decisions
row, not a refactor.

## Effect Metric mapping (effect and @effect/opentelemetry 4.0.6, exporter-prometheus 0.223.0)

Read from package sources on 2026-10-23; `references/telemetry.md` lists
the facts with file names. Snippet types UNVERIFIED until the first `tsc`
run.

| SPEC type | Effect constructor | What the exporter prints |
|---|---|---|
| Counter (`_total`) | `Metric.counter("<full SPEC name>", { incremental: true })` | `# TYPE <name> counter`; `_total` is not appended again because the name already ends in it |
| Gauge | `Metric.gauge("<name>")` | `# TYPE <name> gauge` |
| Histogram (`_seconds`) | `Metric.histogram("<name>", { boundaries })`, values in seconds | `<name>_bucket{le=...}`, `<name>_sum`, `<name>_count`; no unit suffix |

- Define every metric once, as module constants in the Metrics module of
  `packages/shared/src/runtime` (PLAN.md:111); import them where updated.
  Labels go on at update time with `Metric.withAttributes`, using SPEC
  label names. Values live in `Metric.MetricRegistry` (a
  `Context.Reference`); the `Telemetry` layer's exporter reads them
  through the `@effect/opentelemetry` producer.
- A counter without `incremental: true` is an up-down counter, printed as
  a `gauge`. A counter named without `_total` gets `_total` appended:
  `krun_x` with `incremental: true` exports `krun_x_total`; `krun_x_total`
  without it exports a `gauge`. Either way name or type differs from SPEC
  and alert rules break.
- Exporter construction: a bare `new PrometheusExporter()` (no
  `preventServerStart`) opens its own HTTP server on 9464, outside the
  admin listener and the chart's NetworkPolicy.
- Never `Metric.timer` (milliseconds, adds a `time_unit` label). Never an
  attribute named `unit` or `time_unit` (it becomes the OpenTelemetry
  unit).
- Exporter and `/metrics` serializer run with `withoutScopeInfo` and
  `withoutTargetInfo`: no `otel_scope_*` labels (`otel_scope_name`), no
  `target_info` series.
- Tests provide `Metric.MetricRegistry` with a fresh `new Map()` per test
  (`Effect.provideService`). The default registry is shared by every
  context without an override; Vitest apps in one file would otherwise add
  up each other's counts.
- Observe seconds computed from `Clock` (`Clock.currentTimeMillis`
  differences, or `DateTime` differences for run timestamps), never
  `Date.now()`, so `TestClock` tests can assert exact values. Exception:
  `krun_http_request_seconds` may observe `reply.elapsedTime / 1000` in
  `onResponse`. Fastify 5.12.7 measures it from a high-resolution timer
  (`lib/reply.js` `elapsedTime`), so no `Date.now()` appears in krun
  code. Tests of that histogram assert the count, not the value.
- `Metric.histogram` requires `boundaries`. For
  `krun_http_request_seconds` use `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
  0.5, 1, 2.5, 5, 10]`. Queue wait, cold start, run duration and terminal
  detect span seconds to hours: use a list reaching
  `KRUN_MAX_ACTIVE_DEADLINE` (e.g. `[1, 2, 5, 10, 30, 60, 120, 300, 600,
  1800, 3600, 7200, 21600, 86400]`). SPEC fixes no buckets: pick once and
  keep them stable (`KrunQueueWaitHigh` uses `histogram_quantile` over
  them, SPEC.md:1456).
- `krun_runs_current` is refilled from `countByState` each loop
  (SPEC.md:1167). An Effect gauge keeps every attribute set it has seen
  and has no public reset. Keep the `(function, state)` pairs written last
  loop; set each pair missing from this loop's counts to 0, so a Function
  with no runs, or a deleted Function, does not keep its last value. Do
  not delete entries from the registry `Map` (its key format is
  internal).
- `krun_scheduler_leader`: 1 on acquisition, 0 on loss and before the
  Lease is released at shutdown. `KrunNoLeader` also fires on
  `absent(...)`, so every scheduler replica must expose the series
  (SPEC.md:1450): set it to 0 at process start, so a standby exposes it
  too.
- Open gap: SPEC lists no runtime metrics (`Metric.enableRuntimeMetrics`,
  OpenTelemetry host or Node instrumentation), no `krun_build_info`, no
  `target_info`. Each is an addition outside the table and needs a
  Decisions row before it appears on `/metrics` (PLAN.md:32-33 "no options
  or abstractions no task asks for").
