# Telemetry (SPEC.md:1141-1157, D36)

Companion to `SKILL.md` rules 11 and 21-27. Line numbers from the working
tree 2026-10-23; re-check before quoting. Package facts were read from the
published tarballs (`npm pack` on 2026-10-23: `@effect/opentelemetry`
4.0.6, `effect` 4.0.6, `@opentelemetry/exporter-prometheus` 0.223.0,
`@opentelemetry/sdk-trace-base` 2.12.0,
`@opentelemetry/exporter-trace-otlp-http` 0.223.0). They were read, not
run: no probe program exists yet, and every snippet's types are
UNVERIFIED until the first `tsc` run.

## What SPEC asks for

- Metrics: Effect `Metric`s exported by the OpenTelemetry Prometheus
  exporter on the admin listener's `/metrics`, with exactly the names of
  the section 11 table (SPEC.md:1143-1147, 1161-1179).
- Spans: every `/v1` and `/internal/v1` request, every scheduler loop
  iteration, every store call, every Kubernetes API call
  (SPEC.md:1147-1150). Exported over OTLP/HTTP only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set, else dropped (SPEC.md:1150-1151).
- An incoming W3C `traceparent` on the public or internal API is
  honoured; webhook deliveries send one (SPEC.md:1151-1152).
- Every log line inside a span carries `traceId` and `spanId`
  (SPEC.md:1152-1153).
- Every span about a run carries the attribute `krun.run_id`, which
  correlates a run's spans across the gateway, the scheduler and the pod's
  internal calls; v1 does not join them into one trace (SPEC.md:1153-1156,
  docs/OPERATIONS.md "Telemetry").
- Span attributes never contain input, results, tokens or keys; the
  section 9 redaction list applies (SPEC.md:1156-1157, 1103-1105).
- Variables: `OTEL_EXPORTER_OTLP_ENDPOINT` (empty, traces dropped),
  `OTEL_SERVICE_NAME` (`krun-gateway` or `krun-scheduler`),
  `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`
  (`parentbased_traceidratio`, `0.1`) on both processes
  (SPEC.md:1251-1253). The chart sets them from `observability.*`
  (SPEC section 13, values `observability.otlpEndpoint` and
  `observability.tracesSampleRatio`; P7.4d).

## Verified package facts

`@effect/opentelemetry` 4.0.6 (`src/NodeSdk.ts`, `src/Resource.ts`,
`src/OtelMetrics.ts`, `src/internal/metrics.ts`, `src/OtelTracer.ts`):

- Every module is `@stability unstable`. Peers: `@opentelemetry/api`
  `<2`, `sdk-trace-*`, `sdk-metrics`, `resources` `>=2 <3`, `api-logs`
  and `sdk-logs` `>=0.203 <0.300`, `effect ^4.0.6`.
- `NodeSdk.layer(() => config)` (or an Effect of the config) returns
  `Layer<Resource>`. `Configuration` fields: `spanProcessor`,
  `tracerConfig` (a `TracerConfig` without `resource`, so `sampler`
  goes here), `metricReader`, `metricTemporality`, `logRecordProcessor`,
  `loggerProviderConfig`, `loggerMergeWithExisting`, `resource: {
  serviceName, serviceVersion?, attributes? }`, `shutdownTimeout`.
- Each signal is enabled only when its processor or reader is given. No
  `spanProcessor` means no OpenTelemetry tracer; no `logRecordProcessor`
  means no OpenTelemetry logger (krun logs stay in pino, docs/STACK.md
  2.6, so never pass one).
- The tracer provider is released with `forceFlush()` then `shutdown()`,
  bounded by `shutdownTimeout` (default 3000 ms).
- `Resource.layerFromEnv` reads `OTEL_SERVICE_NAME` and
  `OTEL_RESOURCE_ATTRIBUTES`; attributes from the `resource` option are
  applied after them and win.
- Effect metrics become an OpenTelemetry `MetricProducer`: the
  instrument name is the Effect metric's name; its unit is the metric's
  `unit` or `time_unit` attribute, else `"1"`. A `Counter` with
  `incremental: true` is a monotonic `SUM`; without it, an
  `UP_DOWN_COUNTER` (non-monotonic sum). `Gauge` is a `GAUGE`;
  `Histogram` keeps its boundaries.
- `OtelTracer.makeExternalSpan({ traceId, spanId, traceFlags?,
  traceState? })` and `OtelTracer.withSpanContext(spanContext)` exist for
  propagation from outside Effect.

