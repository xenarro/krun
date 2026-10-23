---
name: krun-process-runtime
description: Use when wiring krun env config, health, telemetry or logs. Zod env schema as a Config layer, readiness route over a Ref, OpenTelemetry Telemetry layer (Effect Metric on /metrics, OTLP spans), pino-backed Effect Logger with traceId, runMain shutdown.
---

# krun process runtime: config, admin listener, telemetry, logs, shutdown

Covers what both krun processes share below the business logic: SPEC
section 12 env parsing and startup validation, the admin listener
(`/healthz /readyz /metrics`), SPEC section 11 telemetry (Effect `Metric`s
exported by the OpenTelemetry Prometheus exporter, Effect spans exported
over OTLP), pino logging and the Effect Logger on top of it, the audit
line, health rules, the process entry and the SIGTERM sequences. PLAN
tasks P0.5, P0.7, P3.1b, P3.7, P4.6, P4.11; every app skill points here for
these.

## When to use

- Writing `packages/shared/src/config` (P0.5), `packages/shared/src/health`
  (P0.7) or the Config, Logger, Metrics and Telemetry layers in
  `packages/shared/src/runtime` (PLAN.md:100, 110-111).
- Adding a metric, a span, a span attribute, a log field, a redact path or
  the audit line (P3.1b, P4.6, and any task that touches a `krun_*` metric
  or wraps a store or Kubernetes call).
- Wiring `main.ts` of the gateway (P3.7) or scheduler (P4.11): `runMain`,
  listener layers, the `Telemetry` layer, readiness, finalizer order.
- Load next to it: `krun-gateway-api` or `krun-scheduler-k8s` (routes,
  loops), `krun-functions-crd` (informer `synced`, P2.3),
  `krun-helm-chart` (probes, grace, `observability.*` values),
  `krun-testing-ci` (`test/fake-kube`).
- Also load `effect-core-patterns`, `effect-dependency-injection`,
  `effect-resource-management`, `effect-testing`, `fastify-best-practices`,
  `zod-4`, `vitest`, and for telemetry `observability-and-instrumentation`
  (docs/STACK.md section 5). Effect's `MIGRATION.md`, the
  `@effect/opentelemetry` docs and this skill's verified facts override
  Effect 3 skill text.

## Read first

- docs/STACK.md in full (normative, SPEC D35 and D36): 2.5 pino, 2.6
  observability (package lines and pins), 4.1 process shape with the
  `Telemetry` layer, 4.3, 4.4 time.
- SPEC.md:176-189 listeners; SPEC.md:1141-1206 section 11 (telemetry
  paragraph SPEC.md:1143-1156); SPEC.md:1208-1257 section 12 (`OTEL_*` rows
  SPEC.md:1251-1253); SPEC.md:158-161 readiness waits for the Function
  informer (D17); SPEC.md:1376-1381 probes; D30.
- PLAN.md:183-190 P0.5; PLAN.md:195-202 P0.7; PLAN.md:385-388 P3.1b;
  PLAN.md:438-447 P3.7; PLAN.md:558-566 P4.6; PLAN.md:602-609 P4.11;
  PLAN.md:59-90 allowed dependencies.
- References: `references/env-table.md` (section 12 table, Zod code),
  `references/metrics-table.md` (section 11 metrics, Effect `Metric`
  mapping, exporter naming), `references/telemetry.md` (the `Telemetry`
  layer, `/metrics` mounting, spans, `traceparent`, OTLP variables, span
  redaction, tests), `references/logging.md` (redact list, audit line,
  Effect Logger on pino with `traceId`/`spanId`), `references/shutdown.md`
  (runMain mechanism, both SIGTERM sequences, tests),
  `references/library-facts.md` (verified versions, prior art).

## Rules

