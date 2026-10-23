# Lease leader election (SPEC.md:776-792, SPEC.md:1166-1174)

Serves PLAN P4.2 (PLAN.md:488-496) and the SIGTERM part of P4.11
(PLAN.md:592-599). Written in house as a scoped Effect layer on
`CoordinationV1Api` through the `Kube` service (PLAN.md:82-84, D15
SPEC.md:1456, D35 SPEC.md:1476). Line numbers verified against the
working tree on 2026-10-23; re-check before citing.

## Contract (SPEC.md:783-792, verbatim)

> Leader election uses a Kubernetes Lease named `krun-scheduler` in the krun
> namespace: 15 second lease, 10 second renew deadline, 2 second retry.
> `holderIdentity` is the pod name (downward API `metadata.name`). The
> contract: acquire and renew by `get` then `update` with the read
> `resourceVersion`; a 409 or a changed `holderIdentity` fails the attempt,
> retry in 2 seconds. A candidate deems the Lease expired 15 seconds after it
> last saw `holderIdentity` or `renewTime` change, measured on its own clock,
> never by comparing `renewTime` with local time. A leader with no successful
> renew for 10 seconds stops its loops and informers, cancels in-flight API
> calls and exits non-zero; Kubernetes restarts it as a standby.

Constants: `leaseDurationSeconds: 15`, renew deadline 10 s, retry 2 s. They
satisfy client-go's own check `renewDeadline > retry * 1.2` and
`renewDeadline < leaseDuration` (serving
`vendor/k8s.io/client-go/tools/leaderelection/leaderelection.go:72-81`);
assert both at startup. The values equal controller-runtime's defaults
(keda `cmd/operator/main.go:169-185`). They are not configurable: no env
var in SPEC.md section 12 names them, so adding one is a non-asked option
(PLAN.md:31-32).

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

Every attempt is `Kube` -> `readNamespacedLease({ name: 'krun-scheduler', namespace:
KRUN_NAMESPACE })` then `replaceNamespacedLease({ ..., body })` with
`body.metadata.resourceVersion` taken from the read; a 409
(`ApiException.code === 409`) or a `holderIdentity` that is not ours on the
read fails the attempt (SPEC.md:786-788). A 404 on the read means the Lease
does not exist: `createNamespacedLease`; a 409 `AlreadyExists` on create is
the same "someone else got it" outcome. Never patch; the read-then-replace
with `resourceVersion` is the optimistic lock (docs/research/node-stack-facts.md:274-278).

Local-clock expiry (SPEC.md:788-790, invariant 24): keep
`observed = { holderIdentity, renewTime, seenAt }` in a `Ref`, `seenAt`
from `Clock.currentTimeMillis` (never `Date.now()`). On each read, if
`holderIdentity` or `renewTime` differs from `observed`, replace it with
`seenAt = now`. The Lease is expired when `now - observed.seenAt >=
15_000`. `renewTime` written on acquire and renew is `DateTime.now`
formatted as the MicroTime the Lease API expects. Never compute `now - renewTime` (client-go does the same,
`leaderelection.go:380-388,432-464`): clock skew between replicas or the
API server would otherwise produce two leaders.

Renew deadline (SPEC.md:790-792): track `lastRenewOk` (from `Clock`) in a
`Ref`. When `now - lastRenewOk >= 10_000` on the leader, the renew fiber:
sets `krun_scheduler_leader` 0, closes the leader scope (which interrupts
the loops, the Job/Pod informers, the status writer and every in-flight
`Kube` call, whose `tryPromise` signal aborts the request), logs at error
and fails with a tagged `LeaderLost`. The main program joins the renew
fiber, so that failure ends `NodeRuntime.runMain` with a non-zero exit
code; nothing calls `process.exit`. A read that shows another
`holderIdentity` while we lead is the same loss, without waiting for the
10 s. Knative
demotes and re-enters acquire instead of exiting (serving
`leaderelection.go:279-312`, `leaderelection/context.go:296-315`); SPEC
chooses exit so Kubernetes restarts a clean standby and leader-local maps
(`firstAbsent`, log tails, backoffs) cannot leak across terms. Keep SPEC.

Renew runs on its own fiber (`Effect.repeat` with
`Schedule.spaced("2 seconds")`) forked in the Lease layer's scope, outside
the leader scope it guards, never sequenced behind the main loop: a slow
iteration must not delay the renew (dapr.md:390-398, `cron.go:180-195`).
The renew attempt itself is bounded by the `Kube` 10 s timeout.

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