`effect` 4.0.6 (`Metric.ts`, `Effect.ts`, `Tracer.ts`):

- `Metric.counter(name, { description?, attributes?, bigint?,
  incremental? })`, `Metric.gauge`, `Metric.histogram(name, { description?,
  attributes?, boundaries })` (boundaries required), `Metric.update`,
  `Metric.withAttributes`, `Metric.value`, `Metric.snapshot`.
- `Metric.timer` records milliseconds and adds the attribute
  `time_unit: "milliseconds"`: not for SPEC's `_seconds` histograms.
- `Metric.MetricRegistry` is a `Context.Reference` whose default `Map` is
  shared by every context that does not provide one; tests provide
  `new Map()`.
- `Metric.enableRuntimeMetrics` is opt-in; leave it off (SKILL.md open gap
  on extra series).
- `Effect.withSpan(name, options?)`, `Effect.makeSpan`,
  `Effect.makeSpanScoped`, `Effect.useSpan`, `Effect.withParentSpan`,
  `Effect.currentSpan`, `Effect.currentParentSpan`,
  `Effect.annotateCurrentSpan`, `Effect.linkSpans` exist. Span options:
  `attributes`, `links`, `parent`, `root`, `kind` (`"internal" | "server"
  | "client" | "producer" | "consumer"`), `sampled`.
- `Tracer.externalSpan({ traceId, spanId, sampled? })` builds a parent
  from foreign ids; `Tracer.ParentSpan` is the context service holding the
  current span (an Effect span or an external one).
- Without an OpenTelemetry tracer, Effect's built-in spans still get ids:
  `traceId` is the parent's or 32 random hex digits, `spanId` 16 random hex
  digits (`Tracer.ts` native span). So log lines carry ids even when
  nothing is exported.
- `Logger.tracerLogger` (log lines as span events) is in Effect's default
  logger set; `Logger.layer([PinoLogger])` replaces the set and drops it.

`@opentelemetry/exporter-prometheus` 0.223.0
(`build/src/PrometheusExporter.js`, `PrometheusSerializer.js`):

- Defaults: port 9464, endpoint `/metrics`, and it starts its own HTTP
  server unless `preventServerStart: true`.
- Name rule: `_total` is appended only when the metric is a monotonic
  `SUM` and the name does not already end in `_total`. No unit suffix is
  ever appended; a unit only adds a `# UNIT` comment line.
- Every series gets `otel_scope_name` (and version) labels unless
  `withoutScopeInfo`; a `target_info` series is added unless
  `withoutTargetInfo`.
- Public exports: `PrometheusExporter` (a `MetricReader`, so
  `collect()` returns `{ resourceMetrics, errors }`),
  `PrometheusSerializer(prefix?, appendTimestamp?,
  withResourceConstantLabels?, withoutTargetInfo?, withoutScopeInfo?)`
  with `serialize(resourceMetrics)`, and
  `getMetricsRequestHandler(req, res)`, which writes `content-type:
  text/plain` and the body to the raw Node response.

`@opentelemetry/sdk-trace-base` 2.12.0 (`build/src/index-shim.d.ts`,
`config.js`):

- A shim over `@opentelemetry/sdk-trace`; it exports `BatchSpanProcessor`,
  `SimpleSpanProcessor`, `InMemorySpanExporter`, `ParentBasedSampler`,
  `TraceIdRatioBasedSampler`.
- With no `sampler` in the config, the provider builds one from
  `OTEL_TRACES_SAMPLER`, whose default is `parentbased_always_on`, and
  `OTEL_TRACES_SAMPLER_ARG`.

`@opentelemetry/exporter-trace-otlp-http` 0.223.0: the Node
`OTLPTraceExporter` takes its options from the standard environment for
signal `TRACES` with path `v1/traces`, so `OTEL_EXPORTER_OTLP_ENDPOINT` is
the base URL and `/v1/traces` is appended. JSON encoding by default.

## The Telemetry layer

`packages/shared/src/runtime/telemetry.ts` (shape, not final code):