1. One config per process, every section 12 variable with its default,
   parsed once by a Zod schema over `process.env` in
   `packages/shared/src/config` and exposed as an Effect `Config` service
   layer (PLAN.md:100, 183-190, docs/STACK.md principle 2); scattered
   `process.env` reads skip validation. Effect's own `Config` module and
   Effect Schema are not used for this. The OpenTelemetry SDK also reads
   the standard `OTEL_*` variables itself; that is the one exception, and
   krun still parses them so its own decisions (rule 27) use one value.
2. An empty value is unset: the default applies and no validation runs on
   it (SPEC.md:1215-1216); `KRUN_S3_PRESIGN_TTL=""` must yield the default
   (PLAN.md:189-190).
3. Validate at startup and exit 1 naming the first bad variable
   (SPEC.md:1211-1212): the five rules are DSN empty in postgres mode,
   scheduler with webhook hosts and no secret, a size above 1048576, a
   duration not matching `^\d+(ms|s|m|h)$`, a CIDR that does not parse
   (SPEC.md:1212-1215). Name the variable, never print its value.
4. Flags are unsupported except `--help` (SPEC.md:1210); add no other
   flags or options (PLAN.md:32-33).
5. `KRUN_NAMESPACE` falls back to the ServiceAccount `namespace` file
   (SPEC.md:1229) and `KRUN_GATEWAY_INTERNAL_URL` defaults to
   `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` (SPEC.md:1227),
   computed after the namespace is known.
6. `/healthz` is always 200 while the process runs (SPEC.md:1193); never
   couple it to the database or the informer, the chart's liveness probe
   hits it and a restart loop would not help (SPEC.md:1378-1379).
7. `/readyz` is 503 until marked ready (database check passes and the
   Function informer finished its initial list), when the database check
   exceeds 2 seconds, and from the start of shutdown (SPEC.md:1193-1195,
   SPEC.md:158-161, PLAN.md:195-201). It is a small route over an Effect
   `Ref`, the check bounded with `Effect.timeout("2 seconds")`; a stalled
   check returns 503, it does not hang the probe.
8. A scheduler standby stays ready and reports leader status in the
   `/readyz` body without failing readiness (SPEC.md:1195-1196,
   PLAN.md:604-605); `RollingUpdate maxUnavailable: 0` relies on a Ready
   standby (SPEC.md:1384-1386).
9. Each listener answers 404 for the other listeners' paths
   (SPEC.md:181): `/v1/*` on the admin port is 404 (P3.7, PLAN.md:444),
   so the admin plugin registers only its three routes and no catch-all.
10. Metrics: exactly the SPEC.md:1161-1179 table, names, labels and
    owners; `route` is `request.routeOptions.url` and `unmatched` for 404
    (SPEC.md:1163); the chart's alert rules query these names
    (SPEC.md:1448-1456), so a rename is a Decisions row.
11. Metrics are Effect `Metric`s (`Metric.counter`, `Metric.gauge`,
    `Metric.histogram`) defined once in the Metrics module of
    `packages/shared/src/runtime`. The OpenTelemetry Prometheus exporter
    (`@opentelemetry/exporter-prometheus`, created with
    `preventServerStart: true`) is the `metricReader` of the `Telemetry`
    layer, and `GET /metrics` on the admin Fastify instance serialises its
    `collect()` result. The exporter never opens its own port (its default
    is 9464) and metrics are never on the public or internal port
    (SPEC.md:1143-1145, D30). There is no second metrics library and no
    global registry of any library.
12. pino JSON, level from `KRUN_LOG_LEVEL`, fields `run_id function state
    reason reqId` (SPEC.md:1181-1182), plus `traceId` and `spanId` on every
    line inside a span (SPEC.md:1152-1153); the `redact` list
    `req.headers.authorization input result runtimeStatus error.details
    dsn` on every listener of both processes (SPEC.md:1183-1185). The
    Effect `Logger` is replaced by one that writes to the same pino
    instance, so `Effect.log*` lines get the same format and redaction
    (docs/STACK.md 2.5).
