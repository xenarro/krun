---
name: krun-scheduler-k8s
description: Use when building the krun scheduler or Job lifecycle. Lease, main loop, informers, Job manifest (hostUsers), Kube call spans, jobStatus, failure detection, heartbeat, sweep.
---

# krun scheduler and Kubernetes Job lifecycle

SPEC.md section 7 (Job contract) and section 8 (Scheduler) for
`apps/scheduler`, an Effect 4 program (SPEC D35, docs/STACK.md). PLAN tasks
P4.1-P4.5, P4.8-P4.11, P6.2. P4.6 metrics: `krun-process-runtime`. P4.7
status writer: `krun-functions-crd`. Rules name the Effect construct
docs/STACK.md section 4.3 maps them to.

## When to use

- Task ids P4.1, P4.2, P4.3a/b/c, P4.4, P4.5, P4.8, P4.9, P4.10, P4.11,
  P6.2, or a review of one.
- Touching `apps/scheduler/src/k8s`, the `Kube` service, the Lease layer,
  `makeInformer` use, `setJobStatus`, scheduler `transition` calls,
  `pods/log`.
- Also load `krun-store` for the Store methods the loops call
  (SPEC.md:492-520) and `krun-process-runtime` for the admin listener,
  `/readyz` and `NodeRuntime.runMain` shutdown wiring.
- Before coding, load the docs/STACK.md section 5 skills:
  `effect-core-patterns`, `effect-concurrency`,
  `effect-resource-management`, `effect-error-handling`,
  `effect-dependency-injection`, `effect-testing`, `kubernetes-operator`
  (vocabulary only), `kubernetes-skill`. Effect's `MIGRATION.md` overrides
  Effect 3 skill text: `Context.Service` (not `Context.Tag`),
  `Context.Reference` (not `FiberRef`), no `Runtime<R>` (CLAUDE.md rule 7;
  full rename table in `krun-development`). Effect 3 names (`Runtime`,
  `Layer.scoped`, `Effect.fork`) were renamed or removed. Where a reference
  says "check MIGRATION.md", read it before typing the name.

## Read first

- SPEC.md:564-656 Job contract; SPEC.md:774-932 Scheduler; SPEC.md:320-381
  lifecycle table and rules; SPEC.md:1034-1039 RBAC; SPEC.md:1098-1123
  backpressure constants; SPEC.md:1125-1174 metrics, logs, readiness,
  shutdown; SPEC.md:1139-1152 telemetry (spans on iterations and Kubernetes
  calls); SPEC.md:1022-1027 and 1236 user namespaces
  (`KRUN_JOB_HOST_USERS`); D18, D19, D23, D27, D28, D33, D35, D36 (section
  15). Kubernetes 1.33 minimum (SPEC section 14).
- docs/STACK.md 2.4 (`Kube` service), 2.6 (OpenTelemetry packages), 4.1
  (process shape), 4.2 (tagged errors), 4.3 (SPEC rule to Effect construct,
  spans), 4.4 (time).
- PLAN.md:467-481 phase 4 gate; PLAN.md:483-551 P4.1-P4.5; PLAN.md:562-599
  P4.8-P4.11; PLAN.md:662-667 P6.2; PLAN.md:36-91 dependencies and in-house
  list.

| Reference | Holds |
|---|---|
| `references/job-manifest.md` | Secret and Job YAML verbatim, env order, builder rules, golden test |
| `references/lease.md` | Lease contract, state machine, leader scope, RBAC, SIGTERM finalizer order, P4.2 test table |
| `references/main-loop.md` | loop fiber shape, steps 1-6, step 4 checklist, cancelling, `job_lost`, acceptance list |
| `references/informers.md` | client-node informer facts, informer `Stream`s, restart, 5-minute reconcile, `jobStatus` derivation, terminal path order, heartbeat |
| `references/kube-service.md` | `Kube` service plumbing (P4.3a), leader metrics, client-node 2.0.1 facts, competitor lessons |
| `references/failure-matrix.md` | Kubernetes signal to `jobStatus`, `failureReason`, `error.source`, `logTail`, metric |

Order of work: `job-manifest.md` (P4.1), `lease.md` (P4.2),
`kube-service.md` (P4.3a), `main-loop.md` (P4.3b, P4.3c, P4.5), `informers.md` (P4.4,
P4.9, P6.2), `failure-matrix.md` (P4.8).

## Rules