```ts
import { NodeSdk } from "@effect/opentelemetry"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base"
import { Context, Effect, Layer } from "effect"

export class MetricsReader extends Context.Service<MetricsReader, PrometheusExporter>()("krun/MetricsReader") {}

export const Telemetry = (processName: "krun-gateway" | "krun-scheduler") =>
  Layer.unwrap(Effect.gen(function* () {
    const config = yield* KrunConfig
    const exporter = new PrometheusExporter({
      preventServerStart: true,   // served by the admin Fastify instance, never port 9464
      withoutScopeInfo: true,     // no otel_scope_* labels
      withoutTargetInfo: true,    // no target_info series
    })
    const sampler = config.OTEL_TRACES_SAMPLER === undefined
      ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.OTEL_TRACES_SAMPLER_ARG ?? 0.1) })
      : undefined                 // set: the SDK reads both variables itself
    const sdk = NodeSdk.layer(() => ({
      resource: { serviceName: config.OTEL_SERVICE_NAME ?? processName },
      metricReader: exporter,
      ...(config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()) }),
      ...(sampler === undefined ? {} : { tracerConfig: { sampler } }),
    }))
    return Layer.merge(sdk, Layer.succeed(MetricsReader, exporter))
  }))
```

- Conditional spreads, not `undefined` values: `exactOptionalPropertyTypes`
  is on (docs/STACK.md section 3).
- The service class form `Context.Service<Self, Shape>()(key)` is the one
  `effect` 4.0.6 uses for `Tracer.ParentSpan`; `Layer.unwrap` and
  `Layer.succeed` are used the same way in `NodeSdk.ts`. Check Effect's
  `MIGRATION.md` for any other name.
- Provide it under everything else in `main.ts` (docs/STACK.md 4.1):
  `Layer.provide(AppLayer)`, then `Layer.provide(Telemetry("krun-gateway"))`.
  `KrunConfig` must be provided to it as well.
- `krun migrate` needs no `Telemetry`: SPEC section 11 names no migrate
  spans or metrics.

## /metrics on the admin listener

Preferred, inside the normal Fastify lifecycle so the `krun_http_*`
`onResponse` hook (owner "both") counts it like any route:

```ts
const serializer = new PrometheusSerializer("", false, undefined, true, true)
app.get("/metrics", async (_req, reply) => {
  const { resourceMetrics, errors } = await exporter.collect()
  if (errors.length > 0) app.log.warn({ count: errors.length }, "metrics collection errors")
  return reply.type("text/plain; version=0.0.4; charset=utf-8").send(serializer.serialize(resourceMetrics))
})
```

The last two serializer arguments are `withoutTargetInfo` and
`withoutScopeInfo`; they must match the exporter's options. Alternative:
`reply.hijack()` then `exporter.getMetricsRequestHandler(request.raw,
reply.raw)`. It is shorter, but a hijacked reply skips the rest of
Fastify's lifecycle (Fastify `Reply.md` "hijack"), so the `/metrics` hit
may not reach the `krun_http_*` hook (UNVERIFIED), and the content type is
plain `text/plain`.

## Metric definitions

Names and types in `metrics-table.md`. Pattern (UNVERIFIED types):

```ts
export const httpRequestsTotal = Metric.counter("krun_http_requests_total", { incremental: true })
export const httpRequestSeconds = Metric.histogram("krun_http_request_seconds", {
  boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
})
// in the onResponse hook, run through the captured context:
Metric.update(Metric.withAttributes(httpRequestsTotal, { route, code: String(reply.statusCode) }), 1)
```

Attribute names are the SPEC label names (`route`, `code`, `function`,
`to`, `state`, `reason`, `ready`); never `unit` or `time_unit`.

## Spans

| What | Where | Name (suggested, keep stable) | Kind | Attributes |
|---|---|---|---|---|
| `/v1` and `/internal/v1` request | request runner of the public and internal listeners | `GET /v1/functions/:function/runs/:run` (method plus `request.routeOptions.url`, `unmatched` for 404) | `server` | `http.request.method`, `http.route`, `http.response.status_code`; `krun.run_id` when the request is about one run (create: set once the id exists; internal API: the run in the path) |
| scheduler loop iteration | each loop body (main, heartbeat, deliveries, sweep, reconcile) | `scheduler.main`, `scheduler.heartbeat`, ... | `internal` | counts only; the iteration is about many runs, so no `krun.run_id` here |
| per-run work inside an iteration | a child span around the work for one claimed run (Secret and Job create, transition, terminal handling, one delivery) | `scheduler.run` or similar | `internal` | `krun.run_id`, Function name |
| store call | the `Store` service layer, once per method | `store.claimQueued`, `store.transition`, ... | `client` | method name, row count, `krun.run_id` when the call is for one run; never SQL text with values, never bound parameters |
| Kubernetes API call | the `Kube` service wrapper, inside the semaphore and timeout | `kube.create Job`, `kube.delete Secret`, ... | `client` | verb, resource kind, namespace, HTTP status, `krun.run_id` when the object belongs to one run; never the manifest or env |

