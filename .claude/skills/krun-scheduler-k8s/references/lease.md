# Lease leader election (SPEC.md:776-792, SPEC.md:1166-1174)

Serves PLAN P4.2 (PLAN.md:488-496) and the SIGTERM part of P4.11
(PLAN.md:592-599). In house, a scoped Effect layer on `CoordinationV1Api`
through the `Kube` service (PLAN.md:82-84, D15 SPEC.md:1456, D35
SPEC.md:1476). Line numbers verified on 2026-10-23; re-check before citing.

## Contract (SPEC.md:783-792)

Lease `krun-scheduler` in the krun namespace. `holderIdentity` = pod name
(downward API `metadata.name`). Acquire and renew: `get`, then `update`
with the read `resourceVersion`. Rules 2-4 in SKILL.md; detail below.

Constants: `leaseDurationSeconds: 15`, renew deadline 10 s, retry 2 s.
Assert at startup client-go's checks `renewDeadline > retry * 1.2` and
`renewDeadline < leaseDuration` (serving
`vendor/k8s.io/client-go/tools/leaderelection/leaderelection.go:72-81`).
Values equal controller-runtime defaults (keda
`cmd/operator/main.go:169-185`). Not configurable: no SPEC.md section 12
env var names them, so adding one is a non-asked option (PLAN.md:31-32).

## State machine

```
standby --(get: absent, or expired on local clock)--> acquire (create or update)
   |                                                      |
   | 409 / changed holder: retry in 2 s                   | success: leader
   v                                                      v
standby <--(renew fails for 10 s)-- exit non-zero <--- leader --(every 2 s)--> renew (get + update)
                                                      |  SIGTERM
                                                      v
                                              clear holderIdentity, update, exit 0
```

Each attempt through `Kube`: `readNamespacedLease({ name: 'krun-scheduler', namespace:
KRUN_NAMESPACE })` then `replaceNamespacedLease({ ..., body })` with
`body.metadata.resourceVersion` from the read. A 409
(`ApiException.code === 409`) or a read `holderIdentity` not ours fails the
attempt (SPEC.md:786-788). A 404 on read: the Lease does not exist, call
`createNamespacedLease`. A 409 `AlreadyExists` on create means someone else
got it. Never patch: read-then-replace with `resourceVersion` is the
optimistic lock (docs/research/node-stack-facts.md:274-278).

Local-clock expiry (SPEC.md:788-790, invariant 24):

- Keep `observed = { holderIdentity, renewTime, seenAt }` in a `Ref`;
  `seenAt` from `Clock.currentTimeMillis`, never `Date.now()`.
- On each read, if `holderIdentity` or `renewTime` differs from `observed`,
  replace it with `seenAt = now`.
- Expired when `now - observed.seenAt >= 15_000`.
- `renewTime` written on acquire and renew is `DateTime.now` formatted as
  the MicroTime the Lease API expects.
- Never compute `now - renewTime` (client-go agrees,
  `leaderelection.go:380-388,432-464`): skew between replicas or the API
  server would produce two leaders.

Renew deadline (SPEC.md:790-792): track `lastRenewOk` (from `Clock`) in a
`Ref`. When `now - lastRenewOk >= 10_000` on the leader, the renew fiber:

1. sets `krun_scheduler_leader` 0;
2. closes the leader scope: interrupts loops, Job/Pod informers, status
   writer and every in-flight `Kube` call (its `tryPromise` signal aborts
   the request);
3. logs at error and fails with a tagged `LeaderLost`.

The main program joins the renew fiber, so `NodeRuntime.runMain` exits
non-zero. Nothing calls `process.exit`. A read showing another
`holderIdentity` while we lead is the same loss, without waiting for the
10 s. Knative demotes and re-acquires instead (serving
`leaderelection.go:279-312`, `leaderelection/context.go:296-315`). Keep
SPEC: exit, so Kubernetes restarts a clean standby and leader-local maps
(`firstAbsent`, log tails, backoffs) never leak across terms.

