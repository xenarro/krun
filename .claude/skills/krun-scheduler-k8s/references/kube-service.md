# Kube service, client-node facts, leader metrics

Serves PLAN P4.3a (PLAN.md:497-504) and the leader-metric part of P4.3b,
P4.4. Rules 5-8 and 26 in SKILL.md summarise this file.

## API plumbing (P4.3a)

| Piece | Rule |
|---|---|
| service | `Kube` is a `Context.Service` wrapping `BatchV1Api`, `CoreV1Api`, `CoordinationV1Api`, `CustomObjectsApi`. Every method returns an `Effect` failing with `KubeApiError`. Tests swap it with a stub layer |
| limiter | one `Semaphore` of `KRUN_K8S_CONCURRENCY` permits around every client call (docs/STACK.md 2.4). Test: at most 8 in flight |
| span | `Effect.withSpan` around permit wait, call and timeout, so a queued call shows its wait. Record error tag and status on the span. Check @effect/opentelemetry docs for how Effect 4 sets span status from a failure |
| timeout | `Effect.timeout("10 seconds")` per call. The `Effect.tryPromise` `try` receives an `AbortSignal` that fires on interruption; pass it per call through a middleware calling `ctx.setSignal(signal)` (docs/research/node-stack-facts.md:314-345). A timeout is transient |
| classification | `catch` maps `ApiException` to `KubeApiError { status: code, reason: body.reason, message: body.message, retryAfter: headers['retry-after'] }`. Any other rejection is `KubeApiError` with no status (network, transient) |
| 403 split | `reason === 'Forbidden'` with a quota message (`exceeded quota`): transient + `krun_quota_rejections_total{function}`. RBAC 403: permanent |
| backoff | per-function `Ref<Map<fn, { n, until: DateTime.Utc }>>`, `min(2 ** n, 60)` s from `Clock`, reset on success (serving `controller.go:535-567`) |
| global cap | semaphore plus 429 pause = global token bucket above per-function backoff (serving `revision/controller.go:123-127`) |
| budget | a per-call failure continues the batch; an exhausted 10 s iteration deadline ends it (keda `scale_jobs.go:136-162`) |
| retries in place | only where SPEC asks (informer restart, Lease retry): `Effect.retry` with `Schedule.exponential` and `Schedule.recurs`, or `Schedule.spaced("2 seconds")` for the Lease |

`Effect.timeout` interrupts; it does not undo. A timed-out create may
still reach the API server: deterministic names and `AlreadyExists` =
success cover it. A timed-out store write may still commit: the CAS makes
the retry harmless.

## Leader metrics (SPEC.md:1134-1147)

| Metric | Computed from |
|---|---|
| `krun_runs_current{function,state}` | step 1 `countByState` result, each iteration |
| `krun_queue_wait_seconds{function}` | `createTime` to `scheduleTime`, at `markScheduled` true |
| `krun_cold_start_seconds{function}` | `scheduleTime` to `startTime`, at the `running` CAS |
| `krun_run_duration_seconds{function,state}` | `startTime` to `endTime`, at the terminal CAS |
| `krun_terminal_detect_seconds{function}` | container `terminated.finishedAt` to terminal CAS (CAS time from `Clock`) |
| `krun_scheduler_leader` | 1 while leading, 0 otherwise, on every replica |

Effect `Metric`s, exported by the OpenTelemetry Prometheus exporter on the
admin listener (SPEC.md:1139-1147, docs/STACK.md 2.6, D36). Choose
instrument names so the exporter's `_total` and unit suffixes yield exactly
these names. P4.6 (`krun-process-runtime`) asserts them on `/metrics`.
Histogram labels: `function` (and `state`) only. Alert rules reading them
are fixed in SPEC section 13 (`krun-helm-chart`).

## Library facts (`@kubernetes/client-node` 2.0.1, docs/research/node-stack-facts.md)

- ESM only, undici-backed. krun runs it on Node 26 (D15); the P4.3a spike
  confirms these facts on Node 26. `setDefaultAuthentication` does not
  exist (VERIFIED). A new undici Agent per request, no dispatcher cache
  (VERIFIED by absence): the 8-permit semaphore also bounds sockets.
- Object-parameter API (VERIFIED signatures):
  `batch.createNamespacedJob({ namespace, body })`;
  `deleteNamespacedJob({ name, namespace, propagationPolicy: 'Foreground'
  | 'Background' })` ("default is Orphan" UNVERIFIED: always pass it);
  `core.readNamespacedPodLog({ name, namespace, container, tailLines: 100,
  limitBytes: 16384 })` returns a string;
  `coordination.readNamespacedLease` / `replaceNamespacedLease` with
  `body.metadata.resourceVersion` for 409.
