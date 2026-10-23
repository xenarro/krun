# SIGTERM shutdown sequences (SPEC.md:1198-1206)

Line numbers from the working tree 2026-10-23; re-check before quoting.
Both sequences must fit the 30 second grace period (SPEC.md:1206): the
chart sets `terminationGracePeriodSeconds: 30` (SPEC.md:1274), and the
gateway drains for `KRUN_SHUTDOWN_DELAY` before closing (D30). Mechanism
from D35: `NodeRuntime.runMain` plus scope finalizers (docs/STACK.md 2.1,
2.6, 4.1, and 4.3 "SIGTERM order | scope finalizers"). No graceful-close
package: docs/STACK.md lists none.

## Mechanism (verified: effect 4.0.6, @effect/platform-node 4.0.6)

Read from package sources (`npm pack`), confirmed by probes on Node 26 and
Fastify 5.12.7 in `~/.hermes/cache/scratch/krun-skills/probe-runtime/`
(`p1.mjs` to `p6.mjs`, `scope.test.mjs`):

1. `NodeRuntime.runMain(effect, options)` adds `SIGINT` and `SIGTERM`
   listeners that interrupt the main fiber, then calls
   `process.exit(code)` once that fiber ends
   (`@effect/platform-node-shared` `src/NodeRuntime.ts`). `NodeRuntime` is
   `@stability unstable`: pin the exact minor (docs/STACK.md:36-38, 52).
2. Default teardown (`effect` `Runtime.defaultTeardown`): success 0,
   interrupt-only cause **130**, other failure 1 (or the error's
   `Runtime.errorExitCode`). SPEC says "exits 0" after SIGTERM, so pass:
   ```ts
   const teardown: Runtime.Teardown = (exit, onExit) =>
     onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1)
   NodeRuntime.runMain(Layer.launch(Main), { teardown, disableErrorReporting: true })
   ```
   Probe: default teardown exited 130 on SIGTERM. This one exits 0; a
   `LeaderLost` or `ConfigInvalid` failure exits 1.
3. `disableErrorReporting: true` stops `runMain` logging the failure cause
   itself. Log the tagged error once through the pino-backed logger
   (`references/logging.md`) so a cause never prints a value.
4. Interruption closes the `Layer.launch` scope. Finalizers run in reverse
   acquisition order, uninterruptibly. A layer fed in with `Layer.provide`
   is released after the layers that depend on it: the store (`Database`
   layer) closes after the listeners.
5. `Layer.mergeAll(a, b, c)` builds and releases members concurrently (it
   forks a `"parallel"` child scope, `Layer.ts` `mergeAllEffect`). The
   three gateway listeners close at the same time; Dapr closes its servers
   under one deadline (`dapr pkg/api/http/server.go:235-265`). Probe: all
   three releases started within 1 ms.
6. `Effect.timeout` and `Effect.timeoutOption` work inside a finalizer.
   `Effect.tryPromise((signal) => ...)` aborts its `AbortSignal` when the
   timeout wins. Bound every finalizer step this way: a hanging step
   blocks exit until the kubelet's SIGKILL.
7. In a layer constructor, an `Effect.addFinalizer` registered after
   `Effect.forkScoped(...)` runs before those forks are interrupted
   (reverse order). Probe: a "stop claiming" finalizer let the in-flight
   iteration finish; only then was the heartbeat fiber interrupted.
8. A release function receives the scope's `Exit`: interrupt-only on
   SIGTERM, a failure on `LeaderLost` or startup failure. Skip the drain
   delay on failure:
   `Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)`.

The grace budget comes from krun's own bounds, not a library timeout.
Bound each step. Arm one last-resort watchdog as the first finalizer
starts:

```ts
Effect.sleep(Duration.seconds(25)).pipe(
  Effect.andThen(Effect.logFatal("shutdown grace exceeded")),
  Effect.andThen(Effect.sync(() => process.exit(1))),
  Effect.forkDetach,
)
```

Probe: the detached fiber fires during a stuck finalizer; the process
exits 1. 25 s leaves headroom under the 30 s grace. Only the watchdog and
the `runMain` teardown may end the process; a `process.exit` anywhere
else skips the finalizers and leaves the Lease held. Dapr's integration
test asserts exit 1 with "Graceful shutdown timeout exceeded"
(`dapr tests/integration/suite/daprd/shutdown/graceful/timeout.go:50-60`).
Keep that behaviour; log the step in progress at `fatal`.

