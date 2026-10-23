# Metrics (SPEC.md section 11)

Verbatim from SPEC.md:1161-1179 (working tree 2026-10-23) with `type` and
`PLAN task` columns added. Types follow the name: `_total` → Counter,
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

- `route`: the Fastify route template `request.routeOptions.url`
  (`/v1/functions/:function/runs/:run`), never the raw URL; `unmatched`
  for 404 (SPEC.md:1163). P3.1b asserts a 404 counts under `unmatched`
  (PLAN.md:387-388).
- `code`: the HTTP status as a string (`"404"`).
- `function`: the Function name; bounded by the number of Function
  objects in `KRUN_NAMESPACE`.
- `to` / `state`: run state values from SPEC section 5; `reason`:
  `failureReason` values (`oom_killed deadline_exceeded evicted disrupted
  exit_code job_lost heartbeat_timeout queue_timeout job_create_failed
  ...`; precedence SPEC.md:379-381, full list in SPEC section 4) for
  `krun_runs_failed_total` and the four admission reasons for
  `krun_admission_rejections_total`.
- `ready`: `true` / `false`.
- `krun_deliveries_total{state}`: the `deliveries.state` check values
  `pending delivered dead` (SPEC.md:459) as counted by the deliveries loop
  (P5.3); alert `KrunDeliveriesDead` reads `state="dead"` (SPEC.md:1454).

Never use as a label: run id, request id, key name, client IP, raw path,
error message. One high-cardinality label turns the gateway's `/metrics`
into a memory leak (KEDA made its per-trigger histogram labels opt-in for
this reason, `keda pkg/metricscollector/prommetrics.go:35-178`).

## Consumers that pin the names

Alert rules in SPEC.md:1446-1456 query `krun_scheduler_leader`,
`krun_functions_synced`, `krun_runs_failed_total{reason}`,
`krun_deliveries_total{state="dead"}`, `krun_quota_rejections_total` and
`krun_queue_wait_seconds_bucket`. Renaming a metric or a label breaks the
chart's PrometheusRule and `promtool` in `make helm-lint`; that is a
Decisions row, not a refactor.

## Effect Metric mapping (effect and @effect/opentelemetry 4.0.6, exporter-prometheus 0.223.0)

Read from the package sources on 2026-10-23; `references/telemetry.md`
lists the facts with file names. Types in the snippets are UNVERIFIED
until the first `tsc` run.

| SPEC type | Effect constructor | What the exporter prints |
|---|---|---|
| Counter (`_total`) | `Metric.counter("<full SPEC name>", { incremental: true })` | `# TYPE <name> counter`; `_total` is not appended again because the name already ends in it |
| Gauge | `Metric.gauge("<name>")` | `# TYPE <name> gauge` |
| Histogram (`_seconds`) | `Metric.histogram("<name>", { boundaries })`, values in seconds | `<name>_bucket{le=...}`, `<name>_sum`, `<name>_count`; no unit suffix |

- Define every metric once, as module constants in the Metrics module of
  `packages/shared/src/runtime` (PLAN.md:111), and import them where they
  are updated; labels go on at update time with `Metric.withAttributes`
  using the SPEC label names. The values live in `Metric.MetricRegistry`
  (a `Context.Reference`); the `Telemetry` layer's Prometheus exporter
  reads them through the `@effect/opentelemetry` producer.
- A counter without `incremental: true` is an up-down counter and is
  printed as a `gauge`; a counter named without `_total` gets `_total`
  appended. Either way the name or type differs from SPEC and the alert
  rules break.
- Never `Metric.timer` (milliseconds, adds a `time_unit` label) and never
  an attribute named `unit` or `time_unit` (it becomes the OpenTelemetry
  unit).
- The exporter and the `/metrics` serializer run with `withoutScopeInfo`
  and `withoutTargetInfo`, so no `otel_scope_name` label and no
  `target_info` series are added to the SPEC table.
- Tests provide `Metric.MetricRegistry` with a fresh `new Map()` per test
  (`Effect.provideService`), because the default registry is shared by
  every context without an override; several Vitest apps in one file
  would otherwise add up each other's counts.
- Observe seconds computed from `Clock` (`Clock.currentTimeMillis`
  differences, or `DateTime` differences for run timestamps), never
  `Date.now()`, so `TestClock` tests can assert exact values. Exception:
  `krun_http_request_seconds` may observe `reply.elapsedTime / 1000` in
  the `onResponse` hook; Fastify 5.12.7 measures it itself from a
  high-resolution timer (`lib/reply.js` `elapsedTime`), so no
  `Date.now()` appears in krun code. Tests of that histogram assert the
  count, not the value.
- `Metric.histogram` requires `boundaries`. For
  `krun_http_request_seconds` use `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
  0.5, 1, 2.5, 5, 10]`. Queue wait, cold start, run duration and terminal
  detect run from seconds to hours: give them a list that reaches
  `KRUN_MAX_ACTIVE_DEADLINE` (e.g. `[1, 2, 5, 10, 30, 60, 120, 300, 600,
  1800, 3600, 7200, 21600, 86400]`). SPEC does not fix buckets, so pick
  once and keep them stable (`KrunQueueWaitHigh` uses `histogram_quantile`
  over them, SPEC.md:1456).
- `krun_runs_current` is refilled from `countByState` each loop
  (SPEC.md:1167). An Effect gauge keeps every attribute set it has seen,
  and there is no public reset: keep the set of `(function, state)` pairs
  written last loop and set each pair missing from this loop's counts to
  0, so a Function with no runs, or a deleted Function, does not keep its
  last value. Do not delete entries from the registry `Map` (its key
  format is internal).
- `krun_scheduler_leader` is set to 1 on acquisition and 0 on loss and
  before the Lease is released at shutdown (`KrunNoLeader` also fires on
  `absent(...)`, so every scheduler replica must expose the series,
  SPEC.md:1450): set it to 0 when the scheduler process starts, so a
  standby exposes it too.
- Open gap: SPEC lists no runtime metrics (`Metric.enableRuntimeMetrics`,
  OpenTelemetry host or Node instrumentation), no `krun_build_info` and no
  `target_info`; each is an addition outside the table and needs a
  Decisions row before it appears on `/metrics` (PLAN.md:32-33 "no options
  or abstractions no task asks for").
