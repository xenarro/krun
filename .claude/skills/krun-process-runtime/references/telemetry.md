# Telemetry (SPEC.md:1141-1157, D36)

Companion to `SKILL.md` rules 11 and 22-26. Line numbers from the working
tree 2026-10-23; re-check before quoting.

## What SPEC asks for

- Spans exported over OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set, else dropped (SPEC.md:1150-1151).
- `krun.run_id` correlates a run across gateway, scheduler and the pod's
  internal calls; v1 does not join them into one trace (SPEC.md:1153-1156,
  docs/OPERATIONS.md "Telemetry"). SPEC section 6 has no trace-context
  column.
- Span attributes follow the section 9 redaction list
  (SPEC.md:1156-1157, 1103-1105).
- Variable defaults (SPEC.md:1251-1253): `OTEL_EXPORTER_OTLP_ENDPOINT`
  empty (traces dropped); `OTEL_SERVICE_NAME` `krun-gateway` or
  `krun-scheduler`; `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`
  `parentbased_traceidratio`, `0.1`. The chart sets them from
  `observability.otlpEndpoint` and `observability.tracesSampleRatio`
  (SPEC section 13, P7.4d).

## Verified package facts

Read from published tarballs (`npm pack` 2026-10-23: `@effect/opentelemetry`
4.0.6, `effect` 4.0.6, `@opentelemetry/exporter-prometheus` 0.223.0,
`@opentelemetry/sdk-trace-base` 2.12.0,
`@opentelemetry/exporter-trace-otlp-http` 0.223.0). Read, not run: no
probe exists yet, and every snippet's types are UNVERIFIED until the first
`tsc` run.

`@effect/opentelemetry` 4.0.6 (`src/NodeSdk.ts`, `src/Resource.ts`,
`src/OtelMetrics.ts`, `src/internal/metrics.ts`, `src/OtelTracer.ts`):

- Every module `@stability unstable`. Peers: `@opentelemetry/api` `<2`,
  `sdk-trace-*`, `sdk-metrics`, `resources` `>=2 <3`, `api-logs` and
  `sdk-logs` `>=0.203 <0.300`, `effect ^4.0.6`.
- `NodeSdk.layer(() => config)` (or an Effect of the config) returns
  `Layer<Resource>`. `Configuration` fields: `spanProcessor`,
  `tracerConfig` (a `TracerConfig` without `resource`; `sampler` goes
  here), `metricReader`, `metricTemporality`, `logRecordProcessor`,
  `loggerProviderConfig`, `loggerMergeWithExisting`, `resource: {
  serviceName, serviceVersion?, attributes? }`, `shutdownTimeout`.
- A signal is enabled only when its processor or reader is given. No
  `spanProcessor`: no OpenTelemetry tracer. No `logRecordProcessor`: no
  OpenTelemetry logger. krun logs stay in pino (docs/STACK.md 2.6), so
  never pass one.
- Tracer provider release: `forceFlush()` then `shutdown()`, bounded by
  `shutdownTimeout` (default 3000 ms).
- `Resource.layerFromEnv` reads `OTEL_SERVICE_NAME` and
  `OTEL_RESOURCE_ATTRIBUTES`; the `resource` option applies after and
  wins.
- Effect metrics become an OpenTelemetry `MetricProducer`. Instrument name
  is the Effect metric name. Unit is the metric's `unit` or `time_unit`
  attribute, else `"1"`. `Counter` with `incremental: true` is a monotonic
  `SUM`; without it, an `UP_DOWN_COUNTER` (non-monotonic sum). `Gauge` is a
  `GAUGE`; `Histogram` keeps its boundaries.
- `OtelTracer.makeExternalSpan({ traceId, spanId, traceFlags?,
  traceState? })` and `OtelTracer.withSpanContext(spanContext)` exist for
  propagation from outside Effect.

`effect` 4.0.6 (`Metric.ts`, `Effect.ts`, `Tracer.ts`):

- `Metric.counter(name, { description?, attributes?, bigint?,
  incremental? })`, `Metric.gauge`, `Metric.histogram(name, { description?,
  attributes?, boundaries })` (boundaries required), `Metric.update`,
  `Metric.withAttributes`, `Metric.value`, `Metric.snapshot`.
- `Metric.timer` records milliseconds and adds attribute
  `time_unit: "milliseconds"`: not for `_seconds` histograms.
- `Metric.MetricRegistry` is a `Context.Reference` whose default `Map` is
  shared by every context that does not provide one; tests provide
  `new Map()`.
- `Metric.enableRuntimeMetrics` is opt-in; leave it off (SKILL.md open gap
  on extra series).