## Layer shape

```ts
// gateway main.ts (shape, not final code)
const Listeners = Layer.mergeAll(PublicServer, InternalServer, AdminServer)
const Main = Drain.pipe(              // released first: flip readiness, wait the delay
  Layer.provideMerge(Listeners),       // released next, concurrently
  Layer.provide(AppLayer),             // Config, Logger, Readiness, Functions, Keys, Store
  Layer.provide(Telemetry("krun-gateway")), // NodeSdk: tracer, Prometheus reader (docs/STACK.md 4.1)
)                                      // Store released, then Telemetry flushes last
NodeRuntime.runMain(Layer.launch(Main), { teardown, disableErrorReporting: true })
```

`Drain` is a `Layer.effectDiscard` over an `Effect.acquireRelease`. Its
release sets `Readiness.draining`, then sleeps `KRUN_SHUTDOWN_DELAY`. It
depends on the listeners, so it is released before them; every listener
keeps serving through the delay. docs/STACK.md:206-210 words this as
"each listener's release flips readiness, waits, closes". One `Drain`
above the merged listeners gives the same order with one timer instead of
three. If the drain sits inside each listener release instead, share one
memoised Effect, or each release waits the full delay again. Probe
(`KRUN_SHUTDOWN_DELAY=1s`): `/readyz` 503 and `/v1` 200 at +200 ms, waits
answered at +1004 ms, exit 0 at +1014 ms.

Each listener layer:

```ts
Effect.acquireRelease(
  Effect.tryPromise(async () => { const app = build(ctx); await app.listen(addr); return app }),
  (app) => Effect.promise(() => app.close()).pipe(Effect.timeoutOption("5 seconds")),
)
```

`ctx` is the context captured with `Effect.context()` in the layer
constructor. Route handlers run
`Effect.runPromiseWith(ctx)(effect, { signal })`, so a client disconnect
interrupts the handler fiber (probe: aborting `signal` ran the fiber's
`onInterrupt`). Effect 4 has no `Runtime<R>`; use this or a
`ManagedRuntime` to embed Effect (docs/STACK.md:211-215).

## Gateway (SPEC.md:1198-1202, P3.7 PLAN.md:438-447)

Budget: `KRUN_SHUTDOWN_DELAY` (default 5 s) + listener close + pool close
+ span flush (at most `shutdownTimeout`, 3 s default, only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set), well under 30 s. P3.7 acceptance
runs with `KRUN_SHUTDOWN_DELAY=2s` and no OTLP endpoint and expects exit 0
within 5 seconds of SIGTERM. A process test with an unreachable endpoint
spends up to 3 s more in the flush.

| Step | Effect construct | Why / citation |
|---|---|---|
| 0 | `runMain` interrupts the main fiber; the `Layer.launch` scope starts closing. | docs/STACK.md:52 |
| 1 | `Drain` release, first effect: `Ref.set(readiness.draining, true)`, then arm the watchdog. `/readyz` now returns 503; nothing is closed yet. | SPEC.md:1198 "first makes `/readyz` return 503"; kube-proxy and the endpoints controller need the probe failures to stop routing (D30) |
| 2 | `Drain` release: `Effect.sleep(config.shutdownDelay)` (skipped on a failure exit). Every listener keeps serving; `/v1` answers normally, never `NOT_READY`. | SPEC.md:1199-1200; docs/API.md:342; P3.7 asserts a `/v1` request after `/readyz` turned 503 still answers 200 (PLAN.md:444-446) |
| 3 | Listener releases start concurrently (`Layer.mergeAll`) and call `app.close()`. Fastify sets its closing flag (a new request on a kept-alive socket gets 503 + `Connection: close`), runs `preClose`, then `server.close()` and `onClose`. | Fastify 5.12.7 `fastify.js:384-430`, `lib/route.js:483-500`, read from the tarball |
| 4 | Public listener `preClose` hook: complete the `Shutdown` `Deferred`. Every SSE handler waiting on it ends `reply.raw` (no shutdown event, SPEC.md:256-258). Every wait handler answers at once with the current state (201 for `CreateRun?wait`, 200 for `WaitRun`). The hook then awaits `finish` on the tracked responses. | SPEC.md:1201-1202, SPEC.md:233 "the server may answer earlier at shutdown"; P5.1 and P5.2 (PLAN.md:635-647). `close()` cannot see hijacked `reply.raw` responses (knative `serving pkg/http/handler/hijack.go:27-66`) |
| 5 | `app.close()` resolves on all three listeners, each bounded by `Effect.timeoutOption`. | listeners close before the pool, so step 4 can still read the store |
| 6 | Store layer release: the Kysely pool and, in postgres mode, the dedicated `LISTEN` client (SPEC.md:548-549); in embedded mode the single `node:sqlite` `Database` connection (SPEC.md:561-565). | SPEC.md:1202 "closes the pool"; last of the app layers because every layer above depends on it |
| 7 | `Telemetry` layer release: the tracer provider runs `forceFlush()` then `shutdown()`, bounded by `shutdownTimeout` (default 3000 ms); spans of the steps above reach the OTLP endpoint when one is set. | `@effect/opentelemetry` 4.0.6 `NodeSdk.ts` `layerTracerProvider`; docs/STACK.md 4.1 provides `Telemetry` under everything else |
| 8 | The main fiber ends interrupt-only; the teardown maps that to exit 0. | SPEC.md:1202 "exits 0" |

