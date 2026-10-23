---
name: krun-scheduler-k8s
description: Use when building the krun scheduler or Job lifecycle. Lease, main loop, informers, Job manifest (hostUsers), Kube call spans, jobStatus, failure detection, heartbeat, sweep.
---

# krun scheduler and Kubernetes Job lifecycle

Covers SPEC.md section 7 (Job contract) and section 8 (Scheduler) for
`apps/scheduler`: leader election, API plumbing, Job and Secret builders,
the main loop, Job and Pod informers, `jobStatus`, the terminal path,
failure detection, heartbeat, `job_lost`, cancelling, sweep, leader metrics
and shutdown. PLAN tasks P4.1-P4.5, P4.8-P4.11 and P6.2. P4.6 metrics and
P4.7 status writer belong to `krun-process-runtime` and `krun-functions-crd`.
The scheduler is an Effect 4 program (SPEC D35, docs/STACK.md): every rule
below names the Effect construct docs/STACK.md section 4.3 maps it to.

## When to use

- Any task id P4.1, P4.2, P4.3a/b/c, P4.4, P4.5, P4.8, P4.9, P4.10, P4.11,
  P6.2, or a review of one of them.
- Touching `apps/scheduler/src/k8s`, the `Kube` service, the Lease layer,
  `makeInformer` use, `setJobStatus`, `transition` calls from the scheduler,
  `pods/log`.
- Load `krun-store` next to this skill for the Store methods the loops call
  (SPEC.md:492-520) and `krun-process-runtime` for the admin listener,
  `/readyz` and the `NodeRuntime.runMain` shutdown wiring.
- Load the docs/STACK.md section 5 skills for this area before coding:
  `effect-core-patterns`, `effect-concurrency`, `effect-resource-management`,
  `effect-error-handling`, `effect-dependency-injection`, `effect-testing`,
  `kubernetes-operator` (vocabulary only), `kubernetes-skill`. Effect's
  `MIGRATION.md` overrides any skill text written for Effect 3: use
  `Context.Service` (not `Context.Tag`) and `Context.Reference` (not
  `FiberRef`); Effect 4 has no `Runtime<R>` (CLAUDE.md rule 7).

## Read first

- SPEC.md:564-656 Job contract; SPEC.md:774-932 Scheduler; SPEC.md:320-381
  lifecycle table and rules; SPEC.md:1034-1039 RBAC; SPEC.md:1098-1123
  backpressure constants; SPEC.md:1125-1174 metrics, logs, readiness,
  shutdown; SPEC.md:1139-1152 telemetry (spans on iterations and
  Kubernetes calls); SPEC.md:1022-1027 and 1236 user namespaces
  (`KRUN_JOB_HOST_USERS`); D18, D19, D23, D27, D28, D33, D35, D36
  (section 15). Kubernetes 1.33 is the minimum (SPEC section 14).
- docs/STACK.md section 2.4 (`Kube` service rules), 2.6 (OpenTelemetry
  packages), 4.1 (process shape), 4.2 (tagged errors), 4.3 (SPEC rule to
  Effect construct, including spans), 4.4 (time).
- PLAN.md:467-481 phase 4 gate; PLAN.md:483-551 P4.1-P4.5; PLAN.md:562-599
  P4.8-P4.11; PLAN.md:662-667 P6.2; PLAN.md:36-91 dependencies and the
  in-house list.
- references in this skill: `references/job-manifest.md` (Secret and Job
  YAML verbatim, env order, builder rules, golden test),
  `references/main-loop.md` (steps 1-6 verbatim, loop fiber shape, step 4
  checklist, cancelling, `job_lost`, acceptance list), `references/lease.md`
  (Lease contract, state machine, leader scope, RBAC, SIGTERM finalizer
  order, P4.2 test table), `references/informers.md` (client-node informer
  facts, informer `Stream`s, restart, 5-minute reconcile, `jobStatus`
  derivation, terminal path order, heartbeat),
  `references/failure-matrix.md` (Kubernetes signal -> `jobStatus` ->
  `failureReason` -> `error.source` -> `logTail` -> metric).