1. Only the leader runs loops, Job/Pod informers and the status writer.
   The Function informer runs on every replica: readiness depends on it
   (SPEC.md:776-779). Fork leader-only fibers into the leader scope, never
   into the process scope.
2. Lease: `get`, then `update` with the read `resourceVersion`. A 409 or a
   changed `holderIdentity` fails the attempt; retry in 2 s
   (SPEC.md:786-788). The read-replace pair is the optimistic lock.
3. The Lease expires 15 s after the candidate last saw `holderIdentity` or
   `renewTime` change, on its own clock (`Clock.currentTimeMillis`). Never
   use `now - renewTime`: clock skew would elect two leaders
   (SPEC.md:788-790).
4. A leader with no successful renew for 10 s stops loops and informers,
   cancels in-flight calls and exits non-zero (SPEC.md:790-792). The renew
   fiber closes the leader scope (loops, informers, status writer, every
   in-flight `Kube` call) and fails with tagged `LeaderLost`;
   `NodeRuntime.runMain` exits non-zero. Knative demotes instead (serving
   `leaderelection.go:279-312`); SPEC exits so leader-local state never
   leaks across terms.
5. One scheduler-wide `Semaphore` of `KRUN_K8S_CONCURRENCY` (8) permits and
   a 10 s `Effect.timeout` around every API call, both inside the `Kube`
   service (SPEC.md:794-796, docs/STACK.md 2.4 and 4.3). A stalled API
   server must not hold the loop open. The timeout interrupts the
   `Effect.tryPromise` fiber. The `AbortSignal` that `tryPromise` hands to
   `try` must reach the request, so the socket is torn down.
6. Classify by `KubeApiError.status`. Transient (403 quota, 429, 5xx,
   network, timeout): release lease, back off the function `2^n` s capped
   60, count `krun_job_create_errors_total`. Any other 4xx: permanent
   `job_create_failed` with `error.source krun`, `details { code, reason }`
   (SPEC.md:827-835, D23). Admission rejections surface in seconds; blips
   never fail runs. The classifier is a pure function of tag and status
   (docs/STACK.md 4.2).
7. 429 in the main loop: release unscheduled claims, pause the loop fiber
   for `Retry-After` (default 1 s, cap 60) with `Effect.sleep`, log at warn
   (SPEC.md:796-798).
8. Every Secret or Job delete treats 404 as success (SPEC.md:798-799).
9. Step 4 order per run: Secret (`AlreadyExists` reads the token),
   `setJobToken`, Job (`AlreadyExists` is success), `markScheduled`. False:
   delete Job (foreground) and Secret. True: replay the handler on the
   cached Job and pod, no API call (SPEC.md:820-826, D27). The token hash
   must exist before the pod can call the gateway.
10. Iterations never overlap. One loop fiber takes from a sliding `Queue`
    of capacity 1, fed by the 1 s `Schedule.spaced` ticker and by `state`
    notifies. A `state` notify during an iteration marks exactly one more.
    `status` and `job_status` notifies are ignored. The 10 s deadline is
    `Effect.timeout` on the iteration. `Effect.ensuring` releases the
    leases of unprocessed claims (SPEC.md:801-806, docs/STACK.md 4.3).
11. Pass the `krun.io/run-id` label selector to `makeInformer` and inside
    the `listFn`. Register `on('error')` with a backoff restart before
    `start()` (SPEC.md:847-852, docs/research/node-stack-facts.md:363-397):
    the informer stops for good on any error, and the selector only reaches
    the watch URL. Expose each informer as a `Stream` built in the leader
    scope (`start()` on acquire, `stop()` on release).
12. No resync exists. The leader reconcile runs the handlers over the
    caches once after sync, then every 5 minutes (`Effect.repeat` with
    `Schedule.spaced("5 minutes")`). It writes only on change and runs the
    step 6 check (SPEC.md:848-851, D33).
13. `jobStatus` change = deep inequality of every field except
    `observedAt`. Call `setJobStatus` only on change (SPEC.md:858-860): a
    replayed event costs no write.
14. State comes from Kubernetes only: pod `Running` gives `running`;
    `Complete` gives `succeeded` (from `running` or `scheduled`); `Failed`
    gives `failed`. Never from the function's reports (SPEC.md:861-863,
    SPEC.md:377-378, D18).
15. Terminal order: already-terminal check; object check (only when the Job
    completed and `result` is null; carry `result_ref`); CAS with final
    `jobStatus`, `failureReason`, `error`, `logTail`, `startTime` when
    missing; delete Secret; delete Job background (SPEC.md:863-872, D28).
    State is recorded before the Job can vanish.