Observed pitfall (probe): the `Deferred` was completed outside `preClose`
and `close()` followed at once. The wait response was still being
written, so its keep-alive socket was not idle; `server.close()` waited
on it and the release hit its 5 s timeout. Awaiting `finish` on the
tracked responses inside `preClose` (step 4) cut the close to 2 ms.

## Scheduler (SPEC.md:1202-1206, P4.11 PLAN.md:602-609)

Budget: ≤ 10 s in-flight iteration + informer stop + Lease update (10 s
API timeout, SPEC.md:801) + pool close + span flush (≤ 3 s, only with an
OTLP endpoint), under 30 s. P4.11 acceptance expects exit 0 within 5
seconds of SIGTERM as a *standby* (no iteration in flight) with the Lease
cleared in `test/fake-kube`.

Layer order, top to bottom: `Drain` (flips readiness, no delay),
`AdminServer`, the `Leader` layer, `FunctionInformer`, the store. On
acquisition the `Leader` layer opens a child scope for the leader scope
(loops, Job and Pod informers, status writer); `krun-scheduler-k8s` owns
that contract.

| Step | Effect construct | Why / citation |
|---|---|---|
| 1 | `Drain` release: `Ref.set(readiness.draining, true)`, then arm the watchdog. | SPEC.md:1195 "returns 503 from the start of shutdown"; Dapr flips readiness before draining (`dapr pkg/scheduler/server/server.go:336-366`) |
| 2 | Leader finalizer, registered after the loop forks so it runs first: `Ref.set(stopping, true)`. The main loop checks the flag before each `claimQueued` and starts no new iteration. Do not just interrupt the loop fiber: that would cut an iteration between a Job create and the run's transition. | SPEC.md:1203 "stops claiming" |
| 3 | `Fiber.await(mainLoop).pipe(Effect.timeoutOption("10 seconds"))`. The iteration already carries `Effect.timeout("10 seconds")` and releases its claims in `Effect.ensuring`; unprocessed claims are released, the rest expire normally. | SPEC.md:1203; SPEC.md:808-811 and :1117 (10 s iteration deadline); SPEC.md:1205-1206 "unfinished leases expire normally"; docs/STACK.md:246 |
| 4 | The leader scope closes. Heartbeat, deliveries, sweep and reconcile fibers are interrupted, and so are in-flight Kubernetes calls, which aborts their `signal`. Thread the signal into the client-node call (`krun-scheduler-k8s`). | SPEC.md:785 loops stop on SIGTERM |
| 5 | The Job and Pod informer `Stream`s end; their scoped finalizers call `informer.stop()`. Then the Function informer layer (process-wide, outside the leader scope) releases. | SPEC.md:1204 "stops the informers"; a live watch keeps the event loop busy and the 5 s exit assertion fails |
| 6 | Set `krun_scheduler_leader` to 0, then clear `holderIdentity` on the Lease: `get`; only if the read `holderIdentity` is this pod, `update` with the read `resourceVersion` and `holderIdentity` empty. One 409 retry. Each call under `Effect.timeout("10 seconds")`. A failure is logged at warn and never blocks exit. A standby holds nothing and skips the update. | SPEC.md:1204-1205 "clears `holderIdentity` on the Lease so a standby takes over at once"; P4.11 asserts the Lease is cleared in the fake (PLAN.md:607-609); `maxUnavailable: 0` guarantees a Ready standby (SPEC.md:1384-1386) |
| 7 | Admin listener release: `app.close()`, bounded. | the probe keeps answering (503) until here |
| 8 | Store layer release (pool, `LISTEN` client, or the SQLite connection). | SPEC.md:1205 "closes the pool" |
| 9 | `Telemetry` layer release: span flush, bounded by `shutdownTimeout` (default 3000 ms). | as gateway step 7 |
| 10 | The teardown maps the interrupt to exit 0. | SPEC.md:1205 "exits 0" |

