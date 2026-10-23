# Scheduler main loop (SPEC.md section 8)

Serves PLAN P4.3b (PLAN.md:505-519), P4.3c (PLAN.md:520-522), P4.5
(PLAN.md:543-551). Line numbers verified against the working tree on
2026-10-23; re-check before citing.

## Triggers and deadline (SPEC.md:801-806, verbatim)

> Main loop, every 1 second and on each notify of kind `state`; `status` and
> `job_status` notifies are ignored by it. Iterations never overlap: a
> `state` notify during an iteration marks exactly one more. Each iteration
> carries a 10 second deadline checked between steps and between runs in
> step 4; past it, the leases of unprocessed claimed runs are released and
> the iteration ends.

Implementation shape (Effect fibers in the leader scope, no workqueue;
docs/STACK.md 4.3, PLAN.md:82-87). Constructor names follow Effect 3
spelling; check Effect's `MIGRATION.md` for the Effect 4 names
(`Effect.forkIn`, `Queue.sliding`, `Effect.catchAll`, the `Stream`
runners):

```ts
const wake = yield* Queue.sliding<void>(1)              // capacity 1: coalesces
yield* Queue.offer(wake, undefined).pipe(               // 1 s ticker
  Effect.repeat(Schedule.spaced("1 second")), Effect.forkIn(leaderScope))
yield* store.subscribe.pipe(                            // notifies, kind state only
  Stream.filter((n) => n.kind === "state"),
  Stream.runForEach(() => Queue.offer(wake, undefined)), Effect.forkIn(leaderScope))
yield* Queue.take(wake).pipe(                           // the one loop fiber
  Effect.zipRight(iteration.pipe(
    Effect.timeout("10 seconds"),                       // iteration deadline
    Effect.ensuring(releaseUnprocessedClaims),          // leases of claimed, not yet scheduled runs
    Effect.catchAll(logIterationFailure))),             // a failed iteration never ends the loop
  Effect.forever, Effect.forkIn(leaderScope))
```

Two notifies during one iteration yield one extra iteration, not two
(acceptance in PLAN.md:518-519): the sliding queue holds at most one wake.
The claimed-but-unscheduled set lives in a `Ref` filled by step 3 and
emptied at each `markScheduled` or permanent failure; the `ensuring`
finalizer releases what is left, whether the iteration ended, timed out or
was interrupted by leader loss or SIGTERM. The finalizer runs
uninterruptibly, so bound its store calls. An interruption between Job
create and `markScheduled` is safe: the lease is released, the next claim
finds the Secret and Job by name (`AlreadyExists`) and continues. Readiness
of the loop: it runs only on the leader and stops when the leader scope
closes (SPEC.md:776-779). A failed `subscribe` stream is retried with a `Schedule`
(`Stream.retry`); the 1 s ticker keeps the loop running meanwhile.

## Steps 1-6 (SPEC.md:808-845, verbatim)

> 1. Read `countByState`. For every function name with queued runs call
>    `expireQueued(fn, now - queueTimeout)`, using the cached Function's
>    `queueTimeout` when it is in the informer map (Ready or not) and parses,
>    else the CRD default 1h. Each expired run gets its `run_events` row,
>    notify and delivery; an expired run with `jobTokenHash` set also gets
>    its Job (foreground) and Secret deleted, as after a false
>    `markScheduled`.
> 2. Free slots per function are `maxConcurrency - (scheduled + running)`,
>    and globally `KRUN_MAX_RUNNING - sum(scheduled + running)`. Publish
>    `krun_runs_current` from the same `countByState` result.
> 3. For each Ready function with free slots, claim up to the smaller of the
>    two, lease 30 seconds.
> 4. For each claimed run, in this order: create the Secret with a fresh
>    token (`AlreadyExists`: read the existing token); `setJobToken` with the
>    Job name and the token hash; create the Job (`AlreadyExists` counts as
>    success); `markScheduled`; when it returns false, delete the Job with
>    foreground propagation and the Secret; when it returns true, run the
>    informer handler once on the cached Job and pod for that run (informer
>    cache, no API call), so a `Complete` that arrived first is not missed.
>    Errors from the API server are classified by status: 403 quota, 429,
>    5xx and network errors are transient: release the lease, back off that
>    function for `2^n` seconds capped at 60, count
>    `krun_job_create_errors_total{function,code}`,
>    `krun_quota_rejections_total` for quota. Any other 4xx (400, 403 RBAC,
>    404, 422 admission) is permanent: delete the Secret if created,
>    transition `queued` to `failed` with `job_create_failed` and `error`
>    `{ source: krun, message: <API server Status message>, details: { code:
>    <HTTP status>, reason: <Status reason> } }`.
> 5. For each run in `cancelling`: delete the Job with foreground propagation,
>    delete the Secret, transition to `cancelled`.
> 6. Lost Jobs, active only after the Job informer's initial list: for each
>    run from `listByState(['scheduled','running'], KRUN_MAX_RUNNING)` whose
>    Job is absent from the informer cache, record the first-absent time in a
>    leader-local map (reset on leader change); past the 2 minute grace,
>    transition to `failed` with `job_lost` and a `krun`-sourced error
>    unless the function reported one, keep any `result` already written,
>    then delete the Secret; drop the entry when the Job reappears.