16. An object store error other than not-found leaves the run
    untransitioned. The next event or reconcile tick retries
    (SPEC.md:872-873).
17. `failureReason` precedence `oom_killed > deadline_exceeded > evicted >
    disrupted > exit_code` (SPEC.md:379-381); `error` precedence: function
    report, then Kubernetes reason, then krun; the store enforces it with
    `coalesce(error, patch.error)` (SPEC.md:367-373).
18. Fetch the log tail (100 lines, 16 KB, 10 s `Effect.timeout`) on the
    first pod event with a non-zero exit, `OOMKilled` or
    `deletionTimestamp`. Never on exit 0. Always before any delete
    (SPEC.md:890-899).
19. Heartbeat and `job_lost` start only after both informers' initial list
    (a `Deferred` each, awaited together). They skip runs whose cached Job
    is terminal or whose pod is missing or not `Running` (SPEC.md:779-781,
    904-906, D33). Otherwise a completed run dies as `heartbeat_timeout` at
    startup.
20. Heartbeat order: log fetch, Job delete foreground, CAS `running ->
    failed heartbeat_timeout`, Secret delete (SPEC.md:906-911).
21. `job_lost` after 2 minutes absent from the cache. Leader-local
    first-absent map (times from `Clock`). Keep `result`; Secret delete only
    (SPEC.md:838-845, SPEC.md:1123).
22. Cancelling: Job delete foreground, Secret delete, `cancelled`
    (SPEC.md:836-837). The Job may not exist.
23. Sweep every 10 minutes (`Schedule.spaced`): `sweep(now -
    KRUN_RETENTION, 1000)` until a batch is short. Then delete
    `krun.io/run-id` Secrets older than 1 hour with no matching Job. Count
    `krun_sweep_deleted_total` (SPEC.md:930-932).
24. Never log the token, the Job manifest, env lists (presigned URL),
    input, result, `error.details` (SPEC.md:1087-1089, 1149-1154).
25. SIGTERM order: `/readyz` 503; stop claiming, bound the iteration; stop
    informers; clear `holderIdentity`; close the pool; exit 0
    (SPEC.md:1170-1174). This is the reverse acquisition order of scope
    finalizers under `NodeRuntime.runMain`. No signal handler of our own
    (`references/lease.md`).
26. Wrap every `Kube` method body in `Effect.withSpan` inside the service
    (span name `kube.<verb> <resource>`, for example `kube.create jobs`).
    Every main-loop iteration, reconcile pass, heartbeat pass and sweep is a
    span too (SPEC.md:1145-1152, docs/STACK.md 4.3). Span attributes:
    namespace, object name, function, HTTP status, and `krun.run_id` on
    every span about a run. Never the manifest, env, token, presigned URL,
    input or result (SPEC.md:1150-1156). No
    `@opentelemetry/instrumentation-*` package: write spans by hand where
    SPEC names them.
27. Put `hostUsers: false` in the Job pod template only when
    `KRUN_JOB_HOST_USERS` is `false`. Otherwise omit the field; never set
    it to `true` (SPEC.md:592, 1236). The default golden file stays
    unchanged on clusters without user namespaces.
28. Time comes from `Clock` and `DateTime` only: Lease observation times,
    renew deadline, first-absent times, staleness cut-offs, backoff
    deadlines, `observedAt`. Never `Date.now()` or `new Date()` (CLAUDE.md
    rule 8). Tests drive time with `TestClock.adjust`.

## Start order

Process start: Config, Logger, Database, Store, KubeConfig
(`loadFromDefault`), `Kube`, Function informer, admin listener, then the
Lease layer. What starts on acquisition and after both initial lists:
`references/lease.md` "Leader-gated components". Loss closes the leader
scope; SIGTERM runs the finalizers in reverse.

## Kube service, client-node facts, leader metrics

`references/kube-service.md`: P4.3a plumbing table (PLAN.md:497-504),
leader metrics (SPEC.md:1134-1147), `@kubernetes/client-node` 2.0.1 facts
with UNVERIFIED gaps, KEDA/Knative/Dapr lessons, client-node abort SPEC RISK.

## Pitfalls

- `kubernetes-operator` (project skill) is Go/controller-runtime with
  workqueues, finalizers, `RequeueAfter`. krun has Effect loop fibers, no
  Kubernetes finalizers, no workqueue (PLAN.md:82-87): vocabulary only,
  SPEC wins. `kubernetes-skill` is fine for `kubectl` and Job/Pod semantics.
