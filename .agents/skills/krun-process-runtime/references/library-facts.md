# Library facts and lessons from prior art

Companion to `SKILL.md`. Versions from `npm view` on 2026-10-23; package
tarballs in `~/.hermes/cache/scratch/krun-skills/pkgs/`, JavaScript probes
on Node 26 in `~/.hermes/cache/scratch/krun-skills/probe-runtime/`. The
docs/STACK.md ranges are normative (docs/STACK.md sections 2 and 3);
re-check a fact against the installed version before relying on it.

## Library facts (verified 2026-10-23)

- effect 4.0.6, @effect/platform-node 4.0.6, @effect/vitest 4.0.6, zod
  4.6.7, fastify 5.12.7, pino 10.4.0, prom-client 15.1.3, vitest 5.0.5
  (`npm view`; tarballs in `~/.hermes/cache/scratch/krun-skills/pkgs/`,
  probes in `.../probe-runtime/`).
- Fastify 5.12: `requestIdHeader` default `false`; with a header name set,
  the header value is used unchecked and `genReqId` is skipped; `trustProxy`
  accepts `true`, CIDR strings or a function, hop counts disabled.
- Fastify takes a ready pino through `loggerInstance` and wraps it in a
  child, which inherits the redact list. `redact` is fast-redact syntax
  with `*` wildcards; Fastify 5.12 accepts `pino ^9.14.0 || ^10.1.0`.
- `close()` sequence: closing flag (503 + `Connection: close` for requests
  on kept-alive sockets) → `preClose` → connection draining per
  `forceCloseConnections` (default `"idle"`) → `server.close()` →
  `onClose` (`fastify.js:384-430`).
- `prom-client` 15.1: `Registry`, `Counter/Gauge/Histogram` with
  `registers: [registry]`, `await registry.metrics()`,
  `registry.contentType`, ESM named imports work.
- `onListen` hooks do not run under `inject()`; do not put readiness
  wiring there if the P0.7 test uses `inject`.
- Effect 4: services are `Context.Service`; references are
  `Context.Reference(key, { defaultValue })`; layers acquire with
  `Effect.acquireRelease` or `Effect.addFinalizer` inside `Layer.effect`
  or `Layer.effectDiscard` (there is no separate `Layer.scoped`);
  `Layer.launch` keeps a layer alive until interruption;
  `Logger.layer([...])` replaces the logger set; `Effect.runPromiseWith(ctx)`
  runs an Effect from a Fastify handler with an optional `{ signal }`.
- `TestClock` lives at `effect/testing` (`import { TestClock } from
  "effect/testing"`); `it.effect` provides it, `it.live` uses the real
  clock. There is no `it.scoped` in @effect/vitest 4.0.6: `it.effect`
  already supplies a `Scope`.

## Lessons from Dapr, Knative Serving and KEDA

- Not-ready is 503, never 500: Dapr's sidecar returns 500 for not-ready
  on `/v1.0/healthz` while its control-plane servers use 503; krun uses
  503 everywhere (`dapr pkg/messages/predefined.go:63-78`,
  `pkg/healthz/server/server.go:58`).
- Model readiness as named targets and log the unhealthy names at debug:
  Dapr's operator marks the cache target ready only after cache sync
  (`dapr pkg/operator/operator.go:344-366`, `pkg/healthz/server/server.go:55-62`).
- Flip readiness before draining so probes fail during the drain, then
  close under a hard cap: Dapr's scheduler (`dapr pkg/scheduler/server/server.go:336-366`)
  and Knative's queue-proxy (`serving pkg/queue/sharedmain/main.go:310-347`).
- A shutdown that overruns its grace is an error and is asserted by a test:
  Dapr's integration suite expects exit code 1 and "Graceful shutdown
  timeout exceeded" (`dapr tests/integration/suite/daprd/shutdown/graceful/timeout.go:50-60`).
  krun: the 25 s watchdog logs at `fatal` and exits 1.
- Close independent servers under one deadline so the first close does
  not cancel the rest (`dapr pkg/api/http/server.go:235-265`).
- Hijacked streams are invisible to server close; signal them and drain
  with a cap (`serving pkg/http/handler/hijack.go:27-66`).
- Secrets resolve into values that are never logged; lines name the
  resource or env var only (`dapr pkg/runtime/processor/secret/secret.go:134-186`).
- High-cardinality metric labels are opt-in in KEDA because
  per-trigger histogram labels exploded; keep krun labels bounded by
  Function count and route templates (`keda pkg/metricscollector/prommetrics.go:35-178`).
- Readiness waits for cache sync and fails fast when the initial list
  cannot complete; KEDA exits non-zero on `WaitForCacheSync` failure,
  krun stays 503 and retries with backoff (SPEC.md:159-161,
  `keda cmd/operator/main.go:352-359`).
