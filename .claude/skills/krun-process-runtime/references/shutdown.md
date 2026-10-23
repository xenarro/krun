# SIGTERM shutdown sequences (SPEC.md:1166-1174)

Line numbers from the working tree 2026-10-23; re-check before quoting.
Both sequences must fit the 30 second grace period (SPEC.md:1174); the
chart sets `terminationGracePeriodSeconds: 30` (SPEC.md:1238) and the
gateway drains for `KRUN_SHUTDOWN_DELAY` before closing (D30,
SPEC.md:1471).

## Mechanism: `close-with-grace` (PLAN.md:56)

`closeWithGrace({ delay }, async ({ signal, err, manual }) => { ... })`
installs SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers,
runs the function once, exits 0 when it resolves, exits 1 when it rejects,
and exits 1 with `killed by timeout (<delay>ms)` when `delay` elapses
first; `onTimeout(delay)` runs just before that forced exit
(`close-with-grace` 2.5.0 README lines 16-27, 120-158; `index.js:129-148`,
read from the tarball). Set `delay` to the budget below (leave headroom
under 30 s, e.g. 25000) so a stuck pool close never outlives the kubelet's
SIGKILL. The handler must be the only place that calls `process.exit`.

## Gateway (SPEC.md:1166-1170, P3.7 PLAN.md:413-421)

Budget: `KRUN_SHUTDOWN_DELAY` (default 5 s) + listener close + pool close,
well under 30 s. P3.7 acceptance runs with `KRUN_SHUTDOWN_DELAY=2s` and
expects exit 0 within 5 seconds of SIGTERM.

| Step | Action | Why / citation |
|---|---|---|
| 1 | Set the readiness flag to `draining`; `/readyz` now returns 503. Do not close anything. | SPEC.md:1166 "first makes `/readyz` return 503"; kube-proxy and the endpoints controller need the probe failures to stop routing (D30) |
| 2 | Keep serving every listener for `KRUN_SHUTDOWN_DELAY`. `/v1` keeps answering normally: never `NOT_READY` during the drain. | SPEC.md:1167-1168; P3.7 asserts a `/v1` request after `/readyz` turned 503 still answers 200 (PLAN.md:419-420) |
| 3 | After the delay: end open SSE streams with a final event, then `end()` on each tracked `reply.raw`. | SPEC.md:1169 "ends open SSE streams"; Fastify `close()` does not end hijacked `reply.raw` responses, so track them in a `Set` and end them in a `preClose` hook (knative-serving.md:172-176, `serving pkg/http/handler/hijack.go:27-66`) |
| 4 | Answer in-flight `wait` requests at once with the current state (status unchanged: 201 for `CreateRun?wait`, 200 for `WaitRun`). | SPEC.md:1169-1170, SPEC.md:233 "the server may answer earlier at shutdown"; P5.1 "SIGTERM answers in-flight waits at once" (PLAN.md:608) |
| 5 | `await Promise.all([public.close(), internal.close(), admin.close()])`. Fastify `close()`: new requests get 503 + `Connection: close`, `preClose` hooks, idle connections dropped, `server.close()` waits for in-flight requests, `onClose` hooks. | node-stack-facts.md:559-567 (VERIFIED); close the three listeners concurrently, like Dapr closes its HTTP servers under one shared deadline so the first close cannot cancel the rest (`dapr pkg/api/http/server.go:235-265`) |
| 6 | Close the store: the Kysely pool and, in postgres mode, the dedicated `LISTEN` client (SPEC.md:548-549); in embedded mode the single better-sqlite3 connection (SPEC.md:561). | SPEC.md:1170 "closes the pool"; order matters: listeners first, pool last, so step 4 can still read the current state |
| 7 | Resolve the `closeWithGrace` handler: exit 0. | SPEC.md:1170 "exits 0" |

Step 1 happens synchronously inside the signal handler so no probe can
observe 200 after SIGTERM. Steps 3-4 should run from a `preClose` hook of
the public listener so that `close()` in step 5 cannot start draining
before SSE and waits are done (node-stack-facts.md:571-573).

## Scheduler (SPEC.md:1170-1174, P4.11 PLAN.md:572-579)

Budget: ≤ 10 s in-flight iteration + informer stop + Lease update (10 s
API timeout, SPEC.md:795) + pool close, under 30 s. P4.11 acceptance
expects exit 0 within 5 seconds of SIGTERM as a *standby* (no iteration
in flight) with the Lease cleared in `test/fake-kube`.