13. Never log bodies, Job manifests, env lists, input, results, tokens,
    keys or the config object (SPEC.md:1185-1186, 1103-1105, 992); log
    names and ids, not values. docs/PROBLEM.md:82 makes this a success
    criterion.
14. One audit line per `/v1` request at info, warn on 401 and 403, with
    `key client_ip user_agent route code run_id function idempotency_key`,
    never the key itself (SPEC.md:1188-1191); P3.1b asserts `key: null`
    and a `reqId` on the 401 line (PLAN.md:386-387).
15. `X-Request-Id` accepted up to 128 characters else replaced by a UUID,
    echoed on every response, `reqId` on every request-scoped line
    (SPEC.md:276-277); `trustProxy: true` for `client_ip` (SPEC.md:1189).
16. Gateway SIGTERM: readiness 503 first, serve for `KRUN_SHUTDOWN_DELAY`
    with `/v1` never answering `NOT_READY`, then close listeners, end SSE,
    answer waits, close the pool, exit 0 (SPEC.md:1198-1202).
17. Scheduler SIGTERM: stop claiming, bound the iteration to 10 s, stop
    informers, clear `holderIdentity`, close the pool, exit 0
    (SPEC.md:1202-1206); leader loss exits non-zero instead
    (SPEC.md:796-798).
18. Shutdown is `NodeRuntime.runMain(Layer.launch(Main), { teardown })`
    plus scope finalizers (docs/STACK.md 4.1): SIGTERM interrupts the main
    fiber, finalizers run in reverse acquisition order, so listeners close
    before the pool and the `Telemetry` layer flushes last. Pass the
    teardown from `references/shutdown.md`: the default maps SIGTERM to
    exit 130, SPEC wants 0. No signal handlers of your own; `process.exit`
    only in the grace watchdog. Both sequences fit the 30 s grace
    (SPEC.md:1206, 1274): bound each release step with `Effect.timeout` and
    arm a 25 s watchdog so a stuck step cannot outlive the kubelet's
    SIGKILL.
19. Dependencies only from PLAN.md:59-75 (ranges in docs/STACK.md); `pino`
    arrives through `fastify`; `effect`, `@effect/platform-node`,
    `@effect/opentelemetry`, the `@opentelemetry/*` packages of
    docs/STACK.md 2.6, `zod`, `ipaddr.js`, `uuid` are listed; anything else
    (`pino-pretty`, `dotenv`, `envalid`, `@opentelemetry/core`,
    `@opentelemetry/auto-instrumentations-node`, any instrumentation
    package) needs a Decisions row (PLAN.md:30-31).
20. Time: application code never calls `Date.now()` or `new Date()`; read
    `Clock`/`DateTime`, and tests use `TestClock` (CLAUDE.md rule 8,
    docs/STACK.md 4.4).
