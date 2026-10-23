---
name: krun-process-runtime
description: Use when wiring krun env config, health, telemetry or logs. Zod env schema as a Config layer, readiness route over a Ref, OpenTelemetry Telemetry layer (Effect Metric on /metrics, OTLP spans), pino-backed Effect Logger with traceId, runMain shutdown.
---

# krun process runtime: config, admin listener, telemetry, logs, shutdown

Shared by both processes below the business logic: env config, admin
listener (`/healthz /readyz /metrics`), telemetry, logs, shutdown.

## When to use

- Writing `packages/shared/src/config` (P0.5), `packages/shared/src/health`
  (P0.7), or the Config, Logger, Metrics and Telemetry layers in
  `packages/shared/src/runtime` (PLAN.md:100, 110-111); wiring `main.ts`
  of the gateway (P3.7) or scheduler (P4.11).
- Adding a metric (any `krun_*`), span, span attribute, log field, redact
  path or the audit line; wrapping a store or Kubernetes call (P3.1b,
  P4.6).
- Load with: the app skill (`krun-gateway-api`, `krun-scheduler-k8s`),
  `krun-functions-crd` (informer `synced`, P2.3), `krun-helm-chart`
  (probes, grace, `observability.*` values), `krun-testing-ci`
  (`test/fake-kube`); `effect-core-patterns`,
  `effect-dependency-injection`, `effect-resource-management`,
  `effect-testing`, `fastify-best-practices`, `zod-4`, `vitest`,
  `observability-and-instrumentation` (docs/STACK.md section 5). Effect's
  `MIGRATION.md`, the `@effect/opentelemetry` docs and this skill's
  verified facts override Effect 3 skill text.

## Read first

- docs/STACK.md in full (normative, SPEC D35 and D36): 2.5 pino, 2.6
  observability pins, 4.1 process shape, 4.3, 4.4 time.
- SPEC.md:176-189 listeners; SPEC.md:1141-1206 section 11 (telemetry
  SPEC.md:1143-1156); SPEC.md:1208-1257 section 12 (`OTEL_*` rows
  SPEC.md:1251-1253); SPEC.md:158-161 readiness waits for the informer
  (D17); SPEC.md:1376-1381 probes; D30.
- PLAN.md:183-190 P0.5; PLAN.md:195-202 P0.7; PLAN.md:385-388 P3.1b;
  PLAN.md:438-447 P3.7; PLAN.md:558-566 P4.6; PLAN.md:602-609 P4.11;
  PLAN.md:59-90 allowed dependencies.

| Task | Reference | Acceptance |
|---|---|---|
| P0.5 | `references/env-table.md`: table, startup rules, `parseConfig` shape, Zod code | one Vitest test per rule, plus defaults and the empty-value case (PLAN.md:187-190) |
| P0.7 | `references/health.md`: plugin, `Readiness`, `/readyz` code | stalled DB check 503 at 2 s under `TestClock`, 503 when draining, `/v1/*` 404 on admin, `/metrics` scrape (PLAN.md:201-202) |
| P3.1b metrics | `references/metrics-table.md`: table, labels, `Metric` mapping, buckets | a 404 counts under `unmatched` (PLAN.md:387-388) |
| P3.1b logging | `references/logging.md`: pino, Effect Logger, redact, audit, levels | no redact-path sentinel in any log line or span (PLAN.md:388) |
| P4.6 | `references/metrics-table.md`, `references/telemetry.md`: layer, `/metrics`, spans, `traceparent`, tests | exact names on `/metrics` after one run through `test/fake-kube`, no doubled `_total`, seconds (PLAN.md:561-563); same `krun.run_id` on create, per-run and Kubernetes spans; `traceparent` becomes the parent (PLAN.md:563-566) |
| P3.7, P4.11 | `references/shutdown.md`: `runMain`, layer shape, step tables, tests | exit 0 within 5 s of SIGTERM; scheduler clears the Lease |
| any | `references/library-facts.md`: versions, Effect 4/Fastify facts, prior art | |

## Rules

### Config (P0.5)

1. One Zod schema per process in `packages/shared/src/config` parses
   `process.env` once, every section 12 variable with its default, exposed
   as an Effect `Config` service layer (PLAN.md:100, 183-190, docs/STACK.md
   principle 2). Nothing else reads `process.env`. Not Effect's own
   `Config` module, not Effect Schema. Only exception: the OpenTelemetry
   SDK reads the `OTEL_*` variables itself; krun parses them too (rule 26).