- Exist: `Effect.withSpan(name, options?)`, `Effect.makeSpan`,
  `Effect.makeSpanScoped`, `Effect.useSpan`, `Effect.withParentSpan`,
  `Effect.currentSpan`, `Effect.currentParentSpan`,
  `Effect.annotateCurrentSpan`, `Effect.linkSpans`. Span options:
  `attributes`, `links`, `parent`, `root`, `kind` (`"internal" | "server"
  | "client" | "producer" | "consumer"`), `sampled`.
- `Tracer.externalSpan({ traceId, spanId, sampled? })` builds a parent
  from foreign ids. `Tracer.ParentSpan` is the context service holding the
  current span (Effect span or external).
- Without an OpenTelemetry tracer, Effect's built-in spans still get ids:
  `traceId` is the parent's or 32 random hex digits, `spanId` 16 random hex
  digits (`Tracer.ts` native span). Log lines carry ids even when nothing
  is exported.
- `Logger.tracerLogger` (log lines as span events) is in Effect's default
  logger set; `Logger.layer([PinoLogger])` replaces the set and drops it.

`@opentelemetry/exporter-prometheus` 0.223.0
(`build/src/PrometheusExporter.js`, `PrometheusSerializer.js`):

- Defaults: port 9464, endpoint `/metrics`. Starts its own HTTP server
  unless `preventServerStart: true`.
- `_total` is appended only to a monotonic `SUM` whose name does not
  already end in `_total`. No unit suffix ever; a unit only adds a
  `# UNIT` comment line.
- Every series gets `otel_scope_name` (and version) labels unless
  `withoutScopeInfo`. A `target_info` series is added unless
  `withoutTargetInfo`.
- Exports: `PrometheusExporter` (a `MetricReader`; `collect()` returns
  `{ resourceMetrics, errors }`); `PrometheusSerializer(prefix?,
  appendTimestamp?, withResourceConstantLabels?, withoutTargetInfo?,
  withoutScopeInfo?)`
  with `serialize(resourceMetrics)`;
  `getMetricsRequestHandler(req, res)`, which writes `content-type:
  text/plain` and the body to the raw Node response.

`@opentelemetry/sdk-trace-base` 2.12.0 (`build/src/index-shim.d.ts`,
`config.js`):

- Shim over `@opentelemetry/sdk-trace`. Exports `BatchSpanProcessor`,
  `SimpleSpanProcessor`, `InMemorySpanExporter`, `ParentBasedSampler`,
  `TraceIdRatioBasedSampler`.
- With no `sampler` in config, the provider builds one from
  `OTEL_TRACES_SAMPLER` (default `parentbased_always_on`) and
  `OTEL_TRACES_SAMPLER_ARG`.

