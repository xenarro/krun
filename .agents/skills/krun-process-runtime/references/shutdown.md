# SIGTERM shutdown sequences (SPEC.md:1166-1174)

Line numbers from the working tree 2026-10-23; re-check before quoting.
Both sequences must fit the 30 second grace period (SPEC.md:1174); the
chart sets `terminationGracePeriodSeconds: 30` (SPEC.md:1238) and the
gateway drains for `KRUN_SHUTDOWN_DELAY` before closing (D30,
SPEC.md:1471). The mechanism comes from D35 (SPEC.md:1476): `NodeRuntime.runMain`
plus scope finalizers (docs/STACK.md 2.1, 2.6, 4.1, and 4.3 "SIGTERM order |
scope finalizers"). `close-with-grace` is gone (docs/STACK.md:99).

## Mechanism (verified: effect 4.0.6, @effect/platform-node 4.0.6)

Read from the package sources (`npm pack`), then confirmed with probe
programs on Node 26 and Fastify 5.12.7 in
`~/.hermes/cache/scratch/krun-skills/probe-runtime/` (`p1.mjs` to `p6.mjs`,
`scope.test.mjs`):

1. `NodeRuntime.runMain(effect, options)` adds `SIGINT` and `SIGTERM`
   listeners that interrupt the main fiber, and calls `process.exit(code)`
   once that fiber has ended (`@effect/platform-node-shared`
   `src/NodeRuntime.ts`). The module is marked `@stability unstable`, so
   pin the exact minor (docs/STACK.md:27-29, 43).
2. The default teardown (`effect` `Runtime.defaultTeardown`) maps success
   to 0, an interrupt-only cause to **130**, and any other failure to 1 (or
   to the error's `Runtime.errorExitCode`). SPEC says "exits 0" after
   SIGTERM, so pass a teardown:
   ```ts
   const teardown: Runtime.Teardown = (exit, onExit) =>
     onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1)
   NodeRuntime.runMain(Layer.launch(Main), { teardown, disableErrorReporting: true })
   ```
   Probe: with the default teardown, SIGTERM exited 130. With this one it
   exits 0, and a `LeaderLost` or `ConfigInvalid` failure exits 1.
3. `disableErrorReporting: true` stops `runMain` from logging the failure
   cause itself. Log the tagged error once through the pino-backed logger
   (`references/logging.md`) so a cause never prints a value.
4. Interruption closes the `Layer.launch` scope. Finalizers run in reverse
   acquisition order, uninterruptibly. A layer fed in with `Layer.provide`
   is released after the layers that depend on it, so the store
   (`Database` layer) closes last.
5. `Layer.mergeAll(a, b, c)` builds and releases its members concurrently
   (it forks a `"parallel"` child scope, `Layer.ts` `mergeAllEffect`). The
   three gateway listeners therefore close at the same time, the way Dapr
   closes its servers under one deadline (`dapr pkg/api/http/server.go:235-265`).
   Probe: all three releases started within 1 ms of each other.
6. `Effect.timeout` and `Effect.timeoutOption` work inside a finalizer.
   `Effect.tryPromise((signal) => ...)` aborts its `AbortSignal` when the
   timeout wins. Bound every finalizer step this way: a step that hangs
   blocks exit until the kubelet's SIGKILL.
7. Inside a layer constructor, an `Effect.addFinalizer` registered after
   `Effect.forkScoped(...)` runs before those forks are interrupted
   (reverse order). Probe: a "stop claiming" finalizer let the in-flight
   iteration finish, and only then was the heartbeat fiber interrupted.
8. A release function receives the scope's `Exit`. On SIGTERM it is
   interrupt-only; on `LeaderLost` or a startup failure it is a failure.
   Skip the drain delay on failure:
   `Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)`.

The grace budget no longer comes from a library timeout. Bound each step,
and arm one last-resort watchdog as the first finalizer starts:

```ts
Effect.sleep(Duration.seconds(25)).pipe(
  Effect.andThen(Effect.logFatal("shutdown grace exceeded")),
  Effect.andThen(Effect.sync(() => process.exit(1))),
  Effect.forkDetach,
)
```

Probe: the detached fiber fires during a stuck finalizer and the process
exits 1. 25 s leaves headroom under the 30 s grace. The watchdog and the
`runMain` teardown are the only code that may end the process; a
`process.exit` anywhere else skips the finalizers and leaves the Lease
held. Dapr's integration test asserts exit 1 with "Graceful shutdown
timeout exceeded" (`dapr tests/integration/suite/daprd/shutdown/graceful/timeout.go:50-60`).
Keep that behaviour, and log the step in progress at `fatal`.

## Layer shape

```ts
// gateway main.ts (shape, not final code)
const Listeners = Layer.mergeAll(PublicServer, InternalServer, AdminServer)
const Main = Drain.pipe(              // released first: flip readiness, wait the delay
  Layer.provideMerge(Listeners),       // released next, concurrently
  Layer.provide(AppLayer),             // Config, Logger, Metrics, Readiness, Functions, Keys, Store
)                                      // Store released last
NodeRuntime.runMain(Layer.launch(Main), { teardown, disableErrorReporting: true })
```

`Drain` is a `Layer.effectDiscard` over an `Effect.acquireRelease`. Its
release sets `Readiness.draining` and then sleeps `KRUN_SHUTDOWN_DELAY`.
It depends on the listeners, so it is released before them and every
listener keeps serving through the delay. docs/STACK.md:149-153 words
this as "each listener's release flips readiness, waits, closes". One
`Drain` above the merged listeners gives the same order with one timer
instead of three. If you put the drain inside each listener release
instead, share one memoised Effect, or each release waits the full delay
again. Probe (`KRUN_SHUTDOWN_DELAY=1s`): `/readyz` was 503 and `/v1` was
200 at +200 ms, waits were answered at +1004 ms, and the process exited 0
at +1014 ms.

Each listener layer:

```ts
Effect.acquireRelease(
  Effect.tryPromise(async () => { const app = build(ctx); await app.listen(addr); return app }),
  (app) => Effect.promise(() => app.close()).pipe(Effect.timeoutOption("5 seconds")),
)
```

`ctx` is the context captured with `Effect.context()` in the layer
constructor. Route handlers run `Effect.runPromiseWith(ctx)(effect, { signal })`,
so a client disconnect interrupts the handler fiber (probe: aborting
`signal` ran the fiber's `onInterrupt`). Effect 4 has no `Runtime<R>`;
use this, or a `ManagedRuntime`, to embed Effect (docs/STACK.md:154-158).

## Gateway (SPEC.md:1166-1170, P3.7 PLAN.md:432-441)

Budget: `KRUN_SHUTDOWN_DELAY` (default 5 s) + listener close + pool close,
well under 30 s. P3.7 acceptance runs with `KRUN_SHUTDOWN_DELAY=2s` and
expects exit 0 within 5 seconds of SIGTERM.

| Step | Effect construct | Why / citation |
|---|---|---|
| 0 | `runMain` interrupts the main fiber; the `Layer.launch` scope starts closing. | docs/STACK.md:43 |
| 1 | `Drain` release, first effect: `Ref.set(readiness.draining, true)`, then arm the watchdog. `/readyz` now returns 503; nothing is closed yet. | SPEC.md:1166 "first makes `/readyz` return 503"; kube-proxy and the endpoints controller need the probe failures to stop routing (D30) |
| 2 | `Drain` release: `Effect.sleep(config.shutdownDelay)` (skipped on a failure exit). Every listener keeps serving; `/v1` answers normally and never `NOT_READY`. | SPEC.md:1167-1168; docs/API.md:342; P3.7 asserts a `/v1` request after `/readyz` turned 503 still answers 200 (PLAN.md:438-440) |
| 3 | Listener releases start concurrently (`Layer.mergeAll`) and call `app.close()`. Fastify sets its closing flag (a new request on a kept-alive socket gets 503 + `Connection: close`), runs `preClose`, then `server.close()` and `onClose`. | Fastify 5.12.7 `fastify.js:384-430`, `lib/route.js:483-500`, read from the tarball |
| 4 | Public listener `preClose` hook: complete the `Shutdown` `Deferred`. Every SSE handler waiting on it writes its final event and ends `reply.raw`; every wait handler waiting on it answers at once with the current state (201 for `CreateRun?wait`, 200 for `WaitRun`). The hook then awaits `finish` on the tracked responses. | SPEC.md:1169-1170, SPEC.md:233 "the server may answer earlier at shutdown"; P5.1 and P5.2 (PLAN.md:625-637). `close()` cannot see hijacked `reply.raw` responses (knative `serving pkg/http/handler/hijack.go:27-66`) |
| 5 | `app.close()` resolves on all three listeners, each bounded by `Effect.timeoutOption`. | listeners close before the pool, so step 4 can still read the store |
| 6 | Store layer release: the Kysely pool and, in postgres mode, the dedicated `LISTEN` client (SPEC.md:548-549); in embedded mode the single better-sqlite3 connection (SPEC.md:561). | SPEC.md:1170 "closes the pool"; it goes last because every layer above depends on it |
| 7 | The main fiber ends interrupt-only and the teardown maps that to exit 0. | SPEC.md:1170 "exits 0" |

Observed pitfall (probe): the `Deferred` was completed outside `preClose`
and `close()` followed at once. The wait response was still being
written, so its keep-alive socket was not idle; `server.close()` waited on
it and the release hit its 5 s timeout. Awaiting `finish` on the tracked
responses inside `preClose` (step 4) cut the close to 2 ms.

## Scheduler (SPEC.md:1170-1174, P4.11 PLAN.md:592-599)

Budget: ≤ 10 s in-flight iteration + informer stop + Lease update (10 s
API timeout, SPEC.md:795) + pool close, under 30 s. P4.11 acceptance
expects exit 0 within 5 seconds of SIGTERM as a *standby* (no iteration in
flight) with the Lease cleared in `test/fake-kube`.

Layer order, top to bottom: `Drain` (flips readiness, no delay), then
`AdminServer`, then the `Leader` layer, then `FunctionInformer`, then the
store. On acquisition the `Leader` layer opens a child scope for the leader
scope (loops, Job and Pod informers, status writer); `krun-scheduler-k8s`
owns that contract.

| Step | Effect construct | Why / citation |
|---|---|---|
| 1 | `Drain` release: `Ref.set(readiness.draining, true)`, then arm the watchdog. | SPEC.md:1163 "returns 503 from the start of shutdown"; Dapr flips readiness before draining (`dapr pkg/scheduler/server/server.go:336-366`) |
| 2 | Leader finalizer, registered after the loop forks so it runs first: `Ref.set(stopping, true)`. The main loop checks the flag before each `claimQueued` and starts no new iteration. Do not just interrupt the loop fiber: that would cut an iteration between a Job create and the run's transition. | SPEC.md:1171 "stops claiming" |
| 3 | `Fiber.await(mainLoop).pipe(Effect.timeoutOption("10 seconds"))`. The iteration already carries `Effect.timeout("10 seconds")` and releases its claims in `Effect.ensuring`; unprocessed claims are released and the rest expire normally. | SPEC.md:1171; SPEC.md:802-806 and :1117 (10 s iteration deadline); SPEC.md:1173-1174 "unfinished leases expire normally"; docs/STACK.md:184 |
| 4 | The leader scope closes. The heartbeat, deliveries, sweep and reconcile fibers are interrupted, and so are in-flight Kubernetes calls, which aborts their `signal`. Thread the signal into the client-node call (`krun-scheduler-k8s`). | SPEC.md:779 loops stop on SIGTERM |
| 5 | The Job and Pod informer `Stream`s end, and their scoped finalizers call `informer.stop()`. After that the Function informer layer, which is process-wide and outside the leader scope, releases. | SPEC.md:1172 "stops the informers"; a live watch keeps the event loop busy and the 5 s exit assertion fails |
| 6 | Set `krun_scheduler_leader` to 0, then clear `holderIdentity` on the Lease: `get`, and only if the read `holderIdentity` is this pod, `update` with the read `resourceVersion` and `holderIdentity` empty. One 409 retry. Each call runs under `Effect.timeout("10 seconds")`. A failure is logged at warn and never blocks exit. A standby holds nothing and skips the update. | SPEC.md:1172-1173 "clears `holderIdentity` on the Lease so a standby takes over at once"; P4.11 asserts the Lease is cleared in the fake (PLAN.md:597-599); `maxUnavailable: 0` guarantees a Ready standby (SPEC.md:1335-1337) |
| 7 | Admin listener release: `app.close()`, bounded. | the probe keeps answering (503) until here |
| 8 | Store layer release (pool, `LISTEN` client, or the SQLite connection). | SPEC.md:1173 "closes the pool" |
| 9 | The teardown maps the interrupt to exit 0. | SPEC.md:1173 "exits 0" |

Leader loss (no successful renew for 10 s, SPEC.md:790-792) takes a
different path. The renew fiber interrupts the leader scope (loops,
informers, in-flight calls) and then fails the main fiber with a
`LeaderLost` tagged error. Finalizers still run, but `Drain` skips its
delay because the exit is a failure, and step 6 is skipped because another
pod may already hold the Lease. The teardown exits 1 and Kubernetes
restarts the pod as a standby. Never reuse the SIGTERM path's exit 0 here
(P4.2 PLAN.md:488-496).

## Tests that pin these sequences

Order and timing in-process (`@effect/vitest`, docs/STACK.md:108):

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

Use `Scope.close(scope, Exit.void)` to stand in for SIGTERM, not
`Fiber.interrupt` on a `Layer.launch` fiber. In the probe, under
`TestClock`, an `Effect.sleep` inside a finalizer of an interrupted fiber
returned `Interrupt` at once. The same code waits the full delay under the
live clock and under `Scope.close`. Record events in a `Ref` from fake
listener and store layers, then assert `readyz 503` before `delay over`,
the listener closes after it in any order, and the store close last.

Process tests (real clock, `child_process.spawn`):

- P3.7 (PLAN.md:432-441): embedded mode with a temp dir and `KUBECONFIG`
  at `test/fake-kube` serving one Function; `/readyz` 200 on the admin
  port; `/v1/*` 404 on the admin port; with `KRUN_SHUTDOWN_DELAY=2s` a
  `/v1` request after `/readyz` turned 503 still answers 200; exit 0
  within 5 s of SIGTERM.
- P4.11 (PLAN.md:592-599): the same harness for the scheduler; `/readyz`
  200 as standby; exit 0 within 5 s of SIGTERM with the Lease cleared.
- P5.1 (PLAN.md:625-630): SIGTERM ends an in-flight wait early, returning
  the run without error.
- P5.2 (PLAN.md:631-637): `WatchRun` closes on SIGTERM.
- P4.2 (PLAN.md:488-496): release on SIGTERM, and exit non-zero on renew
  failure, against a stubbed `CoordinationV1Api`.

Spawn the process, send `SIGTERM`, and assert the `exit` event's code and
the elapsed time. Poll `/readyz` with `Effect.retry` and `Schedule.spaced`
under `it.live` instead of fixed sleeps. Pick free ports in the test and
pass them as `KRUN_*_LISTEN_ADDR`.

## Upgrade note

Scheduler downtime must stay below `KRUN_TTL_AFTER_FINISHED`
(SPEC.md:914-919, 1417): a Job that `ttlSecondsAfterFinished` removes
while no leader is running becomes `job_lost`. The sequence above and
`maxUnavailable: 0` keep that window to seconds.