## Rules

1. Only the leader runs loops, Job/Pod informers and the status writer;
   the Function informer runs on every replica (SPEC.md:776-779) because
   readiness depends on it. Leader-only fibers are forked into the leader
   scope, never into the process scope.
2. Lease: `get` then `update` with the read `resourceVersion`; 409 or a
   changed `holderIdentity` fails the attempt, retry in 2 s
   (SPEC.md:786-788) because the read-replace pair is the optimistic lock.
3. Judge Lease expiry 15 s after the candidate last saw `holderIdentity`
   or `renewTime` change on its own clock (`Clock.currentTimeMillis`),
   never `now - renewTime` (SPEC.md:788-790) because clock skew would elect
   two leaders.
4. A leader with no successful renew for 10 s stops loops and informers,
   cancels in-flight calls and exits non-zero (SPEC.md:790-792): the renew
   fiber closes the leader scope (interrupting loops, informers, the status
   writer and every in-flight `Kube` call) and fails with a tagged
   `LeaderLost`, so `NodeRuntime.runMain` exits non-zero. Knative demotes
   and re-acquires instead (serving `leaderelection.go:279-312`); SPEC chose
   exit so leader-local state never leaks across terms.
5. One scheduler-wide `Semaphore` of `KRUN_K8S_CONCURRENCY` (8) permits and
   a 10 s `Effect.timeout` around every API call, both inside the `Kube`
   service (SPEC.md:794-796, docs/STACK.md 2.4 and 4.3) because a stalled
   API server must not hold the loop open. The timeout interrupts the
   `Effect.tryPromise` fiber; the `AbortSignal` that `tryPromise` hands to
   `try` must reach the request so the socket is really torn down.
6. Classify by `KubeApiError.status`: 403 quota, 429, 5xx, network or
   timeout -> transient (release lease, back off the function `2^n` s
   capped 60, count `krun_job_create_errors_total`); any other 4xx ->
   permanent `job_create_failed` with `error.source krun`, `details { code,
   reason }` (SPEC.md:827-835, D23) because admission rejections must
   surface in seconds and blips must not fail runs. The classifier is a
   pure function of the tag and status (docs/STACK.md 4.2).
7. 429 in the main loop releases unscheduled claims, pauses the loop fiber
   for `Retry-After` (default 1 s, cap 60) with `Effect.sleep` and logs at
   warn (SPEC.md:796-798).
8. Every Secret or Job delete treats 404 as success (SPEC.md:798-799)
   because retries and TTL races are normal.
9. Step 4 order per run: Secret (`AlreadyExists` reads the token) ->
   `setJobToken` -> Job (`AlreadyExists` is success) -> `markScheduled`;
   false deletes Job (foreground) and Secret, true replays the handler on
   the cached Job and pod with no API call (SPEC.md:820-826, D27) because
   the token hash must exist before the pod can call the gateway.
10. Iterations never overlap: one loop fiber takes from a sliding `Queue`
    of capacity 1 fed by the 1 s `Schedule.spaced` ticker and by `state`
    notifies, so a `state` notify during an iteration marks exactly one
    more; `status` and `job_status` notifies are ignored. The 10 s deadline
    is `Effect.timeout` on the iteration, and the leases of unprocessed
    claims are released in `Effect.ensuring` (SPEC.md:801-806,
    docs/STACK.md 4.3).
11. Pass the `krun.io/run-id` label selector to `makeInformer` and inside
    the `listFn`; register `on('error')` that restarts with backoff before
    `start()` (SPEC.md:847-852, docs/research/node-stack-facts.md:363-397) because the
    informer stops for good on any error and the selector only reaches the
    watch URL. Each informer is exposed as a `Stream` of events built in
    the leader scope (`start()` on acquire, `stop()` on release).
12. No resync exists: the leader reconcile runs the handlers over the
    caches once after sync and then every 5 minutes (`Effect.repeat` with
    `Schedule.spaced("5 minutes")`), writes only on change, and runs the
    step 6 check (SPEC.md:848-851, D33).
