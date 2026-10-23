# Job and Pod informers, jobStatus, terminal path (SPEC.md:847-875)

Serves PLAN P4.4 (PLAN.md:523-542), P4.5 reconcile part (PLAN.md:543-551),
P6.2 object check (PLAN.md:662-667). `@kubernetes/client-node` facts: 2.0.1,
docs/research/node-stack-facts.md section 2, VERIFIED unless marked. Line
numbers verified on 2026-10-23.

## Construction

```ts
const sel = 'krun.io/run-id';
const jobs = makeInformer(kc, `/apis/batch/v1/namespaces/${ns}/jobs`,
  () => batch.listNamespacedJob({ namespace: ns, labelSelector: sel }), sel);
const pods = makeInformer(kc, `/api/v1/namespaces/${ns}/pods`,
  () => core.listNamespacedPod({ namespace: ns, labelSelector: sel }), sel);
```

- Pass the label selector twice. `makeInformer`'s 4th argument only reaches
  the watch URL; without it in `listFn` the initial list pulls every Job in
  the namespace (docs/research/node-stack-facts.md:363-370). Filter
  server-side, never a cluster-wide watch filtered in the handler (serving
  `filtered_factory.go:61-63`; keda `cmd/operator/main.go:216-220`).
- Jobs namespace only (SPEC.md:847-848). The Function informer is separate
  (`krun-functions-crd`).
- No `fieldSelector` argument on `makeInformer`; not needed.
- The pod template carries the same `krun.io/run-id` label, so the Pod
  informer sees the pod (job-manifest.md; keda `scale_jobs.go:170`).
- Associate pod to run by the `krun.io/run-id` label; not by owner
  references, not by name parsing (keda.md section 1.4).
- Build both informers in the leader scope through the `Kube` service
  (`Effect.acquireRelease`: `makeInformer` + listeners + `start()` on
  acquire, `stop()` on release). Expose each as a `Stream` of `add` /
  `update` / `delete` events (docs/STACK.md 4.3), built from listener
  callbacks with Effect's push-stream constructor (`Stream.async` in
  Effect 3; check `MIGRATION.md` for the Effect 4 name).
- One consumer fiber per stream runs the handler, so one informer's events
  are handled in order. The cache stays the informer's own (`get`, `list`).

## Initial list and readiness

`start()` emits `connect`, runs the full LIST, diffs the cache (emitting
`add`/`update`/`delete`), stores the list `resourceVersion`, then opens the
watch (docs/research/node-stack-facts.md:374-378).

- Wrap your `listFn` so its first resolved promise completes a
  `Deferred<void>` ("initial list processed"; one per informer, leader
  scope).
- A fiber awaiting both deferreds then, in order: runs the handler over
  `informer.list()` once (the "once after sync" reconcile,
  SPEC.md:849-850); logs the count of `scheduled`/`running` runs with no Job
  (SPEC.md:916-917); starts the heartbeat loop, the `job_lost` check and the
  5-minute timer (SPEC.md:779-781, D33 SPEC.md:1474).
- Nothing writes before both lists are in: a controller that creates
  children before its cache is warm duplicates them (serving
  `controller.go:714-725`).
- Initial-list `add` events are not "new run" events. The handler is
  idempotent and derives everything from the cached object (dapr
  `pkg/operator/api/informer/informer.go:115-127`).

## Error handling and restart (SPEC.md:851-852, PLAN.md:524)

| Watch outcome | client-node 2.0.1 behaviour | krun |
|---|---|---|
| 30 s inactivity `TimeoutError` | reconnects from the last RV, delay 0 | normal; log at debug at most, never as an error (docs/research/node-stack-facts.md:347-360) |
| clean server close | reconnects with backoff 1 s -> 30 s | nothing to do |
| 410 Gone | clears RV, next cycle re-LISTs | nothing to do; the re-LIST diff emits deletes for vanished Jobs |
| any other error (list 403/404/5xx, network) | emits `error` and STOPS for good | the `error` listener signals a restart fiber in the leader scope, which calls `informer.start()` again after backoff `min(2^n, 30) s` (`Schedule.exponential` capped at 30 s; check `MIGRATION.md` for the capping combinator), reset `n` on `connect` (docs/research/node-stack-facts.md:390-397); never a bare `setTimeout` |
| `stop()` | aborts the watch, no auto-restart | used on leader loss and SIGTERM |

