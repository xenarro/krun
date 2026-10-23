# Job and Pod informers, jobStatus, terminal path (SPEC.md:847-875)

Serves PLAN P4.4 (PLAN.md:503-522), P4.5 reconcile part (PLAN.md:523-531),
P6.2 object check (PLAN.md:642-647). `@kubernetes/client-node` facts come
from node-stack-facts.md section 2 (2.0.1, VERIFIED unless marked). Line
numbers verified against the working tree on 2026-10-23.

## Construction

```ts
const sel = 'krun.io/run-id';
const jobs = makeInformer(kc, `/apis/batch/v1/namespaces/${ns}/jobs`,
  () => batch.listNamespacedJob({ namespace: ns, labelSelector: sel }), sel);
const pods = makeInformer(kc, `/api/v1/namespaces/${ns}/pods`,
  () => core.listNamespacedPod({ namespace: ns, labelSelector: sel }), sel);
```

- Pass the label selector twice: `makeInformer`'s 4th argument only reaches
  the watch URL; the `listFn` must carry it too or the initial list pulls
  every Job in the namespace (node-stack-facts.md:363-370). Server-side
  filtering, never a cluster-wide watch filtered in the handler (serving
  `filtered_factory.go:61-63`; keda `cmd/operator/main.go:216-220`).
- Jobs namespace only (SPEC.md:847-848); the Function informer is a
  different object (`krun-functions-crd`).
- No `fieldSelector` argument on `makeInformer`; not needed.
- The pod template carries the same `krun.io/run-id` label so the Pod
  informer sees the pod (job-manifest.md; keda `scale_jobs.go:170`).
- Associate pod to run by the `krun.io/run-id` label, not by owner
  references and not by name parsing (keda.md section 1.4).

## Initial list and readiness

`start()` emits `connect`, runs the full LIST, diffs the cache (emitting
`add`/`update`/`delete`), stores the list `resourceVersion`, then opens the
watch (node-stack-facts.md:374-378). Treat the returned promise of your
`listFn` as "initial list processed": wrap it so the informer's first list
resolves a `synced` promise; run the handler over `informer.list()` once
after both informers are synced (the "once after sync" reconcile,
SPEC.md:849-850), log the count of `scheduled`/`running` runs with no Job
(SPEC.md:916-917), then start the heartbeat loop, the `job_lost` check and
the 5-minute timer (SPEC.md:779-781, D33 SPEC.md:1474). Nothing writes
before both lists are in; a controller that creates children before its
cache is warm duplicates them (serving `controller.go:714-725`).

Initial-list `add` events are not "new run" events: the handler is
idempotent and derives everything from the cached object (dapr
`pkg/operator/api/informer/informer.go:115-127`).

## Error handling and restart (SPEC.md:851-852, PLAN.md:504)

| Watch outcome | client-node 2.0.1 behaviour | krun |
|---|---|---|
| 30 s inactivity `TimeoutError` | reconnects from the last RV, delay 0 | normal; log at debug at most, never as an error (node-stack-facts.md:347-360) |
| clean server close | reconnects with backoff 1 s -> 30 s | nothing to do |
| 410 Gone | clears RV, next cycle re-LISTs | nothing to do; the re-LIST diff emits deletes for vanished Jobs |
| any other error (list 403/404/5xx, network) | emits `error` and STOPS for good | the `error` handler must call `informer.start()` again after backoff `min(2^n, 30) s`, reset `n` on `connect` (node-stack-facts.md:390-397) |
| `stop()` | aborts the watch, no auto-restart | used on leader loss and SIGTERM |

Without an `error` handler the informer stops silently and the scheduler
never sees another event (SPEC.md:851-852). Register `on('error')` before
`start()`. Bound the restart loop: after 60 s of continuous failure log at
error (the readiness of a standby is unaffected; only the leader runs these
informers). To unit-test the backoff construct `new ListWatch(path,
fakeWatch, listFn, false, sel, undefined, { delayFn })`
(node-stack-facts.md:408-411).

## No resync: the 5-minute reconcile (SPEC.md:848-851, D33)

client-node has no resync; `update` fires only when `resourceVersion`
changes (node-stack-facts.md:382-386, 398-401). On the leader, every 5
minutes and once after sync: iterate `jobs.list(ns)`, for each Job find the
pod by label from `pods.list(ns)`, run the same handler. No API call; writes
only on change; also run the step 6 `job_lost` check (main-loop.md). Yield
with `setImmediate` between runs so a live event is not delayed behind the
sweep, and skip a run id currently inside the handler (serving two-lane
queue, `two_lane_queue.go:26-74`). This tick is what retries an object-store
error (SPEC.md:872-873) and what fires `job_lost`; without it both never
happen (D33).

## jobStatus derivation (SPEC.md:852-860)

```ts
type JobStatus = {
  podName: string | null; phase: string | null;
  reason: string | null;  message: string | null;
  exitCode: number | null; observedAt: string;   // ISO, JSON key observedAt (SPEC.md:263)
};
```

Inputs: the cached Job and the cached pod with the same `krun.io/run-id`
(the newest by `creationTimestamp` when two exist; `backoffLimit: 0` makes
that rare). Derive:

- `podName`: pod `metadata.name`.
- `phase`: pod `status.phase`.
- `reason`/`message`, first match: pod condition `PodScheduled=False`
  reason `Unschedulable`; pod condition `DisruptionTarget=True`; pod
  `status.reason` (`Evicted`); `function` container `state.waiting.reason`
  (`ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`);
  `state.terminated.reason` (`OOMKilled`, `Error`); Job condition
  `Failed=True` reason (`DeadlineExceeded`). Message from the same source.