21. One `Telemetry` layer per process, built with `NodeSdk.layer` from
    `@effect/opentelemetry` and provided in `main.ts` of the gateway and
    the scheduler below every other layer (docs/STACK.md 4.1), so spans
    from shutdown steps still flush when it is released. It carries the
    resource (service name), the Prometheus exporter as `metricReader`,
    and a `BatchSpanProcessor` over `OTLPTraceExporter` only when
    `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Shape and verified facts:
    `references/telemetry.md`.
22. Metric naming, so `/metrics` shows exactly the SPEC names and no
    doubled `_total`: give each Effect metric its full SPEC name. Counters
    use `incremental: true`; the exporter appends `_total` only to a
    monotonic sum whose name does not already end in `_total`, and a
    counter without `incremental: true` is exported as a Prometheus
    `gauge`. Histograms carry `_seconds` in the name and record seconds;
    the exporter adds no unit suffix. Never use `Metric.timer` (it records
    milliseconds and adds a `time_unit` label) and never an attribute
    named `unit` or `time_unit`. Construct the exporter and serializer
    with `withoutScopeInfo` and `withoutTargetInfo` so no `otel_scope_*`
    labels and no `target_info` series appear. P4.6 asserts this
    (PLAN.md:561-563).
23. Spans (SPEC.md:1147-1150), each with `Effect.withSpan` or an explicit
    span: every `/v1` and `/internal/v1` request (one server span per
    request, named `<METHOD> <route template>`), every scheduler loop
    iteration (main, heartbeat, deliveries, sweep, reconcile), every
    `Store` method, every Kubernetes API call. Wrap store and Kubernetes
    calls once, in the `Database`/`Store` and `Kube` service layers, not
    at each call site. Every span about a run carries the attribute
    `krun.run_id` (SPEC.md:1153-1156): the `CreateRun` and run-scoped
    `/v1` requests, internal API requests (the run in the path), per-run
    work inside an iteration (give it a child span), and store and
    Kubernetes calls made for one run. That attribute, not a shared trace,
    correlates a run across gateway, scheduler and pod: v1 does not join
    them into one trace. Admin routes (`/healthz`, `/readyz`, `/metrics`)
    get no span. Span names are not in SPEC: pick them once in the
    Telemetry module and keep them stable.
24. `traceparent`: an incoming W3C header on the public and internal API
    becomes the parent of the request span (SPEC.md:1151-1152). Parse it
    in house (version `00`, 32 and 16 lowercase hex, two-hex flags, all-zero
    ids invalid); an invalid header is ignored, never a 400. Webhook
    deliveries send one built from the current span
    (`krun-webhooks-objstore`). Do not add `@opentelemetry/core` for its
    propagator.
25. `traceId` and `spanId` on log lines inside a span: the pino-backed
    Effect Logger reads the fiber's current span and adds both fields; the
    audit hook adds them from the request span. Never also bind them into
    a pino child, or pino writes the keys twice. Details:
    `references/logging.md`.
26. Span attributes and span events never contain input, results,
    `runtimeStatus`, `error.details`, tokens, API keys, the
    `Authorization` header, the DSN, presigned URLs, Job manifests, env
    lists, bodies, or SQL bound parameters (SPEC.md:1156-1157, the same
    list as rule 13). pino `redact` does not apply to spans: the rule is
    enforced by what you pass to `withSpan` attributes and
    `Effect.annotateCurrentSpan`. Allowed: route template, method, status
    code, `krun.run_id`, the Function name, state, reason, store method
    name, Kubernetes verb, resource kind and status code.
27. OTLP variables are section 12 rows (SPEC.md:1251-1253), parsed by the
    Zod config like any other (empty is unset, no extra validation rules):
    no `OTEL_EXPORTER_OTLP_ENDPOINT` means no span processor and nothing
    exported, while spans still exist so log lines keep their ids;
    `OTEL_SERVICE_NAME` defaults to `krun-gateway` or `krun-scheduler`;
    with `OTEL_TRACES_SAMPLER` unset krun passes the SPEC default
    `parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG` (default
    `0.1`) itself, because the SDK's own default is
    `parentbased_always_on`. The chart sets them from `observability.*`
    (P7.4d, `krun-helm-chart`).

## Config parsing (P0.5)

- Shape: Zod schemas `GatewayEnv` and `SchedulerEnv` over a plain
  `Record<string, string | undefined>`, and a `parseConfig(env)` Effect
  that fails with a `ConfigInvalid` `Data.TaggedError` carrying the
  variable name; tests pass objects, never `process.env`. The service
  layer (`Layer.effect`) reads `process.env` once and runs `parseConfig`.
  Its failure fails `Layer.launch`: one error line naming the variable,
  then the teardown exits 1 (probe: exit 1). Name the service `KrunConfig`
  or similar so it is not confused with Effect's `Config` module.
- Treat `''` as `undefined` before every rule (rule 2): one `z.preprocess`
  wrapper shared by every field. Trim nothing else; a stray space in a
  duration is a validation error.
- Durations: `z.string().regex(/^\d+(ms|s|m|h)$/)` transformed into an
  Effect `Duration` (docs/STACK.md 4.3). Give its default with
  `.prefault("5s")`, never `.default(Duration.seconds(5))`: Zod 4.6.7
  shallow-clones an object default and the `Duration` comes back as a
  plain object (probe). Integer variables are plain digits
  (`KRUN_MAX_ACTIVE_DEADLINE=86400` is seconds, not a duration). Do not use
  `z.coerce.number()`: it accepts `1e3`, ` 12` and `""`. Verified code and
  the full table: `references/env-table.md`.
- CIDRs: split on `,`, trim, parse each with `ipaddr.js` (`parseCIDR`,
  PLAN.md:74) in a transform that adds an issue on failure; keep the parsed
  tuples so the webhook check does not re-parse (`krun-webhooks-objstore`).
- "First bad variable": the first issue's `path[0]`. Field issues come in
  schema key order (keep the SPEC table order); cross-field rules (DSN in
  postgres mode, scheduler webhook secret) sit in a `superRefine`, whose
  issues always come after the field issues. Never format the `ZodError`
  or `issue.input` into a log line: it can hold the DSN or a secret.
- The webhook-secret rule applies to the scheduler config only
  (SPEC.md:1212-1213); the gateway validates hosts and CIDRs but not the
  secret.
- `KRUN_DB_MODE` is `postgres` or `embedded` (SPEC.md:1220); anything else
  is the first bad variable.
- Acceptance (PLAN.md:187-190): one Vitest test per rule plus defaults and
  the empty-value case. Parsing is pure, so plain `it` is enough; use
  `it.effect` for the `parseConfig` Effect and its tagged failure.

## Admin listener (P0.7)

- `packages/shared/src/health`: a Fastify plugin registered on its own
  Fastify instance listening on `KRUN_ADMIN_LISTEN_ADDR`, wrapped in the
  `AdminServer` scoped layer; the gateway has three instances, the
  scheduler one (SPEC.md:178-180; one Fastify instance owns one server).
  Readiness is the hand-written route below; no plugin outside
  docs/STACK.md.
- A `Readiness` service holds a `Ref` of `{ ready: boolean, draining:
  boolean, leader?: boolean }` plus a `dbCheck: Effect<void, DatabaseError>`
  and `functionsSynced: Effect<boolean>`. `main.ts` flips `ready` after the
  first good check; the `Drain` finalizer sets `draining`.
- The hand-written route (probe `mod.test.mjs` passed with this shape):
  ```ts
  app.get("/readyz", async (_req, reply) => {
    const ok = await run(Effect.gen(function* () {
      const s = yield* Ref.get(readiness.state)
      if (s.draining || !s.ready || !(yield* readiness.functionsSynced)) return false
      return Option.isSome(yield* readiness.dbCheck.pipe(Effect.timeoutOption("2 seconds"), Effect.option, Effect.map(Option.flatten)))
    }))
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "unavailable", ...leaderField })
  })
  ```
  `run` is `Effect.runPromiseWith(ctx)` over the context captured in the
  layer constructor; `leaderField` is `{ leader }` on the scheduler only.
- `/healthz` is a plain route that returns 200.
- `/metrics`: the admin plugin takes the exporter from the `Telemetry`
  layer (a `MetricsReader` service) and answers with
  `serializer.serialize((await exporter.collect()).resourceMetrics)` and
  `text/plain; version=0.0.4; charset=utf-8`. Code, the alternative with
  `getMetricsRequestHandler` and why it is second choice:
  `references/telemetry.md`.
- Acceptance (PLAN.md:201-202): `@effect/vitest` `it.effect` with Fastify
  `inject` and `TestClock`. Build the app inside the test from
  `yield* Effect.context()` so its handlers run on the `TestClock`. Stalled
  DB check: `dbCheck = Effect.never`, fork `Effect.promise(() =>
  app.inject("/readyz"))`, `TestClock.adjust("1999 millis")` and assert the
  fiber is still pending (`fiber.pollUnsafe()` is `undefined` after an
  `Effect.yieldNow`), adjust 1 ms more, join, expect 503. Also: 200 when
  ready, 503 when `draining`, 404 for `/v1/functions` on the admin app, and
  a `/metrics` scrape that contains a counter registered in the test.
- Probe hits are not audit lines, not info logs and not spans.

## Metrics (P3.1b, P4.6)

- Table, types, owning tasks and the Effect `Metric` mapping:
  `references/metrics-table.md`.
- `krun_http_*` are recorded in one `onResponse` hook on every listener,
  including the admin listener of the scheduler (owner "both",
  SPEC.md:1163-1164); the hook reads `request.routeOptions.url` and maps
  undefined to `unmatched`.
- Histograms for every `_seconds` metric with explicit `boundaries`
  (`Metric.histogram` requires them), run-timing buckets up to
  `KRUN_MAX_ACTIVE_DEADLINE`, durations from `Clock`; `krun_runs_current`
  refilled from `countByState` each loop (SPEC.md:1167) with every pair
  seen before and now absent set to 0; no run id, request id, key name, IP
  or raw path as a label.
- Tests provide `Metric.MetricRegistry` with a fresh `new Map()` per test:
  the default registry is shared by every context that does not override
  it.
- Acceptance P3.1b: a 404 counts under `unmatched` (PLAN.md:387-388);
  P4.6: the exact names appear on `/metrics` after one run through
  `test/fake-kube`, no doubled `_total`, histograms in seconds
  (PLAN.md:561-563).

## Telemetry (P0.7, P4.6)

- Layer shape, exporter mounting, spans, `traceparent`, OTLP variables,
  span redaction and tests: `references/telemetry.md`.
- `NodeSdk` and every `@effect/opentelemetry` module are
  `@stability unstable` in 4.0.6; docs/STACK.md 2.6 pins them `~4.0.6`
  with `effect`. For a name not shown in `references/telemetry.md`, check
  the `@effect/opentelemetry` docs and Effect's `MIGRATION.md` rather than
  guess.
- Acceptance P4.6 (PLAN.md:563-566): with an `InMemorySpanExporter` behind
  a `SimpleSpanProcessor` in the test `Telemetry` layer, the run's create
  request, the iteration's per-run span and its Kubernetes calls all carry
  the same `krun.run_id`, and a `traceparent` sent with `CreateRun`
  becomes the parent of the request span (same trace id, parent span id
  from the header).

## Logging and audit (P3.1b)

- Details, redact list verbatim, audit fields, levels and the verified
  Effect Logger code: `references/logging.md`.
- Request logging off on every listener through `logController: new
  LogController({ disableRequestLogging: true })` (the top-level
  `disableRequestLogging` is deprecated in Fastify 5.12.7, FSTDEP023); the
  audit line is one `onResponse` hook on the public listener so 401, 404
  and 415 produce it too.
- Effect logs: `Logger.layer([PinoLogger])` replaces the default logger
  set (which also drops Effect's `tracerLogger`, so log lines do not
  become span events), and `References.MinimumLogLevel` follows
  `KRUN_LOG_LEVEL` (Effect's default minimum is `Info`). Inside a request,
  provide `request.log` as the `CurrentPino` reference so `Effect.log*`
  lines carry `reqId`.
- Redaction test (PLAN.md:388): capture pino output to a stream, log an
  object with sentinel values at each redact path through the root pino,
  `request.log` and `Effect.logInfo`, assert the sentinel is absent; run
  the same request with an in-memory span exporter and assert the
  sentinel is in no span attribute or event either.

## Shutdown (P3.7, P4.11)

- Verified mechanism, layer shape, step tables for both processes, the
  budget, the watchdog and the tests: `references/shutdown.md`.
- Exit codes: SIGTERM is an interrupt-only exit, which `runMain`'s default
  teardown maps to **130** (probe). Pass `teardown: (exit, onExit) =>
  onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1)`.
  Leader loss and config failure fail the main fiber and exit 1.
- `Layer.mergeAll` releases its members concurrently, so the three
  gateway listeners close together; a `Drain` layer above them flips
  readiness (`Ref.set`, before any sleep) and waits the delay once.
- Fastify `close()` does not end hijacked `reply.raw` SSE responses:
  complete the shutdown `Deferred` in the public listener's `preClose`
  hook and await the tracked responses' `finish` there, or `close()`
  waits on a busy keep-alive socket until its timeout (probe).
- The `Telemetry` layer releases last: the tracer provider force-flushes
  and shuts down under `shutdownTimeout` (default 3000 ms in
  `@effect/opentelemetry` 4.0.6), inside the 25 s watchdog budget.

## Library facts and prior art

Verified versions, Effect 4/Fastify/pino/OpenTelemetry API facts and the
Dapr, Knative, KEDA lessons: `references/library-facts.md`.

## Pitfalls

- `KRUN_S3_PRESIGN_TTL=""` is the default, not an invalid duration
  (PLAN.md:189-190).
- The embedded-mode scheduler listens on `:9091` because the chart sets
  `KRUN_ADMIN_LISTEN_ADDR` so two processes share one pod (SPEC.md:1226);
  tests that run both processes locally must pick distinct admin ports.
- `KRUN_MAX_INPUT_BYTES` and `KRUN_MAX_RESULT_BYTES` have a hard ceiling
  of 1048576 (SPEC.md:1214); the chart also fails above it
  (`krun-helm-chart`).
- Liveness never on `/readyz`, no startup probe (SPEC.md:1379); a
  `/healthz` that checks the DB turns an outage into a restart storm.
- Gateway readiness depends on the API server at startup (D17,
  docs/PROBLEM.md:97-98): an unreachable API server keeps the gateway 503
  by design; do not "fix" it by serving before the initial list.
- `process.exit` anywhere but the grace watchdog skips the finalizers and
  leaves the Lease held and the pool open; `runMain`'s teardown ends the
  process. A config failure is a failed layer, not an exit call.
- `KRUN_SHUTDOWN_DELAY` must elapse once per process: one `Drain` layer
  above the merged listeners, not one sleep per listener release.
- A `ManagedRuntime` or context captured outside an `it.effect` body runs
  on the live clock; `TestClock.adjust` then does nothing and the 2 s
  readiness test hangs or sleeps for real.
- Under `TestClock`, test shutdown order with `Scope.close` on a scope
  from `Layer.buildWithScope`; interrupting a `Layer.launch` fiber made a
  finalizer's `Effect.sleep` return `Interrupt` at once (probe).
- Informer stop must run in a finalizer or the watch keeps the event loop
  alive and the P4.11 5 s exit assertion fails.
- `new PrometheusExporter()` without `preventServerStart: true` opens its
  own HTTP server on 9464, outside the admin listener and the chart's
  NetworkPolicy.
- Naming a counter `krun_x` with `incremental: true` exports
  `krun_x_total`; naming it `krun_x_total` without `incremental: true`
  exports a `gauge`. Both break the alert rules. Use the full SPEC name
  and `incremental: true`.
- Passing `resource.serviceName` to `NodeSdk.layer` overrides
  `OTEL_SERVICE_NAME` (explicit attributes win over the environment in
  `Resource.layerFromEnv`), so pass the parsed variable, defaulting per
  process, not a constant.
- A store span whose attributes carry SQL text with inlined values or the
  bound parameters leaks input into the trace backend; record the
  `Store` method name only.
- SPEC RISK (quiet period vs fixed delay): knative-serving argues the drain
  should be a quiet period that restarts on activity; SPEC.md:1198-1199
  and D30 define a fixed `KRUN_SHUTDOWN_DELAY`. Implement the fixed delay;
  a quiet period is a Decisions row.
- Open gap (Lease identity): SPEC.md:791 says
  `holderIdentity` is the pod name from the downward API (`metadata.name`),
  but section 12 (SPEC.md:1218-1254) lists no variable carrying it (e.g.
  `KRUN_POD_NAME`), the chart's `config:` block (SPEC.md:1276-1292) names
  none, and P4.2 (PLAN.md:494-495) only says "the pod name". P4.2/P4.11
  need a Decisions row adding the variable (default: `os.hostname()`,
  which is the pod name in Kubernetes) before the scheduler config is
  complete.
- Open gap (namespace outside a pod): SPEC.md:1229 gives no behaviour
  when `KRUN_NAMESPACE` is unset and the ServiceAccount file is missing.
  Fail startup naming `KRUN_NAMESPACE` and set it in tests; a `krun`
  default like the CLI's (SPEC.md:762) needs a Decisions row.
- Open gap (extra series): SPEC lists no Node runtime metrics, no
  `krun_build_info`, no `target_info`; do not enable
  `Metric.enableRuntimeMetrics` or any OpenTelemetry host or runtime
  instrumentation without a Decisions row (`references/metrics-table.md`).
- Do not join a run's spans into one trace across processes: SPEC
  section 11 says v1 does not, and SPEC section 6 has no column for a
  trace context. No `traceparent` column, no span links from stored ids,
  no trace env variable on the Job; that would be a Decisions row.
  Correlation is the `krun.run_id` attribute (docs/OPERATIONS.md
  "Telemetry").
- Open gap (sampler argument): SPEC gives no rule for an
  `OTEL_TRACES_SAMPLER_ARG` outside `[0, 1]` or not a number; the five
  startup rules do not cover it. Fall back to `0.1` with a warn line
  naming the variable, or ask for a Decisions row; do not exit 1 on it.

## Before marking a task done

- Run the task's acceptance (`pnpm exec vitest run <dir>` for P0.5/P0.7,
  PLAN.md:187-190, 201-202; handler tests for P3.1b; process tests against
  `test/fake-kube` for P3.7/P4.11; the `/metrics` scrape and the in-memory
  span exporter for P4.6), then `make check`, which includes `knip`
  (PLAN.md:17-18, CLAUDE.md rule 3).
- Branch per task id, Conventional Commits scoped `shared`, `gateway` or
  `scheduler`, PR to main, mark `[x]` and append the progress-log line in
  the same commit (PLAN.md:13-22); no `Co-Authored-By` trailer (CLAUDE.md
  rule 5).
- Blocked on an owner decision (Lease identity variable, namespace
  default): `BLOCKED P4.11: <need>` in the progress log (PLAN.md:28-29).

## Limitations

- Line numbers verified against the working tree on 2026-10-23; Decisions
  are cited by id. Re-check a cited line before quoting it in a commit or
  a Decisions row.
- Library facts come from JavaScript probes on Node 26, not TypeScript 7:
  snippet type signatures are UNVERIFIED until the first `tsc` run.
  `NodeRuntime` and `NodeSdk` are `@stability unstable` in 4.0.6. The
  OpenTelemetry facts in `references/telemetry.md` were read from the
  published package sources (`npm pack`), not run; each is marked.
- This skill does not cover route handlers, error envelopes or SSE
  framing (`krun-gateway-api`), the loops and Lease contract
  (`krun-scheduler-k8s`), Store pool setup (`krun-store`), the informer
  (`krun-functions-crd`), chart probes, NetworkPolicies and
  `observability.*` values (`krun-helm-chart`), the webhook `traceparent`
  header (`krun-webhooks-objstore`), or `test/fake-kube`
  (`krun-testing-ci`).