- Without an `error` handler the informer stops silently and the scheduler
  never sees another event (SPEC.md:851-852). Register `on('error')` before
  `start()`.
- Bound the restart loop: after 60 s of continuous failure, log at error.
  Standby readiness is unaffected: only the leader runs these informers.
- The restart delay is an Effect `Schedule`, so `TestClock.adjust` drives
  it. client-node's own watch reconnect delay is a real timer: unit tests
  construct `new ListWatch(path, fakeWatch, listFn, false, sel,
  undefined, { delayFn })` with an immediate `delayFn`
  (docs/research/node-stack-facts.md:408-411).

## No resync: the 5-minute reconcile (SPEC.md:848-851, D33)

client-node has no resync; `update` fires only when `resourceVersion`
changes (docs/research/node-stack-facts.md:382-386, 398-401).

- On the leader: `reconcileOnce.pipe(Effect.repeat(
  Schedule.spaced("5 minutes")))`: `repeat` runs the effect once before the
  first delay, which is the "once after sync" pass.
- Each pass: iterate `jobs.list(ns)`; for each Job find the pod by label in
  `pods.list(ns)`; run the same handler. No API call. Writes only on
  change. Also run the step 6 `job_lost` check (main-loop.md).
- `Effect.yieldNow()` between runs, so a live event is not delayed behind
  the pass. Skip a run id currently inside the handler (a
  `Ref<Set<runId>>` shared with the event consumers) (serving two-lane
  queue, `two_lane_queue.go:26-74`).
- This tick is what retries an object-store error (SPEC.md:872-873) and
  what fires `job_lost`. Without it neither happens (D33).

## jobStatus derivation (SPEC.md:852-860)

```ts
type JobStatus = {
  podName: string | null; phase: string | null;
  reason: string | null;  message: string | null;
  exitCode: number | null; observedAt: string;   // ISO, JSON key observedAt (SPEC.md:263)
};
```

Inputs: cached Job and cached pod with the same `krun.io/run-id` (newest by
`creationTimestamp` when two exist; `backoffLimit: 0` makes that rare).

| Field | Source |
|---|---|
| `podName` | pod `metadata.name` |
| `phase` | pod `status.phase` |
| `reason`/`message` | first match: pod condition `PodScheduled=False` reason `Unschedulable`; pod condition `DisruptionTarget=True`; pod `status.reason` (`Evicted`); `function` container `state.waiting.reason` (`ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`); `state.terminated.reason` (`OOMKilled`, `Error`); Job condition `Failed=True` reason (`DeadlineExceeded`). Message from the same source |
| `exitCode` | `function` container `state.terminated.exitCode` once terminated; null before |
| `observedAt` | `DateTime.now` rendered with `DateTime.formatIso` (RFC 3339 UTC, milliseconds; docs/STACK.md 4.4), never `new Date()` |

Find the container by `name === 'function'` in `status.containerStatuses`;
never index `[0]`.

Change rule (SPEC.md:858-860, invariant 19):

- Compare the new object with the run's stored `jobStatus` field by field,
  excluding `observedAt` (`node:util` `isDeepStrictEqual` on copies with
  `observedAt` removed). Call `setJobStatus` only on change.
- `setJobStatus` applies the same comparison inside its compare-and-set: a
  replayed or reconciled event costs one read and no write (PLAN.md:537-538
  "reconcile tick with no change: no write").
- `setJobStatus` is accepted in `scheduled`, `running` and `cancelling`
  (SPEC.md:511).
- Do not mutate the cached object; copy fields out (serving
  `revision/reconciler.go:236-237`). Do not rely on `kind` or `apiVersion`
  on informer objects (serving `controller.go:143-148`).

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