`krun.run_id` is the only attribute name SPEC fixes. Put it on through the
span options or `Effect.annotateCurrentSpan("krun.run_id", id)`. A `Store` or `Kube`
wrapper gets the id from its own arguments (most store methods take the
run id) or from a small `Context.Reference` the per-run span sets; pick
one and use it everywhere. Do not
store a trace context with the run to join the processes into one trace:
SPEC says v1 does not.

- The request span covers the whole request, including 401, 404 and 415
  answered before a handler: start it in `onRequest` with
  `Effect.makeSpan(name, { kind: "server", parent })`, keep it on the
  request, run the handler under `Effect.withParentSpan(span)`, and end it
  in `onResponse` with the status attribute and an end time from `Clock`
  (`span.end(endTime, exit)` takes nanoseconds as a `bigint`). Or wrap the
  handler Effect in `Effect.withSpan` and accept that pre-handler
  rejections have no span. Either way, check the exact signatures in the
  `effect` 4.0.6 `Tracer.ts`/`Effect.ts` docs before relying on them.
- Kubernetes calls: the span wraps the call inside the semaphore, so its
  duration is the API call, not the queue wait; a 429 or 5xx sets the
  status attribute before the tagged failure propagates.
- A failed Effect inside a span marks the span failed from its `Exit`.
  krun's tagged errors carry names, ids and HTTP statuses only, so the
  recorded cause holds no secret. Never wrap a raw `pg` or client-node
  error message into a tagged error field that reaches a span.

## traceparent

Inbound (public and internal listeners), written in house:

```ts
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const parseTraceparent = (h: string | undefined) => {
  const m = h === undefined ? null : TRACEPARENT.exec(h)
  if (m === null || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined
  return Tracer.externalSpan({ traceId: m[1]!, spanId: m[2]!, sampled: (parseInt(m[3]!, 16) & 1) === 1 })
}
```

Pass the result as the request span's `parent`. An invalid or missing
header starts a new trace; it is never a 400. `tracestate` is not read in
v1. With the OpenTelemetry tracer installed, `OtelTracer.makeExternalSpan`
also carries `traceFlags`/`traceState`; either is fine for a
parent-based sampler.

Outbound: webhook deliveries send `traceparent:
00-<traceId>-<spanId>-<01|00>` from `Effect.currentSpan` inside the
delivery attempt (`krun-webhooks-objstore`). No other outbound call
sends one (the Kubernetes API and S3 are not traced backends).

## Redaction for spans

pino `redact` covers log lines only. For spans the rule is "never put it
there":

- No attribute or event holds input, result, `runtimeStatus`,
  `error.details`, a per-run token, an API key or its hash, the
  `Authorization` header, `KRUN_DB_DSN`, a presigned URL, a webhook secret
  or signature, a Job manifest, an env list, a request or response body,
  SQL text with values or bound parameters, or `keys.yaml` content.
- Do not record the full URL: query strings carry page tokens and filters;
  use `http.route`.
- `Effect.annotateLogs` values are log fields, not span attributes; Effect's
  `tracerLogger` (which would copy log lines into span events) is not in
  krun's logger set. Keep it out.
- Test: the P3.1b redaction test also runs one request with an in-memory
  exporter and asserts no sentinel in any span attribute, event or status
  message.

## Tests

- Metrics: build the app with a fresh `Metric.MetricRegistry` (`new
  Map()`), a `PrometheusExporter` with `preventServerStart: true` in a
  test `Telemetry` layer, scrape `/metrics` with `inject`, and assert
  lines with exact names (`# TYPE krun_http_requests_total counter`, no
  `krun_http_requests_total_total`, `krun_queue_wait_seconds_bucket`, no
  `otel_scope_name`, no `target_info`).
- Spans: `new InMemorySpanExporter()` behind `new
  SimpleSpanProcessor(exporter)` as `spanProcessor`; after the run,
  `exporter.getFinishedSpans()` gives names, attributes, parent ids and
  `spanContext().traceId`. P4.6 (PLAN.md:563-566) asserts that the create
  request, the iteration's per-run span and the Kubernetes call spans
  carry the same `krun.run_id`, and that a `traceparent` sent with
  `CreateRun` becomes the request span's parent (its trace id, and the
  header's span id as parent).
- No test sets a real `OTEL_EXPORTER_OTLP_ENDPOINT`; the OTLP path is
  covered by the layer choosing a processor, not by a network export.