## Step 4 per run, as a checklist

| # | Call | On failure |
|---|---|---|
| a | `secrets.create(krun-<id>, immutable, token)` | `409 AlreadyExists`: `secrets.read` and use its `token`; transient (403 quota/429/5xx/network): `releaseLease`, back off function `2^n` s ≤ 60; permanent 4xx: `queued -> failed job_create_failed` (SPEC.md:827-835) |
| b | `store.setJobToken(id, 'krun-<id>', sha256(token))` | idempotent (SPEC.md:504); must precede the Job (SPEC.md:568-570, D27 SPEC.md:1468) |
| c | `jobs.create(buildJob(run, fn))` | `409 AlreadyExists` = success; transient: release lease, back off; permanent: delete the Secret, `queued -> failed job_create_failed` with `error.details { code, reason }` |
| d | `store.markScheduled(id)` | `false`: delete Job (`propagationPolicy: Foreground`) and Secret, 404 = success (SPEC.md:798-799); `true`: replay the Job/Pod handler on `jobInformer.get(name)` and the cached pod, no API call |

The 10 s deadline (SPEC.md:804-806) is the `Effect.timeout` on the whole
iteration: when it fires, the iteration fiber is interrupted wherever it
is, and the `ensuring` finalizer calls `releaseLease` for every claimed run
not yet past step d. Process the claimed runs sequentially (no
`concurrency` option on the per-run `Effect.forEach`) so "unprocessed" is
well defined. A 429 anywhere in the loop also releases the leases of
claimed-but-unscheduled runs, pauses the loop fiber for `Retry-After`
(default 1 s, cap 60 s, `Effect.sleep` so `TestClock` controls it) and logs
at warn (SPEC.md:796-798).

Never log the token, the Job manifest or the env list: `KRUN_RESULT_UPLOAD_URL`
is a presigned URL (SPEC.md:1149-1154).

## Step 5 cancelling (SPEC.md:836-837, SPEC.md:336-337)

Order: Job delete `Foreground` (404 ok) -> Secret delete (404 ok) ->
`transition(id, 'cancelling', 'cancelled', null, {})`. The gateway writes
`cancelling` from `queued`, `scheduled` or `running`; a `cancelling` run
whose Job never existed still ends `cancelled` (PLAN.md:520-522 tests both
Job absent and present).

## Step 6 job_lost (SPEC.md:838-845, SPEC.md:914-919, D28 SPEC.md:1469)

- Gate: only after both the Job and Pod informers' initial list (SPEC
  section 8 intro; step 6 itself names the Job informer, and both is the
  stricter gate); nothing fires before it (PLAN.md:543-551). `firstAbsent:
  Ref<Map<runId, DateTime.Utc>>` is created in the leader scope, so it is
  discarded on leader change. First-absent times come from `DateTime.now`,
  never `Date.now()`.
- `absent` means `jobInformer.get('krun-<id>', jobsNamespace)` is undefined.
  Drop the map entry when the Job reappears.
- Past 2 minutes (SPEC.md:1123): `transition(id, state, 'failed', 'job_lost',
  { error: { source: 'krun', message: ... }, jobStatus?: last known })` for
  `state` in `scheduled`, `running`; the store's `coalesce(error, patch.error)`
  keeps a function-reported error (SPEC.md:367-373); the patch never clears
  `result`; then delete the Secret. No Job delete (there is none).
- After sync, log at info the count of `scheduled`/`running` runs with no
  Job (SPEC.md:916-917). Downtime longer than `KRUN_TTL_AFTER_FINISHED`
  turns finished runs into `job_lost` (SPEC.md:917-919, docs/OPERATIONS.md:37-38).

## Acceptance cases to write first (PLAN.md:512-519, PLAN.md:520-522, PLAN.md:548-551)

- `AlreadyExists` on Secret (token read back) and on Job (success).
- 403 quota -> lease released, `krun_quota_rejections_total` incremented.
- 422 -> run `failed`, `failureReason` `job_create_failed`, `error.source`
  `krun`, `error.details.code` 422, Secret deleted.
- 503 -> lease released, function backed off, run still `queued`.
- `markScheduled` false -> Job (foreground) and Secret deleted.
- `Complete` cached before `markScheduled` -> replay ends the run
  `succeeded`.
- Queued run of a deleted Function expires after 1h; with a token its Job
  (foreground) and Secret are deleted.
- Deadline hit mid step 4 -> remaining claims released.
- Two `state` notifies during an iteration -> exactly one more iteration.
- Cancelling with the Job absent and present -> `cancelled` both times.
- `job_lost`: running run with no Job fails after `TestClock.adjust("2
  minutes")`, result kept, a reported error kept, Job reappearing clears
  the entry, nothing before the initial list.

Write them as `@effect/vitest` `it.effect` tests with the `Kube` and Store
stubs provided as layers; drive the 1 s ticker, the 10 s deadline, the
`2^n` backoff and the 2 minute grace with `TestClock.adjust`, never with
real sleeps.