Leader loss (no successful renew for 10 s, SPEC.md:796-798) takes a
different path. The renew fiber interrupts the leader scope (loops,
informers, in-flight calls), then fails the main fiber with a
`LeaderLost` tagged error. Finalizers still run. `Drain` skips its delay
because the exit is a failure. Step 6 is skipped because another pod may
already hold the Lease. The teardown exits 1; Kubernetes restarts the pod
as a standby. Never reuse the SIGTERM path's exit 0 here (P4.2
PLAN.md:494-502).

## Tests that pin these sequences

Order and timing in-process (`@effect/vitest`, docs/STACK.md:161):

```ts
it.effect("drain flips readiness, waits the delay, then closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(MainUnderTest, scope)    // fake listeners and store
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
    yield* Effect.yieldNow
    // events: [..., "readyz 503"]; no listener closed yet
    yield* TestClock.adjust("4999 millis")              // still draining
    yield* TestClock.adjust("1 millis")
    yield* Fiber.join(closing)
    // events: "delay over", listener closes in any order, "store close" last
  }))
```

Stand in for SIGTERM with `Scope.close(scope, Exit.void)` on a scope from
`Layer.buildWithScope`, not
`Fiber.interrupt` on a `Layer.launch` fiber. In the probe, under
`TestClock`, an `Effect.sleep` inside a finalizer of an interrupted fiber
returned `Interrupt` at once. The same code waits the full delay under the
live clock and under `Scope.close`. Record events in a `Ref` from fake
listener and store layers. Assert `readyz 503` before `delay over`,
listener closes after it in any order, store close last.

Process tests (real clock, `child_process.spawn`):

- P3.7 (PLAN.md:438-447): embedded mode with a temp dir and `KUBECONFIG`
  at `test/fake-kube` serving one Function; `/readyz` 200 on the admin
  port; `/v1/*` 404 on the admin port; with `KRUN_SHUTDOWN_DELAY=2s` a
  `/v1` request after `/readyz` turned 503 still answers 200; exit 0
  within 5 s of SIGTERM.
- P4.11 (PLAN.md:602-609): same harness for the scheduler; `/readyz` 200
  as standby; exit 0 within 5 s of SIGTERM with the Lease cleared.
- P5.1 (PLAN.md:635-640): SIGTERM ends an in-flight wait early, returning
  the run without error.
- P5.2 (PLAN.md:641-647): `WatchRun` closes on SIGTERM.
- P4.2 (PLAN.md:494-502): release on SIGTERM, exit non-zero on renew
  failure, against a stubbed `CoordinationV1Api`.

Spawn the process, send `SIGTERM`, assert the `exit` event's code and the
elapsed time. Poll `/readyz` with `Effect.retry` and `Schedule.spaced`
under `it.live`, not fixed sleeps. Pick free ports in the test and pass
them as `KRUN_*_LISTEN_ADDR`.

## Upgrade note

Scheduler downtime must stay below `KRUN_TTL_AFTER_FINISHED`
(SPEC.md:920-925, 1472): a Job that `ttlSecondsAfterFinished` removes
while no leader runs becomes `job_lost`. The sequence above and
`maxUnavailable: 0` keep that window to seconds.