| Step | Action | Why / citation |
|---|---|---|
| 1 | Set `/readyz` to 503 (shutdown started). | SPEC.md:1163 "returns 503 from the start of shutdown"; Dapr flips readiness before draining so probes fail during the drain (`dapr pkg/scheduler/server/server.go:336-366`) |
| 2 | Stop claiming: set the `stopping` flag the main loop checks before each `claimQueued`; do not start a new iteration. | SPEC.md:1171 "stops claiming" |
| 3 | Bound the in-flight iteration to 10 seconds: abort its `AbortController` at the deadline; unprocessed claims are released (their leases expire normally). | SPEC.md:1171, SPEC.md:1117 (10 s loop deadline), SPEC.md:1173-1174 "unfinished leases expire normally" |
| 4 | Stop the heartbeat, deliveries, sweep and reconcile timers (clear timers, abort in-flight API calls through the limiter). | SPEC.md:779 loops stop on SIGTERM |
| 5 | Stop the Job and Pod informers (`informer.stop()`), then the Function informer. | SPEC.md:1172 "stops the informers"; without this the watch keeps the event loop alive and the process never exits |
| 6 | Set `krun_scheduler_leader` to 0, then clear `holderIdentity` on the Lease: `get`, then `update` with the read `resourceVersion` and `holderIdentity` empty; a 409 is retried once within the budget; failure is logged at warn, never blocks exit. Standby replicas skip the update (they hold nothing). | SPEC.md:1172-1173 "clears `holderIdentity` on the Lease so a standby takes over at once"; P4.11 asserts the Lease is cleared in the fake (PLAN.md:578-579); `RollingUpdate maxUnavailable: 0` guarantees a Ready standby exists (SPEC.md:1335-1337) |
| 7 | Close the store (pool, `LISTEN` client, or the SQLite connection). | SPEC.md:1173 "closes the pool" |
| 8 | Resolve the handler: exit 0. | SPEC.md:1173 "exits 0" |

Leader loss (no renew for 10 s) is a different path: stop loops and
informers, cancel in-flight API calls and exit non-zero so Kubernetes
restarts the pod as a standby (SPEC.md:790-792). Do not reuse the SIGTERM
handler's exit 0 for it.

## Grace expiry

If the handler has not resolved when `delay` elapses, `close-with-grace`
exits 1. Keep that behaviour: Dapr's runtime does the same and its
integration test asserts exit code 1 with "Graceful shutdown timeout
exceeded, forcing shutdown" (`dapr tests/integration/suite/daprd/shutdown/graceful/timeout.go:50-60`,
`pkg/runtime/runtime_test.go:2000-2054`). Log the step that was in
progress at `fatal` from `onTimeout` so the stuck resource is named.

## Tests that pin these sequences

- P3.7 (PLAN.md:413-421): process start in embedded mode with a temp dir
  and `KUBECONFIG` at `test/fake-kube` serving one Function; `/readyz` 200
  on the admin port; `/v1/*` 404 on the admin port; with
  `KRUN_SHUTDOWN_DELAY=2s` a `/v1` request after `/readyz` turned 503
  still answers 200; exit 0 within 5 s of SIGTERM.
- P4.11 (PLAN.md:572-579): same harness for the scheduler; `/readyz` 200
  as standby; exit 0 within 5 s of SIGTERM with the Lease cleared in the
  fake.
- P5.1 (PLAN.md:608-610): SIGTERM ends an in-flight wait early, returning
  the run without error.
- P5.2 (PLAN.md:613-614): `WatchRun` closes on SIGTERM.
- P4.2 (PLAN.md:473-476): release on SIGTERM with a stubbed
  `CoordinationV1Api`.

Spawn the process with `child_process.spawn` from the test, send
`SIGTERM`, and assert the `exit` event's code and elapsed time; use a
fresh `KRUN_ADMIN_LISTEN_ADDR=127.0.0.1:0`-style free port only if the
config accepts it, otherwise pick a free port in the test and pass it.

## Upgrade note

Scheduler downtime must stay below `KRUN_TTL_AFTER_FINISHED`
(SPEC.md:917-919, 1417): a Job removed by `ttlSecondsAfterFinished` while
no leader is running becomes `job_lost`. The shutdown sequence above and
`maxUnavailable: 0` keep that window to seconds.
