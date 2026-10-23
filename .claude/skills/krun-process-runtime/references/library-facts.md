# Library facts and lessons from prior art

Versions from `npm view` on 2026-10-23. Tarballs in
`~/.hermes/cache/scratch/krun-skills/pkgs/`, JavaScript probes on Node 26
in `~/.hermes/cache/scratch/krun-skills/probe-runtime/` (`.../probe-runtime/`
below). docs/STACK.md ranges are normative (docs/STACK.md sections 2 and
3); re-check a fact against the installed version before relying on it.

## Versions

- effect 4.0.6, @effect/platform-node 4.0.6, @effect/vitest 4.0.6, zod
  4.6.7, fastify 5.12.7, pino 10.4.0, vitest 5.0.5. Runtime: Node.js 26
  (SPEC D15).
- Telemetry (read from `npm pack` sources, not probed):
  @effect/opentelemetry 4.0.6, @opentelemetry/exporter-prometheus 0.223.0,
  @opentelemetry/exporter-trace-otlp-http 0.223.0,
  @opentelemetry/sdk-trace-base 2.12.0, @opentelemetry/sdk-metrics 2.12.0.
  `@effect/opentelemetry` 4.0.6 peers on the 2.x SDK lines and `<0.300`
  for the 0.2xx lines, hence the pins in docs/STACK.md 2.6. Metrics are
  Effect `Metric`s and `/metrics` is the exporter's output (SPEC D36).
  Facts: `telemetry.md`, `metrics-table.md`.

## Facts not stated elsewhere in this skill

Covered in other references, not repeated here: `NodeRuntime.runMain`
exit codes and `Layer.mergeAll` concurrency (`shutdown.md`); Fastify
`requestIdHeader`, `trustProxy`, `loggerInstance` redact inheritance and
FSTDEP023 (`logging.md`); Zod `superRefine` order (`env-table.md`);
Effect tracing API (`telemetry.md`).

- Fastify 5.12: `trustProxy` hop counts disabled. `redact` is fast-redact
  syntax with `*` wildcards. Fastify 5.12 accepts `pino ^9.14.0 || ^10.1.0`.
- Fastify `close()` sequence: closing flag (503 + `Connection: close` for
  requests on kept-alive sockets), then `preClose`, then connection
  draining per `forceCloseConnections` (default `"idle"`), then
  `server.close()`, then `onClose` (`fastify.js:384-430`).
- Fastify 5.12.7: top-level `requestIdLogLabel` also emits FSTDEP024 and
  is removed in Fastify 6; use `logController: new LogController({ ... })`.
- Effect 4: services are `Context.Service`; references are
  `Context.Reference(key, { defaultValue })`. Layers acquire with
  `Effect.acquireRelease` or `Effect.addFinalizer` inside `Layer.effect`
  or `Layer.effectDiscard`; there is no separate `Layer.scoped`.
  `Layer.launch` keeps a layer alive until interruption.
  `Logger.layer([...])` replaces the logger set, including the default
  `Logger.tracerLogger`. `Effect.runPromiseWith(ctx)` runs an Effect from
  a Fastify handler with an optional `{ signal }`. `Layer.provide`
  releases the provided layer after its dependants.
- `References.MinimumLogLevel` defaults to `Info`: `Effect.logDebug` is
  dropped unless lowered (probe; `logging.md`).
- Zod 4.6.7: `.default(value)` shallow-clones object values (a `Duration`
  becomes a plain object); `.prefault(raw)` runs the raw input through the
  schema (`env-table.md`).
- `TestClock` lives at `effect/testing`
  (`import { TestClock } from "effect/testing"`). `it.effect` provides it;
  `it.live` uses the real clock. No `it.scoped` in @effect/vitest 4.0.6:
  `it.effect` already supplies a `Scope`.

## Lessons from Dapr, Knative Serving and KEDA

Each line: lesson, then the krun rule.

- Dapr's sidecar returns 500 for not-ready on `/v1.0/healthz`; its
  control-plane servers use 503. krun: not-ready is 503 everywhere, never
  500 (`dapr pkg/messages/predefined.go:63-78`,
  `pkg/healthz/server/server.go:58`).
- Dapr's operator marks the cache target ready only after cache sync.
  krun: model readiness as named targets; log unhealthy names at debug
  (`dapr pkg/operator/operator.go:344-366`, `pkg/healthz/server/server.go:55-62`).
- Dapr's scheduler and Knative's queue-proxy flip readiness before
  draining, then close under a hard cap. krun: `Drain` first
  (`dapr pkg/scheduler/server/server.go:336-366`,
  `serving pkg/queue/sharedmain/main.go:310-347`).
- Dapr's suite expects exit 1 and "Graceful shutdown timeout exceeded" on
  overrun. krun: the 25 s watchdog logs at `fatal` and exits 1
  (`dapr tests/integration/suite/daprd/shutdown/graceful/timeout.go:50-60`).
- Close independent servers under one deadline so the first close does
  not cancel the rest (`dapr pkg/api/http/server.go:235-265`).
- Hijacked streams are invisible to server close. krun: signal them and
  drain with a cap (`serving pkg/http/handler/hijack.go:27-66`).
- Secrets resolve into values never logged; lines name the resource or env
  var only (`dapr pkg/runtime/processor/secret/secret.go:134-186`).
- KEDA made per-trigger histogram labels opt-in after they exploded.
  krun: labels bounded by Function count and route templates
  (`keda pkg/metricscollector/prommetrics.go:35-178`).
- KEDA exits non-zero on `WaitForCacheSync` failure. krun: readiness waits
  for cache sync, stays 503 and retries with backoff (SPEC.md:159-161,
  `keda cmd/operator/main.go:352-359`).