Renew runs on its own fiber (`Effect.repeat` with
`Schedule.spaced("2 seconds")`), forked in the Lease layer's scope, outside
the leader scope it guards. Never sequence it behind the main loop: a slow
iteration must not delay renew (dapr.md:390-398, `cron.go:180-195`). The
`Kube` 10 s timeout bounds each renew attempt.

## Layer shape

Effect 3 spelling; check Effect's `MIGRATION.md` for `Layer.scoped`,
`Effect.forkScoped` and `Scope.make` in Effect 4:

```ts
export const LeaderLive = Layer.scoped(Leader, Effect.gen(function* () {
  yield* acquireUntilLeader                       // get/update every 2 s; a standby waits here, ready
  yield* Effect.addFinalizer(() => clearHolder)   // runs last: SIGTERM step 5, one attempt, bounded
  const leaderScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(leaderScope, exit)) // runs before clearHolder
  const renew = yield* Effect.forkScoped(renewLoop(leaderScope))      // interrupted first on SIGTERM
  return { scope: leaderScope, renew }
}))
```

Finalizers run in reverse registration order. On SIGTERM: renew fiber
stops, leader scope closes (loops, informers, status writer), then
`holderIdentity` is cleared. Leader-only components fork into
`leaderScope` (`Effect.forkIn`) or build resources in it (`Scope.extend`),
never into the process scope.

## Identity

`holderIdentity` = pod name from the `Config` service, which reads the env
the chart wires from downward API `metadata.name` (SPEC.md:785; env in
`krun-helm-chart`, `Config` in `krun-process-runtime`). Never read
`process.env` outside `Config`. Knative uses `hostname_<uuid>` (serving
`leaderelection/context.go:199-205`); SPEC says pod name, keep it. Same-name
restart: the restarted pod's first read sees its own old `holderIdentity`,
starts the 15 s timer and waits it out like any candidate. Do not shortcut
by trusting a matching `holderIdentity` on the first read.

## Leader-gated components (SPEC.md:776-781)

| Component | Starts | Stops |
|---|---|---|
| Function informer | process start, every replica (readiness) | process exit |
| Lease loop, admin listener, `/readyz` | process start | SIGTERM |
| Job and Pod informers | on acquisition, in the leader scope | leader scope closes: loss, renew-deadline exit, SIGTERM |
| main loop, cancelling, deliveries, sweep, Function status writer | on acquisition, fibers in the leader scope | same |
| heartbeat loop, `job_lost` check, reconcile timer | after both Job and Pod informers' initial list (D33), fibers in the leader scope | same |
| leader metrics (`krun_scheduler_leader` 1, section 11 leader rows) | on acquisition | set `krun_scheduler_leader` 0 on loss |

Only the leader writes Function status (SPEC.md:154). A standby stays
`/readyz` 200 and reports `leader: false` there (SPEC.md:1163-1164,
PLAN.md:594-596). On promotion, run the reconcile handler once over the
caches before the loops claim anything (serving
`leaderelection/context.go:154-167`, `revision/controller.go:66-92`). In
krun that is the "once after sync" reconcile tick (SPEC.md:849-850).

## RBAC (SPEC.md:1036-1039)

Krun namespace, `coordination.k8s.io` `leases`: verbs `get`, `update` with
`resourceNames: [krun-scheduler]`, plus `create` without `resourceNames`
(Kubernetes cannot scope `create` by name). No `patch`, no `list`, no
`watch`, no `delete`. The chart renders it (`krun-helm-chart`). A 403 on
the Lease is permanent: surface it in the log, never retry as transient.

## SIGTERM order on the scheduler (SPEC.md:1170-1174, PLAN.md:592-599)

`NodeRuntime.runMain` turns SIGTERM into interruption of the main fiber;
scope finalizers then run in reverse acquisition order. No signal handler
of our own (docs/STACK.md 2.1, 2.9, 4.3). SPEC's order follows:

1. `/readyz` returns 503 (SPEC.md:1163). The readiness finalizer is
   registered last, so it runs first (`krun-process-runtime` owns it).