13. `jobStatus` change = deep inequality of every field except
    `observedAt`; call `setJobStatus` only on change (SPEC.md:858-860)
    because a replayed event must cost no write.
14. State comes from Kubernetes only: pod `Running` -> `running`,
    `Complete` -> `succeeded` (from `running` or `scheduled`), `Failed` ->
    `failed`; never from the function's reports (SPEC.md:861-863,
    SPEC.md:377-378, D18).
15. Terminal order: already-terminal check -> object check (only when the
    Job completed and `result` is null, carry `result_ref`) -> CAS with
    final `jobStatus`, `failureReason`, `error`, `logTail`, `startTime`
    when missing -> delete Secret -> delete Job background
    (SPEC.md:863-872, D28) so the state is recorded before the Job can
    vanish.
16. An object store error other than not-found leaves the run
    untransitioned; the next event or reconcile tick retries
    (SPEC.md:872-873).
17. `failureReason` precedence `oom_killed > deadline_exceeded > evicted >
    disrupted > exit_code` (SPEC.md:379-381); `error` precedence function
    report > Kubernetes reason > krun, enforced by the store's
    `coalesce(error, patch.error)` (SPEC.md:367-373).
18. Fetch the log tail (100 lines, 16 KB, 10 s `Effect.timeout`) on the
    first pod event with a non-zero exit, `OOMKilled` or
    `deletionTimestamp`; never on exit 0; always before any delete
    (SPEC.md:890-899).
19. Heartbeat and `job_lost` start only after both informers' initial list
    (a `Deferred` each, awaited together) and skip runs whose cached Job is
    terminal or whose pod is missing or not `Running` (SPEC.md:779-781,
    904-906, D33) because otherwise a completed run is killed as
    `heartbeat_timeout` at startup.
20. Heartbeat order: log fetch -> Job delete foreground -> CAS `running ->
    failed heartbeat_timeout` -> Secret delete (SPEC.md:906-911).
21. `job_lost` after 2 minutes absent from the cache, leader-local
    first-absent map (times from `Clock`), keep `result`, Secret delete
    only (SPEC.md:838-845, SPEC.md:1123).
22. Cancelling: Job delete foreground -> Secret delete -> `cancelled`
    (SPEC.md:836-837); the Job may not exist.
23. Sweep every 10 minutes (`Schedule.spaced`): `sweep(now -
    KRUN_RETENTION, 1000)` until a batch is short, then delete
    `krun.io/run-id` Secrets older than 1 hour with no matching Job;
    `krun_sweep_deleted_total` (SPEC.md:930-932).
24. Never log the token, the Job manifest, env lists (presigned URL),
    input, result, `error.details` (SPEC.md:1087-1089, 1149-1154).
25. SIGTERM: `/readyz` 503 -> stop claiming, bound the iteration -> stop
    informers -> clear `holderIdentity` -> close the pool -> exit 0
    (SPEC.md:1170-1174). This order is the reverse acquisition order of
    scope finalizers under `NodeRuntime.runMain`; no signal handler of
    our own (`references/lease.md`).
26. Every `Kube` method body is wrapped in `Effect.withSpan` inside the
    service (span name `kube.<verb> <resource>`, for example `kube.create
    jobs`), and every main-loop iteration, reconcile pass, heartbeat pass
    and sweep is a span too (SPEC.md:1145-1152, docs/STACK.md 4.3). Span
    attributes: namespace, object name, function, HTTP status, and on
    every span about a run the attribute `krun.run_id`; never the
    manifest, env, token, presigned URL, input or result
    (SPEC.md:1150-1156). No `@opentelemetry/instrumentation-*` package:
    spans are written by hand where SPEC names them.
27. `hostUsers: false` goes into the Job pod template only when
    `KRUN_JOB_HOST_USERS` is `false`; otherwise the field is omitted, not
    set to `true` (SPEC.md:592, 1236), so the default golden file is
    unchanged on clusters without user namespaces.
28. Time comes from `Clock` and `DateTime` only: Lease observation times,
    renew deadline, first-absent times, staleness cut-offs, backoff
    deadlines, `observedAt`. Never `Date.now()` or `new Date()` (CLAUDE.md
    rule 8); tests drive time with `TestClock.adjust`.