Finalizers run in reverse order of registration, so on SIGTERM the renew
fiber stops, then the leader scope closes (loops, informers, status
writer), then `holderIdentity` is cleared. Leader-only components fork
into `leaderScope` (`Effect.forkIn`) or build their resources in it
(`Scope.extend`), never into the process scope.

## Identity

`holderIdentity` = the pod name from the `Config` service, which reads the
env the chart wires from the downward API `metadata.name` (SPEC.md:785;
see `krun-helm-chart` for the env, `krun-process-runtime` for `Config`;
never read `process.env` outside `Config`). Knative uses
`hostname_<uuid>` to survive fast restarts with the same pod name (serving
`leaderelection/context.go:199-205`); SPEC says the pod name, so keep it. The local-clock rule covers the
same-name restart: a restarted pod's first read sees its own old
`holderIdentity`, starts the 15 s timer and waits it out like any candidate.
Do not shortcut by trusting a matching `holderIdentity` on the first read.

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
PLAN.md:594-596). On promotion run the reconcile handler once over the
caches before the loops claim anything (serving
`leaderelection/context.go:154-167`, `revision/controller.go:66-92`); in
krun that is the "once after sync" reconcile tick (SPEC.md:849-850).

## RBAC (SPEC.md:1036-1039)

In the krun namespace: `coordination.k8s.io` `leases` verbs `get`, `update`
with `resourceNames: [krun-scheduler]`, plus `create` without
`resourceNames` (Kubernetes cannot scope `create` by name). No `patch`, no
`list`, no `watch`, no `delete`. The chart renders this (`krun-helm-chart`);
a 403 on the Lease is a permanent error that must surface in the log, not a
transient retry.

## SIGTERM order on the scheduler (SPEC.md:1170-1174, PLAN.md:592-599)

`NodeRuntime.runMain` turns SIGTERM into interruption of the main fiber;
the scope finalizers then run in reverse acquisition order. There is no
signal handler of our own (docs/STACK.md 2.1, 2.9, 4.3). The order SPEC asks
for falls out of that:

1. `/readyz` returns 503 (SPEC.md:1163): the readiness finalizer is
   registered last, so it runs first (`krun-process-runtime` owns it).
2. Stop claiming: the loop fiber is interrupted; the in-flight iteration's
   `Effect.ensuring` releases the leases of unscheduled claims, and the
   iteration is bounded by its own 10 s `Effect.timeout` (SPEC.md:1171).
3. Stop the heartbeat, deliveries, sweep and reconcile fibers and the Job
   and Pod informers (`informer.stop()` in their release): all of them
   close with the leader scope. The Function informer closes later with
   its process-level layer.
4. In-flight `Kube` calls are interrupted with their fibers; the
   `tryPromise` signal aborts the request, so nothing hangs on the API
   server (dapr `server.go:336-366`: readiness first, bounded drain,
   forced stop).
5. Clear `holderIdentity` on the Lease (the `clearHolder` finalizer): read,
   set `spec.holderIdentity: ''` (empty string, not an omitted field; the
   standby's local-clock rule needs to see the change) and `renewTime`
   now from `DateTime.now`, replace with the read `resourceVersion`; one
   attempt under `Effect.timeout`, errors logged at warn and swallowed so
   the remaining finalizers run. A standby takes over at once because it
   sees `holderIdentity` change and the Lease is unheld
   (SPEC.md:1172-1173). Knative additionally shrinks
   `leaseDurationSeconds` to 1 (serving `leaderelection.go:315-347`);
   SPEC only clears the holder, so a standby that missed the change waits
   at most 15 s. Keep SPEC.
6. The admin listener closes, then the `Database` layer closes the pool
   (acquired first, released last); exit 0. Unfinished claim leases expire
   normally (SPEC.md:1173-1174). Everything fits the 30 s grace period
   (SPEC.md:1174); the chart's `RollingUpdate maxSurge 1 maxUnavailable 0`
   guarantees a Ready standby exists before the leader gets SIGTERM
   (SPEC.md:1335-1337).

Exit code: an interrupt-only exit from the signal is 0 and a `LeaderLost`
failure is non-zero under `NodeRuntime.runMain`'s default teardown;
confirm the Effect 4 teardown behaviour once in the P4.11 test rather than
assuming it.

## P4.2 unit test cases (PLAN.md:493-496), stubbed `CoordinationV1Api`

`@effect/vitest` `it.effect` (already scoped) with the `Kube` stub as a
layer; time moves only through `TestClock.adjust`, which advances both
`Clock.currentTimeMillis` and every `Schedule`/`Effect.sleep`, so the
local-clock expiry and the 2 s retry agree by construction. Fork the
election under test, then adjust; no real sleeps.

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