- `exitCode`: `function` container `state.terminated.exitCode` once
  terminated; null before.
- `observedAt`: now.

Find the container by `name === 'function'` in `status.containerStatuses`;
never index `[0]`.

Change rule (SPEC.md:858-860, invariant 19): compare the new object with
the run's stored `jobStatus` field by field excluding `observedAt`
(`node:util` `isDeepStrictEqual` on copies with `observedAt` removed). Call
`setJobStatus` only on change; `setJobStatus` applies the same comparison
inside its compare-and-set, so a replayed or reconciled event costs one
read and no write (PLAN.md:517-518 "reconcile tick with no change: no
write"). `setJobStatus` is accepted in `scheduled`, `running` and
`cancelling` (SPEC.md:511). Do not mutate the cached object; copy fields
out (serving `revision/reconciler.go:236-237`). Do not rely on `kind` or
`apiVersion` being present on informer objects (serving
`controller.go:143-148`).

## State mapping (SPEC.md:861-863)

| Observation | Transition |
|---|---|
| pod phase `Running` | `scheduled -> running` (sets `startTime`) |
| Job condition `Complete=True` | `running -> succeeded`; from `scheduled` when `running` was never observed |
| Job condition `Failed=True` | `scheduled`/`running -> failed` with `failureReason` from failure-matrix.md |
| no condition, pod `Pending` with a reason | `setJobStatus` only; state unchanged |

A run read as `queued` with a cached Job (Job created, `markScheduled` not
yet run) is left alone: step 4 replays the handler right after
`markScheduled` (SPEC.md:824-826). A run read as `cancelling` gets
`setJobStatus` only; step 5 owns it.

## Terminal path order (SPEC.md:863-875, PLAN.md:509-514)

1. Read the run. Already terminal: no writes; delete the Secret and the
   Job (background), 404 is success, done (SPEC.md:870-872).
2. Object check (P6.2): only when object storage is configured, the Job
   condition is `Complete`, and `run.result` is null. `exists(runs/<id>/
   result.json)` -> carry `result_ref = s3://<bucket>/runs/<id>/result.json`
   in the patch. Not found -> no `result_ref`. Any other error -> stop
   here, no transition, no delete; the next event or the reconcile tick
   retries (SPEC.md:872-873). The run never carries both `result` and
   `result_ref` (SPEC.md:647-649).
3. `transition(id, from, to, failureReason | null, { jobStatus, error,
   logTail, startTime? , resultRef? })`. `startTime` only when missing:
   from the `function` container `terminated.startedAt`, else the Job
   `status.startTime` (SPEC.md:359-362). `error` is written as
   `coalesce(error, patch.error)` by the store. The delivery row is
   inserted in the same transaction (SPEC.md:348-351). `false` -> re-read;
   terminal now -> step 1's cleanup; not terminal -> log at debug, stop.
4. Delete the Secret (404 ok).
5. Delete the Job with `propagationPolicy: 'Background'` (404 ok); pods are
   GC'd asynchronously. The log tail was fetched before this point
   (failure-matrix.md). Pass the policy explicitly: the REST default for
   Jobs orphans pods (node-stack-facts.md:252-262).
6. Publish `krun_runs_transitions_total`, `krun_runs_failed_total`,
   `krun_run_duration_seconds`, `krun_terminal_detect_seconds`.

The Job delete call must be observed after the CAS in the P4.4 test
(PLAN.md:521-522), and the delivery payload must carry `resultUri`.

Foreground vs background per path:

| Path | Job delete |
|---|---|
| terminal (informer) | Background: the state is already recorded |
| heartbeat | Foreground, before the CAS: the pod must be gone before the run is `failed` (SPEC.md:907-908) |
| cancelling | Foreground (SPEC.md:836) |
| `markScheduled` false, `expireQueued` with token | Foreground (SPEC.md:812-814, 823-824) |
| `job_lost` | none, the Job is absent; Secret only |

## Heartbeat loop (SPEC.md:900-913, PLAN.md:556-567)

Every 10 s after both initial lists. For each cached Function with
`heartbeatTimeout` (parsed duration): `listStale(fn, now -
heartbeatTimeout)`. For each stale run: skip when the cached Job has
`Complete` or `Failed`, or the cached pod is missing or not `Running` (the
informer path owns those, D33). Otherwise, in order: fetch the log tail;
delete the Job foreground; `transition(id, 'running', 'failed',
'heartbeat_timeout', { error: { source: 'krun', message: 'no status for
<timeout>, last at <time>' }, logTail })`; delete the Secret. Functions
without `heartbeatTimeout` are never judged (SPEC.md:911-913). Metric
`krun_runs_failed_total{reason="heartbeat_timeout"}`; alert
`KrunHeartbeatTimeouts` reads it (docs/OPERATIONS.md:74).

## Cache hygiene

client-node keeps the full object graph. Copy only the fields the handler
needs into leader-local maps (`podName`, `phase`, conditions, the
`function` container status, `deletionTimestamp`, Job conditions,
`status.startTime`) and never hold a cached object past the handler (keda
`pkg/util/cache_transform.go:24-65`, dapr `pkg/operator/cache/cache.go:18-36`).
Do not strip `status.containerStatuses`: `OOMKilled` and `ImagePullBackOff`
live there.