## Start order and leader gating

See `references/lease.md` "Leader-gated components" for the table. In
short, as layers and scopes: process start = Config, Logger, Database,
Store, KubeConfig (`loadFromDefault`), `Kube`, Function informer, admin
listener, then the Lease layer. Acquisition opens the leader scope: Job and
Pod informers, main loop, cancelling (step 5), deliveries, sweep, status
writer, `krun_scheduler_leader` 1. Both initial lists = reconcile once,
startup log of runs with no Job, heartbeat loop, `job_lost`, 5-minute
timer. Loss closes the leader scope; SIGTERM runs the finalizers in reverse.

## API plumbing (P4.3a, PLAN.md:497-504)

| Piece | Rule |
|---|---|
| service | `Kube` is a `Context.Service` wrapping `BatchV1Api`, `CoreV1Api`, `CoordinationV1Api`, `CustomObjectsApi`; every method returns an `Effect` failing with `KubeApiError`; tests swap it with a stub layer |
| limiter | one `Semaphore` of `KRUN_K8S_CONCURRENCY` permits taken around every client call (docs/STACK.md 2.4); test: at most 8 in flight |
| span | `Effect.withSpan` around permit wait, call and timeout, so a call queued behind the semaphore shows its wait; the error tag and status are recorded on the span; check @effect/opentelemetry docs for how Effect 4 sets span status from a failure |
| timeout | `Effect.timeout("10 seconds")` per call; the `Effect.tryPromise` `try` receives an `AbortSignal` that fires on interruption, passed per call through a middleware calling `ctx.setSignal(signal)` (docs/research/node-stack-facts.md:314-345); a timeout is transient |
| classification | `catch` maps `ApiException` to `KubeApiError { status: code, reason: body.reason, message: body.message, retryAfter: headers['retry-after'] }`; any other rejection is `KubeApiError` with no status (network, transient) |
| 403 split | `reason === 'Forbidden'` with a quota message (`exceeded quota`) -> transient + `krun_quota_rejections_total{function}`; RBAC 403 -> permanent |
| backoff | per-function `Ref<Map<fn, { n, until: DateTime.Utc }>>`, `min(2 ** n, 60)` s from `Clock`, reset on success (serving `controller.go:535-567`: reset backoff on success) |
| global cap | the semaphore plus the 429 pause is the global token bucket on top of per-function backoff (serving `revision/controller.go:123-127`) |
| budget | a per-call failure continues the batch; an exhausted 10 s iteration deadline ends it (keda `scale_jobs.go:136-162`) |
| retries in place | only where SPEC asks for them (informer restart, Lease retry): `Effect.retry` with `Schedule.exponential` and `Schedule.recurs`, or `Schedule.spaced("2 seconds")` for the Lease |

Order of work: `job-manifest.md` (P4.1) -> `lease.md` (P4.2) -> the table
above (P4.3a) -> `main-loop.md` (P4.3b, P4.3c, P4.5) -> `informers.md`
(P4.4, P4.9, P6.2) -> `failure-matrix.md` (P4.8).

## Leader metrics (SPEC.md:1134-1147)

| Metric | Computed from |
|---|---|
| `krun_runs_current{function,state}` | the `countByState` result of step 1, each iteration |
| `krun_queue_wait_seconds{function}` | `createTime` -> `scheduleTime`, observed at `markScheduled` true |
| `krun_cold_start_seconds{function}` | `scheduleTime` -> `startTime`, at the `running` CAS |
| `krun_run_duration_seconds{function,state}` | `startTime` -> `endTime`, at the terminal CAS |
| `krun_terminal_detect_seconds{function}` | container `terminated.finishedAt` -> terminal CAS (CAS time from `Clock`) |
| `krun_scheduler_leader` | 1 while leading, 0 otherwise, on every replica |

