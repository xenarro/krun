---
name: krun-scheduler-k8s
description: Use when building the krun scheduler or Job lifecycle. Lease, main loop, informers, jobStatus, failure detection, heartbeat, sweep.
---

# krun scheduler and Kubernetes Job lifecycle

Covers SPEC.md section 7 (Job contract) and section 8 (Scheduler) for
`apps/scheduler`: leader election, API plumbing, Job and Secret builders,
the main loop, Job and Pod informers, `jobStatus`, the terminal path,
failure detection, heartbeat, `job_lost`, cancelling, sweep, leader metrics
and shutdown. PLAN tasks P4.1-P4.5, P4.8-P4.11 and P6.2. P4.6 metrics and
P4.7 status writer belong to `krun-process-runtime` and `krun-functions-crd`.

## When to use

- Any task id P4.1, P4.2, P4.3a/b/c, P4.4, P4.5, P4.8, P4.9, P4.10, P4.11,
  P6.2, or a review of one of them.
- Touching `apps/scheduler/src/k8s`, the Lease loop, `makeInformer` use,
  `setJobStatus`, `transition` calls from the scheduler, `pods/log`.
- Load `krun-store` next to this skill for the Store methods the loops call
  (SPEC.md:492-520) and `krun-process-runtime` for the admin listener,
  `/readyz` and `close-with-grace` wiring.

## Read first

- SPEC.md:564-656 Job contract; SPEC.md:774-932 Scheduler; SPEC.md:320-381
  lifecycle table and rules; SPEC.md:1034-1039 RBAC; SPEC.md:1098-1123
  backpressure constants; SPEC.md:1125-1174 metrics, logs, readiness,
  shutdown; D18, D19, D23, D27, D28, D33 (SPEC.md:1459-1474).
- PLAN.md:447-461 phase 4 gate; PLAN.md:463-531 P4.1-P4.5; PLAN.md:542-579
  P4.8-P4.11; PLAN.md:642-647 P6.2; PLAN.md:36-74 dependencies and the
  in-house list.
- references in this skill: `references/job-manifest.md` (Secret and Job
  YAML verbatim, env order, builder rules, golden test),
  `references/main-loop.md` (steps 1-6 verbatim, step 4 checklist,
  cancelling, `job_lost`, acceptance list), `references/lease.md` (Lease
  contract, state machine, RBAC, SIGTERM order, P4.2 test table),
  `references/informers.md` (client-node informer facts, restart, 5-minute
  reconcile, `jobStatus` derivation, terminal path order, heartbeat),
  `references/failure-matrix.md` (Kubernetes signal -> `jobStatus` ->
  `failureReason` -> `error.source` -> `logTail` -> metric).

## Rules

1. Only the leader runs loops, Job/Pod informers and the status writer;
   the Function informer runs on every replica (SPEC.md:776-779) because
   readiness depends on it.
2. Lease: `get` then `update` with the read `resourceVersion`; 409 or a
   changed `holderIdentity` fails the attempt, retry in 2 s
   (SPEC.md:786-788) because the read-replace pair is the optimistic lock.
3. Judge Lease expiry 15 s after the candidate last saw `holderIdentity`
   or `renewTime` change on its own clock, never `now - renewTime`
   (SPEC.md:788-790) because clock skew would elect two leaders.
4. A leader with no successful renew for 10 s stops loops and informers,
   aborts in-flight calls and exits non-zero (SPEC.md:790-792); Knative
   demotes and re-acquires instead (serving `leaderelection.go:279-312`),
   SPEC chose exit so leader-local state never leaks across terms.
5. One scheduler-wide limiter at `KRUN_K8S_CONCURRENCY` (8) and
   `AbortSignal.timeout(10_000)` on every API call (SPEC.md:794-796) because
   a stalled API server must not hold the loop open.
6. Classify by status: 403 quota, 429, 5xx, network -> transient (release
   lease, back off the function `2^n` s capped 60, count
   `krun_job_create_errors_total`); any other 4xx -> permanent
   `job_create_failed` with `error.source krun`, `details { code, reason }`
   (SPEC.md:827-835, D23) because admission rejections must surface in
   seconds and blips must not fail runs.