2. Stop claiming: the loop fiber is interrupted. The in-flight iteration's
   `Effect.ensuring` releases leases of unscheduled claims; its own 10 s
   `Effect.timeout` bounds it (SPEC.md:1171).
3. Heartbeat, deliveries, sweep and reconcile fibers and the Job and Pod
   informers (`informer.stop()` in their release) close with the leader
   scope. The Function informer closes later with its process-level layer.
4. In-flight `Kube` calls are interrupted with their fibers; the
   `tryPromise` signal aborts the request, so nothing hangs on the API
   server (dapr `server.go:336-366`: readiness first, bounded drain, forced
   stop).
5. `clearHolder` finalizer: read; set `spec.holderIdentity: ''` (empty
   string, not an omitted field: the standby's local-clock rule must see
   the change) and `renewTime` now from `DateTime.now`; replace with the
   read `resourceVersion`. One attempt under `Effect.timeout`; log errors
   at warn and swallow them so the remaining finalizers run. A standby
   takes over at once: it sees `holderIdentity` change and the Lease
   unheld (SPEC.md:1172-1173). Knative also shrinks
   `leaseDurationSeconds` to 1 (serving `leaderelection.go:315-347`); SPEC
   only clears the holder, so a standby that missed the change waits at
   most 15 s. Keep SPEC.
6. Admin listener closes, then the `Database` layer closes the pool
   (acquired first, released last); exit 0. Unfinished claim leases expire
   normally (SPEC.md:1173-1174). All of it fits the 30 s grace period
   (SPEC.md:1174). The chart's `RollingUpdate maxSurge 1 maxUnavailable 0`
   guarantees a Ready standby before the leader gets SIGTERM
   (SPEC.md:1335-1337).

Exit code under `NodeRuntime.runMain`'s default teardown: interrupt-only
exit from the signal is 0; `LeaderLost` failure is non-zero. Confirm the
Effect 4 teardown once in the P4.11 test; do not assume it.

## P4.2 unit test cases (PLAN.md:493-496), stubbed `CoordinationV1Api`

`@effect/vitest` `it.effect` (already scoped), `Kube` stub as a layer. Time
moves only via `TestClock.adjust`, which advances both
`Clock.currentTimeMillis` and every `Schedule`/`Effect.sleep`: local-clock
expiry and the 2 s retry agree by construction. Fork the election under
test, then adjust. No real sleeps.

| Case | Stub | Assert |
|---|---|---|
| acquire from absent | read -> `ApiException 404`, create -> Lease | `isLeader` true, `krun_scheduler_leader` 1, `onAcquire` called once |
| acquire from expired | read returns holder `other`, `renewTime` unchanged across reads; `TestClock.adjust("15 seconds")` | no replace before 15 s on the local clock; replace after; holder is now us |
| renew | leader; `TestClock.adjust("2 seconds")` | read then replace with the read `resourceVersion`; `renewTime` updated |
| 409 on renew | replace -> `ApiException 409` | attempt fails, next try after 2 s, still leader until the 10 s deadline |
| lose (holder changed) | read returns holder `other` while we lead | leader scope closed: Job/Pod informers `stop()` called, loop fibers interrupted, `krun_scheduler_leader` 0, election fiber fails with `LeaderLost` |
| renew failure exit | every replace fails; `TestClock.adjust("10 seconds")` | loops interrupted, informers stopped, a pending stub call sees its `AbortSignal` aborted, the joined fiber exits with failure `LeaderLost` (no `process.exit` stub needed) |
| release on SIGTERM | leader; interrupt the election fiber (what `runMain` does on SIGTERM) | leader scope closed first, then replace called with `holderIdentity: ''`; the fiber exit is interrupt-only |
| skewed renewTime | read returns `renewTime` 1 h in the future, never changing | still expired 15 s after first seen (local clock, not `renewTime`) |

The two-scheduler check (one leader, standby takes over inside 15 s) runs
on kind in P7.6, not here (PLAN.md:493-496).