Effect `Metric`s exported by the OpenTelemetry Prometheus exporter on
the admin listener (SPEC.md:1139-1147, docs/STACK.md 2.6, D36). Choose
instrument names so the exporter's `_total` and unit suffixes yield exactly the table above, and
P4.6 (owned by `krun-process-runtime`) asserts them on `/metrics`.
Histogram labels stay `function` (and `state`) only. Alert rules reading
them are fixed in SPEC section 13 (`krun-helm-chart`).

## Library facts (`@kubernetes/client-node` 2.0.1, docs/research/node-stack-facts.md)

- ESM only, undici-backed; krun runs it on Node 26 (D15), and the P4.3a
  spike confirms the facts below on Node 26; `setDefaultAuthentication`
  does not exist (VERIFIED). A new undici Agent per request, no dispatcher
  cache (VERIFIED by absence): the 8-permit semaphore also bounds sockets.
- Object-parameter API: `batch.createNamespacedJob({ namespace, body })`,
  `deleteNamespacedJob({ name, namespace, propagationPolicy: 'Foreground'
  | 'Background' })` (VERIFIED signature; "default is Orphan" UNVERIFIED,
  always pass it), `core.readNamespacedPodLog({ name, namespace,
  container, tailLines: 100, limitBytes: 16384 })` returns a string
  (VERIFIED), `coordination.readNamespacedLease` / `replaceNamespacedLease`
  with `body.metadata.resourceVersion` for 409 (VERIFIED).
- `ApiException { code, body, headers }` for non-2xx; network errors are
  not `ApiException`; `Retry-After` from `err.headers['retry-after']`
  (VERIFIED types; undici error shapes UNVERIFIED).
- Per-call abort: 2.0.1 has no `setRequestTimeoutOptions`; a middleware
  calling `ctx.setSignal(signal)` with the signal `Effect.tryPromise` passes
  to `try` works (`RequestContext.setSignal` VERIFIED; whether the Object
  API's `ConfigurationOptions` is the promise or observable flavour
  UNVERIFIED, budget a spike). The 10 s bound itself is `Effect.timeout`,
  not `AbortSignal.timeout`.
- Informers: no resync, no `fieldSelector` on `makeInformer`, selector
  must also be in `listFn`, `error` stops the informer for good,
  `TimeoutError` after 30 s inactivity is normal, `update` only on
  `resourceVersion` change, 410 re-lists, cache `get(name, ns)` /
  `list(ns)` (all VERIFIED from `dist/informer.js`, `dist/cache.js`).
  Its internal watch reconnect delay is a real timer that `TestClock` does
  not move; unit tests inject a fake `ListWatch` (`informers.md`).
- Patch calls default to `application/json-patch+json`; the status writer
  (P4.7) needs `setHeaderOptions('Content-Type', PatchStrategy.MergePatch)`
  (VERIFIED); irrelevant to Jobs and Secrets here (no patch calls).
- Tests: Vitest 5 with `@effect/vitest`: `it.effect` (already scoped),
  `layer(...)` for shared stubs, the `Kube` stub provided as a layer, time
  moved with `TestClock.adjust`. Fork the program under test first, then
  adjust: a fiber sleeping on `Schedule.spaced` wakes only when the test
  clock passes its deadline. No real sleeps, no Vitest fake timers.
- `@types/node ^26` arrives as a runtime dependency of client-node and
  matches krun's Node 26 line, so no override is expected (UNVERIFIED
  until the first install).
- `V1PodSpec.hostUsers` is an optional boolean in the client-node model;
  set it only when false (rule 27). Failure modes are UNVERIFIED and
  outside the scheduler's control: with the feature gate off, the API
  server may drop the field silently; on a node whose runtime or kernel
  lacks ID-mapped mounts the pod fails to start. Either way the run is
  classified by the normal pod-signal rules (`failure-matrix.md`), not as
  `job_create_failed`; the operator opts in only when every node
  supports it (docs/OPERATIONS.md, Security operations).

## Lessons from KEDA, Knative Serving, Dapr

- Derive terminal state from Job conditions `Complete`/`Failed` = True,
  never from `status.active/succeeded/failed` counters (keda
  `scale_jobs.go:231-238,438-445`).