`@opentelemetry/exporter-trace-otlp-http` 0.223.0: the Node
`OTLPTraceExporter` reads the standard environment for signal `TRACES`
with path `v1/traces`. `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL;
`/v1/traces` is appended. JSON encoding by default.

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
- `Context.Service<Self, Shape>()(key)` is the form `effect` 4.0.6 uses
  for `Tracer.ParentSpan`; `NodeSdk.ts` uses `Layer.unwrap` and
  `Layer.succeed` the same way. Check Effect's `MIGRATION.md` for any
  other name.
- Provide it under everything else in `main.ts` (docs/STACK.md 4.1):
  `Layer.provide(AppLayer)`, then `Layer.provide(Telemetry("krun-gateway"))`.
  `KrunConfig` must be provided to it too.
- `krun migrate` needs no `Telemetry`: SPEC section 11 names no migrate
  spans or metrics.

## /metrics on the admin listener

Preferred: inside the normal Fastify lifecycle, so the `krun_http_*`
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
`withoutScopeInfo`; they must match the exporter's options. Second choice:
`reply.hijack()` then `exporter.getMetricsRequestHandler(request.raw,
reply.raw)`. A hijacked reply skips the rest of Fastify's lifecycle
(Fastify `Reply.md` "hijack"), so the hit may miss the `krun_http_*` hook
(UNVERIFIED), and the content type is plain `text/plain`.

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
| `/v1` and `/internal/v1` request | request runner of public and internal listeners | `GET /v1/functions/:function/runs/:run` (method plus `request.routeOptions.url`, `unmatched` for 404) | `server` | `http.request.method`, `http.route`, `http.response.status_code`; `krun.run_id` when the request is about one run (create: set once the id exists; internal API: the run in the path) |
| scheduler loop iteration | each loop body (main, heartbeat, deliveries, sweep, reconcile) | `scheduler.main`, `scheduler.heartbeat`, ... | `internal` | counts only; covers many runs, so no `krun.run_id` |
| per-run work inside an iteration | child span around the work for one claimed run (Secret and Job create, transition, terminal handling, one delivery) | `scheduler.run` or similar | `internal` | `krun.run_id`, Function name |
| store call | `Store` service layer, once per method | `store.claimQueued`, `store.transition`, ... | `client` | method name, row count, `krun.run_id` when for one run; never SQL text with values, never bound parameters |
| Kubernetes API call | `Kube` service wrapper, inside the semaphore and timeout | `kube.create Job`, `kube.delete Secret`, ... | `client` | verb, resource kind, namespace, HTTP status, `krun.run_id` when the object belongs to one run; never the manifest or env |

Request span name is `<METHOD> <route template>`, one server span per
request. Every span about a run carries `krun.run_id`: the `CreateRun` and
run-scoped `/v1` requests, internal API requests (the run in the path),
per-run work inside an iteration (a child span), and store and Kubernetes
calls made for one run.

`krun.run_id` is the only attribute name SPEC fixes. Set it through span
options or `Effect.annotateCurrentSpan("krun.run_id", id)`. A `Store` or
`Kube` wrapper gets the id from its own arguments (most store methods take
the run id) or from a small `Context.Reference` the per-run span sets.
Pick one and use it everywhere. Do not store a trace context with the run
to join processes into one trace: SPEC says v1 does not.

- The request span covers the whole request, including 401, 404 and 415
  answered before a handler. Option A: start it in `onRequest` with
  `Effect.makeSpan(name, { kind: "server", parent })`, keep it on the
  request, run the handler under `Effect.withParentSpan(span)`, end it in
  `onResponse` with the status attribute and an end time from `Clock`
  (`span.end(endTime, exit)` takes nanoseconds as a `bigint`). Option B:
  wrap the handler Effect in `Effect.withSpan`; pre-handler rejections
  then have no span. Either way, check exact signatures in the `effect`
  4.0.6 `Tracer.ts`/`Effect.ts` docs before relying on them.
- Kubernetes span wraps the call inside the semaphore: its duration is the
  API call, not the queue wait. A 429 or 5xx sets the status attribute
  before the tagged failure propagates.
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

Rules: version `00`, 32 and 16 lowercase hex, two-hex flags, all-zero ids
invalid. Pass the result as the request span's `parent`. An invalid or missing
header starts a new trace; never a 400. `tracestate` is not read in v1.
With the OpenTelemetry tracer installed, `OtelTracer.makeExternalSpan`
also carries `traceFlags`/`traceState`; either works for a parent-based
sampler.

Outbound: webhook deliveries send `traceparent:
00-<traceId>-<spanId>-<01|00>` from `Effect.currentSpan` inside the
delivery attempt (`krun-webhooks-objstore`). No other outbound call sends
one (Kubernetes API and S3 are not traced backends).

## Redaction for spans

pino `redact` covers log lines only. For spans: never put it there.

- No attribute or event holds input, result, `runtimeStatus`,
  `error.details`, a per-run token, an API key or its hash, the
  `Authorization` header, `KRUN_DB_DSN`, a presigned URL, a webhook secret
  or signature, a Job manifest, an env list, a request or response body,
  SQL text with values or bound parameters, or `keys.yaml` content.
- Allowed: route template, method, status code, `krun.run_id`, Function
  name, state, reason, `Store` method name, Kubernetes verb, resource
  kind.
- Never record the full URL: query strings carry page tokens and filters.
  Use `http.route`.
- `Effect.annotateLogs` values are log fields, not span attributes.
  Effect's `tracerLogger` (copies log lines into span events) is not in
  krun's logger set. Keep it out.
- Test: the P3.1b redaction test also runs one request with an in-memory
  exporter and asserts no sentinel in any span attribute, event or status
  message.

## Tests

- Metrics: fresh `Metric.MetricRegistry` (`new Map()`), a
  `PrometheusExporter` with `preventServerStart: true` in a test
  `Telemetry` layer, scrape `/metrics` with `inject`. Assert exact lines:
  `# TYPE krun_http_requests_total counter`, no
  `krun_http_requests_total_total`, `krun_queue_wait_seconds_bucket`, no
  `otel_scope_name`, no `target_info`.
- Spans: `new InMemorySpanExporter()` behind `new
  SimpleSpanProcessor(exporter)` as `spanProcessor`. After the run,
  `exporter.getFinishedSpans()` gives names, attributes, parent ids and
  `spanContext().traceId`. P4.6 (PLAN.md:563-566) asserts the create
  request, the per-run iteration span and the Kubernetes call spans carry
  the same `krun.run_id`, and a `traceparent` sent with `CreateRun`
  becomes the request span's parent (its trace id; the header's span id as
  parent).
- No test sets a real `OTEL_EXPORTER_OTLP_ENDPOINT`. Cover the OTLP path by
  the layer choosing a processor, not by a network export.
