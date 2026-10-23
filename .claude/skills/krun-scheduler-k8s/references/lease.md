# Lease leader election (SPEC.md:776-792, SPEC.md:1166-1174)

Serves PLAN P4.2 (PLAN.md:468-476) and the SIGTERM part of P4.11
(PLAN.md:572-579). Written in house, about 40 lines on `CoordinationV1Api`
(PLAN.md:71-72, D15 SPEC.md:1456). Line numbers verified against the
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

Every attempt is `readNamespacedLease({ name: 'krun-scheduler', namespace:
KRUN_NAMESPACE })` then `replaceNamespacedLease({ ..., body })` with
`body.metadata.resourceVersion` taken from the read; a 409
(`ApiException.code === 409`) or a `holderIdentity` that is not ours on the
read fails the attempt (SPEC.md:786-788). A 404 on the read means the Lease
does not exist: `createNamespacedLease`; a 409 `AlreadyExists` on create is
the same "someone else got it" outcome. Never patch; the read-then-replace
with `resourceVersion` is the optimistic lock (node-stack-facts.md:274-278).

Local-clock expiry (SPEC.md:788-790, invariant 24): keep
`observed = { holderIdentity, renewTime, seenAt: Date.now() }`. On each
read, if `holderIdentity` or `renewTime` differs from `observed`, replace
it with `seenAt = now`. The Lease is expired when `now - observed.seenAt >=
15_000`. Never compute `now - renewTime` (client-go does the same,
`leaderelection.go:380-388,432-464`): clock skew between replicas or the
API server would otherwise produce two leaders.

Renew deadline (SPEC.md:790-792): track `lastRenewOk`. When `now -
lastRenewOk >= 10_000` on the leader: set `isLeader = false`, stop the
loops and the Job/Pod informers, abort the scheduler-wide `AbortController`
so in-flight API calls end, log at error, `process.exit(1)`. Knative
demotes and re-enters acquire instead of exiting (serving
`leaderelection.go:279-312`, `leaderelection/context.go:296-315`); SPEC
chooses exit so Kubernetes restarts a clean standby and leader-local maps
(`firstAbsent`, log tails, backoffs) cannot leak across terms. Keep SPEC.

Renew runs on its own timer (`setInterval(2000)` with an `unref`-free
handle while leading), never awaited behind the main loop: a slow iteration
must not delay the renew (dapr.md:390-398, `cron.go:180-195`).

## Identity

`holderIdentity` = `process.env.KRUN_POD_NAME` or whatever the chart wires
from the downward API `metadata.name` (SPEC.md:785); the chart renders that
env (see `krun-helm-chart`). Knative uses `hostname_<uuid>` to survive fast
restarts with the same pod name (serving `leaderelection/context.go:199-205`);
SPEC says the pod name, so keep it. The local-clock rule covers the
same-name restart: a restarted pod's first read sees its own old
`holderIdentity`, starts the 15 s timer and waits it out like any candidate.
Do not shortcut by trusting a matching `holderIdentity` on the first read.

## Leader-gated components (SPEC.md:776-781)

| Component | Starts | Stops |
|---|---|---|
| Function informer | process start, every replica (readiness) | process exit |
| Lease loop, admin listener, `/readyz` | process start | SIGTERM |
| Job and Pod informers | on acquisition | on loss, renew-deadline exit, SIGTERM |
| main loop, cancelling, deliveries, sweep, Function status writer | on acquisition | same |
| heartbeat loop, `job_lost` check, reconcile timer | after both Job and Pod informers' initial list (D33) | same |
| leader metrics (`krun_scheduler_leader` 1, section 11 leader rows) | on acquisition | set `krun_scheduler_leader` 0 on loss |

Only the leader writes Function status (SPEC.md:154). A standby stays
`/readyz` 200 and reports `leader: false` there (SPEC.md:1163-1164,
PLAN.md:574-575). On promotion run the reconcile handler once over the
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

## SIGTERM order on the scheduler (SPEC.md:1170-1174, PLAN.md:575-579)

1. `/readyz` returns 503 (SPEC.md:1163).
2. Stop claiming: the main loop takes no new iteration; the in-flight
   iteration is bounded by its own 10 s deadline (SPEC.md:1171).
3. Stop the heartbeat, deliveries, sweep and reconcile timers; stop the
   Job and Pod informers (`informer.stop()`), then the Function informer.
4. Abort the scheduler-wide `AbortController` after the bounded wait so
   nothing hangs on the API server (dapr `server.go:336-366`: readiness
   first, bounded drain, forced stop).
5. Clear `holderIdentity` on the Lease: read, set `spec.holderIdentity:
   ''` (empty string, not an omitted field; the standby's local-clock
   rule needs to see the change) and `renewTime` now, replace with the
   read `resourceVersion`; one attempt, errors logged at warn. A standby
   takes over at once because it sees `holderIdentity` change and the
   Lease is unheld (SPEC.md:1172-1173). Knative additionally shrinks
   `leaseDurationSeconds` to 1 (serving `leaderelection.go:315-347`);
   SPEC only clears the holder, so a standby that missed the change
   waits at most 15 s. Keep SPEC.
6. Close the pool, exit 0. Unfinished claim leases expire normally
   (SPEC.md:1173-1174). Everything fits the 30 s grace period
   (SPEC.md:1174); the chart's `RollingUpdate maxSurge 1 maxUnavailable 0`
   guarantees a Ready standby exists before the leader gets SIGTERM
   (SPEC.md:1335-1337).

Use `close-with-grace` (PLAN.md:56) for the signal hook; it is the only
allowed dependency for this.

## P4.2 unit test cases (PLAN.md:474-476), stubbed `CoordinationV1Api`

Fake time with `mock.timers.enable({ apis: ['setTimeout', 'setInterval',
'Date'] })`; `Date` must be in the list or `Date.now()` stays real and
disagrees with the timers (node-stack-facts.md:858-860).

| Case | Stub | Assert |
|---|---|---|
| acquire from absent | read -> `ApiException 404`, create -> Lease | `isLeader` true, `krun_scheduler_leader` 1, `onAcquire` called once |
| acquire from expired | read returns holder `other`, `renewTime` unchanged across reads; advance 15 s | no replace before 15 s on the local clock; replace after; holder is now us |
| renew | leader; advance 2 s | read then replace with the read `resourceVersion`; `renewTime` updated |
| 409 on renew | replace -> `ApiException 409` | attempt fails, next try after 2 s, still leader until the 10 s deadline |
| lose (holder changed) | read returns holder `other` while we lead | `onLose` fires: Job/Pod informers `stop()` called, loops stopped, `krun_scheduler_leader` 0 |
| renew failure exit | every replace fails; advance 10 s | loops stopped, informers stopped, `AbortController` aborted, `process.exit(1)` (stub `exit`) |
| release on SIGTERM | leader; send the shutdown signal | replace called with `holderIdentity: ''`, then `exit(0)` within 5 s |
| skewed renewTime | read returns `renewTime` 1 h in the future, never changing | still expired 15 s after first seen (local clock, not `renewTime`) |

The two-scheduler check (one leader, standby takes over inside 15 s) runs
on kind in P7.6, not here (PLAN.md:476).