7. 429 in the main loop releases unscheduled claims, pauses for
   `Retry-After` (default 1 s, cap 60) and logs at warn (SPEC.md:796-798).
8. Every Secret or Job delete treats 404 as success (SPEC.md:798-799)
   because retries and TTL races are normal.
9. Step 4 order per run: Secret (`AlreadyExists` reads the token) ->
   `setJobToken` -> Job (`AlreadyExists` is success) -> `markScheduled`;
   false deletes Job (foreground) and Secret, true replays the handler on
   the cached Job and pod with no API call (SPEC.md:820-826, D27) because
   the token hash must exist before the pod can call the gateway.
10. Iterations never overlap; a `state` notify during one marks exactly one
    more; `status` and `job_status` notifies are ignored; 10 s deadline
    checked between steps and runs, past it release unprocessed claims
    (SPEC.md:801-806).
11. Pass the `krun.io/run-id` label selector to `makeInformer` and inside
    the `listFn`; register `on('error')` that restarts with backoff before
    `start()` (SPEC.md:847-852, node-stack-facts.md:363-397) because the
    informer stops for good on any error and the selector only reaches the
    watch URL.
12. No resync exists: the leader reconcile timer runs the handlers over the
    caches every 5 minutes and once after sync, writes only on change, and
    runs the step 6 check (SPEC.md:848-851, D33).
13. `jobStatus` change = deep inequality of every field except
    `observedAt`; call `setJobStatus` only on change (SPEC.md:858-860)
    because a replayed event must cost no write.
14. State comes from Kubernetes only: pod `Running` -> `running`,
    `Complete` -> `succeeded` (from `running` or `scheduled`), `Failed` ->
    `failed`; never from the function's reports (SPEC.md:861-863,
    SPEC.md:377-378, D18).
15. Terminal order: already-terminal check -> object check (Complete, no
    inline result, carry `result_ref`) -> CAS with final `jobStatus`,
    `failureReason`, `error`, `logTail`, `startTime` when missing ->
    delete Secret -> delete Job background (SPEC.md:863-872, D28) so the
    state is recorded before the Job can vanish.
16. An object store error other than not-found leaves the run
    untransitioned; the next event or reconcile tick retries
    (SPEC.md:872-873).
17. `failureReason` precedence `oom_killed > deadline_exceeded > evicted >
    disrupted > exit_code` (SPEC.md:379-381); `error` precedence function
    report > Kubernetes reason > krun, enforced by the store's
    `coalesce(error, patch.error)` (SPEC.md:367-373).
18. Fetch the log tail (100 lines, 16 KB, 10 s abort) on the first pod
    event with a non-zero exit, `OOMKilled` or `deletionTimestamp`; never on
    exit 0; always before any delete (SPEC.md:890-899).
19. Heartbeat and `job_lost` start only after both informers' initial list
    and skip runs whose cached Job is terminal or whose pod is missing or
    not `Running` (SPEC.md:779-781, 904-906, D33) because otherwise a
    completed run is killed as `heartbeat_timeout` at startup.
20. Heartbeat order: log fetch -> Job delete foreground -> CAS `running ->
    failed heartbeat_timeout` -> Secret delete (SPEC.md:906-911).
21. `job_lost` after 2 minutes absent from the cache, leader-local
    first-absent map, keep `result`, Secret delete only (SPEC.md:838-845,
    SPEC.md:1123).
22. Cancelling: Job delete foreground -> Secret delete -> `cancelled`
    (SPEC.md:836-837); the Job may not exist.
23. Sweep every 10 minutes: `sweep(now - KRUN_RETENTION, 1000)` until a
    batch is short, then delete `krun.io/run-id` Secrets older than 1 hour
    with no matching Job; `krun_sweep_deleted_total` (SPEC.md:930-932).
24. Never log the token, the Job manifest, env lists (presigned URL),
    input, result, `error.details` (SPEC.md:1087-1089, 1149-1154).
25. SIGTERM: `/readyz` 503 -> stop claiming, bound the iteration -> stop
    informers -> clear `holderIdentity` -> close the pool -> exit 0
    (SPEC.md:1170-1174).

