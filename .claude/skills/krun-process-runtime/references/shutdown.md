# SIGTERM shutdown sequences (SPEC.md:1166-1174)

Line numbers from the working tree 2026-10-23; re-check before quoting.
Both sequences must fit the 30 second grace period (SPEC.md:1174); the
chart sets `terminationGracePeriodSeconds: 30` (SPEC.md:1238) and the
gateway drains for `KRUN_SHUTDOWN_DELAY` before closing (D30,
SPEC.md:1471).

## Mechanism: `NodeRuntime.runMain` and scope finalizers (docs/STACK.md 4.1)

```ts
NodeRuntime.runMain(Layer.launch(Main))
```

`runMain` turns SIGTERM and SIGINT into interruption of the main fiber.
`Layer.launch` holds the layer's scope open until then; closing it runs
every finalizer in reverse acquisition order. So the shape of `Main`
decides the order: resources acquired first (Config, Logger, Database
pool, Metrics, the Function informer) are released last; the listener
layers, acquired on top of them, are released first. There is no signal
handler and no `process.exit` in krun code.

- Exit code: an interrupt-only exit is 0; a failure or defect, including a
  failing finalizer, is 1 (Effect 3 platform-node behaviour; confirm the
  teardown rule in the installed `@effect/platform-node` and Effect's
  `MIGRATION.md`).
- Budget: bound each release step with `Effect.timeout` and fail (log the
  step name at `fatal` first) when it overruns, so the whole sequence stays
  under about 25 s, below the kubelet's SIGKILL at 30 s.
- Every sleep in a release is `Effect.sleep` on a `Duration` from Config;
  the in-process tests drive it with `TestClock`.

## Gateway (SPEC.md:1166-1170, P3.7 PLAN.md:432-441)

Budget: `KRUN_SHUTDOWN_DELAY` (default 5 s) + listener close + pool close,
well under 30 s. P3.7 acceptance runs with `KRUN_SHUTDOWN_DELAY=2s` and
expects exit 0 within 5 seconds of SIGTERM.