- Foreground vs background propagation differs per path (table in
  `informers.md`). Mixing them deletes pods before the log fetch, or records
  `failed` while the pod still runs.
- The jobs namespace may carry the `krun-jobs-digest`
  ValidatingAdmissionPolicy (SPEC.md:1017-1021). A Job image without its
  digest is rejected with 422 or 403: permanent `job_create_failed` per
  rule 6. Never retry it as transient.
- Run correlation is by attribute, not by trace (SPEC section 11).
  `krun.run_id` goes on the per-run step 4 span, terminal-path, heartbeat
  and `job_lost` spans, and that run's `Kube` calls. No trace context to
  the pod (no `TRACEPARENT` env, no Job annotation); no trace column on
  `runs`. P4.6 asserts a shared `krun.run_id`, not a shared trace id.
- Identity is the downward-API pod name (SPEC.md:785); never trust a
  matching `holderIdentity` on the first read (`references/lease.md`).
- `expireQueued` and `job_create_failed` are terminal transitions. The
  store inserts the delivery row, not the scheduler (SPEC.md:348-351). Do
  not insert it twice.
- `queued`-with-token window: step 4 may be interrupted after the Job
  exists (deadline or SIGTERM). The replay after `markScheduled` true and
  the `job_lost` map cover it. Do not add an "orphan Job" scanner.
- Never count or list Jobs through the API in the loop. Informer cache and
  `countByState` are the only sources (SPEC.md:815-817).
- No new dependency: Lease election, limiter, backoff are in house on
  Effect primitives (`Semaphore`, `Schedule`, scopes; PLAN.md:82-87).
  `async-mutex`, `p-limit`, a leader-election package or
  `@effect/platform-node`'s unstable `Undici` module are not allowed
  without a Decisions row (PLAN.md:29-30, docs/STACK.md 2.1).
- SPEC RISK (`AlreadyExists` adoption): SPEC.md:822-823 counts a Job
  `AlreadyExists` as success with no ownership check; Knative refuses to
  adopt a child it does not control. A stranger's `krun-<uuid>` Job is
  practically impossible (UUIDv7 names): implement SPEC as written. A
  `krun.io/run-id` label check on the 409 path needs a Decisions row, not a
  silent change.
- SPEC RISK (manifest extras): competitor-only Job fields need a Decisions
  row; detail in `references/job-manifest.md`.

## Before marking a task done

- Acceptance test first (docs/AGENT-KICKOFF.md), run with
  `pnpm exec vitest run apps/scheduler`:

  | Task | Test |
  |---|---|
  | P4.1 | golden file (`job-manifest.md`) |
  | P4.2 | stubbed `CoordinationV1Api` table in `lease.md` |
  | P4.3a | semaphore/503/422/429 |
  | P4.3b, P4.3c | list in `main-loop.md` |
  | P4.4, P4.5, P4.8, P4.9 | lists in `informers.md` and `failure-matrix.md` |
  | P4.10 | `TestClock` + stubbed `CoreV1Api` |
  | P4.11 | embedded mode with `KUBECONFIG` at `test/fake-kube`; `/readyz` 200 as standby; exit 0 within 5 s of SIGTERM with the Lease cleared |
  | P6.2 | fake object store, `resultUri` in the delivery payload |

- `make check` green (CLAUDE.md:5, PLAN.md:17-18).
- Branch `p4-<n>-<slug>`, Conventional Commit scope `scheduler`
  (PLAN.md:13-15). Mark `[x]` and append `2026-10-23 P4.x <sha> note` in
  the same commit (PLAN.md:19-20). PR to main, merge when CI is green;
  never push main. No `Co-Authored-By` trailer or Claude attribution
  (CLAUDE.md:7, PLAN.md:16).
- Phase gate after P4.13: `make e2e` on kind in embedded mode
  (PLAN.md:469-481).

## Limitations

- Not covered: Function informer, Function validation, status writer
  (`krun-functions-crd`); deliveries loop and object store client
  (`krun-webhooks-objstore`); config parsing, `/readyz` plumbing, admin
  listener (`krun-process-runtime`); chart RBAC and NetworkPolicy
  (`krun-helm-chart`); `test/fake-kube` and the kind e2e harness
  (`krun-testing-ci`).
- Line numbers verified on 2026-10-23 against a tree another agent edits.
  Citations from SPEC section 9 onwards may be a few lines off. Re-verify
  before citing in a PR.