## Start order and leader gating

See `references/lease.md` "Leader-gated components" for the table. In
short: process start = config, store, KubeConfig (`loadFromDefault`),
Function informer, admin listener, Lease loop. Acquisition = Job and Pod
informers, main loop, cancelling (step 5), deliveries, sweep, status
writer, `krun_scheduler_leader` 1. Both initial lists = reconcile once,
startup log of runs with no Job, heartbeat loop, `job_lost`, 5-minute
timer. Loss or SIGTERM = reverse.

## API plumbing (P4.3a, PLAN.md:477-484)

| Piece | Rule |
|---|---|
| limiter | in-house semaphore of `KRUN_K8S_CONCURRENCY` permits around every client call (PLAN.md:72-73); test: at most 8 in flight |
| timeout | `AbortSignal.timeout(10_000)` per call via a promise middleware calling `ctx.setSignal` (node-stack-facts.md:314-345); expect `DOMException name TimeoutError`, not `ApiException` |
| classification | `err instanceof ApiException` -> `code`, `body.reason`, `body.message`, `headers['retry-after']`; else network (transient) |
| 403 split | `body.reason === 'Forbidden'` with a quota message (`exceeded quota`) -> transient + `krun_quota_rejections_total{function}`; RBAC 403 -> permanent |
| backoff | per-function `Map<fn, { n, until }>`, `min(2 ** n, 60)` s, reset on success (serving `controller.go:535-567`: reset backoff on success) |
| global cap | the limiter plus the 429 pause is the global token bucket on top of per-function backoff (serving `revision/controller.go:123-127`) |
| budget | a per-call failure continues the batch; an exhausted 10 s iteration deadline ends it (keda `scale_jobs.go:136-162`) |

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
| `krun_terminal_detect_seconds{function}` | container `terminated.finishedAt` -> terminal CAS |
| `krun_scheduler_leader` | 1 while leading, 0 otherwise, on every replica |

`prom-client` only (PLAN.md:63); histogram labels stay `function` (and
`state`) only. Alert rules reading them are fixed in SPEC.md:1373-1385
(`krun-helm-chart`).

## Library facts (`@kubernetes/client-node` 2.0.1, node-stack-facts.md)

- ESM only, undici-backed, Node 24 supported; `setDefaultAuthentication`
  does not exist (VERIFIED). A new undici Agent per request, no dispatcher
  cache (VERIFIED by absence): the 8-way limiter also bounds sockets.
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
- Per-call timeout: 2.0.1 has no `setRequestTimeoutOptions`; a middleware
  calling `ctx.setSignal(AbortSignal.timeout(ms))` works
  (`RequestContext.setSignal` VERIFIED; whether the Object API's
  `ConfigurationOptions` is the promise or observable flavour UNVERIFIED,
  budget a spike). `AbortSignal.timeout` timers do not keep the process
  alive.
- Informers: no resync, no `fieldSelector` on `makeInformer`, selector
  must also be in `listFn`, `error` stops the informer for good,
  `TimeoutError` after 30 s inactivity is normal, `update` only on
  `resourceVersion` change, 410 re-lists, cache `get(name, ns)` /
  `list(ns)` (all VERIFIED from `dist/informer.js`, `dist/cache.js`).
- Patch calls default to `application/json-patch+json`; the status writer
  (P4.7) needs `setHeaderOptions('Content-Type', PatchStrategy.MergePatch)`
  (VERIFIED); irrelevant to Jobs and Secrets here (no patch calls).
- Tests: `node --test` with `mock.timers.enable({ apis: ['setTimeout',
  'setInterval', 'Date'] })`; omit `'Date'` and expiry logic disagrees with
  the timers (VERIFIED).
- `@types/node ^26` arrives as a runtime dependency; a duplicate
  `@types/node` next to krun's 24 pin may need a pnpm override
  (UNVERIFIED consequence).

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
  `reconcile_resources.go:75-79`): see SPEC RISK below; SPEC today says
  `AlreadyExists` counts as success without a label check.