- A list error coerced to zero over-creates: when a cache is not synced
  treat the count as unknown and skip, never as zero (keda
  `scale_jobs.go:251-253,334-336`); krun's gate on both initial lists is
  that rule.
- Deterministic names make create idempotent after a timeout: `409
  AlreadyExists` is success; KEDA's `generateName` cannot retry safely
  (keda `scale_jobs.go:166,205`).
- No owner reference to a parent: a Function re-apply would GC in-flight
  runs (keda `scale_jobs.go:220-224` does the opposite, deliberately
  rejected; SPEC.md:571-572).
- Strip `managedFields` and keep only the fields you read in your own
  maps; client-node has no transform hook (keda
  `pkg/util/cache_transform.go:24-65`, dapr `pkg/operator/cache/cache.go:18-36`).
- Lease expiry on the local observation time (serving
  `leaderelection.go:380-388`); promotion runs a full pass over caches
  before loops (serving `revision/controller.go:66-92`); informers wait for
  sync before any loop (serving `controller.go:714-725`).
- Classify errors transient / permanent / requeue-after and reset backoff
  on success; add a global bucket above per-item backoff (serving
  `controller.go:535-567`, `revision/controller.go:123-127`).
- Failure evidence: unschedulable > terminated > waiting reason, waiting
  reasons final only after a deadline (serving
  `reconcile_resources.go:103-131`); krun's deadline is
  `activeDeadlineSeconds`.
- Never adopt a stranger's object on `AlreadyExists` (serving
  `reconcile_resources.go:75-79`): see SPEC RISK below; SPEC counts
  `AlreadyExists` as success without a label check.
- Keep lease renew on its own fiber, never behind the loop's effects; a
  blocked leadership path once made Dapr's cron exit silently (dapr
  `cron.go:180-195`). Shutdown: readiness first, bounded drain, forced
  stop, then release (dapr `server.go:336-366`).

## Pitfalls

- `kubernetes-operator` (project skill) is Go/controller-runtime with
  workqueues, finalizers and `RequeueAfter`; krun has Effect loop fibers,
  no Kubernetes finalizers, no workqueue (PLAN.md:82-87). Use it for
  vocabulary only; SPEC wins. `kubernetes-skill` is fine for `kubectl` and
  Job/Pod semantics.
- Effect skills and examples written for Effect 3 use `Context.Tag`,
  `Runtime`, `FiberRef`, `Layer.scoped`, `Effect.fork`; Effect 4 renamed
  or removed several. Where a name here is marked "check MIGRATION.md",
  read Effect's `MIGRATION.md` before typing it.
- `Effect.timeout` interrupts; it does not undo. A timed-out create may
  still have reached the API server, which is why deterministic names and
  `AlreadyExists` = success matter. A timed-out store write may still
  commit; the CAS makes the retry harmless.
- Foreground vs background propagation differs per path (table in
  `informers.md`); mixing them either deletes pods before the log fetch or
  records `failed` while the pod still runs.
- `DisruptionTarget` is always present on the supported Kubernetes 1.33+
  (SPEC section 14); the "Failed with no terminated state" fallback rule
  still covers a pod deleted before the condition is written.
- The jobs namespace may carry the `krun-jobs-digest`
  ValidatingAdmissionPolicy (SPEC.md:1017-1021). A Job whose image lost
  its digest is then rejected with 422 or 403 by the API server: a
  permanent `job_create_failed` per rule 6, which is correct; never
  retry it as transient.
- Run correlation is by attribute, not by trace (SPEC section 11): every
  span about a run carries `krun.run_id` (the per-run step 4 span, the
  terminal-path, heartbeat and `job_lost` spans, and the `Kube` calls made
  for that run). v1 does not join a run's spans into one trace across
  processes: there is no trace column on `runs` and no trace context is
  passed to the pod (no `TRACEPARENT` env, no Job annotation). P4.6
  asserts that the create request, the iteration's per-run span and the
  Kubernetes calls share the same `krun.run_id`, not the same trace id.
- Identity is the downward-API pod name (SPEC.md:785); a StatefulSet
  restart in embedded mode reuses the name, so never trust a matching
  `holderIdentity` on the first read.