## Terminal path order (SPEC.md:863-875, PLAN.md:529-534)

1. Read the run. Already terminal: no writes; delete Secret and Job
   (background), 404 is success, done (SPEC.md:870-872).
2. Object check (P6.2): only when object storage is configured, the Job
   completed (condition `Complete`) and `run.result` is null. Never for a
   `Failed` Job. `exists(runs/<id>/
   result.json)` found: carry `result_ref = s3://<bucket>/runs/<id>/result.json`
   in the patch. Not found: no `result_ref`. Any other error: stop here, no
   transition, no delete; the next event or reconcile tick retries
   (SPEC.md:872-873). `ObjectStoreError` is a tagged failure; the handler
   catches it by tag, logs and returns. A run never carries both `result`
   and `result_ref` (SPEC.md:647-649).
3. `transition(id, from, to, failureReason | null, { jobStatus, error,
   logTail, startTime? , resultRef? })`. `startTime` only when missing:
   `function` container `terminated.startedAt`, else Job
   `status.startTime` (SPEC.md:359-362). The store writes `error` as
   `coalesce(error, patch.error)` and inserts the delivery row in the same
   transaction (SPEC.md:348-351). `false`: re-read. Terminal now: step 1's
   cleanup. Not terminal: log at debug, stop.
4. Delete the Secret (404 ok).
5. Delete the Job with `propagationPolicy: 'Background'` (404 ok); pods are
   GC'd asynchronously. The log tail was fetched before this point
   (failure-matrix.md). Pass the policy explicitly: the REST default for
   Jobs orphans pods (docs/research/node-stack-facts.md:252-262).
6. Publish `krun_runs_transitions_total`, `krun_runs_failed_total`,
   `krun_run_duration_seconds`, `krun_terminal_detect_seconds`.

The P4.4 test must observe the Job delete call after the CAS
(PLAN.md:541-542), and the delivery payload must carry `resultUri`.

Job delete propagation per path:

| Path | Job delete |
|---|---|
| terminal (informer) | Background: the state is already recorded |
| heartbeat | Foreground, before the CAS: the pod must be gone before the run is `failed` (SPEC.md:907-908) |
| cancelling | Foreground (SPEC.md:836) |
| `markScheduled` false, `expireQueued` with token | Foreground (SPEC.md:812-814, 823-824) |
| `job_lost` | none, the Job is absent; Secret only |

## Heartbeat loop (SPEC.md:900-913, PLAN.md:576-587)

Every 10 s after both initial lists: `Effect.repeat` with
`Schedule.spaced("10 seconds")`, forked in the leader scope after the two
`Deferred`s complete.

1. For each cached Function with `heartbeatTimeout` (parsed into a
   `Duration` by the Zod duration refinement): `listStale(fn,
   now - heartbeatTimeout)`, `now` from `DateTime.now` (`DateTime.subtractDuration`).
2. Skip a stale run when the cached Job has `Complete` or `Failed`, or the
   cached pod is missing or not `Running`. The informer path owns those
   (D33).
3. Otherwise, in order: fetch the log tail; delete the Job foreground;
   `transition(id, 'running', 'failed',
   'heartbeat_timeout', { error: { source: 'krun', message: 'no status for
   <timeout>, last at <time>' }, logTail })` with `<time>` rendered by
   `DateTime.formatIso`; delete the Secret.

Functions without `heartbeatTimeout` are never judged (SPEC.md:911-913).
Metric `krun_runs_failed_total{reason="heartbeat_timeout"}`; alert
`KrunHeartbeatTimeouts` reads it (docs/OPERATIONS.md:74).

## Cache hygiene

client-node keeps the full object graph. Copy only the fields the handler
needs into leader-local maps (`podName`, `phase`, conditions, the
`function` container status, `deletionTimestamp`, Job conditions,
`status.startTime`). Never hold a cached object past the handler (keda
`pkg/util/cache_transform.go:24-65`, dapr
`pkg/operator/cache/cache.go:18-36`). Do not strip
`status.containerStatuses`: `OOMKilled` and `ImagePullBackOff` live there.
