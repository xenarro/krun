# Metrics (SPEC.md section 11)

Verbatim from SPEC.md:1127-1147 (working tree 2026-10-23) with `type` and
`PLAN task` columns added. Types follow the name: `_total` → Counter,
`_seconds` → Histogram, the rest → Gauge. Re-check line numbers before
quoting.

"Prometheus metrics on the admin listener of each process" (SPEC.md:1127).

| Metric | Owner | Meaning (SPEC text) | type | PLAN task |
|---|---|---|---|---|
| `krun_http_requests_total{route,code}` | both | `route` is `request.routeOptions.url`, `unmatched` for 404 | Counter | P3.1b (PLAN.md:379-382); registered on every listener incl. the scheduler admin listener in P4.11 |
| `krun_http_request_seconds{route}` | both | | Histogram | P3.1b |
| `krun_admission_rejections_total{reason}` | gateway | `rate_limit`, `max_queued`, `input_size`, `schema` | Counter | P3.3 (PLAN.md:405) |
| `krun_runs_transitions_total{function,to}` | scheduler leader | | Counter | P4.6 (PLAN.md:552-556) |
| `krun_runs_current{function,state}` | scheduler leader | from `countByState` each loop | Gauge | P4.6 |
| `krun_runs_failed_total{function,reason}` | scheduler leader | `failureReason` values | Counter | P4.8 (PLAN.md:562-575) |
| `krun_queue_wait_seconds{function}` | scheduler leader | created to scheduled | Histogram | P4.6 |
| `krun_cold_start_seconds{function}` | scheduler leader | scheduled to running | Histogram | P4.6 |
| `krun_run_duration_seconds{function,state}` | scheduler leader | running to terminal | Histogram | P4.6 |
| `krun_terminal_detect_seconds{function}` | scheduler leader | container exit to terminal state | Histogram | P4.8 |
| `krun_job_create_errors_total{function,code}` | scheduler leader | API status on Secret or Job create | Counter | P4.3a (PLAN.md:497) |
| `krun_quota_rejections_total{function}` | scheduler leader | | Counter | P4.3a |
| `krun_scheduler_leader` | scheduler | 1 on the leader | Gauge | P4.2 (PLAN.md:488) |
| `krun_functions_synced` | both | 1 after the Function informer's initial list | Gauge | P2.3 (PLAN.md:336-345) |
| `krun_functions{ready}` | both | Function count by readiness | Gauge | P2.3 |
| `krun_deliveries_total{state}` | scheduler leader | | Counter | P5.3 (PLAN.md:638) |
| `krun_sweep_deleted_total` | scheduler leader | | Counter | P4.10 (PLAN.md:588) |

## Label values

- `route`: the Fastify route template `request.routeOptions.url`
  (`/v1/functions/:function/runs/:run`), never the raw URL; `unmatched`
  for 404 (SPEC.md:1131). P3.1b asserts a 404 counts under `unmatched`
  (PLAN.md:381-382).
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
  (P5.3); alert `KrunDeliveriesDead` reads `state="dead"` (SPEC.md:1399).

Never use as a label: run id, request id, key name, client IP, raw path,
error message. One high-cardinality label turns the gateway's `/metrics`
into a memory leak (KEDA made its per-trigger histogram labels opt-in for
this reason, `keda pkg/metricscollector/prommetrics.go:35-178`).

## Consumers that pin the names

Alert rules in SPEC.md:1391-1401 query `krun_scheduler_leader`,
`krun_functions_synced`, `krun_runs_failed_total{reason}`,
`krun_deliveries_total{state="dead"}`, `krun_quota_rejections_total` and
`krun_queue_wait_seconds_bucket`. Renaming a metric or a label breaks the
chart's PrometheusRule and `promtool` in `make helm-lint`; that is a
Decisions row, not a refactor.

## prom-client mapping (prom-client 15.1.3, `npm view` 2026-10-23)

- One `new Registry()` per process, held by the `Metrics` service layer
  (`Layer.sync(Metrics, () => ...)` in `packages/shared/src/runtime`,
  PLAN.md:107) and taken from it by every module that registers a metric
  and by the admin plugin; never the global default registry (duplicate
  registration throws when one Vitest file builds several apps). Tests
  provide a fresh `Metrics` layer per test (`it.effect` with
  `Effect.provide`, or `layer(MetricsTest)` from `@effect/vitest`).
  Effect `Metric` is not used (docs/STACK.md 2.5), even though `effect`
  4.0.6 ships a `Metric` module.
- `new Counter({ name, help, labelNames, registers: [registry] })`,
  same for `Gauge` and `Histogram`.
- `GET /metrics`: `reply.type(registry.contentType)` then
  `await registry.metrics()` (async, returns a string).
- Observe seconds computed from `Clock` (`Clock.currentTimeMillis`
  differences, or `DateTime` differences for run timestamps), never
  `Date.now()`, so `TestClock` tests can assert exact values. Exception:
  `krun_http_request_seconds` may observe `reply.elapsedTime / 1000` in
  the `onResponse` hook; Fastify 5.12.7 measures it itself from a
  high-resolution timer (`lib/reply.js` `elapsedTime`), so no
  `Date.now()` appears in krun code. Tests of that histogram assert the
  count, not the value.
- Default buckets are `[0.005 … 10]` seconds: fine for
  `krun_http_request_seconds`, wrong for queue wait, cold start, run
  duration and terminal detect, whose values run from seconds to hours.
  Give those an explicit bucket list that reaches `KRUN_MAX_ACTIVE_DEADLINE`
  (e.g. `[1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600,
  86400]`); SPEC does not fix buckets, so pick once and keep them stable
  (`KrunQueueWaitHigh` uses `histogram_quantile` over them, SPEC.md:1401).
- `krun_runs_current` is refilled from `countByState` each loop (SPEC.md:1135):
  call `gauge.reset()` before refilling so a Function with no runs, or a
  deleted Function, does not keep its last value forever.
- `krun_scheduler_leader` is set to 1 on acquisition and 0 on loss and
  before the Lease is released at shutdown (`KrunNoLeader` also fires on
  `absent(...)`, so every scheduler replica must expose the series,
  SPEC.md:1395).
- Open gap: SPEC lists no `process_*`/`nodejs_*` default metrics
  (`collectDefaultMetrics`) and no `krun_build_info`; both are additions
  outside the table and need a Decisions row before they appear on
  `/metrics` (PLAN.md:31-32 "no options or abstractions no task asks for").