- Keep lease renew on its own timer, never behind the loop's awaits; a
  blocked leadership path once made Dapr's cron exit silently (dapr
  `cron.go:180-195`). Shutdown: readiness first, bounded drain, forced
  stop, then release (dapr `server.go:336-366`).

## Pitfalls

- `kubernetes-operator` (project skill) is Go/controller-runtime with
  workqueues, finalizers and `RequeueAfter`; krun has hand-written loops,
  no finalizers, no workqueue (PLAN.md:69-73). Use it for vocabulary only;
  SPEC wins. `kubernetes-skill` is fine for `kubectl` and Job/Pod
  semantics.
- Foreground vs background propagation differs per path (table in
  `informers.md`); mixing them either deletes pods before the log fetch or
  records `failed` while the pod still runs.
- `DisruptionTarget` needs Kubernetes 1.29+ (SPEC.md:1433-1434); on older
  clusters a drained pod shows as `disrupted` through the "Failed with no
  terminated state" rule, not the condition.
- Identity is the downward-API pod name (SPEC.md:785); a StatefulSet
  restart in embedded mode reuses the name, so never trust a matching
  `holderIdentity` on the first read.
- `expireQueued` and `job_create_failed` are terminal transitions: the
  delivery row is inserted by the store, not by the scheduler
  (SPEC.md:348-351); do not insert it twice.
- The `queued`-with-token window: step 4 may be interrupted after the Job
  exists; the replay after `markScheduled` true and the `job_lost` map
  cover it. Do not add a separate "orphan Job" scanner.
- Do not count or list Jobs through the API in the loop; the informer
  cache and `countByState` are the only sources (SPEC.md:815-817).
- No new dependency for any of this: Lease election, limiter, backoff are
  in house (PLAN.md:69-73); a research report suggesting `async-mutex`,
  `p-limit` or a leader-election package is not allowed without a
  Decisions row (PLAN.md:29-30).
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
- SPEC RISK (client-node timeout middleware): the promise-vs-observable
  `ConfigurationOptions` shape is UNVERIFIED (node-stack-facts.md:338-343);
  if the spike fails, write BLOCKED P4.3a rather than wrapping each call
  in `Promise.race` without aborting the request.

## Before marking a task done

- Run the task's acceptance test first (test written before code,
  docs/AGENT-KICKOFF.md): P4.1 golden file; P4.2 stubbed
  `CoordinationV1Api` table in `lease.md`; P4.3a limiter/503/422/429; P4.3b
  and P4.3c the list in `main-loop.md`; P4.4, P4.5, P4.8, P4.9 the lists in
  `informers.md` and `failure-matrix.md`; P4.10 fake clock + stubbed
  `CoreV1Api`; P4.11 embedded mode with `KUBECONFIG` at `test/fake-kube`,
  `/readyz` 200 as standby, exit 0 within 5 s of SIGTERM with the Lease
  cleared; P6.2 fake object store, `resultUri` in the delivery payload.
- `make check` green (CLAUDE.md:5, PLAN.md:17-18).
- Branch `p4-<n>-<slug>`, Conventional Commit with scope `scheduler`
  (PLAN.md:13-15); mark `[x]` and append the progress-log line
  `2026-10-23 P4.x <sha> note` in the same commit (PLAN.md:19-20); PR to
  main, merge when CI is green; never push main.
- No `Co-Authored-By` trailer or Claude attribution (CLAUDE.md:7,
  PLAN.md:16).
- Phase gate after P4.13: `make e2e` on kind in embedded mode
  (PLAN.md:449-461).

## Limitations

- This skill does not cover the Function informer, Function validation or
  the status writer (`krun-functions-crd`), the deliveries loop and object
  store client (`krun-webhooks-objstore`), config parsing, `/readyz`
  plumbing and the admin listener (`krun-process-runtime`), or the chart's
  RBAC and NetworkPolicy rendering (`krun-helm-chart`).
- `test/fake-kube` and the kind e2e harness are `krun-testing-ci`.
- Line numbers were verified on 2026-10-23 against a working tree that
  another agent edits; re-verify before citing in a PR.