2. Empty value is unset: the default applies, no validation runs
   (SPEC.md:1215-1216). `KRUN_S3_PRESIGN_TTL=""` yields the default, not an
   invalid duration (PLAN.md:189-190).
3. Validate at startup; exit 1 naming the first bad variable (first Zod
   issue's `path[0]`, SPEC.md:1211-1212). Five rules (SPEC.md:1212-1215):
   DSN empty in postgres mode; scheduler only: webhook hosts set and no
   secret (SPEC.md:1212-1213); size above 1048576 (SPEC.md:1214); duration
   not matching `^\d+(ms|s|m|h)$`; CIDR that does not parse. `KRUN_DB_MODE`
   is `postgres` or `embedded` (SPEC.md:1220). Name the variable, never
   print its value. Never log the `ZodError` or `issue.input`: it can hold
   the DSN or a secret.
4. No flags except `--help` (SPEC.md:1210); add no other flags or options
   (PLAN.md:32-33).
5. `KRUN_NAMESPACE` falls back to the ServiceAccount `namespace` file
   (SPEC.md:1229). `KRUN_GATEWAY_INTERNAL_URL` defaults to
   `http://krun-gateway-internal.<KRUN_NAMESPACE>.svc:8081` (SPEC.md:1227),
   computed after the namespace is known.

### Admin listener and health (P0.7)

6. `/healthz` is always 200 while the process runs (SPEC.md:1193). Never
   couple it to the database or the informer: liveness hits it, so a DB
   outage would become a restart storm (SPEC.md:1378-1379). Liveness never
   on `/readyz`; no startup probe (SPEC.md:1379).
7. `/readyz` is 503 until marked ready (DB check passes and the Function
   informer finished its initial list), when the DB check exceeds 2
   seconds, and from the start of shutdown (SPEC.md:1193-1195,
   SPEC.md:158-161, PLAN.md:195-201). Small route over an Effect `Ref`;
   bound the check with `Effect.timeout("2 seconds")` so a stalled check
   returns 503 and never hangs the probe.
8. A scheduler standby stays ready and reports leader status in the
   `/readyz` body (SPEC.md:1195-1196, PLAN.md:604-605).
   `RollingUpdate maxUnavailable: 0` relies on a Ready standby
   (SPEC.md:1384-1386).
9. Each listener answers 404 for the other listeners' paths (SPEC.md:181):
   `/v1/*` on the admin port is 404 (P3.7, PLAN.md:444). The admin plugin
   registers only its three routes, no catch-all.

### Metrics (P3.1b, P4.6)

10. Exactly the SPEC.md:1161-1179 table: names, labels, owners. `route` is
    `request.routeOptions.url`, `unmatched` for 404 (SPEC.md:1163).
    `krun_http_*` come from one `onResponse` hook on every listener,
    scheduler admin included (SPEC.md:1163-1164). Chart alert rules query
    these names (SPEC.md:1448-1456): a rename is a Decisions row.
11. Metrics are Effect `Metric`s (`Metric.counter`, `Metric.gauge`,
    `Metric.histogram`), defined once in the Metrics module of
    `packages/shared/src/runtime`. The `Telemetry` layer's `metricReader`
    is the OpenTelemetry Prometheus exporter
    (`@opentelemetry/exporter-prometheus`) with `preventServerStart: true`.
    `GET /metrics` on the admin Fastify instance serialises its
    `collect()` result. Metrics are never on the exporter's own port 9464,
    the public or the internal port (SPEC.md:1143-1145, D30). No second
    metrics library; no global registry of any library.
12. Full SPEC name on each Effect metric; counters with
    `incremental: true`; histograms named `_seconds`, recording seconds;
    never `Metric.timer`; exporter and serializer with `withoutScopeInfo`
    and `withoutTargetInfo`. Otherwise names, types or labels drift from
    SPEC. P4.6 asserts this (PLAN.md:561-563).

### Logging (P3.1b)

13. pino JSON, level from `KRUN_LOG_LEVEL`, fields `run_id function state
    reason reqId` (SPEC.md:1181-1182), plus `traceId` and `spanId` on every
    line inside a span (SPEC.md:1152-1153). `redact` list
    `req.headers.authorization input result runtimeStatus error.details
    dsn` on every listener of both processes (SPEC.md:1183-1185). The
    Effect `Logger` writes to the same pino instance, so `Effect.log*`
    lines get the same format and redaction (docs/STACK.md 2.5). Never also
    bind `traceId`/`spanId` into a pino child: pino would write the keys
    twice.
14. Never log bodies, Job manifests, env lists, input, results, tokens,
    keys or the config object (SPEC.md:1185-1186, 1103-1105, 992). Log
    names and ids, not values (success criterion, docs/PROBLEM.md:82).
15. One audit line per `/v1` request at info, warn on 401 and 403, with
    `key client_ip user_agent route code run_id function idempotency_key`;
    never the key itself (SPEC.md:1188-1191). P3.1b asserts `key: null`
    and a `reqId` on the 401 line (PLAN.md:386-387).
16. `X-Request-Id` accepted up to 128 characters, else replaced by a UUID;
    echoed on every response; `reqId` on every request-scoped line
    (SPEC.md:276-277). `trustProxy: true` for `client_ip` (SPEC.md:1189).
    Fastify request logging off on every listener. Probe hits are not
    audit lines, not info logs, not spans.

### Shutdown (P3.7, P4.11)

17. Gateway SIGTERM: readiness 503 first; serve for `KRUN_SHUTDOWN_DELAY`,
    `/v1` never answering `NOT_READY`; close listeners, end SSE, answer
    waits, close the pool, exit 0 (SPEC.md:1198-1202).
18. Scheduler SIGTERM: stop claiming, bound the iteration to 10 s, stop
    informers, clear `holderIdentity`, close the pool, exit 0
    (SPEC.md:1202-1206). Leader loss exits non-zero instead
    (SPEC.md:796-798).
19. `NodeRuntime.runMain(Layer.launch(Main), { teardown })` plus scope
    finalizers (docs/STACK.md 4.1), released in reverse acquisition order:
    listeners before the pool, `Telemetry` last. Pass the krun teardown:
    the default maps SIGTERM to exit **130**, SPEC wants 0. No signal
    handlers of your own. `process.exit` only in the grace watchdog:
    elsewhere it skips finalizers, leaving the Lease held and the pool
    open. A config failure is a failed layer, not an exit call. Fit the
    30 s grace (SPEC.md:1206, 1274): bound each release step with
    `Effect.timeout`, arm a 25 s watchdog. One `Drain` layer waits the
    delay once per process.

### Dependencies and time

20. Dependencies only from PLAN.md:59-75 (ranges in docs/STACK.md); `pino`
    arrives through `fastify`. Listed: `effect`, `@effect/platform-node`,
    `@effect/opentelemetry`, the `@opentelemetry/*` packages of
    docs/STACK.md 2.6, `zod`, `ipaddr.js`, `uuid`. Anything else
    (`pino-pretty`, `dotenv`, `envalid`, `@opentelemetry/core`,
    `@opentelemetry/auto-instrumentations-node`, any instrumentation
    package) needs a Decisions row (PLAN.md:30-31).
21. Application code never calls `Date.now()` or `new Date()`: read
    `Clock`/`DateTime`; tests use `TestClock` (CLAUDE.md rule 8,
    docs/STACK.md 4.4).

### Telemetry (P0.7, P4.6)

22. One `Telemetry` layer per process: `NodeSdk.layer` from
    `@effect/opentelemetry`, provided in `main.ts` below every other layer
    (docs/STACK.md 4.1) so shutdown-step spans still flush. It carries the
    service name, the Prometheus exporter as `metricReader`, and a
    `BatchSpanProcessor` over `OTLPTraceExporter` only when
    `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `NodeSdk` is
    `@stability unstable` in 4.0.6; docs/STACK.md 2.6 pins it `~4.0.6`.
    For a name not in `references/telemetry.md`, check the
    `@effect/opentelemetry` docs and Effect's `MIGRATION.md`; never guess.
23. Spans (SPEC.md:1147-1150): every `/v1` and `/internal/v1` request,
    scheduler loop iteration, `Store` method and Kubernetes API call. Wrap
    store and Kubernetes calls once, in the `Database`/`Store` and `Kube`
    service layers, not per call site. Every span about a run carries
    `krun.run_id` (SPEC.md:1153-1156); that attribute, not a shared trace,
    correlates a run across gateway, scheduler and pod. Never join a run's
    spans into one trace: no `traceparent` column, no span links from
    stored ids, no trace env variable on the Job (docs/OPERATIONS.md
    "Telemetry"). Admin routes get no span. Span names are not in SPEC:
    pick once, keep stable.
24. `traceparent`: an incoming W3C header on the public and internal API
    becomes the request span's parent (SPEC.md:1151-1152). Parse it in
    house; an invalid header is ignored, never a 400. Do not add
    `@opentelemetry/core` for its propagator. Webhook deliveries send one
    (`krun-webhooks-objstore`).
25. Span attributes and events never hold the rule 14 list, the
    `Authorization` header, the DSN, presigned URLs, SQL text with inlined
    values, or bound parameters (SPEC.md:1156-1157). pino `redact` does not
    reach spans: control what you pass to `withSpan` attributes and
    `Effect.annotateCurrentSpan`. A store span records the `Store` method
    name only.
26. OTLP variables are section 12 rows (SPEC.md:1251-1253): empty is unset,
    no extra validation, no exit 1. No `OTEL_EXPORTER_OTLP_ENDPOINT`: no
    span processor, but spans still exist, so log lines keep their ids.
    Pass the parsed `OTEL_SERVICE_NAME` (default `krun-gateway` or
    `krun-scheduler`) as `resource.serviceName`, never a constant. With
    `OTEL_TRACES_SAMPLER` unset, krun passes `parentbased_traceidratio`
    with `OTEL_TRACES_SAMPLER_ARG` (default `0.1`) itself: the SDK default
    is `parentbased_always_on`. The chart sets them (P7.4d,
    `krun-helm-chart`).

## Pitfalls and open gaps

- Embedded mode: the chart puts the scheduler admin on `:9091`
  (SPEC.md:1226). Tests running both processes locally must pick distinct
  admin ports.
- Gateway readiness depends on the API server at startup (D17,
  docs/PROBLEM.md:97-98): an unreachable API server keeps it 503 by
  design. Do not "fix" it by serving before the initial list.
- Fastify `close()` does not end hijacked `reply.raw` SSE responses: end
  them in `preClose` (`references/shutdown.md` step 4). Informer stop must
  run in a finalizer, or the P4.11 5 s exit assertion fails. Test shutdown
  order with `Scope.close`, not by interrupting a `Layer.launch` fiber.
- SPEC RISK (quiet period vs fixed delay): knative-serving argues the drain
  should be a quiet period that restarts on activity. SPEC.md:1198-1199
  and D30 define a fixed `KRUN_SHUTDOWN_DELAY`. Implement the fixed delay;
  a quiet period is a Decisions row.
- Open gaps (default behaviour below; anything else needs a Decisions
  row; detail in `references/env-table.md` "Open gaps" and
  `references/metrics-table.md`):
  - Lease identity: SPEC.md:791 wants the pod name as `holderIdentity`,
    but section 12 has no variable (e.g. `KRUN_POD_NAME`). P4.2 and P4.11
    need a Decisions row adding it before the scheduler config is
    complete.
  - Namespace outside a pod (SPEC.md:1229): fail startup naming
    `KRUN_NAMESPACE`; set it in tests.
  - Extra series: never enable `Metric.enableRuntimeMetrics`, OpenTelemetry
    host or runtime instrumentation, `krun_build_info` or `target_info`.
  - Sampler argument outside `[0, 1]` or not a number: fall back to `0.1`
    with a warn line naming the variable. Do not exit 1 on it.

## Before marking a task done

- Run the task's acceptance (table above; `pnpm exec vitest run <dir>` for
  P0.5/P0.7, process tests against `test/fake-kube` for P3.7/P4.11), then
  `make check`, which includes `knip` (PLAN.md:17-18, CLAUDE.md rule 3).
- Branch per task id; Conventional Commits scoped `shared`, `gateway` or
  `scheduler`; mark `[x]` plus progress-log line in the same commit
  (PLAN.md:13-22). No `Co-Authored-By` trailer (CLAUDE.md rule 5).
- Blocked on an owner decision (Lease identity variable, namespace
  default): `BLOCKED P4.11: <need>` in the progress log (PLAN.md:28-29).

## Limitations

- Line numbers verified on 2026-10-23; re-check before quoting in a commit
  or Decisions row. Facts come from JavaScript probes on Node 26: snippet
  type signatures are UNVERIFIED until the first `tsc` run. OpenTelemetry
  facts were read from package sources (`npm pack`), not run.
- Out of scope: route handlers, error envelopes, SSE framing
  (`krun-gateway-api`); loops and Lease contract (`krun-scheduler-k8s`);
  Store pool setup (`krun-store`); the informer (`krun-functions-crd`);
  chart probes, NetworkPolicies, `observability.*` values
  (`krun-helm-chart`); the webhook `traceparent` header
  (`krun-webhooks-objstore`); `test/fake-kube` (`krun-testing-ci`).