| Step | Action | Why / citation |
|---|---|---|
| 1 | First statement of the listener release: `Ref.set` the readiness state to `draining`; `/readyz` now returns 503. Do not close anything. | SPEC.md:1166 "first makes `/readyz` return 503"; kube-proxy and the endpoints controller need the probe failures to stop routing (D30) |
| 2 | Keep serving every listener for `KRUN_SHUTDOWN_DELAY` (`Effect.sleep`). `/v1` keeps answering normally: never `NOT_READY` during the drain. Steps 1-2 run once per process: one memoised drain Effect awaited by all three listener releases. | SPEC.md:1167-1168; P3.7 asserts a `/v1` request after `/readyz` turned 503 still answers 200 (PLAN.md:438-440) |
| 3 | After the delay: complete the `shuttingDown` `Deferred`; every SSE handler ends its `reply.raw` (its scope's finalizer). | SPEC.md:1169 "ends open SSE streams"; Fastify `close()` does not end hijacked `reply.raw` responses, so they must end before or in `preClose` (`serving pkg/http/handler/hijack.go:27-66`) |
| 4 | The same `Deferred` answers in-flight `wait` requests at once with the current state (status unchanged: 201 for `CreateRun?wait`, 200 for `WaitRun`). | SPEC.md:1169-1170, SPEC.md:233 "the server may answer earlier at shutdown"; P5.1 "SIGTERM answers in-flight waits at once" (PLAN.md:628) |
| 5 | `app.close()` under `Effect.promise` for each listener (public, internal, admin). Fastify `close()`: new requests get 503 + `Connection: close`, `preClose` hooks, idle connections dropped, `server.close()` waits for in-flight requests, `onClose` hooks. | Fastify 5 close sequence; like Dapr, close the listeners under one shared deadline so the first close cannot cancel the rest (`dapr pkg/api/http/server.go:235-265`) |
| 6 | The notify subscription fiber is interrupted with the public layer's scope; then the store's finalizer closes the Kysely pool and, in postgres mode, the dedicated `LISTEN` client (SPEC.md:548-549); in embedded mode the single better-sqlite3 connection (SPEC.md:561). | SPEC.md:1170 "closes the pool"; the pool was acquired before the listeners, so it is released after them and step 4 can still read the current state |
| 7 | The scope is closed; runMain exits 0 (interrupt-only exit). | SPEC.md:1170 "exits 0" |

Step 1 is the first thing the release does, before any `await` or sleep,
so no probe can observe 200 after the drain has started. Steps 3-4 run
before `close()` (or from a `preClose` hook of the public listener) so
that `close()` in step 5 cannot wait on a stream or a wait that nobody
ends.

## Scheduler (SPEC.md:1170-1174, P4.11 PLAN.md:592-599)

Budget: ≤ 10 s in-flight iteration + informer stop + Lease update (10 s
API timeout, SPEC.md:795) + pool close, under 30 s. P4.11 acceptance
expects exit 0 within 5 seconds of SIGTERM as a *standby* (no iteration
in flight) with the Lease cleared in `test/fake-kube`.

| Step | Action | Why / citation |
|---|---|---|
| 1 | Set `/readyz` to 503 (shutdown started): `Ref.set` as the first finalizer to run (acquire the admin listener layer last, or register a dedicated finalizer last). | SPEC.md:1163 "returns 503 from the start of shutdown"; Dapr flips readiness before draining so probes fail during the drain (`dapr pkg/scheduler/server/server.go:336-366`) |
| 2 | Stop claiming: interrupting the leader scope interrupts the main loop fiber between iterations; no new iteration starts. | SPEC.md:1171 "stops claiming" |
| 3 | Bound the in-flight iteration to 10 seconds: the iteration already runs under `Effect.timeout("10 seconds")` with claims released in `Effect.ensuring`; interruption waits for that, not longer. Unprocessed leases expire normally. | SPEC.md:1171, SPEC.md:1117 (10 s loop deadline), SPEC.md:1173-1174 "unfinished leases expire normally" |
| 4 | The heartbeat, deliveries, sweep and reconcile fibers (forked into the leader scope with `Schedule.spaced`) are interrupted with it; in-flight API calls under the `KRUN_K8S_CONCURRENCY` `Semaphore` are interrupted and aborted. | SPEC.md:779 loops stop on SIGTERM |
| 5 | Informer finalizers stop the Job and Pod informers (`informer.stop()`), then the Function informer. | SPEC.md:1172 "stops the informers"; without this the watch keeps the event loop alive and the process never exits |
| 6 | The leader layer's finalizer sets `krun_scheduler_leader` to 0, then clears `holderIdentity` on the Lease: `get`, then `update` with the read `resourceVersion` and `holderIdentity` empty; a 409 is retried once within the budget; failure is logged at warn, never blocks exit. Standby replicas skip the update (they hold nothing). | SPEC.md:1172-1173 "clears `holderIdentity` on the Lease so a standby takes over at once"; P4.11 asserts the Lease is cleared in the fake (PLAN.md:598-599); `RollingUpdate maxUnavailable: 0` guarantees a Ready standby exists (SPEC.md:1335-1337) |
| 7 | The store's finalizer closes the pool, `LISTEN` client, or the SQLite connection. | SPEC.md:1173 "closes the pool" |
| 8 | The scope is closed; runMain exits 0. | SPEC.md:1173 "exits 0" |

Leader loss (no renew for 10 s) is a different path: the renew fiber
interrupts the leader scope (loops, informers, in-flight API calls) and
fails the main fiber with a tagged `LeaderLost` error, so runMain exits
non-zero and Kubernetes restarts the pod as a standby (SPEC.md:790-792,
docs/STACK.md 4.3). It must not look like the SIGTERM path's exit 0.

## Grace overrun

A release step that exceeds its `Effect.timeout` logs the step name at
`fatal` and fails, which makes the exit non-interrupt-only and runMain
exits 1. Keep that behaviour: Dapr's runtime does the same and its
integration test asserts exit code 1 with "Graceful shutdown timeout
exceeded, forcing shutdown" (`dapr tests/integration/suite/daprd/shutdown/graceful/timeout.go:50-60`,
`pkg/runtime/runtime_test.go:2000-2054`).

## Tests that pin these sequences

- P3.7 (PLAN.md:432-441): process start in embedded mode with a temp dir
  and `KUBECONFIG` at `test/fake-kube` serving one Function; `/readyz` 200
  on the admin port; `/v1/*` 404 on the admin port; with
  `KRUN_SHUTDOWN_DELAY=2s` a `/v1` request after `/readyz` turned 503
  still answers 200; exit 0 within 5 s of SIGTERM.
- P4.11 (PLAN.md:592-599): same harness for the scheduler; `/readyz` 200
  as standby; exit 0 within 5 s of SIGTERM with the Lease cleared in the
  fake.
- P5.1 (PLAN.md:628-630): SIGTERM ends an in-flight wait early, returning
  the run without error.
- P5.2 (PLAN.md:633-634): `WatchRun` closes on SIGTERM.
- P4.2 (PLAN.md:488-496): release on SIGTERM with a stubbed
  `CoordinationV1Api`.

The process tests (P3.7, P4.11) run under Vitest on the real clock: spawn
the process with `child_process.spawn`, send `SIGTERM`, and assert the
`exit` event's code and elapsed time; use a fresh
`KRUN_ADMIN_LISTEN_ADDR=127.0.0.1:0`-style free port only if the config
accepts it, otherwise pick a free port in the test and pass it. The
in-process tests (P5.1, P5.2, P4.2) use `@effect/vitest`: build the layer
with `it.effect` (scoped) or `Layer.build` in a `Scope`, close the scope to stand
in for SIGTERM, and move time with `TestClock.adjust`.

## Upgrade note

Scheduler downtime must stay below `KRUN_TTL_AFTER_FINISHED`
(SPEC.md:917-919, 1417): a Job removed by `ttlSecondsAfterFinished` while
no leader is running becomes `job_lost`. The shutdown sequence above and
`maxUnavailable: 0` keep that window to seconds.