- `expireQueued` and `job_create_failed` are terminal transitions: the
  delivery row is inserted by the store, not by the scheduler
  (SPEC.md:348-351); do not insert it twice.
- The `queued`-with-token window: step 4 may be interrupted after the Job
  exists (deadline or SIGTERM); the replay after `markScheduled` true and
  the `job_lost` map cover it. Do not add a separate "orphan Job" scanner.
- Do not count or list Jobs through the API in the loop; the informer
  cache and `countByState` are the only sources (SPEC.md:815-817).
- No new dependency for any of this: Lease election, limiter, backoff are
  in house on Effect primitives (`Semaphore`, `Schedule`, scopes;
  PLAN.md:82-87); a research report suggesting `async-mutex`, `p-limit`,
  a leader-election package or `@effect/platform-node`'s unstable `Undici`
  module is not allowed without a Decisions row (PLAN.md:29-30,
  docs/STACK.md 2.1).
- SPEC RISK (`AlreadyExists` adoption): SPEC.md:822-823 counts a Job
  `AlreadyExists` as success with no ownership check; Knative refuses to
  adopt a child it does not control. A stranger's `krun-<uuid>` Job is
  practically impossible (UUIDv7 names), so implement SPEC as written; if
  an agent wants a `krun.io/run-id` label check on the 409 path, that is a
  Decisions row, not a silent change.
- SPEC RISK (manifest extras): `terminationMessagePolicy:
  FallbackToLogsOnError`, `enableServiceLinks: false`,
  `krun.io/function-generation` labels appear in Knative and KEDA (serving
  `revision_defaults.go:213-264`, keda `scaledjob_controller.go:269-328`)
  and not in SPEC.md:574-626; the golden file is exact, so add none without
  a Decisions row.
- SPEC RISK (client-node abort middleware): the promise-vs-observable
  `ConfigurationOptions` shape is UNVERIFIED (docs/research/node-stack-facts.md:338-343);
  if the spike fails, write BLOCKED P4.3a rather than letting
  `Effect.timeout` abandon a request that keeps running on the socket.

## Before marking a task done

- Run the task's acceptance test first (test written before code,
  docs/AGENT-KICKOFF.md) with `pnpm exec vitest run apps/scheduler`: P4.1
  golden file; P4.2 stubbed `CoordinationV1Api` table in `lease.md`; P4.3a
  semaphore/503/422/429; P4.3b and P4.3c the list in `main-loop.md`; P4.4,
  P4.5, P4.8, P4.9 the lists in `informers.md` and `failure-matrix.md`;
  P4.10 `TestClock` + stubbed `CoreV1Api`; P4.11 embedded mode with
  `KUBECONFIG` at `test/fake-kube`, `/readyz` 200 as standby, exit 0 within
  5 s of SIGTERM with the Lease cleared; P6.2 fake object store,
  `resultUri` in the delivery payload.
- `make check` green (CLAUDE.md:5, PLAN.md:17-18).
- Branch `p4-<n>-<slug>`, Conventional Commit with scope `scheduler`
  (PLAN.md:13-15); mark `[x]` and append the progress-log line
  `2026-10-23 P4.x <sha> note` in the same commit (PLAN.md:19-20); PR to
  main, merge when CI is green; never push main.
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7,
  PLAN.md:16).
- Phase gate after P4.13: `make e2e` on kind in embedded mode
  (PLAN.md:469-481).

## Limitations

- This skill does not cover the Function informer, Function validation or
  the status writer (`krun-functions-crd`), the deliveries loop and object
  store client (`krun-webhooks-objstore`), config parsing, `/readyz`
  plumbing and the admin listener (`krun-process-runtime`), or the chart's
  RBAC and NetworkPolicy rendering (`krun-helm-chart`).
- `test/fake-kube` and the kind e2e harness are `krun-testing-ci`.
- Line numbers were verified on 2026-10-23 against a working tree that
  another agent edits; some citations from SPEC section 9 onwards may be
  a few lines off. Re-verify before citing in a PR.