- Non-2xx is `ApiException { code, body, headers }`. Network errors are not
  `ApiException`. `Retry-After` from `err.headers['retry-after']`
  (VERIFIED types; undici error shapes UNVERIFIED).
- Per-call abort: 2.0.1 has no `setRequestTimeoutOptions`. A middleware
  calling `ctx.setSignal(signal)` with the signal `Effect.tryPromise` passes
  to `try` works (`RequestContext.setSignal` VERIFIED). Whether the Object
  API's `ConfigurationOptions` is the promise or observable flavour is
  UNVERIFIED: budget a spike. The 10 s bound is `Effect.timeout`, not
  `AbortSignal.timeout`.
- Informers (all VERIFIED from `dist/informer.js`, `dist/cache.js`): no
  resync; no `fieldSelector` on `makeInformer`; selector must also be in
  `listFn`; `error` stops the informer for good; `TimeoutError` after 30 s
  inactivity is normal; `update` only on `resourceVersion` change; 410
  re-lists; cache `get(name, ns)` / `list(ns)`. The internal watch
  reconnect delay is a real timer that `TestClock` does not move: unit
  tests inject a fake `ListWatch` (`informers.md`).
- Patch calls default to `application/json-patch+json`. The status writer
  (P4.7) needs `setHeaderOptions('Content-Type', PatchStrategy.MergePatch)`
  (VERIFIED). Jobs and Secrets here use no patch calls.
- Tests: `@effect/vitest` `it.effect` (already scoped), `layer(...)` for
  shared stubs, the `Kube` stub as a layer, `TestClock.adjust` for time.
  Fork the program under test first, then adjust: a fiber sleeping on
  `Schedule.spaced` wakes only when the test clock passes its deadline. No
  real sleeps, no Vitest fake timers.
- `@types/node ^26` arrives as a runtime dependency of client-node and
  matches Node 26; no override expected (UNVERIFIED until the first
  install).
- `V1PodSpec.hostUsers` is an optional boolean; set it only when false
  (rule 27). Failure modes are UNVERIFIED and outside scheduler control:
  with the feature gate off, the API server may drop the field silently; on
  a node lacking ID-mapped mounts the pod fails to start. Either way normal
  pod-signal rules classify the run (`failure-matrix.md`), not
  `job_create_failed`. The operator opts in only when every node supports
  it (docs/OPERATIONS.md, Security operations).
- SPEC RISK (client-node abort middleware): the promise-vs-observable
  `ConfigurationOptions` shape is UNVERIFIED
  (docs/research/node-stack-facts.md:338-343). If the spike fails, write
  BLOCKED P4.3a. Never let `Effect.timeout` abandon a request that keeps
  running on the socket.

## Lessons from KEDA, Knative Serving, Dapr

Each line: lesson; krun rule (source).

- Job status counters mislead; terminal only on `Complete`/`Failed` = True,
  never `status.active/succeeded/failed` (keda
  `scale_jobs.go:231-238,438-445`).
- List error coerced to zero over-creates; unsynced cache = unknown count,
  skip, never zero; krun gates on both initial lists (keda
  `scale_jobs.go:251-253,334-336`).
- `generateName` cannot retry safely; deterministic names,
  `409 AlreadyExists` = success (keda `scale_jobs.go:166,205`).
- Parent owner reference GCs in-flight runs on Function re-apply; no owner
  reference (keda `scale_jobs.go:220-224` does the opposite;
  SPEC.md:571-572).
- client-node has no transform hook; strip `managedFields`, copy read
  fields into own maps (keda `pkg/util/cache_transform.go:24-65`, dapr
  `pkg/operator/cache/cache.go:18-36`).
- Lease expiry on local observation time (serving
  `leaderelection.go:380-388`); full pass over caches on promotion (serving
  `revision/controller.go:66-92`); informers sync before any loop (serving
  `controller.go:714-725`).
- Classify transient / permanent / requeue-after, reset backoff on success,
  global bucket above per-item backoff (serving `controller.go:535-567`,
  `revision/controller.go:123-127`).
- Failure evidence: unschedulable > terminated > waiting reason; waiting
  reason final only after a deadline, krun's is `activeDeadlineSeconds`
  (serving `reconcile_resources.go:103-131`).
- Never adopt a stranger's object on `AlreadyExists` (serving
  `reconcile_resources.go:75-79`); see SPEC RISK (`AlreadyExists` adoption) in SKILL.md Pitfalls.
- Blocked leadership path made Dapr's cron exit silently; renew on its own
  fiber, never behind loop effects (dapr `cron.go:180-195`). Shutdown:
  readiness first, bounded drain, forced stop, release (dapr
  `server.go:336-366`).
